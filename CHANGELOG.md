# Changelog

## Unreleased

- **Security review before the release:**
  - Preview containers never download an image (`--pull=never`); a changed `preview.image` could otherwise have fetched and run any image. They are now limited in file size, open files and memory as well as processes.
  - An agent could put a named pipe where its inbox or `AGENTS.md` should be, and Stet (in VS Code, too) would wait on it forever. Agents' files are now opened only if they are regular files, without blocking.
  - Agent-written text no longer reaches the terminal with control characters or Unicode direction overrides (`stet review`, `show`, feedback), which could rewrite, hide or reorder what the reviewer sees.
  - Previews: images are shown only from Stet's own cache, cache folders are named only by real commit hashes, git filter programs stay off when exporting the project, and a timeout without a container stops TeX as well as latexmk.
- **Faster previews on large projects:** a preview's copy of the project uses copy-on-write where the filesystem supports it (btrfs, XFS, APFS), so figures aren't duplicated; the panel no longer redraws while the cursor stays in one change.
- **Smaller linked groups:** a group's parts could only name changes by line, and a LaTeX paragraph is often one line, so agents couldn't split changes within a paragraph into separate parts: Stet had to join them. Locations now take a quoted snippet of the new text, `main.tex:12 "suggestion"`, which picks one change on a line. Agents are told to use it, and the note when parts are joined says how. Checking that one part doesn't block another now also treats the first part's text as accepted, as a real accept does.
- **What wakes an agent:** the bell next to an agent opens one checklist: when it is woken (when you pause, or right away) and by what: accepted changes, rejections, revision requests, comments and replies, new notes, commits and shared edits, and saves. Untick everything to turn notifications off. `stet agent notify <name> --on <kinds>` on the command line. Switched-off news still reaches the agent when it next checks.
- **Notify now:** the megaphone next to an agent (or `stet agent ping <name> -m <text>`) wakes it at once, whatever its settings, with an optional message.
- **PDF previews:** *Preview in PDF* (VS Code) or `stet preview <id>` shows the region of the compiled paper where a change lands, after and before. Changes appear at once; previews compile in the background and fill in a second or two later. Changes with no place on the page get none, and a change that breaks compilation shows the LaTeX error. Builds run in an isolated Podman container with your own TeX Live, because LaTeX can read any file you can. Stet offers to build the container image once (`stet preview setup`, about 150 MB) and otherwise says what is missing; everything else works without previews.

## 0.9.0 — 2026-11-18

- **Undo in the History:** the new ↶ button (or `stet undo <id>`) undoes a rejection, or an accept until you finish the review. The change is pending again, an undone accept is taken out of your file, and changes the accept had made stale are pending again too. Changes decided together (a linked group, a move) are undone together, and the agent is told.
- **Notifications per agent:** the bell next to an agent (or `stet agent notify <name>`) chooses when an agent waiting with `stet watch` is woken. *When I pause* (the new default) waits until you have stopped for half a minute, so the agent hears about a review at once instead of after every click. *Right away* is the behaviour of 0.8.0. *Off* doesn't wake it at all; switching back on delivers what arrived meanwhile.
- **View options in the panel:** a gear in the Stet panel's title switches the settings you may change back and forth: changes inline, Accept / Reject actions above changes, going to the next change, how long changes are shown, and which of your edits agents see.
- **Accepted changes that can't reach agents are shown:** if the review base can't apply an accepted change on top of your last commit or shared edits, the panel, the status bar, `stet review` and `stet doctor` say so, and the agent is told not to propose it again. Nothing is shown while everything works.

## 0.8.1 — 2026-11-18

- **Fix: Windows build of 0.8.0.** The release build of 0.8.0 failed on Windows: when an agent's Stet tools stopped, the inbox writer could still be busy in the agent's workspace, so it couldn't be removed right away. Stopping now waits for it. 0.8.1 contains all changes of 0.8.0.

## 0.8.0 — 2026-11-18

