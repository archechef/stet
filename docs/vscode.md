# Stet for VS Code — user guide

The Stet extension lets you review AI-proposed changes to a LaTeX project entirely from VS Code. AI agents (Claude, Codex, …) work in their own *agent workspace* folder and never touch your files. Each change they propose appears in VS Code, and it reaches your document only when you accept it.

You don't need the command line or Node.js for any of this.

---

## 1. Installation

- **From the Marketplace:** search for **Stet** (publisher *archechef*) in VS Code's Extensions view and click **Install**.
- **From a file:** download `stet-vscode-<version>.vsix` from the repository's Releases page, then Extensions view → `…` menu → **Install from VSIX…**, or `code --install-extension stet-vscode-<version>.vsix`.

**Requirements:**
- VS Code 1.100 or newer
- git 2.28 or newer (on Windows: *Git for Windows*, which Claude Code needs anyway)

Node.js is optional (see [§9](#9-settings)).

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

**Notifications** (the bell next to the agent): an agent that waits for you with `stet watch` is woken when something arrives for it. The bell opens one checklist:
- **When**, one of two: **When I pause** (the default: once you have stopped for half a minute, with all your decisions together, not after every click) or **Right away** (at each decision, comment or note).
- **Wake it for:** the kinds of news that should wake it: accepted changes, rejected changes, revision requests, comments and replies, new notes, commits and shared edits, and saves (when agents see your saved edits). News left out doesn't wake the agent, but it still finds it when it next checks, and it arrives if you tick that kind again.
- Untick every kind to turn notifications **off** (the bell is crossed out).

**Notify now** (the megaphone next to the agent): wakes the agent at once, whatever the settings above, with an optional message such as *I've finished reviewing round 3*.

A woken agent starts working without you prompting it, so *Off* is also the way to keep it waiting for you.

**Right-click an agent in the panel** to open its workspace again, copy its path, set its notifications, or **Archive** it. Archiving withdraws its pending changes and can also delete the folder and its branch. Stet shows what it did, and an agent session that is still open is told on its next action that its workspace was archived (and asked to stop); you can then close that session.

More on how agents work with Stet, per tool: [agents.md](agents.md).

---

## 4. Reviewing

### 4.1 The Stet panel

```
claude-1                                       3 pending
└─ Round 2: Polish the introduction            3 pending
   ├─ 🔗 Rename sec:intro → sec:introduction    linked · 2
   │  ├─ 1  “\label{sec:intro}” → “\label{sec:introduction}”   main.tex:3
   │  └─ 3  “\ref{sec:intro}” → “\ref{sec:introduction}”       main.tex:12
   └─ 2  “problem” → “task”                                     main.tex:4
```

The panel is a tree: **agent → round → group → change.** It shows only what is still open; decided changes move to the **History** view (below).

**Numbering:** each submission of an agent is a **round**, numbered in the order they arrive. Changes are numbered within their round, so change 3 of round 12 is `12.3`. The panel shows the round number on the round and just the number on each change; the full id appears in the editor's actions, hovers and messages, and is what the agent and the command line use. Changes from before this numbering keep their old ids (`S412`).

- **Round:** one submission by the agent, with its title and rationale. Hover it to read the rationale.
- **Group:**
  - 🔗 **linked:** changes that must be accepted together, such as a label and its references. Accepting only some of them could break the document. A large linked group can be split into **parts** (*Part 1: …*, *Part 2: …*). Each part has its own ✓/✗ buttons: accepting a part alone keeps the document compiling and leaves the other parts acceptable.
  - ▣ **related:** changes on the same theme, which you can accept or reject in one go.
  - The tag *auto* means Stet detected the group itself. *broken* means the group was resolved inconsistently, and the agent has been asked to repair the document.
- **Change** (`S<n>`): a single edit, located at `file:line` in your current text.
  - Icons show its status: pending, *revision requested*, accepted, rejected, stale.
  - Selecting a change shows it in the editor.

**Other parts of the window:**
- The number on the Stet icon and in the status bar counts the changes waiting for you.
- The status bar also shows how many accepted changes are not committed yet, and a sync icon while an agent is working on an older version of your text. The agent catches up by itself.
- A cloud icon means you have saved edits that agents don't see yet (see *Sharing your edits* below).
- A warning icon, and a line at the top of the panel, appear only if an accepted change can't reach agents: Stet could not apply it on top of your last commit or shared edits. **Finish review** or **Share my edits** passes it on. While everything works, neither is shown.

**Panel title buttons:**
- **Share my edits with agents** (only shown when you have saved edits that agents don't see)
- **Finish review** (only shown when there is something to commit)
- **New agent workspace**
- **Highlight proposed text in green** / **Show proposed text in theme colours** (for word-wrapped editors, see 4.2)
- **View options** (gear): settings you may want to switch back and forth, with a checkmark at the current one: changes shown inline, Accept / Reject actions above changes, going to the next change after deciding, how long changes are shown, and which of your edits agents see. They are the settings of §9, so the Settings editor shows the same values.
- **Refresh**: reloads the panel and rewrites the active agents' instructions, tool configuration and guardrails, e.g. after you updated Stet. Agent sessions read them when they start, so restart running ones.
- `…` menu: **Check setup**, **Set up project**

#### The History view

The **History** view (under Review in the Stet sidebar; click its title to open it) lists the decided changes: accepted, rejected, withdrawn or stale. It has the same structure, agent → round → change, with the newest round first. Each round is closed by default and says how it was decided, e.g. *4 accepted · 1 rejected*.

- Clicking a change shows its diff: the old text against the text that was accepted (your edited version, if you edited it), in its original context.
- Right-click for **Go to change** and **Comment…** (the agent can still reply).
- **Undo** (the ↶ button): the change is pending again, and the agent is told. Undoing an accept takes the change out of your file again, and changes the accept had made stale are pending again too. A change decided together with others (a linked group, a move) is undone with them. You can undo an accept until you **Finish review**; after that it is in git's history, and its diff still shows here.
- A round that is partly decided appears in both views: its open changes under Review, the decided ones under History.

### 4.2 In the editor

Open a `.tex` file with pending changes:

- **only what actually changes is marked:** a change may span a whole formula (math is always reviewed whole, so it can't end up half-edited), but only the symbols that differ are marked, and the new ones appear right where they go. Everything unchanged stays plain;
- the **old text is struck through in red**, and the **new text follows in green**;
- **with word wrap on**, the new text is drawn so that it wraps with the line (as an inlay hint). VS Code draws those in your theme's inlay-hint colour, usually grey. The **colour button** in the Stet panel title (*Highlight proposed text in green*) makes them green: it sets the colour of parameter-name hints in your user settings, so other extensions' parameter hints turn green too (LaTeX files rarely have any). Click it again to undo; a value you had set before is restored. Inlay hints must be enabled (`editor.inlayHints.enabled`, on by default);
- the setting `stet.newTextStyle` chooses explicitly: `highlighted` (always green, doesn't wrap) or `wrapping`. The default `auto` follows the word wrap setting. Toggling word wrap with Alt+Z doesn't change that setting, so if you toggle it that way, choose explicitly;
- new text that doesn't fit there is shortened, and shown **in full in a panel directly below the change**, closed until you click its marker in the gutter. That is new text with several lines, or longer than 80 characters (400 with word wrap on). The panel is the change's thread: you can reply to the agent from it, and close it with its collapse button. The setting `stet.longChanges` keeps these panels closed until you click the gutter marker (`collapsed`, default), opens them (`expanded`), or leaves the full text to the hover (`hover`);
- above each change is a row of actions: **2.2: ✓ Accept · ✗ Reject · ✎ Edit · ↻ Revise · 💬 Comment**. For a member of a linked group, *Accept* reads **✓ Accept all n linked**, or **✓ Accept part 2 of 3 (n changes)** when the group has parts;
- **hovering** a change shows the agent, the round and its rationale, the groups, the diff, the latest thread messages, and the same actions;
- **moved passages:** when an agent moves a passage of two sentences or more, or a whole paragraph or environment, the old place is struck through with a note **⇣ moved to line N**, and the new place shows **⇡ moved here from line N, word for word** instead of repeating the text. If a few words changed on the way, the note says which, e.g. **with 1 word changed: "small" → "short"**, in the editor's warning colour. Above both: **✓ Accept move · ✗ Reject move** and a link to the other end. Accepting or rejecting either end decides the whole move. Several blocks moved next to each other are one move: the new place says **moved here from lines 12 and 40**. In the panel, a move is a group *Move "…"* (or *Move 2 passages …*) with its parts *⇣ moved out* and *⇡ moved in*.

You can keep typing in the file while changes are pending. Stet finds each change again in your current text, including unsaved edits.

### Reviewing a whole file

**Review all changes in this file** opens VS Code's diff editor: on the left your file, on the right the same file with every pending change in it applied. Real line breaks and word wrap, so long rewrites read like text; VS Code's *Inline View* (the diff's **…** menu) shows both in one column, like tracked changes.

- **Open it from:** the button in the editor's title bar (shown when the file has pending changes), the editor's right-click menu, *All changes* in a change's hover, right-clicking a change in the Stet panel, or the command palette.
- **Edit the right side** to reword proposals. Saving keeps your wording for those changes (the panel marks them *your wording*); nothing is accepted. Edits outside the proposed changes are refused when you save: make those in your file itself.
- **Decide** with the buttons above each change on the right: **✓ Accept** (with your wording, if you gave one), **✗ Reject**, and **↺ Agent's wording** to drop yours. Accepting elsewhere (panel, editor, `stet accept`) uses your wording too. The agent is told when you accept a change in your own wording.
- Changes that overlap another one (two agents on the same text) are not in it; a line at the top names them.

### 4.3 Actions

| Action | Key in the panel | What happens |
|---|---|---|
| **Accept** | `a` | Applies the change to your file. It is committed together with the rest of the review when you click **Finish review**. |
| **Reject…** | `r` | Asks for an optional reason. The agent gets the reason and won't propose the same change again. |
| **Edit and accept…** | `e` | Lets you change the wording first, then accepts it. The agent sees your version and adapts to your style. Short changes are edited in an input box; multi-line ones in a separate tab, where you then choose *Accept edited*. |
| **Request revision…** | `v` | Tells the agent what to change. The change stays open until the agent resubmits it. |
| **Comment…** | `c` | Sends a message about the change; the agent can reply. |
| **Show diff** | `d` | Opens a side-by-side diff of your current file and the file with this change. File additions, deletions and renames are shown this way too. |
| **Accept all** | `Shift+A` | Accepts the whole group. On a round, it accepts the whole round, after asking. |
| **Reject all…** | `Shift+R` | Rejects the whole group or round with one reason. |
| **Dissolve group** | (context menu) | Removes a group, for example a wrong automatic one. The changes themselves stay. |
| **Next / previous change** | `j` / `k` | Selects the next or previous change and shows it in the editor, keeping the focus in the panel. The arrow keys move through the panel too; press Enter to show the change. |

After you accept, reject, edit or request a revision, Stet **moves on to the next pending change** and shows it, so reviewing takes one key per change. From the panel, the focus stays in the panel; from the actions in the editor, the editor moves to the next change. The setting `stet.autoAdvance` turns this off.

**Linked changes:**
- Accepting or rejecting one member of a linked group asks what to do with the rest of the group, or of its part if the group has parts:
  - *Accept all linked changes*, or *Accept only this one*, which breaks the group.
  - *Reject all*, *Reject this one and ask the agent to revise the rest*, or *Reject only this one*.
- Accepting a linked group is all-or-nothing: if any member can't be applied, nothing is applied.

**Committing: Finish review.** Accepting only writes your files; nothing is committed per change. When you're done reviewing, click **Finish review** (the commit icon in the panel title, also shown in the status bar with the number of accepted changes). It asks for the commit's summary line, prefilled with the titles of the accepted changesets, and makes **one commit** for the whole review. The commit body lists the accepted changes per changeset, with a `Stet-Applied:` trailer.

- The files are committed as they are at that moment, including your own edits in them.
- Accepted but not yet committed changes already count as your latest text: agents sync onto them.
- Prefer a commit per accepted change? Set `"autoCommit": "when-clean"` in `.git/stet/config.json`. Stet then commits after each accept, unless the file had your own uncommitted edits.

**Sharing your edits.** Changes you accept always reach agents. Your own edits reach them when you click **Share my edits with agents** (cloud icon in the panel title, or *Stet: Share my edits with agents* in the command palette). It saves your open project files, and agents work on that version from their next sync. You don't need to commit first.

- The setting `stet.shareEdits` changes this: `saved` shares every save automatically (agents may then see half-written drafts); `committed` shares only committed text.
- Shared are your tracked files, files staged with `git add`, and new `.tex`/`.bib` files. Build output such as `.aux` or `.pdf` stays out. Your git staging area is not changed.
- After a new commit, agents see the commit; share again if you have edits on top of it.

**Stale changes:** a change becomes *stale* when:
- its text was rewritten in the meantime, by you or by accepting another agent's overlapping change, so it no longer applies; or
- it overlaps a change you accepted.

The agent is told and can propose it again against the current text.

### PDF previews

**Preview in PDF** (the *PDF* link in a change's hover, or right-click a change) opens a panel next to the editor. It shows the region of the compiled paper where the change lands, after and before. The change itself is in the editor at once; the panel says *Building the preview…* and fills in a second or two later. While the panel is open it follows the change you select or put the cursor on, and prepares the next two changes in the background, so moving through a review stays quick.

- **In the hover, too:** a change's hover shows its preview once it is built. Selecting a change starts building it, so it is usually ready by the time you hover. The setting `stet.pdfPreviews` (also under **View options**) chooses where previews appear: in the hover and the panel (default), only one of them, or off (nothing is compiled).
- **What a preview includes:** the change with what accepting it would apply too (the rest of its move or linked part). If that alone breaks the document (say, the change removes a `\begin{proof}` and another change its `\end{proof}`), the preview adds the changes of its round that complete it, or the whole round, and says so: accept them together.
- Changes with no place of their own on the page (the preamble, a macro definition, bibliography data, files that aren't `.tex`) get no preview, and the panel says so.
- **LaTeX errors:** previews are built like your own compile, past errors, so a paper with a small error elsewhere still gets them. Errors that only appear with the change are shown as a warning next to the preview. If no PDF comes out, the panel shows the LaTeX error, or says the document doesn't compile without the change either.

**Zoom** works like a PDF viewer: each image keeps its place in the panel, and zooming enlarges the page inside it. Ctrl/Cmd + wheel zooms around the mouse pointer, dragging moves the page, and when zoomed in the wheel moves it too. Double-click zooms in on a spot, or back to the whole width; the buttons above the images (−, *Fit*, +) do the same. *After* and *Before* keep the same zoom and position, so they show the same spot, and both stay while you move from change to change.

**What it needs:** Podman, and on Linux preferably TeX Live. Previews compile the agents' text in an isolated container, because LaTeX can read any file you can and copy it into the PDF. The container has no network and sees only the build folder.
- **Linux with a standalone TeX Live** (from tug.org): the container uses your TeX, read-only. Its image is small (**Set up**, about 150 MB: Debian, Perl and Poppler).
- **macOS, or Linux with a distribution's TeX:** your TeX can't run in the Linux container, so the image brings its own (Debian's TeX Live with the common packages, about 1 GB). If a preview fails because a file isn't there (say `dsfont.sty`), Stet names it and asks once whether to install TeX's extra fonts (dsfont, bbm, bbold and many more, about 2 GB more); the panel offers the same as a button. Nothing is downloaded without your click. On macOS, Podman runs containers in its machine: start it once with `podman machine init` and `podman machine start`. Projects must be in your home folder, which Podman shares with its machine.
- The setting `preview.tex` in `.git/stet/config.json` chooses where TeX comes from: `auto` (default), `host` or `image`.

The first time, Stet offers to build the image (**Set up**). It never downloads anything without that click. If something is missing (Podman, its machine, the image), Stet says once what and how to fix it; everything else works as usual. *Stet: Set up PDF previews* builds the image at any time.

Without Podman, previews stay off. For material you trust, you can set `"preview": { "isolation": "process" }` in `.git/stet/config.json` to compile without a container. TeX can then read every file you can.

### 4.4 Threads

Comments and revision requests appear as threads on the change, in the editor and in the **Comments** view (the panel area at the bottom). Agent replies show up there too.

- To answer, type in the thread and click **Send to agent**.
- To start a new thread, use **💬 Comment**, or the `+` in the gutter on a line that has a pending change.

**Notes for an agent.** To ask an agent for something about a passage it hasn't changed ("shorten this paragraph", "check this proof"), select the passage and choose **Stet: Note for agent…** from the editor's context menu, or click the gutter `+` on a line without a pending change and type. With several agents, Stet asks which one.
- The agent receives the note at its next sync, at the passage as it is in its copy. It is told when a note is waiting, and gets it even if it is in the middle of other work.
- The note shows as a thread at its passage (labelled *arrives at its next sync* until then) and under its agent in the panel. Replies go both ways, as with comments.
- When it's done, click **Resolve** (✓) on the thread or the note in the panel. Archiving an agent resolves its notes.

---

## 5. Keeping in sync

- The panel updates by itself when an agent submits, replies or withdraws something.
- **Agents catch up themselves:** when you accept changes or edit the document, an agent's workspace falls behind. It catches up with your latest text when it next calls `stet_sync`, which its instructions tell it to do before new work.
- **Rejected changes disappear** from the agent's copy at the same time.

---

## 6. Other agents, other editors

- **Codex in VS Code:** open the agent workspace in a new VS Code window (**Open in new VS Code window**) and use the Codex extension there. Stet itself is only active in your project window. It deliberately ignores agent workspaces, so the agent's window shows no review panel.
- **Reviewing from the command line:** the review commands work just as well in a terminal (`stet review`, `stet accept 2.2`, …; see [cli.md](cli.md)). The extension and the command line share the same data and see each other's actions immediately.

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
| The Stet panel stays empty, VS Code shows *Restricted Mode* | Stet only runs in trusted folders. Choose *Trust* in the Restricted Mode banner. |
| An agent says its workspace was archived | It was: create a new agent workspace and open that folder in the agent instead. |
| "Stet lost its lock to another process" | A Stet process was unresponsive for over 10 minutes and another one took over. Nothing more was written; repeat the action. |
| Check setup reports *damaged record files* | A file in `.git/stet/` could not be read and is skipped. Restore it from a backup or delete it. |

---

## 8. Security

Agents can write only their own workspace folder. Your project, its `.git` folder and Stet's data are read-only to them, and Stet checks what they submit (paths, git links, ids) before using it. On macOS, Linux and WSL2 the agent tools' sandbox enforces this. On native Windows, Claude Code has no sandbox: a guard hook blocks edits and commands aimed at your project, which reliably catches mistakes, but a deliberately evasive agent (for example one following instructions hidden in a source document) can get around it. For untrusted material, run the agent in WSL2. Details: [spec.md](spec.md) §9.

**Restricted Mode:** Stet runs git in your project and writes accepted changes to your files, so it only works in folders you trust. If VS Code opens a folder in Restricted Mode, choose *Trust* to use Stet there.

---

## 9. Settings

Most of these can also be switched from the panel's **View options** (§4.1).

| Setting | Default | Meaning |
|---|---|---|
| `stet.codeLens` | `true` | Actions above each proposed change. |
| `stet.autoAdvance` | `true` | After a decision on a change, select the next pending change and show it. |
| `stet.inlineChanges` | `true` | Strike-through and the new text in the editor. With word wrap on, the new text wraps with the line. VS Code can't show line breaks inline (⏎ marks them); the panel under a long change shows its text in full. Stet sets VS Code's `editor.inlayHints.maximumLength` to no limit for LaTeX files; if your own settings cut or hide inline text, Stet says so once and offers to fix them for that language. |
| `stet.longChanges` | `collapsed` | How changes too long for one line of grey text are shown: in full in a panel under the change that you open from the gutter (`collapsed`), the same panel open (`expanded`), or only in the hover (`hover`). |
| `stet.newTextStyle` | `auto` | How new text is drawn: `highlighted` (green, doesn't wrap), `wrapping` (wraps with the line, in the inlay-hint colour), or `auto` (by the word wrap setting). |
| `stet.runtime` | `auto` | What runs the Stet server for the agents. `auto`: Node.js ≥ 20 if installed, otherwise VS Code's own runtime. `node` or `vscode` to force one. |
| `stet.shareEdits` | `manual` | Which of your own edits agents see: `manual` (when you click *Share my edits*), `saved` (every save), `committed` (only commits). Accepted changes always reach agents. Stored in the project, so the command line follows it too. |

**Colours:** the theme colours `stet.insertedText.foreground`/`.background` and `stet.removedText.foreground`/`.background` can be changed in `workbench.colorCustomizations`.

For LaTeX and BibTeX files, the extension sets `editor.inlayHints.maximumLength` to `0` (no limit), so proposed text isn't cut at VS Code's default of 43 characters. You can override it in your settings.

**How the agents reach Stet:**
- The extension brings its own copy of the `stet` program and places it in `.git/stet/bin/stet.mjs`. That path stays valid across extension updates.
- The agent workspaces point there. When that changes (after an update, or after switching `stet.runtime`), the extension rewrites the workspaces' configuration.
- If you installed the `stet` command-line tool yourself and ran `stet init`, the extension leaves that configuration alone.

---

## 10. For developers

Development setup, tests and packaging: [CONTRIBUTING.md](../CONTRIBUTING.md).

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
