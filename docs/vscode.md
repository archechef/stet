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

**Notify now** (the megaphone at the top of that checklist, or right-click the agent): wakes the agent at once, whatever the settings above, with an optional message such as *I've finished reviewing round 3*.

A woken agent starts working without you prompting it, so *Off* is also the way to keep it waiting for you.

**Right-click an agent in the panel** to open its workspace again, copy its path, set its notifications, or **Archive** it. Archiving withdraws its pending changes and can also delete the folder and its branch. *Archive, keep folder* is the first button (what Enter does); the delete button says how many files the agent changed without submitting, which deleting loses. Stet shows what it did, and an agent session that is still open is told on its next action that its workspace was archived (and asked to stop); you can then close that session.

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
  - 🔗 **linked:** changes that must be accepted together because accepting only some would break the document or lose text: a macro and its uses, a moved passage, the same symbol renamed in several formulas. Stet checks agents' linked groups and makes them *related* when it sees no such dependency (the agent can insist with a reason, shown as "Linked because: …" in the group's rationale). A large linked group can be split into **parts** (*Part 1: …*, *Part 2: …*). Each part has its own ✓/✗ buttons: accepting a part alone keeps the document compiling and leaves the other parts acceptable.
  - ▣ **related:** changes on the same theme, which you can accept or reject in one go.
  - The tag *auto* means Stet detected the group itself. *broken* means the group was resolved inconsistently, and the agent has been asked to repair the document.
- **Change** (`1.2`: round 1, change 2): a single edit, located at `file:line` in your current text. In the panel it shows its number within the round.
  - Icons show its status: pending, *revision requested*, accepted, rejected, stale.
  - Selecting a change shows it in the editor.

**Other parts of the window:**
- The number on the Stet icon and in the status bar counts the changes waiting for you.
- The status bar also shows how many accepted changes are not committed yet, and a sync icon while an agent is working on an older version of your text. The agent catches up by itself.
- A cloud icon means you have saved edits that agents don't see yet (see *Sharing your edits* below).
- A warning icon, and a line at the top of the panel, appear only if an accepted change can't reach agents: Stet could not apply it on top of your last commit or shared edits. **Finish review** or **Share my edits** passes it on. While everything works, neither is shown.

**Panel title:** only what you act on now, and the View options.
- **Filter and search** (funnel, `/`), and ✕ to show everything again while a filter is on. The line at the top of the panel says what it shows.
- **Share my edits with agents** (cloud): shown only when you have saved edits that agents don't see.
- **Finish review** (commit): shown only when there is something to commit.
- **View options** (gear): everything you may want to switch while you work, with a checkmark at the current choice:
  - changes inline in the editor, actions above changes (CodeLens), going to the next change after deciding, what the left side of a diff shows;
  - how new text is drawn (by word wrap, highlighted, or wrapping), and whether wrapping text is green too (see 4.2);
  - how long changes are shown, which of your edits agents see, and where PDF previews appear.
  
  They are the settings of §9, so the Settings editor shows the same values. Settings you choose once (such as `stet.runtime`) are only there.
