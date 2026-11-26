# Stet

*stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

**Stet lets AI agents propose changes to your LaTeX, Typst, Lean or Markdown project while you stay in control.**
- The agents (Claude, Codex, …) work in their own copy of the project.
- Their edits reach you as small, reviewable changes.
- You accept, reject, edit or discuss each one, from VS Code or the command line.
- Nothing touches your files until you accept it.

```
$ stet review
claude-1 › Round 1 (C1) Polish the introduction — Clearer terms.
  ⛓ G1 linked Rename label sec:intro → sec:introduction [auto]
      G1.1 \label{sec:intro} → \label{sec:introduction}
        1.1 pending main.tex:3  "\label{sec:intro}" → "\label{sec:introduction}"
      G1.2 \ref{sec:intro} → \ref{sec:introduction}
        1.3 pending main.tex:6  "\ref{sec:intro}" → "\ref{sec:introduction}"
    1.2 pending main.tex:4  "problem" → "task"
Next: stet show <id> · stet accept <id> · stet reject <id> -m <why>
```

`1.2` is round 1, change 2; `C1` the whole round. ⛓ `G1` is a *linked* group, Stet found it itself (`[auto]`), and it comes in parts (`G1.1`, `G1.2`) that you can accept one at a time. The same review in VS Code is a tree in the Stet panel, with each change marked in your file.

## Features

- **Reviewable changes:**
  - Agent edits are split into word- and sentence-level changes that understand LaTeX, Typst and Markdown: math, labels, citations and links stay intact, and re-wrapped lines are ignored. Lean files are reviewed by declaration: a theorem's changed proof is one change, and a renamed lemma comes with the proofs that use it. (PDF previews of changes are LaTeX only for now; in VS Code, Markdown changes show rendered.)
  - Changes that belong together are grouped. *Linked* groups, such as a macro and its uses, are all-or-nothing; large ones come in parts you can accept one at a time, as long as each part alone still compiles.
- **A real conversation:**
  - Rejections with a reason, revision requests, comments and edited wording all go back to the agent automatically, through MCP tools. No copy-paste.
  - The agent learns from them.
- **Your text keeps moving:** you can keep writing while changes are pending, and Stet finds each change again in your current text. Several agents can work in parallel.
- **Git-native:**
  - Each agent has its own git worktree and branch.
  - Accepted changes are committed in one commit when you finish the review.
  - Works with Overleaf's git integration.
- **Safe by design:**
  - Agents cannot write your project, its `.git` folder or Stet's data.
  - Git hooks stop agent branches from being merged or pushed.
  - Stet checks everything an agent hands over. See [SECURITY.md](SECURITY.md).
- **Works with:** the Claude desktop app, Claude Code and Codex, on Windows, macOS and Linux.

## Getting started

### VS Code (no command line needed)

Install **Stet** (publisher *archechef*) from the VS Code Marketplace, or download `stet-vscode-<version>.vsix` from the repository's **Releases** page, or build it:

```bash
npm install
npm run build
npm run package:vscode        # → packages/vscode/stet-vscode.vsix
```

Install it in VS Code: Extensions view → `…` → *Install from VSIX…*. Coworkers only need the `.vsix` file, not Node.js or this repository.

1. Open your LaTeX, Typst, Lean or Markdown project folder in VS Code, then open the **Stet** view in the activity bar and click **Set up project**.
2. Click **New agent workspace**, pick Claude or Codex, and open the workspace folder in that agent.
3. Ask the agent to improve the paper. Its proposals appear in the Stet panel and inline in your `.tex` files. Keys: `a` accept, `r` reject, `e` edit, `v` revise, `c` comment, `j`/`k` next/previous.
4. Click **Finish review** to commit everything you accepted in one commit.

→ [VS Code user manual](docs/vscode.md)

### Command line

Requirements: Node.js ≥ 22 and git ≥ 2.28. Download `stet-<version>.mjs` from the [latest release](https://github.com/archechef/stet/releases/latest): it is the whole command in one file. Run it as `node stet-<version>.mjs`, or put a `stet` command on your PATH that does ([details](docs/cli.md#1-installation)).

In your LaTeX, Typst, Lean or Markdown project (a git repository with at least one commit):

```bash
stet init                             # set up Stet (and git hooks)
stet agent new claude-1               # prints the agent's workspace folder: open it in your agent
stet review                           # what the agent proposed
stet accept 2.1 2.2                   # round 2, changes 1 and 2; or a whole group: stet accept G1
stet reject 2.3 -m "keep the original formula"
stet commit -m "Polish the introduction"   # commits the files whole, your own edits in them too
```

→ [Command-line manual](docs/cli.md)

## Documentation

| | |
|---|---|
| [docs/vscode.md](docs/vscode.md) | **User manual: VS Code extension.** Setup, the panel, reviewing, threads, troubleshooting, settings. |
| [docs/cli.md](docs/cli.md) | **User manual: command line.** Every command, grouping hints, configuration. |
| [docs/agents.md](docs/agents.md) | **Working with AI agents.** Connecting Claude and Codex, prompting, the agent's tools, archiving, protections. |
| [SECURITY.md](SECURITY.md) | Security model, known limitations, reporting problems. |
| [docs/spec.md](docs/spec.md) | Design specification and development notes (per milestone). |
| [docs/live-tests.md](docs/live-tests.md) | Hands-on test plans and their status. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, tests, packaging. |
| [CHANGELOG.md](CHANGELOG.md) | Release history. |

## Status

Version 0.19.0. Milestones M1–M3 and M5 are done:
- **M1:** core library and CLI.
- **M2:** MCP server and guardrails.
- **M3:** VS Code extension.
- **M5:** PDF previews of a change (LaTeX).

**Tested:**
- live with the Claude desktop app;
- hands-on in VS Code;
- by about 630 automated tests, which CI runs on Windows, macOS and Linux with Node.js 22, 24 and 26, and the VS Code integration test (59 checks in real VS Code, run by hand).

**Still to do:** live runs with the Claude Code CLI and with Codex ([docs/live-tests.md](docs/live-tests.md)).

**Not there yet:**
- PDF previews for Typst;
- Hayagriva (`.yml`) bibliographies in Typst projects;
- **M4:** Overleaf pull/push helpers;
- **M6:** a web UI.

On native Windows the guard is a heuristic ([SECURITY.md](SECURITY.md)).

## Compatibility

From 1.0, Stet follows [semantic versioning](https://semver.org). Within 1.x, these keep working as they are; something is removed or changed only in 2.0:
- the `stet` commands, their options, exit codes and `--json` output;
- the MCP tools' names and arguments;
- the keys of `.git/stet/config.json`;
- the VS Code extension's settings and command ids;
- the data in `.git/stet/`: a newer 1.x reads what an older one wrote. If a newer Stet ever has to change that format in a way older versions can't read, an older Stet refuses to write to it and says to update, instead of damaging it.

New commands, options, tools, settings and fields can come in any 1.x. Not covered: the wording of messages and of the agents' instructions, and `@stet/core`, which is internal to Stet's own packages.

## License

[MIT](LICENSE)
