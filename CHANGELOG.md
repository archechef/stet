# Changelog

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