- `…` menu: **New agent workspace**, **Refresh** (reloads the panel and rewrites the active agents' instructions, tool configuration and guardrails, e.g. after you updated Stet; agent sessions read them when they start, so restart running ones), **Set up PDF previews**, **Check setup**, **Set up project**.

#### The History view

The **History** view (under Review in the Stet sidebar; click its title to open it) lists the decided changes: accepted, rejected, withdrawn or stale. It has the same structure, agent → round → change, with the newest round first. Each round is closed by default and says how it was decided, e.g. *4 accepted · 1 rejected*.

- Clicking a change shows its diff: the old text against the text that was accepted (your edited version, if you edited it), in its original context.
- Right-click for **Comment…** (the agent can still reply), **Diff**, **PDF preview** and **Go to change**, with the same names as everywhere (4.3). `d` shows the diff, `u` undoes.
- **Where changes open:** going to a change (or a note, or a diff) uses the editor group that already has its file open, even when another one has the focus. Otherwise it opens in the active group, unless that shows the PDF preview: then in a group showing text, or beside it.
- **Undo** (the ↶ button): the change is pending again, and the agent is told. Undoing an accept takes the change out of your file again, and changes the accept had made stale are pending again too. A change decided together with others (a linked group, a move) is undone with them. You can undo an accept until you **Finish review**; after that it is in git's history, and its diff still shows here.
- A round that is partly decided appears in both views: its open changes under Review, the decided ones under History.

### 4.2 In the editor

Open a `.tex` file with pending changes:

- **only what actually changes is marked:** a change may span a whole formula (math is always reviewed whole, so it can't end up half-edited), but only the symbols that differ are marked, and the new ones appear right where they go. Everything unchanged stays plain;
- the **old text is struck through in red**, and the **new text follows in green**;
- **with word wrap on**, the new text is drawn so that it wraps with the line (as an inlay hint). VS Code draws those in your theme's inlay-hint colour, usually grey. **View options → Proposed text in green, also when it wraps** makes them green: it sets the colour of parameter-name hints in your user settings, so other extensions' parameter hints turn green too (LaTeX files rarely have any). Untick it to undo; a value you had set before is restored. Inlay hints must be enabled (`editor.inlayHints.enabled`, on by default);
- **View options → New text** (the setting `stet.newTextStyle`) chooses explicitly: *highlighted* (always green, doesn't wrap) or *wraps with the line*. The default follows the word wrap setting. Toggling word wrap with Alt+Z doesn't change that setting, so if you toggle it that way, choose explicitly;
- new text that doesn't fit there is shortened, and shown **in full in a panel directly below the change**, closed until you click its marker in the gutter. That is new text with several lines, or longer than 80 characters (400 with word wrap on). The panel is the change's thread: you can reply to the agent from it, and close it with its collapse button. The setting `stet.longChanges` keeps these panels closed until you click the gutter marker (`collapsed`, default), opens them (`expanded`), or leaves the full text to the hover (`hover`);
- above each change: **2.2: ✓ Accept · ✗ Reject… · ⋯ More…**. For a member of a linked group, *Accept* reads **Accept all n linked**, or **Accept part 2 of 3 (n changes)** when the group has parts. *More…* lists every action on the change (4.3);
- **Ctrl+.** (Cmd+. on macOS, VS Code's Quick Fix) with the cursor in a change lists the same actions; a light bulb shows they're there;
- **hovering** a change shows the agent, the round and its rationale, the groups, the diff, the thread (its last three messages while the change is pending, all of it once decided), and every action. It opens over the change and the word before and after it (so short changes and insertions are easy to hit) and stays open while the mouse is in that area; the green proposed text has the same hover;
- **moved passages:** when an agent moves a passage of two sentences or more, or a whole paragraph or environment, the old place is struck through with a note **⇣ moved to line N**, and the new place shows **⇡ moved here from line N, word for word** instead of repeating the text. If a few words changed on the way, the note says which, e.g. **with 1 word changed: "small" → "short"**, in the editor's warning colour. Above both: **✓ Accept move · ✗ Reject move… · ⋯ More…**, where *More…* also goes to the other end. Accepting or rejecting either end decides the whole move. Several blocks moved next to each other are one move: the new place says **moved here from lines 12 and 40**. In the panel, a move is a group *Move "…"* (or *Move 2 passages …*) with its parts *⇣ moved out* and *⇡ moved in*. A sentence that only changes paragraph (the break before or after it moved) is no move but one change, labelled *paragraph break moved*, and the editor marks just the breaks: **¶** where one goes in, **␣** where one is taken out. A split or a join says *paragraph split* / *paragraphs joined*.

You can keep typing in the file while changes are pending. Stet finds each change again in your current text, including unsaved edits.

### Reviewing a whole file

**Review file** opens VS Code's diff editor: on the left your text as it is (read-only, with what the changes remove in red), on the right the same file with every pending change in it applied. **View options → Diffs: your side shows the proposals too** (`stet.diffShowsProposals`) puts your file itself on the left instead: editable, with the proposals marked in it as in the editor. Real line breaks and word wrap, so long rewrites read like text; VS Code's *Inline View* (the diff's **…** menu) shows both in one column, like tracked changes.

- **Open it from:** the button in the editor's title bar (shown when the file has pending changes), the editor's right-click menu, or a change's actions (hover, *More…*, Ctrl+., right-click in the panel, `f` in the panel).
- **Edit the right side** to reword proposals. Saving keeps your wording for those changes (the panel marks them *your wording*); nothing is accepted. Edits outside the proposed changes are refused when you save: make those in your file itself.
- **Decide** right there, with the same actions as in your file: the buttons above each change (**✓ Accept**, as the change must be decided, so *Accept move* or *Accept all 3 linked* where it says so; **✗ Reject…**; **Use agent's wording** to drop yours; **More…**), the hover with its PDF preview, and Ctrl+. in the change. Each saves your unsaved edits in the review first, so Accept uses the wording you see. Accepting elsewhere (panel, editor, `stet accept`) uses your wording too. The agent is told when you accept a change in your own wording.
- **Diff** on a pending change opens the same review with only that change in it, plus what accepting it takes along in the same file (its linked group, a move's other half): editable, with the same actions. Decided changes and whole-file changes get a plain, read-only diff.
- Changes that overlap another one (two agents on the same text) are not in it; a line at the top names them.

### 4.3 Actions

Every change has the same actions, under the same names and in the same order, wherever you meet it:

| Where | What it shows |
|---|---|
| **Hover** over a change | every action, as links |
| **Above the change** (CodeLens) | Accept, Reject… and *More…* |
| **More…** (CodeLens, or `.` in the panel) | every action, with its key and what it does |
| **Ctrl+.** (Cmd+. on macOS) in the change | every action, in VS Code's Quick Fix menu |
| **Stet panel**, change row | Diff, Accept, Reject as buttons; right-click for every action |
| **Keys** in the panel | one letter per action (below) |

An action that ends in "…" asks you something first (a reason, your wording, a message).

A key in the panel acts on the change selected there. From the Command Palette, an action takes the change you picked last: the one selected in the panel, or, once you have moved the cursor in a file, the change the cursor is in (or the nearest one on its line).

| Action | Key in the panel | What happens |
|---|---|---|
| **Accept** | `a` | Applies the change to your file. It is committed together with the rest of the review when you click **Finish review**. On a linked change it reads *Accept all n linked* (see below). |
| **Reject…** | `r` | Asks for an optional reason. The agent gets the reason and won't propose the same change again. |
| **Edit & accept…** | `e` | Lets you change the wording first, then accepts it. The agent sees your version and adapts to your style. Short changes (one line, up to 80 characters) are edited in an input box: Enter accepts, its save button saves your wording without accepting, and "Edit in a tab" moves to an editor if you need more room. Longer ones open in an editor of their own: **Ctrl+S saves your wording** (the change stays pending, the panel marks it *your wording*), and above the text, also in the title bar, are **Accept … with this wording**, **Agent's wording** and **More…**. The editor closes when the change is decided. To reword several changes and decide later, use **Review file**. |
| **Revise…** | `v` | Tells the agent what to change. The change stays open until the agent resubmits it. |
| **Comment…** | `c` | Sends a message about the change; the agent can reply. |
| **Diff** | `d` | Your file and the file with this change, side by side: a review of just this change (and what accepting it takes along), editable, with the same actions (see *Reviewing a whole file*). Decided changes, and file additions, deletions and renames, get a read-only diff. |
| **PDF preview** | `p` | The compiled page with the change, after and before (see *PDF previews*). |
| **Review file** | `f` | All pending changes of the file in one editable diff (see *Reviewing a whole file*). |
| **Use agent's wording** | | Drops the wording you gave the change in *Review file*. |
| **Undo** | `u` in History | For a decided change: it is pending again (see *The History view*). |
| **Undo my last decision** | `u` in the panel | Takes back your last accept or reject, with everything it decided. For 15 seconds after each decision, the status bar also shows an **Undo** button. |
| **Filter and search…** | `/` | Shows only the changes of one agent, of one file, waiting for you or for the agent's revision, or with some words in their text, note or conversation (all of them). Pick an entry again to drop it; ✕ in the panel title shows everything again. What a filter hides is still decided by *Accept all* on its group; `j`/`k` move through what is shown. |
| **More…** | `.` | Lists every action on the change. |
| **Accept all** | `Shift+A` | Accepts the whole group, part or round. It asks first when that is more than one change, except for a linked group or part, whose changes go together anyway. |
| **Reject all…** | `Shift+R` | Rejects the whole group, part or round with one reason, asking first as *Accept all* does. |
| **Dissolve group** | (right-click) | Removes a group, for example a wrong automatic one. The changes themselves stay. A linked group asks first: its changes can then be accepted apart. |
| **Next / previous change** | `j` / `k` | Selects the next or previous change and shows it in the editor, keeping the focus in the panel. The arrow keys move through the panel too; press Enter to show the change. |

After you accept, reject, edit or request a revision, Stet **moves on to the next pending change** and shows it, so reviewing takes one key per change. From the panel, the focus stays in the panel; from the actions in the editor, the editor moves to the next change. The setting `stet.autoAdvance` turns this off.

**Linked changes:**
- **Accept** on a linked change accepts what belongs together: its whole group, or its part if the group has parts. Where there's room, the label says so (*Accept all 3 linked*, *Accept part 2 of 3*). The panel's button and `a` can't show that, so there Stet asks: all of them, or only this one. **Accept only 2.3**, in the change's actions, breaks the group; the agent is asked to repair the document.
- Rejecting one member asks what to do with the rest: *Reject all*, *Reject this one and ask the agent to revise the rest*, or *Reject only this one*.
- Accepting a linked group is all-or-nothing: if any member can't be applied, nothing is applied.

**Committing: Finish review.** Accepting only writes your files; nothing is committed per change. When you're done reviewing, click **Finish review** (the commit icon in the panel title, also shown in the status bar with the number of accepted changes). It asks for the commit message's summary line, prefilled with the title of the accepted round (several titles joined with "; " while they fit in 60 characters, else *Accept n changes from <agents>*), and makes **one commit** for the whole review. Stet commits the changed files whole, so your own uncommitted edits in them go into that commit too; the dialog lists the files, and the commit message names those with edits of yours. The commit body lists the accepted changes per changeset, with a `Stet-Applied:` trailer.

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

**PDF preview** (among a change's actions: hover, *More…*, Ctrl+., right-click, `p` in the panel) opens a panel next to the editor. It shows the region of the compiled paper where the change lands, after and before. The change itself is in the editor at once; the panel says *Building the preview…* and fills in a second or two later. While the panel is open it follows the change you select or put the cursor on, and prepares the next two changes in the background, so moving through a review stays quick.

- **In the hover, too:** a change's hover shows its preview once it is built. Selecting a change starts building it, so it is usually ready by the time you hover. The setting `stet.pdfPreviews` (also under **View options**) chooses where previews appear: in the hover and the panel (default), only one of them, or off (nothing is compiled).
- **What a preview includes:** the change with what accepting it would apply too (the rest of its move or linked part). If that alone breaks the document (say, the change removes a `\begin{proof}` and another change its `\end{proof}`), the preview adds the changes of its round that complete it, or the whole round, and says so: accept them together.
- Changes with no place of their own on the page (the preamble, a macro definition, bibliography data, files that aren't `.tex`) get no preview, and the panel says so.
- **LaTeX errors:** previews are built like your own compile, past errors, so a paper with a small error elsewhere still gets them. Errors that only appear with the change are shown as a warning next to the preview. If no PDF comes out, the panel shows the LaTeX error, or says the document doesn't compile without the change either.

**The page view:** the Preview panel shows the whole page with the change, opened at it. The changed words are highlighted: inserted ones in green in *After*, removed ones in red in *Before*. The highlighting compares the words of the two versions as typeset, punctuation included, so a paragraph that only reflowed isn't marked, and a comma added is. Only the change itself is highlighted: an equation or a reference that got another number because of it is not. A change the editor shows whole (mostly rewritten) is highlighted whole; inside a formula, the symbols that differ. Formulas that only moved because the words around them changed are not highlighted. **After | Before** flips between the versions at the same zoom and position, and ◀ ▶ turn the pages (other pages are rendered when you go there, without highlights). The hover keeps showing just the region of the change.

**Zoom** works like a PDF viewer: the page keeps its place in the panel, and zooming enlarges it inside. Ctrl/Cmd + wheel zooms around the mouse pointer, dragging moves the page, and when zoomed in the wheel moves it too. Double-click zooms in on a spot, or back to the whole width; the buttons above the images (−, *Fit*, +) do the same. Zoom and position stay while you flip and while you move from change to change.

**What it needs:** Podman, and on Linux preferably TeX Live. Previews compile the agents' text in an isolated container, because LaTeX can read any file you can and copy it into the PDF. The container has no network and sees only the build folder.
- **Linux with a standalone TeX Live** (from tug.org): the container uses your TeX, read-only. Its image is small (**Set up**, about 150 MB: Debian, Perl and Poppler).
- **macOS, or Linux with a distribution's TeX:** your TeX can't run in the Linux container, so the image brings its own (Debian's TeX Live with the common packages, about 1 GB). If a preview fails because a file isn't there (say `dsfont.sty`), Stet names it and asks once whether to install TeX's extra fonts (dsfont, bbm, bbold and many more, about 2 GB more); the panel offers the same as a button. Nothing is downloaded without your click. On macOS, Podman runs containers in its machine: start it once with `podman machine init` and `podman machine start`. Projects must be in your home folder, which Podman shares with its machine.
- The setting `preview.tex` in `.git/stet/config.json` chooses where TeX comes from: `auto` (default), `host` or `image`.

The first time, Stet offers to build the image (**Set up**). It never downloads anything without that click. If something is missing (Podman, its machine, the image), Stet says once what and how to fix it; everything else works as usual. *Stet: Set up PDF previews* builds the image at any time.

Without Podman, previews stay off. For material you trust, you can set `"preview": { "isolation": "process" }` in `.git/stet/config.json` to compile without a container. TeX can then read every file you can.

### 4.4 Threads

Comments and revision requests appear as threads on the change, in the editor and in the **Comments** view (the panel area at the bottom). Agent replies show up there too.

- To answer, type in the thread and click **Send to agent**.
- To start a new thread, use **Comment…** among the change's actions, or the `+` in the gutter on a line that has a pending change.

**Notes for an agent.** To ask an agent for something about a passage it hasn't changed ("shorten this paragraph", "check this proof"), select the passage and choose **Stet: Note for agent…** from the editor's context menu, or click the gutter `+` on a line without a pending change and type. With several agents, Stet asks which one.
- The agent receives the note at its next sync, at the passage as it is in its copy. It is told when a note is waiting, and gets it even if it is in the middle of other work.
- The note shows as a thread at its passage (labelled *arrives at its next sync* until then) and under its agent in the panel. Replies go both ways, as with comments.
- When it's done, click **Resolve** (✓) on the thread or the note in the panel. Archiving an agent resolves its notes.

---

### 4.5 With a screen reader or the keyboard only

Stet's colours and inline text are decorations, which screen readers don't read, so review from the panel and the hovers:

- **The panel** reads each change in words: "Change 2.1, replace “problem” with “task”, in main.tex line 4, pending". Rounds and groups read their titles; the status bar reads how many changes wait for you. Focus the panel with **Stet: Focus on Review View** (Command Palette).
- **Keys in the panel** (4.3): `j`/`k` next and previous, `a` accept, `r` reject, `e` edit the wording, `c` comment, `v` revise, `d` diff, `.` every action. After a decision, `u` undoes it. Selecting a change moves the editor's cursor to it.
- **A change's text:** in the editor, put the cursor in the change and open its hover with **Ctrl+K Ctrl+I**, then **Alt+F2** (Accessible View) to read it as plain text, links to its actions included. **Ctrl+.** lists its actions as a menu.
- **Diff** (`d`) opens VS Code's diff editor; its **Accessible Diff Viewer** (**F7** / **Shift+F7**) reads the change line by line.
- **The PDF preview** names its buttons and announces the page; Tab to the page, then the arrow keys move it and `+`/`-` zoom.
- **High-contrast themes:** removed text is struck through, and inserted text has a dashed border, so neither depends on colour.
- The command line reads well in a terminal too: `stet review`, `stet show 2.1` (without colours, `[-…-]` marks removed text and `{+…+}` added text).

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

Run **Stet: Check setup** first. It checks git, the hooks, the agent workspaces and their configuration, and prints fixes in the **Stet** output channel.

| Symptom | Cause and fix |
|---|---|
| Panel says "This folder is an AI agent's workspace" | You opened an agent's folder. Review in your project's window: **Open the project**. |
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
| `stet.diffShowsProposals` | `false` | In Diff and Review file, your file itself on the left (editable, with the proposals in it) instead of your text as it is, read-only. |
| `stet.inlineChanges` | `true` | Strike-through and the new text in the editor. With word wrap on, the new text wraps with the line. VS Code can't show line breaks inline (⏎ marks them); the panel under a long change shows its text in full. Stet sets VS Code's `editor.inlayHints.maximumLength` to no limit for LaTeX files; if your own settings cut or hide inline text, Stet says so once and offers to fix them for that language. |
| `stet.longChanges` | `collapsed` | How changes too long for one line of grey text are shown: in full in a panel under the change that you open from the gutter (`collapsed`), the same panel open (`expanded`), or only in the hover (`hover`). |
| `stet.newTextStyle` | `auto` | How new text is drawn: `highlighted` (green, doesn't wrap), `wrapping` (wraps with the line, in the inlay-hint colour), or `auto` (by the word wrap setting). |
| `stet.runtime` | `auto` | What runs the Stet server for the agents. `auto`: Node.js ≥ 20 if installed, otherwise VS Code's own runtime. `node` or `vscode` to force one. |
| `stet.pdfPreviews` | `both` | Where PDF previews of changes appear: in the hover and the Preview panel (`both`), only `hover`, only `panel`, or `off` (nothing is compiled). |
| `stet.shareEdits` | `manual` | Which of your own edits agents see: `manual` (when you click *Share my edits*), `saved` (every save), `committed` (only commits). Accepted changes always reach agents. Stored in the project, so the command line follows it too. |

**Colours:** the theme colours `stet.insertedText.foreground`/`.background`/`.border` and `stet.removedText.foreground`/`.background` can be changed in `workbench.colorCustomizations`. In high-contrast themes, inserted text has a dashed border (`.border`), so it isn't marked by colour alone; removed text is always struck through.

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
