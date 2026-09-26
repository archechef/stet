# Stet for VS Code

Review AI-proposed changes to your LaTeX project, one change at a time. Agents (Claude, Codex, …) work in their own workspace folder and never touch your files; a change reaches your document only when you accept it.

- **Stet panel** (activity bar): agent → changeset → group → change. Keys: `a` accept, `r` reject, `e` edit and accept, `v` request revision, `c` comment, `d` diff, `A`/`R` accept/reject the whole group, `j`/`k` move.
- **In the editor:** proposed changes inline (old text struck through, new text as ghost text), actions above each change, details on hover.
- **Threads:** comment on a change and read the agent's replies in the Comments view.
- **Setup without a command line:** *Stet: Set up project*, *Stet: New agent workspace*. Then open the workspace folder in the Claude desktop app, Claude Code or Codex.

The full user guide is `docs/vscode.md` in the Stet repository; the design is in `docs/spec.md`.
