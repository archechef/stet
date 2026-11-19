# Pending live tests

Automated tests cover the core, the CLI, the MCP protocol, the guard rules, the git hooks and an integration run of the extension in real VS Code. What they cannot cover is listed here: the parts a person has to click through, or that need a logged-in agent.

| Test | Milestone | Status |
|---|---|---|
| Claude desktop app, full loop + guardrails | M2 | ✅ passed 2026-09-26 (spec §16, M2 notes) |
| [A. VS Code extension, hands-on](#a-vs-code-extension-hands-on-m3) | M3 | ✅ passed 2026-09-27 (fixes: spec §16, hands-on test notes) |
| [B. Claude Code CLI](#b-claude-code-cli-m2) | M2 | ⏳ to do (needs a logged-in `claude` CLI) |
| [C. Codex](#c-codex-m2) | M2 | ⏳ to do (needs Codex, e.g. a coworker's setup) |

Record the results, and any fixes, in spec §16. Then tick them off here.

---

## A. VS Code extension, hands-on (M3)

**Goal (M3 acceptance):** the full workflow runs from VS Code plus the desktop app, with no command line.

**Setup (about 5 min):**
1. Install `packages/vscode/stet-vscode.vsix` (Extensions → `…` → *Install from VSIX…*).
2. Make a fresh test folder, e.g. `Documents/stet-test2/paper`, with a small `main.tex` that has:
   - a `\section` with a `\label`, and at least one `\ref` to it;
   - a `\cite` and a short `.bib` file;
   - two paragraphs of prose and some inline math.

   **Do not** run `git init`: test A1 covers setup from scratch.
3. Open the folder in VS Code.

### A1. Setup from scratch
- [ ] The Stet panel shows "not set up" and a **Set up project** button.
- [ ] Clicking it offers to create a repository ("not a git repository") and then commits the files ("Initial commit").
- [ ] It reports the main branch and offers **New agent workspace**.
- [ ] **Check setup** (Stet panel → `…` menu) shows no errors in the *Stet* output panel, including a ✓ line for "stet command".
- [ ] `.git/stet/bin/stet.mjs` exists. VS Code hides `.git`, so check in the terminal (`` Ctrl+` ``): `dir .git\stet\bin`.
- [ ] *(Test-only; users never need this: the default `auto` picks Node.js if installed, otherwise VS Code's runtime.)* Switch the runtime: Settings (`Ctrl+,`) → search `stet.runtime` → `vscode`. The status bar briefly shows "agents … now use VS Code's runtime". `type .git\stet\config.json` shows `"cli"` with `Code.exe` and `ELECTRON_RUN_AS_NODE`.
  - Leave it on `vscode` until A7 (the guard-hook check there needs it), then set it back to `auto`.
  - Once an agent exists (A2), its `.mcp.json` shows the same command.

### A2. Agent workspace
- [ ] **New agent workspace** → Claude → `claude-1` → **Copy folder path**.
- [ ] Open that folder in the Claude desktop app (Code tab). Expected: only a folder-trust prompt, and the agent lists the `stet_*` tools.
- [ ] The panel shows `claude-1` with "0 pending", and the welcome text is gone.

### A3. Proposals appear by themselves
Prompt the agent:
> Improve the wording of the introduction, and rename the label `sec:intro` to `sec:introduction` everywhere.

- [ ] Without clicking **Refresh**:
  - the changeset appears in the panel;
  - the badge on the Stet icon and the status bar show the number of pending changes;
  - the label rename is a 🔗 linked group.
- [ ] In `main.tex`:
  - old text is struck through, with the new text in grey;
  - CodeLens rows are above the changes;
  - hovers show the diff and the rationale.
- [ ] Selecting items in the panel moves the editor to them without taking focus from the panel.

### A4. Keyboard review in the panel
- [x] ~~`j`/`k` move only the focus; the editor follows only after Enter~~ (found 2026-09-27). Fixed: `j`/`k` now run *Stet: Next/Previous change*, which select the change and show it. Re-check: `j`/`k` move through the changes and the editor follows at once; the arrow keys keep VS Code's usual behaviour (Enter shows the change).
- [ ] `a` on a wording change accepts it. The file changes, the item leaves the panel, and **no** commit is made (since 2026-09-27 Stet commits on *Finish review*); the commit icon and count appear.
- [ ] `a` on one linked member offers "Accept all 2 linked" or "Accept only". Choose *all*.
- [ ] `r` on a change → give a reason → it is rejected. The agent (`stet_get_feedback`) sees the reason.
- [ ] `v` → a revision text. The item shows "revision requested". Ask the agent to handle its feedback: the revised item replaces the old one.
- [ ] `e` on a short change → edit the text in the input box → accepted with your wording.
- [ ] `e` on a multi-line change (ask the agent for a paragraph rewrite) → a tab opens → edit → *Accept edited* → the tab closes without a save prompt.
- [ ] `d` opens the side-by-side diff.
- [ ] `Shift+A` / `Shift+R` on a group member acts on its group. On a changeset, the context menu *Accept all* asks for confirmation first.

### A5. Editor actions and your own edits
- [ ] Type a new line above a pending change **without saving**. The decorations and CodeLens move with it.
- [ ] Click **✓ Accept** in the CodeLens:
  - the file is saved first, and your line is kept;
  - the change is applied, and the commit count in the status bar goes up.
- [ ] **Finish review** → the confirmation lists the files → *Commit* → the summary line is prefilled with the changeset titles; edit it → **one** commit for all accepted changes (`git log`: your summary, and a body listing the changes), and the icon disappears.
- [ ] Hover links (✓ Accept, Diff, …) work.
- [ ] Turning off `stet.codeLens` / `stet.inlineChanges` hides them.

### A6. Threads
- [ ] **💬 Comment** on a change ("Why this word?") → a thread appears on the line and in the Comments view.
- [ ] Ask the agent to check its feedback. Its `stet_reply` shows up in the thread without a refresh.
- [ ] Reply in the thread with **Send to agent** → the agent receives it as a comment.
- [ ] Use the gutter `+` on a line with a pending change to start a new thread → it attaches to that change. On a line *without* a change, you should see a warning.

### A7. Parallel agent, archive, guardrails
- [ ] Create `codex-1` (or a second Claude agent) and let both propose changes to the same sentence.
  - Accept one: the other becomes *stale*, shown with *Show resolved items*.
- [ ] With `stet.runtime = "vscode"`, ask the agent to edit `../paper/main.tex`. The guard hook must block it.
  - This verifies that the `ELECTRON_RUN_AS_NODE=… "Code.exe" … guard` hook command works in Claude Code on Windows (spec §16, M3 notes: unverified).
- [ ] **Archive agent…** → *Archive and delete folder*:
  - its pending items are withdrawn;
  - the folder and the `stet/<name>` branch are gone;
  - doctor stays clean.

### A8. Robustness
- [ ] Reload the VS Code window: the panel comes back with the same state.
- [ ] Open the *agent* workspace in a second VS Code window: no review panel there (by design).
- [ ] Doing a review step with the CLI (`stet reject S…`) updates the panel within a second.

**Worth noting while testing:**
- confusing wording in dialogs;
- actions you expected but didn't find;
- slowness with many items;
- any error notification (copy the text).

---

## B. Claude Code CLI (M2)

Same loop as the desktop-app test (spec §16, M2 notes), but started with `claude` in the agent workspace:

- [ ] On first start, is there an MCP approval prompt, or does `enabledMcpjsonServers` skip it as in the app?
- [ ] Full loop: propose → reject with a reason → revise → accept, without copy-paste.
- [ ] Guardrails: edit the project folder, `git merge`, `git push`, `git checkout master`, edit `.claude/settings.json`, and a shell write such as `sed -i … .claude/settings.json`. All must be blocked.
- [ ] Optional: `stet setup claude` registers the server at user scope.

## C. Codex (M2)

In an agent workspace created with kind *Codex*:

- [ ] Does `.codex/config.toml` (MCP server, `workspace-write`) apply without extra trust steps? (spec §17 item 2)
- [ ] Does Codex read `AGENTS.override.md`, and does it surface the MCP server's instructions?
- [ ] Can the agent commit in the worktree under `workspace-write`? (Submitting works either way, because Stet commits from the MCP server.)
- [ ] Full loop as in B. Note whether Codex supplies `linked` hints for a label rename by itself (spec §17 item 4).
- [ ] Guardrails: Codex has no PreToolUse hook. Check that the sandbox and the git hooks still stop writes to the project folder and merges/pushes of the agent branch.
