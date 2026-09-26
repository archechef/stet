# Stet for VS Code — user guide

The Stet extension lets you review AI-proposed changes to a LaTeX project entirely from VS Code. AI agents (Claude, Codex, …) work in their own *agent workspace* folder and never touch your files. Each change they propose appears in VS Code, and it reaches your document only when you accept it.

You don't need the command line or Node.js for any of this.

---

## 1. Installation

The extension is not on the Marketplace yet. It is distributed as a single file, `stet-vscode.vsix`.

- **In VS Code:** Extensions view → `…` menu → **Install from VSIX…** → choose `stet-vscode.vsix`.
- **From a terminal:** `code --install-extension stet-vscode.vsix`

**Requirements:**
- VS Code 1.100 or newer
- git 2.28 or newer (on Windows: *Git for Windows*, which Claude Code needs anyway)

Node.js is optional (see [§8](#8-settings)).

**Building the `.vsix` yourself** (in the Stet repository):

```bash
npm install
npm run build
npm run package:vscode      # → packages/vscode/stet-vscode.vsix
```

---

## 2. Setting up a project

1. Open the folder of your LaTeX project in VS Code.
2. Click the **Stet** icon in the activity bar. It looks like a page with a tick.
3. Click **Set up project**.
   - If the folder is not a git repository yet, Stet offers to create one and commit your current files as a starting point.
   - If the repository has no commits yet, Stet offers to commit the current files. Stet reviews every change against your last commit.
   - Stet also installs git hooks that stop agent branches from being merged or pushed by accident. Existing hooks are kept and still run.
4. Stet then offers to create the first agent workspace.

Everything Stet stores lives in `.git/stet/` of your repository. It is never committed or pushed, so Overleaf and your co-authors don't see it.

**Overleaf:** clone the project with Overleaf's git integration and open that clone in VS Code. Nothing else is needed.

---

## 3. Agent workspaces

Every AI session works in its own workspace: a separate folder next to your project, `<project>.stet/<name>/`, on its own git branch `stet/<name>`.

**Creating one:** **Stet: New agent workspace** (the `+` in the panel title).
1. Choose which agent will work there: Claude, Codex or Other.
2. Accept or change the suggested name (`claude-1`, `codex-1`, …).
3. Choose what to do with the folder:
   - **Copy folder path**, then open that folder in your agent:
     - *Claude desktop app:* Code tab → choose the folder.
     - *Claude Code / Codex CLI:* `cd` into it and start the agent.
   - **Reveal in file manager.**
   - **Open in new VS Code window:** for agents that run inside VS Code, such as the Codex or Claude Code extensions.

**What the workspace already contains:**
- the agent's instructions (`CLAUDE.local.md`, `AGENTS.override.md`);
- the Stet tools for the agent (`.mcp.json`, `.codex/config.toml`);
- guardrails (`.claude/settings.json`), which block edits outside the workspace and git commands that would bypass your review.

The agent needs no further setup. The first time it opens the folder, Claude asks you once to trust it.

**Working with the agent:** ask it to improve the paper as usual, for example "Tighten the introduction". It edits its own copy and submits the result for review by itself. Several agents can work in parallel, each in its own workspace.

**Right-click an agent in the panel** to open its workspace again, copy its path, or **Archive** it. Archiving withdraws its pending changes and can also delete the folder and its branch. Close the agent's session first.

---

## 4. Reviewing

### 4.1 The Stet panel

```
claude-1                      3 pending
└─ Polish the introduction    C2 · 3 pending
   ├─ 🔗 Rename sec:intro → sec:introduction    linked · 2
   │  ├─ S7  “\label{sec:intro}” → “\label{sec:introduction}”   main.tex:3
   │  └─ S9  “\ref{sec:intro}” → “\ref{sec:introduction}”       main.tex:12
   └─ S8  “problem” → “task”                                     main.tex:4
```

The panel is a tree: **agent → changeset → group → change.**

- **Changeset:** one submission by the agent, with its title and rationale. Hover it to read the rationale.
- **Group:**
  - 🔗 **linked:** changes that must be accepted together, such as a label and its references. Accepting only some of them could break the document.
  - ▣ **related:** changes on the same theme, which you can accept or reject in one go.
  - The tag *auto* means Stet detected the group itself. *broken* means the group was resolved inconsistently, and the agent has been asked to repair the document.
- **Change** (`S<n>`): a single edit, located at `file:line` in your current text.
  - Icons show its status: pending, *revision requested*, accepted, rejected, stale.
  - Selecting a change shows it in the editor.

**Other parts of the window:**
- The number on the Stet icon and in the status bar counts the changes waiting for you.
- The status bar also shows how many accepted changes are not committed yet, and a sync icon while an agent is working on an older version of your text. The agent catches up by itself.

**Panel title buttons:**
- **Finish review** (only shown when there is something to commit)
- **New agent workspace**
- **Show/Hide resolved items**
- **Refresh**
- `…` menu: **Check setup**, **Set up project**

### 4.2 In the editor

Open a `.tex` file with pending changes:

- the **old text is struck through**, and the **new text follows in grey italics**;
- above each change is a row of actions: **S8: ✓ Accept · ✗ Reject · ✎ Edit · ↻ Revise · 💬 Comment**. For a member of a linked group, *Accept* reads **✓ Accept all n linked**;
- **hovering** a change shows the agent, the changeset and its rationale, the groups, the diff, the latest thread messages, and the same actions.

You can keep typing in the file while changes are pending. Stet finds each change again in your current text, including unsaved edits.

### 4.3 Actions

| Action | Key in the panel | What happens |
|---|---|---|
| **Accept** | `a` | Applies the change to your file and commits it (`stet: accept S8 — <changeset title>`). |
| **Reject…** | `r` | Asks for an optional reason. The agent gets the reason and won't propose the same change again. |
| **Edit and accept…** | `e` | Lets you change the wording first, then accepts it. The agent sees your version and adapts to your style. Short changes are edited in an input box; multi-line ones in a separate tab, where you then choose *Accept edited*. |
| **Request revision…** | `v` | Tells the agent what to change. The change stays open until the agent resubmits it. |
| **Comment…** | `c` | Sends a message about the change; the agent can reply. |
| **Show diff** | `d` | Opens a side-by-side diff of your current file and the file with this change. File additions, deletions and renames are shown this way too. |
| **Accept all** | `Shift+A` | Accepts the whole group. On a changeset, it accepts the whole changeset, after asking. |
| **Reject all…** | `Shift+R` | Rejects the whole group or changeset with one reason. |
| **Dissolve group** | (context menu) | Removes a group, for example a wrong automatic one. The changes themselves stay. |
| Move | `j` / `k`, arrow keys | Moves through the panel. |

**Linked changes:**
- Accepting or rejecting one member of a linked group asks what to do with the rest:
  - *Accept all linked changes*, or *Accept only this one*, which breaks the group.
  - *Reject all*, *Reject this one and ask the agent to revise the rest*, or *Reject only this one*.
- Accepting a linked group is all-or-nothing: if any member can't be applied, nothing is applied.

**When a change is not committed automatically:** if the file has your own uncommitted edits (including unsaved ones, which Stet saves first), the change is applied but not committed. Stet won't mix your work into its commit on its own. Once you're done, click **Finish review**: it commits all such files as they are now, including your edits in them.

**Stale changes:** a change becomes *stale* when:
- its text was rewritten in the meantime, by you or by accepting another agent's overlapping change, so it no longer applies; or
- it overlaps a change you accepted.

The agent is told and can propose it again against the current text.

### 4.4 Threads

Comments and revision requests appear as threads on the change, in the editor and in the **Comments** view (the panel area at the bottom). Agent replies show up there too.

- To answer, type in the thread and click **Send to agent**.
- To start a new thread, use **💬 Comment**, or the `+` in the gutter on a line that has a pending change.

---

## 5. Keeping in sync

- The panel updates by itself when an agent submits, replies or withdraws something.
- **Agents catch up themselves:** when you accept changes or edit the document, an agent's workspace falls behind. It catches up with your latest text when it next calls `stet_sync`, which its instructions tell it to do before new work.
- **Rejected changes disappear** from the agent's copy at the same time.

---

## 6. Other agents, other editors

- **Codex in VS Code:** open the agent workspace in a new VS Code window (**Open in new VS Code window**) and use the Codex extension there. Stet itself is only active in your project window. It deliberately ignores agent workspaces, so the agent's window shows no review panel.
- **Reviewing from the command line:** the review commands work just as well in a terminal (`stet review`, `stet accept S8`, …; see the main README). The extension and the command line share the same data and see each other's actions immediately.

---

## 7. Troubleshooting

Run **Stet: Check setup (doctor)** first. It checks git, the hooks, the agent workspaces and their configuration, and prints fixes in the **Stet** output channel.

| Symptom | Cause and fix |
|---|---|
| Panel says "Stet is not set up" | Run **Set up project**. If the folder you opened is a sub-folder of the repository, open the repository root instead. |
| An agent can't find the Stet tools | Start a new agent session in the workspace folder. A session started before a Stet update keeps using the old server until it restarts. |
| "Your project folder is on '…', not 'master'" | Switch your project back to the main branch before accepting. |
| A change can't be located ("no longer where it was") | Its text changed under it. Reject it or ask for a revision. The agent is told when a change goes stale. |
| A commit or push of an agent branch is refused | That's the git hooks protecting your review. Accept the changes through Stet instead. |

---

## 8. Settings

| Setting | Default | Meaning |
|---|---|---|
| `stet.codeLens` | `true` | Actions above each proposed change. |
| `stet.inlineChanges` | `true` | Strike-through and ghost text in the editor. |
| `stet.runtime` | `auto` | What runs the Stet server for the agents. `auto`: Node.js ≥ 20 if installed, otherwise VS Code's own runtime. `node` or `vscode` to force one. |

**How the agents reach Stet:**
- The extension brings its own copy of the `stet` program and places it in `.git/stet/bin/stet.mjs`. That path stays valid across extension updates.
- The agent workspaces point there. When that changes (after an update, or after switching `stet.runtime`), the extension rewrites the workspaces' configuration.
- If you installed the `stet` command-line tool yourself and ran `stet init`, the extension leaves that configuration alone.

---

## 9. For developers

- **Source:** `packages/vscode/src`
  - `extension.ts`: panel, commands, setup
  - `editor.ts`: decorations, CodeLens, hovers, diff documents
  - `comments.ts`: threads
  - `project.ts`: store access, live updates
  - `runtime.ts`: bundled CLI and runtime choice
  - `model.ts`: view model, free of `vscode`, unit-tested
- **Build:** `npm run build` (the TypeScript type check plus esbuild bundles `dist/extension.js` and `dist/stet.mjs`).
- **Tests:**
  - `npm test` for the unit tests.
  - `npm run test:integration -w stet-vscode` starts your installed VS Code with a throwaway profile against a fixture project, once with each runtime. A VS Code window appears briefly. It is not part of CI.
- **Design:** see [spec.md](spec.md) §12.2 and the M3 notes in §16.
