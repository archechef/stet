# Security

Stet's promise: **an AI agent never changes your project without your approval.** This page summarizes how Stet keeps that promise, where the limits are, and how to report a problem. The full design is in [docs/spec.md](docs/spec.md) §9.

## Threat model

- **Primary:** an agent that means well but edits the wrong file, merges its branch or pushes.
- **Secondary:** an agent steered by text in the document or its sources (prompt injection) that tries to get changes past you.
  - Where the agent tool has an OS sandbox, Stet is designed to hold against this: Claude Code on macOS, Linux and WSL2, and Codex.
  - Without a sandbox (Claude Code on native Windows), Stet catches mistakes but not a determined adversary. See *Known limitations*.

## Protections

- **Isolation:**
  - Agents work in a separate git worktree outside your project.
  - With a sandbox, they can write only there, plus that worktree's private git folder.
  - Your project, its `.git` folder (config, hooks, objects, refs) and Stet's data are read-only to them.
- **Guardrails for Claude** (`.claude/settings.json`): deny rules and a `PreToolUse` hook (`stet guard`) that block:
  - edits outside the workspace;
  - writes into the git folder;
  - git commands that bypass review, such as merge, push, branch switching, `git config` and remote changes.
  - changes to the files Stet manages in the workspace, including the inbox `.stet/inbox`. The one command naming the project's git folder that the guard allows is the workspace's own `stet watch` command exactly as its instructions give it, with no other arguments or shell operators: it only reads the inbox inside the workspace.

  The guard prevents accidents; it is not a security boundary against an agent that sets out to get around it (quoting, `sh -c`, scripts). The sandbox is. When the guard can't check a tool call (an error, a workspace whose git link was changed), it blocks it.
- **PDF previews** compile text an agent proposed, and LaTeX can read any file you can (`\input{/etc/passwd}` works whatever `openin_any` says). So every build runs in a rootless Podman container: no network, a read-only system, no privileges, and only the build folder (writable), your TeX Live and `~/texmf` (read-only) mounted. Shell escape is off, writes are restricted, latexmk's rc files (Perl) are ignored, and the project is exported with symbolic links as plain files. Without Podman, previews are off unless you set `preview.isolation` to `"process"`, and Stet then warns that TeX can read your files. Containers run only the image you built (`--pull=never`, never a download) and are limited in file size, open files, processes and (where cgroups allow) memory; a timeout stops them. Preview images are shown only from Stet's own cache folder.
- **Git hooks in your project:** `reference-transaction` and `pre-push` refuse to bring agent commits into the main branch or push agent branches.
- **Stet's own checks** (these hold even if the guard is bypassed):
  - Agent files are handled through your project's repository, with Stet's own index. Stet's MCP server and guard open your project from the folder recorded when the workspace was created (`STET_PROJECT`), never through the workspace's own git link, and check that link before any git runs in the workspace: an agent that points it at a repository of its own (with hooks) gets an error, not its hooks run.
  - Stet's git calls on agent files run with hooks, filter drivers, submodules, fsmonitor and commit signing switched off.
  - Submitted and accepted paths must stay inside the project and outside `.git`, including Windows aliases such as `GIT~1`.
  - Stet never writes or reads through symbolic links or junctions, and opens agents' files only if they are regular files, without blocking: a named pipe in place of the inbox or `AGENTS.md` can't make Stet (or your VS Code) wait forever.
  - Control characters, Unicode direction overrides and invisible characters (zero-width, soft hyphen, tag characters, byte-order mark) in text an agent wrote are shown as visible markers such as `⟨U+202E⟩`, in the terminal and in VS Code, so they can't rewrite, hide or reorder what you see. A lone carriage return is shown as the line break it is. Agent titles reach commit messages on one line, without control characters.
  - `stet show` says when it shows only the first lines of an added or deleted file (`--full` shows all).
  - Ids are checked before they are used as file names.
  - Accepting is all-or-nothing, with a journal. After a crash, the next Stet operation undoes the interrupted accept (or completes it), but never over your own later edits.
  - The store lock is owned, and every write is fenced: a process that lost the lock stops.
- **VS Code extension:**
  - It runs only in trusted folders (Restricted Mode).
  - Text written by agents is escaped in hovers and tooltips (including link tooltips, `~` fences and line breaks), comment threads show it as plain text, and it can't form links in notifications.
  - Only Stet's own command links are enabled.

## Known limitations

- **Native Windows (Claude Code):** there is no OS sandbox, so the guard hook is the only barrier for shell commands. It parses commands heuristically. An agent that deliberately hides its target can get around it, e.g. by quoting (`g''it`), `sh -c`, `node -e`, `cd` chains, shell variables, or paths built inside a script. It could then write your project's git folder or Stet's data. For untrusted material, run the agent in WSL2.
- **Agent-writable tool settings:** the workspace's `.mcp.json` and `.codex/config.toml` are in the agent's writable folder, and the processes they configure run outside the sandbox at the agent tool's next start. Stet rewrites them when it syncs the workspace.
- **Files that take effect** (`.latexmkrc`, `.gitattributes`, `.vscode/*`, `CLAUDE.md`, `AGENTS.md`) are proposed as ordinary new files: look at them before you accept them.
- **Undecodable bytes:** a text file with bytes that aren't UTF-8 is proposed as a whole binary file, whose content review doesn't show.
- **Fast-forward merges** done by hand: git updates the working tree before a hook can object. The hook stops the branch from moving and prints how to undo the file changes.
- **Not yet verified in a live session:** Claude Code (CLI) and Codex are covered by automated tests only. See [docs/live-tests.md](docs/live-tests.md).

## Reviews

The code went through several security reviews in September 2026: an independent audit, two reviews by Codex, and a pre-release pass for security, efficiency and code quality. All findings were fixed, each with a regression test (`packages/core/test/security.test.ts`, `review-findings.test.ts`). They are summarized in the spec (§16).

## Reporting a problem

Please report security problems privately to the repository owner (via GitHub, or the contact in the commit history) rather than in a public issue. Include:
- steps to reproduce;
- the platform;
- the agent tool involved.