- **Agents are told when something arrives, instead of polling:** while an agent's session runs, the Stet MCP server writes a line to `.stet/inbox` in its workspace for each decision, comment, note, needed sync, or archiving. The new agent-side command `stet watch` waits for these lines and prints them (`--once`: exits after the first ones), so an agent can wait for you in the background. It is read-only, works in the sandbox, and the guard allows the workspace's own `stet watch` command. Every Stet tool result also mentions unread feedback, waiting notes and a needed sync. Run **Refresh** (or `stet agent refresh <name>`) to give existing agents the new instructions.
- **Fix: accepted changes missing from agents' copies.** An accepted change right next to another accepted one (a sentence rewritten up to the line break that the next change removes) could not be located on top of your commit or shared edits, and was left out of what agents sync onto. Re-proposing it then failed with "could not be applied". Stet now locates such a change with its accepted neighbours.
- **Fix: changes right next to each other.** Accepting a change after its neighbour failed with "the surrounding text changed", and a sync marked it stale. `stet_group` refused to merge such changes into an atomic group when one of them crossed a paragraph break itself; only the text between them counts now.
- **Fix: a failed accept no longer blocks a change for good.** If accepting fails and you then reject the change, the rejection doesn't count when Stet looks for repeats, and the agent is told to propose it again against the current text instead of never again.
- **Fix: a reworded sentence is kept together** when a piece of it repeats a change you rejected. Before, only that piece was auto-rejected, and accepting the rest would have left a broken sentence.
- **Fix: several insertions at one spot** (entries appended to a `.bib` file, paragraphs added at the end of a section) no longer go stale at every sync, and keep their order when you accept them one at a time.

## 0.7.3 — 2026-11-17

- **Fix: projects inside a git submodule.** Stet took the submodule's git directory (`.git/modules/<name>` in the parent repository) for the project folder. VS Code then treated the project as an agent workspace and never offered **New agent workspace** after setup, and agent workspaces were placed inside the parent's `.git`. Stet now uses the submodule's folder.

## 0.7.2 — 2026-11-13

- **Fix: more moves recognised.** Moving a passage word for word was often not shown as a move:
  - A block inserted or deleted right before a paragraph that starts with words also found in the block came out as a changed paragraph instead of a pure insertion or deletion.
  - The two sides of a move were only paired within one submission; a later submit that re-splits pending changes could put them in different ones.
  - Moving a block next to another pending move merged the two and left the old move's group linking unrelated changes. Moves that lose a change are now dissolved and detected again, and a deletion and an insertion holding the same paragraphs in another order are one move.

## 0.7.1 — 2026-11-13

- **Fix: moves next to each other.** Moves were not recognised once two moved blocks ended up next to each other, or next to a heading with another change below it. Blocks moved from different places to one spot (or from one spot to different places) are now one move, and the new place lists where each block came from. Changes that start or end at a paragraph break are no longer merged with the neighbouring paragraph.

## 0.7.0 — 2026-11-13

- **Moves:** when an agent moves a passage (two sentences or more, a whole paragraph or an environment), Stet shows it as one move instead of an unrelated deletion and insertion. The old place says *moved to line N*, the new one *moved here from line N, word for word*. If a few words changed on the way, the note lists them in a warning colour. Accepting or rejecting either end decides the whole move. Agents are asked to move text word for word where they can. Setting `grouping.moves` in `.git/stet/config.json`.
- **Refresh updates agents:** the *Refresh* button in the Stet panel also rewrites the active agents' instructions, tool configuration and guardrails, so after an update new agent sessions get the new instructions without a sync first. Restart running agent sessions to load them.
- **Long changes closed by default:** the panel with a long change's full new text (several lines, or over 80 characters) now starts closed; click the change's marker in the gutter to open it. The setting `stet.longChanges` set to `expanded` brings back the open panels.

## 0.6.2 — 2026-11-12

- **Fix: timing case for older accepted changes.** The release build of 0.6.1 could fail on a test that depended on machine speed; 0.6.2 contains all changes of 0.6.1. For changes accepted before 0.6.1, a commit made in the same second, just before the accept, no longer counts as committing it.

## 0.6.1 — 2026-11-12

