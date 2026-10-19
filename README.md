# Stet

*stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

**Stet lets AI agents propose changes to your LaTeX project while you stay in control.**
- The agents (Claude, Codex, …) work in their own copy of the project.
- Their edits reach you as small, reviewable changes.
- You accept, reject, edit or discuss each one, from VS Code or the command line.
- Nothing touches your files until you accept it.

```
claude-1                      3 pending
└─ Polish the introduction    C2 · 3 pending
   ├─ 🔗 Rename sec:intro → sec:introduction    linked · 2
   │  ├─ S7  “\label{sec:intro}” → “\label{sec:introduction}”   main.tex:3
   │  └─ S9  “\ref{sec:intro}” → “\ref{sec:introduction}”       main.tex:12
   └─ S8  “problem” → “task”                                     main.tex:4
```

## Features

- **Reviewable changes:**
  - Agent edits are split into word- and sentence-level changes that understand LaTeX: math, labels and citations stay intact, and re-wrapped lines are ignored.
  - Changes that belong together are grouped. *Linked* groups, such as a label and its references, are all-or-nothing.
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

1. Open your LaTeX project folder in VS Code, then open the **Stet** view in the activity bar and click **Set up project**.
2. Click **New agent workspace**, pick Claude or Codex, and open the workspace folder in that agent.
3. Ask the agent to improve the paper. Its proposals appear in the Stet panel and inline in your `.tex` files. Keys: `a` accept, `r` reject, `e` edit, `v` revise, `c` comment, `j`/`k` next/previous.
4. Click **Finish review** to commit everything you accepted in one commit.

→ [VS Code user manual](docs/vscode.md)

### Command line

Requirements: Node.js ≥ 20 and git ≥ 2.28.

```bash
npm install && npm run build
cd packages/cli && npm link           # puts `stet` on your PATH
```

In your LaTeX project (a git repository with at least one commit):

```bash
stet init                             # set up Stet (and git hooks)
stet agent new claude-1               # prints the agent's workspace folder: open it in your agent
stet review                           # what the agent proposed
stet accept S3 S4                     # or a whole group: stet accept G1
stet reject S5 -m "keep the original formula"
stet commit -m "Polish the introduction"
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

Version 0.4.1. Milestones M1–M3 are done:
- **M1:** core library and CLI.
- **M2:** MCP server and guardrails.
- **M3:** VS Code extension.

**Tested:**
- live with the Claude desktop app;
- hands-on in VS Code;
- by automated tests (about 130), run on Windows so far; the CI workflow runs them on Windows, macOS and Linux with Node.js 22 and 24, and checks that Stet runs on Node.js 20.

**Still to do:** live runs with the Claude Code CLI and with Codex ([docs/live-tests.md](docs/live-tests.md)).

**Planned:**
- **M4:** Overleaf pull/push helpers.
- **M5:** PDF previews of a change.
- **M6:** a web UI.

## License

[MIT](LICENSE)
