# Stet: review AI edits to your LaTeX project

*stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

**Let AI agents (Claude, Codex, …) propose changes to your paper, and decide on each one yourself.**

- Agents work in their **own copy** of your project. They never touch your files.
- Their edits reach you as **small, reviewable changes**, split along words and sentences, and aware of LaTeX: math, labels and citations stay intact.
- You **accept, reject, edit, ask for a revision or comment**, right where the change is in your file, and see it **in the compiled PDF**.
- Your decisions, reasons and comments go **back to the agent**. It learns your style and revises.
- Everything you accept becomes **one git commit** when you finish the review.

> **Preview.** Stet is new. It has been tested with the Claude desktop app and in VS Code. Live tests with the Claude Code command line and with Codex are still to come. Feedback is welcome.

---

## Getting started

**You need** VS Code 1.100 or newer and git 2.28 or newer (on Windows: *Git for Windows*). Node.js is optional. PDF previews need [Podman](https://podman.io) (see below); everything else works without it.

1. **Open your LaTeX project folder** and click the **Stet** icon in the activity bar.
2. Click **Set up project**. If the folder isn't a git repository yet, Stet offers to make it one.
3. Click **New agent workspace**, choose Claude or Codex, and open the folder Stet creates in your agent:
   - **Claude desktop app:** Code tab → choose the folder.
   - **Claude Code / Codex (command line):** `cd` into the folder and start the agent.
   - **Agents inside VS Code** (e.g. the Codex extension): **Open in new VS Code window**.

   The folder already has the agent's instructions, the Stet tools (an MCP server) and guardrails.
4. **Ask the agent** as usual, e.g. *"Tighten the introduction."* It edits its copy and submits the result for review by itself.
5. **Review** each change as it appears (below).
6. Click **Finish review** to commit what you accepted.

Stet keeps its data in `.git/stet/`. It is never committed or pushed, so Overleaf's git integration and your co-authors don't see it.

---

## Reviewing a change

Each change is shown in your file: the old text struck through in red, the new text in green right where it goes. Only what actually differs is marked, even inside a long formula. You can keep writing; Stet finds each change again in your current text.

**Every change has the same actions, under the same names, wherever you meet it:**

| Where | What you get |
|---|---|
| Above the change | **Accept · Reject… · More…** |
| Hover over it (or the word next to it) | its rationale, the diff, the conversation, the PDF preview, and every action |
| **Ctrl+.** (Cmd+. on macOS) in the change | every action, in VS Code's Quick Fix menu |
| **More…** | every action, with its key and what it does |
| The Stet panel | buttons on each row, every action on right-click, and one key per action |

| Action | Key | What happens |
|---|---|---|
| **Accept** | `a` | Applies the change to your file. Linked changes are accepted together (*Accept all 3 linked*). |
| **Reject…** | `r` | With an optional reason. The agent won't propose it again. |
| **Edit & accept…** | `e` | Change the wording, then accept it. The agent sees your version and adapts. |
| **Revise…** | `v` | Tell the agent what to change; it resubmits. |
| **Comment…** | `c` | A message about the change; the agent can reply. |
| **Diff** | `d` | Your file with and without the change, side by side; editable like Review file. |
| **PDF preview** | `p` | The compiled page with the change, after and before. |
| **Review file** | `f` | All pending changes of the file in one editable diff. |
| **Undo** | `u` | A decided change is pending again. |
| **More…** | `.` | Every action on the change. |
| **Next / previous** | `j` / `k` | Moves through the changes and shows each in the editor. |

After each decision Stet moves on to the next change, so a review takes one key per change.

**Review file** shows your file next to the same file with all its pending changes applied, with real line breaks. Type in the right side to reword proposals: saving keeps your wording, and the changes stay pending until you accept them. Each change has the same actions there as in your file (the buttons above it, its hover, Ctrl+.). **Diff** opens the same view for one change.

**Groups.** 🔗 *Linked* changes must go together, like a label and its references; large linked groups come in parts you can accept one at a time. ▣ *Related* changes share a theme and can be decided in one go (`Shift+A` / `Shift+R`).

**Moves.** A moved paragraph is shown as a move, not as a deletion plus an insertion: *moved here from line 40, word for word*, or *with 1 word changed*.

**History.** Decided changes move to the **History** view, by round. Click one to see what was accepted. **Undo** works on a rejection at any time, and on an accept until you finish the review.

---

## PDF previews

**PDF preview** opens a panel with the whole page where the change lands, opened at it, the changed words highlighted. **After | Before** flips between the versions. Zoom and drag like a PDF viewer (Ctrl/Cmd + wheel, double-click). The hover shows the changed region too.

Previews compile the agent's text in an isolated [Podman](https://podman.io) container without network access, because LaTeX can read any file you can and put it into the PDF. The first time, Stet offers to set it up; it never downloads anything without your click. On macOS, and on Linux without a standalone TeX Live, the container brings its own TeX Live (about 1 GB). If a package is missing, Stet names it and offers TeX's extra fonts.

---

## Agents

- **What they see:** changes you accept always reach them. Your own edits reach them when you click **Share my edits** (cloud icon), or on every save if you choose so.
- **Notifications:** an agent waiting with `stet watch` is woken when something arrives for it. Click the bell next to the agent to choose when (right away, or when you pause) and for what (accepts, rejections, comments, notes, …). The megaphone there wakes it at once.
- **Notes:** select a passage, right-click → **Note for agent…**, and ask for something the agent hasn't touched yet ("shorten this paragraph").
- **Several agents** can work in parallel, each in its own workspace. When a task is done, right-click the agent → **Archive agent**.

---

## View options

The gear in the Stet panel holds everything you may want to switch while you work, with a checkmark at the current choice: changes inline, the actions above changes, moving to the next change after deciding, how new text is drawn with word wrap, how long changes are shown, which of your edits agents see, and where PDF previews appear. They are ordinary settings (`stet.*`), so the Settings editor shows the same values.

| Setting | Default | Meaning |
|---|---|---|
| `stet.inlineChanges` | `true` | Show changes in the editor. |
| `stet.codeLens` | `true` | Actions above each change. |
| `stet.autoAdvance` | `true` | After a decision, move on to the next change. |
| `stet.newTextStyle` | `auto` | New text `highlighted` (green, doesn't wrap), `wrapping` (wraps with the line), or by the word wrap setting. |
| `stet.longChanges` | `collapsed` | Long proposals in a panel under the change, opened from the gutter (`collapsed`), open (`expanded`), or only on hover (`hover`). |
| `stet.shareEdits` | `manual` | Which of your edits agents see: when you share them (`manual`), every save (`saved`), or only commits (`committed`). |
| `stet.pdfPreviews` | `both` | Previews in the hover and the panel, in one of them, or `off`. |
| `stet.runtime` | `auto` | What runs the agents' Stet server: Node.js 20+ if installed, else VS Code's own runtime. |

---

## Safety

- Agents can write only their own workspace. Your project, its `.git` folder and Stet's data are read-only to them.
- Stet checks everything an agent submits before using it, and an accept is all-or-nothing.
- Git hooks stop agent branches from being merged or pushed by accident. Your existing hooks keep working.
- On macOS, Linux and WSL2, the agent tool's sandbox enforces these limits. On native Windows, Claude Code has no sandbox: a guard hook catches mistakes, but not a deliberately evasive agent (one following instructions hidden in a source document, say). For untrusted material, use WSL2.
- Stet runs only in folders you trust (it is off in VS Code's Restricted Mode).

---

## Troubleshooting

Run **Stet: Check setup** (Stet panel → `…`) first. It checks git, the hooks and the agent workspaces, and prints fixes in the **Stet** output channel.

| Symptom | Fix |
|---|---|
| The panel says "Stet is not set up" | Run **Set up project**. If you opened a sub-folder of the repository, open its root instead. |
| The panel stays empty, VS Code shows *Restricted Mode* | Choose *Trust* in the Restricted Mode banner. |
| An agent can't find the Stet tools | Start a new agent session in the workspace folder. Sessions started before a Stet update keep the old server until they restart. |
| "Your project folder is on '…', not 'main'" | Switch your project back to its main branch before accepting. |
| A change "is no longer where it was" | Its text changed in the meantime. Reject it or ask for a revision. |
| No PDF preview | The preview panel says why: Podman missing, its machine not running (macOS), or a LaTeX error. **Set up PDF previews** (panel → `…`) sets it up. |
| A commit or push of an agent branch is refused | That's the git hooks protecting your review. Accept the changes through Stet instead. |

---

## License

MIT. © 2026 Noah Tittelbach.