- **Fix: accepted changes duplicated in agents' copies.** If you edited, moved or removed text after accepting it (especially an inserted paragraph or environment), agents could see it twice, or see it again after you had removed it. Stet now treats an accepted change as yours once you commit its file, and takes your saved text as it is when sharing it. Agents' copies are corrected at their next sync.
- **Smaller parts:** agents are told to make parts of linked groups as small as possible (a sentence, a formula, a label with its references) instead of one per paragraph or section. They are also told that their instruction file is rewritten at every sync, so they no longer suggest adding your wishes to it.

## 0.6.0 — 2026-11-11

- **Notes for an agent:** select a passage and choose *Stet: Note for agent…* (or click the gutter `+` on a line without a proposed change) to ask one agent for something, e.g. "shorten this paragraph". The agent receives it at its next sync, located in its own copy, and is told when one is waiting. Notes show as threads at their passage and under their agent in the panel; the agent can reply, and you resolve them when done. Command line: `stet note <agent> main.tex:42-47 -m "…"`, `stet notes`, `stet note resolve N3`.
- **Parts of linked groups:** a long linked group can be split into parts that you accept or reject one at a time (*Part 1: …* in the panel, `G3.2` on the command line). A part is only kept if accepting it alone still compiles (warnings such as a missing reference are fine) and blocks no other part; Stet joins parts that make the same change, need each other's macro definitions, or touch the same text. Agents can declare parts in `stet_submit` and `stet_group`; a detected label rename is split into the label and its references. If some parts are accepted and others rejected, the agent is told so it can make the paper consistent.
- **Fix: label renames not linked.** A label rename was not detected when two references to it were close together (within about 80 characters).

## 0.5.1 — 2026-11-11

- **Fix: comments left behind.** After archiving an agent (or another change to the proposals), comment threads in the editor could remain although their proposals were gone, and a thread could appear twice. The extension now updates its threads one pass at a time. Leftover threads disappear when you reload the window.
- Development tools updated for security advisories (`npm audit` is clean): `vitest`, `@vscode/vsce` and its dependencies; vsce's `minimatch` is pinned to a fixed version until vsce adopts one. The extension and CLI were not affected.

## 0.5.0 — 2026-10-21

- **Fix: accepted changes applied twice.** An accepted change whose new text contains its old text (`pk` → `\pk`, `H` → `\Hash`) was applied a second time when Stet built the agents' view of your text: after *Share my edits*, or after you committed accepted changes with git yourself. Agents then saw `\\pk` and `\\Hashash`, text that isn't in your document, and proposed "fixes" for it. Workspaces affected by this are repaired at the agent's next sync; their proposals for the broken text become stale. Accepting a proposal that is already in your text is now refused instead of applied twice.
- **Rounds:** each agent submission is a round, and its changes are numbered within it: `12.3` is change 3 of round 12. The panel shows "Round 12: title" with the changes numbered 1, 2, 3 … underneath. The ids are the same for agents and the command line. Existing changes keep their old ids (`S412`).
- **History view:** decided changes (accepted, rejected, withdrawn, stale) move from the Review panel to a separate History view, by round, newest first, each round with a summary such as "4 accepted · 1 rejected". Clicking a change shows what was accepted. The *Show/Hide resolved* button is gone.
- **Faster accepting:** accepting a change and moving on to the next takes about 0.15 s (was 0.25–0.9 s). Accept starts fewer git processes, the panel redraws before updating its buttons, and the background checks wait for a 2-second pause, so they don't hold up the next accept.
- **Quick key presses:** pressing `a` (or `r`, `j`, …) again before the panel has moved on no longer acts on the change just decided; decisions run one after another.
- The buttons in the panel title no longer change order when one of them is toggled.
- Development tools: `vite` (used by the test runner) updated for a security advisory. The extension and CLI were not affected.

## 0.4.3 — 2026-10-20

- **Colours:** removed text is struck through in red, new text is green. With word wrap on (where new text is an inlay hint, so it wraps), a button in the Stet panel makes it green as well. Setting `stet.newTextStyle` to choose explicitly.
- **Faster reviewing:** moving on to the next change after a decision takes about 0.3 s instead of 2 s. The checks whether agents are behind and whether you have unshared edits now run in the background once you pause.

