# Stet

*stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

Stet lets AI agents (Claude Code, Codex, …) propose changes to a LaTeX project while you review them one by one. Agents work in their own git worktree and never touch your files; a change reaches your document only when you accept it. See [docs/spec.md](docs/spec.md) for the design.

**Status:** M1 (core + command-line tool), M2 (MCP server for agents, guardrails) and M3 (VS Code extension) are implemented. Live-tested with the Claude desktop app; Claude Code CLI and Codex are covered by automated tests only so far (their live runs are still to do, see spec §16/§17). The VS Code extension passes an automated run in real VS Code; its panel and dialogs still need a hands-on test. The plans for all pending live tests are in [docs/live-tests.md](docs/live-tests.md).

**Security:** agents can write only their own workspace folder; your project, its `.git` folder and Stet's data are read-only to them, and Stet checks everything they hand over before using it. On macOS, Linux and WSL2 the agent tools' sandbox enforces this. On native Windows, Claude Code has no sandbox, so a guard hook is the only barrier for shell commands: it reliably catches mistakes, but a deliberately evasive agent (e.g. one steered by instructions hidden in a source document) can get around it. For untrusted material, run the agent in WSL2. Details: spec §9.

## VS Code (no command line needed)

Build the extension package and install it:

```bash
npm install
npm run build
npm run package:vscode
code --install-extension packages/vscode/stet-vscode.vsix
```

(or in VS Code: Extensions view → `…` → *Install from VSIX…* → `packages/vscode/stet-vscode.vsix`). Share the `.vsix` with coworkers; they need neither Node.js nor this repository.

1. Open your LaTeX project folder in VS Code, open the **Stet** view in the activity bar and click **Set up project** (creates a git repository first if there is none).
2. **New agent workspace** → pick Claude or Codex → copy the folder path and open that folder in the Claude desktop app (Code tab), Claude Code or Codex.
3. Ask the agent to improve the paper. Its proposals appear in the Stet panel and inline in your `.tex` files: accept (`a`), reject (`r`), edit (`e`), request a revision (`v`), comment (`c`), diff (`d`); `A`/`R` for the whole group. CodeLens actions above each change and hovers do the same.
4. Accepting only writes your files. **Finish review** (commit icon) commits the whole review in one commit; you can edit the summary line.

Full guide: [docs/vscode.md](docs/vscode.md). The extension brings its own copy of `stet` for the agents (in `.git/stet/bin/`), run with Node.js if installed, otherwise with VS Code's own runtime (setting `stet.runtime`).

## Command line

Requirements: Node.js ≥ 20 and git ≥ 2.28.

```bash
npm install
npm run build
cd packages/cli && npm link # optional: puts `stet` on your PATH
```

Without `npm link`, run `node <path-to-repo>/packages/cli/dist/index.js` wherever `stet` appears below.

In your LaTeX project (a git repository with at least one commit):

```bash
stet init                   # also installs git hooks that stop agent branches from being merged or pushed
stet agent new claude-1     # prints the agent's workspace folder (use --kind codex for Codex)
```

Open the printed folder in the Claude desktop app (Code tab), Claude Code or Codex. The workspace already contains:

- the agent's instructions (`CLAUDE.local.md`, `AGENTS.override.md`),
- the Stet MCP server config (`.mcp.json`, `.codex/config.toml`), giving the agent tools like `stet_submit` and `stet_get_feedback`,
- guardrails (`.claude/settings.json`): a hook that blocks edits outside the workspace and git commands that would bypass review.

The workspace's MCP server is pre-approved, so Claude Code only asks you to trust the folder. Optionally register it for all workspaces with `stet setup claude` / `stet setup codex`.

Ask the agent to improve the paper; it submits its edits for review itself. (Without MCP, it can run `stet submit -t "Polish the introduction" -m "Shorter sentences"` in the workspace.)

Back in your project folder:

```bash
stet review                 # pending items, grouped by agent → changeset → group
stet show S3                # an item with its context
stet accept S3 S4           # or a whole group: stet accept G1
stet reject S5 -m "keep the original formula"
stet revise S6 -m "shorter, please"
stet commit -m "Polish intro" # finish the review: one commit for everything accepted
```

The agent picks up your decisions with `stet_get_feedback` (or `stet feedback`) and moves onto your latest text with `stet_sync`. Run `stet doctor` if anything looks off, and `stet --help` for all commands.

## Development

```bash
npm run build     # tsc for packages/core and packages/cli
npm test          # vitest: unit tests + end-to-end tests on temporary git repos
```

- `packages/core` (`@stet/core`): store, git plumbing, LaTeX-aware splitting, anchoring, the review service, MCP server, guard, git hooks, workspace files, doctor.
- `packages/cli` (`stet-tex`): the `stet` command.
- `packages/vscode` (`stet-vscode`): the VS Code extension (bundled with esbuild; `npm run package:vscode` builds the `.vsix`). `npm run test:integration -w stet-vscode` starts your installed VS Code with a throwaway profile and runs the integration checks.
