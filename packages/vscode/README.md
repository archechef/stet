# Stet: review AI edits to your LaTeX project

*stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

**Let AI agents (Claude, Codex, …) propose changes to your paper, and decide on each one yourself.**

- Agents work in their **own copy** of your project. They never touch your files.
- Their edits reach you as **small, reviewable changes**, split along words and sentences, and aware of LaTeX: math, labels and citations stay intact.
- You **accept, reject, edit, request a revision or comment**, right in the editor or from the Stet panel.
- Your decisions, reasons and comments go **back to the agent automatically**. It learns your style and revises.
- Accepted changes become **one git commit** when you finish the review.

> **Preview.** Stet is new. It has been tested with the Claude desktop app and in VS Code. Live tests with the Claude Code command line and with Codex are still to come. Feedback is welcome.

---

## Getting started

**You need:** VS Code 1.100 or newer, and git 2.28 or newer (on Windows: *Git for Windows*). Node.js is optional; the extension brings everything else.

1. **Open your LaTeX project folder** in VS Code and click the **Stet** icon in the activity bar.
2. Click **Set up project**. If the folder isn't a git repository yet, Stet offers to create one and commit your files as the starting point.
3. Click **New agent workspace**, choose Claude or Codex, and open the folder Stet creates in your agent:
   - **Claude desktop app:** Code tab → choose the folder.
   - **Claude Code / Codex (command line):** `cd` into the folder and start the agent.
   - **Agents inside VS Code** (e.g. the Codex extension): **Open in new VS Code window**.

   The folder already contains the agent's instructions, the Stet tools (MCP server) and guardrails. No further setup is needed.
4. **Ask the agent** to improve the paper as usual, e.g. *"Tighten the introduction."* It edits its copy and submits the result for review by itself.
5. **Review** the proposals as they appear (below).
6. Click **Finish review** to commit everything you accepted, in one commit.

Everything Stet stores lives in `.git/stet/`. It is never committed or pushed, so Overleaf (git integration) and your co-authors don't see it.

---

## Reviewing

**The Stet panel** lists the proposals by agent → changeset (one submission, with the agent's rationale) → group → change:

```
claude-1                      3 pending
└─ Polish the introduction    C2 · 3 pending
   ├─ 🔗 Rename sec:intro → sec:introduction    linked · 2
   │  ├─ S7  "\label{sec:intro}" → "\label{sec:introduction}"   main.tex:3
   │  └─ S9  "\ref{sec:intro}" → "\ref{sec:introduction}"       main.tex:12
   └─ S8  "problem" → "task"                                     main.tex:4
```

- 🔗 **Linked** groups must be accepted together, such as a label and its references, because accepting only part would break the document.
- ▣ **Related** groups share a theme and can be accepted or rejected in one go.

**In the editor**, each proposed change appears in place:
- the old text is struck through and the new text follows in grey;
- longer new text is shown in full in a panel directly below the change;
- actions sit above each change: **✓ Accept · ✗ Reject · ✎ Edit · ↻ Revise · 💬 Comment**;
- hovering shows the agent's rationale, the diff and the conversation.

You can keep writing while changes are pending: Stet finds each change again in your current text.

| Action | Key in the panel | What happens |
|---|---|---|
| **Accept** | `a` | Applies the change to your file. |
| **Reject** | `r` | With an optional reason. The agent gets it and won't propose the same change again. |
| **Edit and accept** | `e` | Change the wording first. The agent sees your version and adapts to your style. |
| **Request revision** | `v` | Tell the agent what to change; it resubmits. |
| **Comment** | `c` | A message about the change; the agent can reply. |
| **Show diff** | `d` | Side-by-side diff of your file with this change. |
| **Accept all / Reject all** | `Shift+A` / `Shift+R` | The whole group or changeset. |
| **Next / previous change** | `j` / `k` | Moves through the proposals and shows each one in the editor. |

**Conversations** appear as comment threads on the change and in the **Comments** view. Type in a thread and click **Send to agent** to answer.

**Finish review** (commit icon in the panel title) makes one commit for everything you accepted. The summary line is prefilled with the titles of the agent's changesets, and you can edit it.

---

## What agents see

- **Changes you accept** always reach the agents. They move onto your latest text the next time they sync, and rejected changes disappear from their copy.
- **Your own edits** reach them when you click **Share my edits with agents** (cloud icon in the panel title or status bar). You don't need to commit first. The setting `stet.shareEdits` can instead share every save (`saved`) or only commits (`committed`).
- **Several agents** can work in parallel, each in its own workspace. If two change the same text, accepting one makes the other *stale*, and that agent is told.

When a task is done, right-click the agent → **Archive agent**. Its pending proposals are withdrawn, and the agent is told on its next action.

---

## Safety

- Agents can write only their own workspace folder. Your project, its `.git` folder and Stet's data are read-only to them.
- Stet checks everything an agent submits before using it, and an accept is all-or-nothing.
- Git hooks in your project stop agent branches from being merged or pushed by accident. Existing hooks keep working.
- On macOS, Linux and WSL2, the agent tool's sandbox enforces the boundaries. On native Windows, Claude Code has no sandbox: a guard hook blocks edits and commands aimed at your project, which reliably catches mistakes but not a deliberately evasive agent (for example one following instructions hidden in a source document). For untrusted material, run the agent in WSL2.
- Stet runs only in folders you trust (it is disabled in VS Code's Restricted Mode).

---

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `stet.shareEdits` | `manual` | Which of your own edits agents see: `manual` (when you click *Share my edits*), `saved` (every save), `committed` (only commits). |
| `stet.longChanges` | `expanded` | How long proposals are shown: in full in an open panel under the change (`expanded`), the same panel closed (`collapsed`), or only on hover (`hover`). |
| `stet.inlineChanges` | `true` | Strike-through and grey new text in the editor. |
| `stet.codeLens` | `true` | Actions above each proposed change. |
| `stet.runtime` | `auto` | What runs the Stet server for the agents: Node.js 20 or newer if installed, otherwise VS Code's own runtime. `node` or `vscode` forces one. |

---

## Troubleshooting

Run **Stet: Check setup (doctor)** first. It checks git, the hooks and the agent workspaces, and prints fixes in the **Stet** output channel.

| Symptom | Fix |
|---|---|
| The panel says "Stet is not set up" | Run **Set up project**. If you opened a sub-folder of the repository, open the repository root instead. |
| The panel stays empty, VS Code shows *Restricted Mode* | Choose *Trust* in the Restricted Mode banner. |
| An agent can't find the Stet tools | Start a new agent session in the workspace folder. Sessions started before a Stet update keep the old server until they restart. |
| "Your project folder is on '…', not 'main'" | Switch your project back to its main branch before accepting. |
| A change "is no longer where it was" | Its text changed in the meantime. Reject it or request a revision. |
| A commit or push of an agent branch is refused | That is the git hooks protecting your review. Accept the changes through Stet instead. |

---

## License

MIT. © 2026 Noah Tittelbach.