## 0.4.2 — 2026-10-19

- **Clearer changes in long formulas:** a change to a formula covers the whole formula (it is reviewed as a unit), but the editor now marks only the symbols that actually differ, instead of striking through the whole formula and repeating it.
- **Word wrap:** the proposed new text after a change now wraps with the line (it is shown as an inlay hint instead of a decoration, which word wrap ignored). With word wrap on, single-line proposals up to 400 characters are shown inline in full.
- **Faster reviewing:** after you accept, reject, edit or request a revision of a change, the extension selects the next pending change and shows it (setting `stet.autoAdvance`).

## 0.4.1 — 2026-10-19

- **VS Code Marketplace:** the extension is published as a preview under the publisher *archechef*, with an icon and a self-contained Marketplace page.
- **Release script:** `release.mjs set` checks the changelog before changing any file.

## 0.4.0 — 2026-10-15

- **Share my edits:** agents can see your own edits without you committing them first. Click **Share my edits with agents** (VS Code) or run `stet share`. The setting `shareEdits` (`stet.shareEdits` in VS Code) chooses between this (`manual`, default), sharing every save (`saved`), and committed text only (`committed`, the old behaviour).
- **Long changes in the editor:** proposals with several lines or more than 80 characters were only shown shortened in the grey inline text. Their full new text now appears in a panel directly below the change (setting `stet.longChanges`).
- **Guard:** compares real paths, so a link or an alternative spelling of the project folder (macOS `/private/var`, Windows short names) is recognised.

## 0.3.0 — 2026-09-27

**VS Code extension (milestone M3).**
- **Stet panel:** agent → changeset → group → change, with keyboard review:
  - `a` accept, `r` reject, `e` edit and accept, `v` request revision, `c` comment, `d` diff;
  - `A`/`R` for the whole group;
  - `j`/`k` for the next/previous change.
- **In the editor:** changes shown inline, CodeLens actions and hovers.
- **Comment threads** with the agent.
- **Setup without a command line:** set up a project, create/open/archive agent workspaces, check setup.
- **Finish review:** accepted changes are committed in one commit with an editable summary line (`autoCommit: "on-finish"`, the new default). `stet commit` does the same on the command line.
- **Runtime:** the extension brings its own `stet` for the agents and runs it with Node.js or with VS Code's own runtime (setting `stet.runtime`).
- **Archiving an agent** tells the agent (on its next action) and you what happened.
- Runs only in trusted folders (Restricted Mode).

**Security.** Findings from an independent audit and two Codex reviews are fixed, each with a regression test:
- **Agent files:** handled through the project's repository with Stet's own index, never through the agent worktree's git metadata. Hooks, filters, submodules, fsmonitor and signing are off.
- **Paths and ids:** checked; no writes through links.
- **Accept:** all-or-nothing, with crash recovery.
- **Lock:** owned, with heartbeat and fencing.
- **Guard and hooks:** the guard hook command is single-quoted, config values are validated, and the git hooks chain existing hooks correctly.

**Performance** (3,000-line paper, 300 proposals):
- Accepting one change: 1.9 s → 0.16 s.
- Relocating changes after each keystroke: 650 ms → 5 ms.

## 0.2.0 — 2026-09-26

**MCP server and guardrails (milestone M2).**
- MCP tools for agents: `stet_submit`, `stet_sync`, `stet_get_feedback`, `stet_reply`, …
- Agent workspaces with instructions for Claude (`CLAUDE.local.md`) and Codex (`AGENTS.override.md`).
- Guard hook, deny rules and sandbox settings for Claude Code; git hooks against merging or pushing agent branches.
- Live-tested with the Claude desktop app.

## 0.1.0 — 2026-09-26

**Core library and CLI (milestone M1).**
- LaTeX-aware splitting of agent edits into reviewable items.
- Anchoring of changes in text you keep editing.
- Accept, reject, revise, replay (sync), stale detection and grouping (linked / atomic / related).
- `stet doctor`.
