# Stet — M0 Specification

> *stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

Status: **v0.5** (M1 done; M2 live-tested with the Claude desktop app, CLI/Codex runs pending; M3 implemented; see §16 notes) · 2026-09-26

Stet lets AI agents (Claude Code, Codex, …) propose changes to a LaTeX project while a human reviews and accepts or rejects each change. Agents never write to the real files. Everything is git-native and runs on Windows, macOS and Linux.

---

## 1. Goals and non-goals

### Goals
- **G1 — Isolation:** agents never modify the user's working copy or main branch. Only Stet, acting on a human decision, applies changes.
- **G2 — Fine-grained review:** agent changes show up as small, independent *items* (word or sentence level for prose) that can each be accepted, rejected, edited or discussed.
- **G3 — Two-way loop:** agents receive rejections, revision requests, comments and conflict notices through tools, with no copy-pasting.
- **G4 — Parallelism:** several agents at once, each isolated. The user keeps editing in parallel.
- **G5 — Agent-agnostic:** works with any agent that can edit files, plus optional MCP tools. Claude Code (CLI and desktop app) and Codex are first-class.
- **G6 — Git and Overleaf:** plain git underneath. Overleaf projects work through the Overleaf git integration.
- **G7 — Multiple frontends:** the VS Code extension comes first, a browser UI later. Both sit on the same service API and UI components.

### Non-goals (for now)
- Shared review queues between people. Each person has their own local queue.
- Protection against a malicious agent. Stet guards against accidents and over-eager agents (see §9).
- Writing Overleaf tracked changes, or any Overleaf-specific UI.
- Semantic LaTeX understanding beyond the tokenizer rules in §6.

---

## 2. Terminology

| Term | Meaning |
|---|---|
| **Main branch** | The user's real branch, e.g. `master` for Overleaf. Configurable. |
| **Working copy** | The user's checkout of the main branch, where they edit. It may contain uncommitted edits. |
| **Agent** | One AI session or workstream, identified by an `agentId` such as `claude-1` or `codex-lit`. |
| **Agent branch** | `stet/<agentId>`, the agent's git branch. Stet owns its history. |
| **Agent worktree** | A git worktree with the agent branch checked out. It is the agent's only writable workspace. |
| **Review base** | The text agents build on: `HEAD` of main plus items that were accepted but not yet committed (§7.3). Stored at `refs/stet/base`. |
| **Changeset** | One submission by an agent: a title, a rationale and a set of items. |
| **Group** | A set of items inside one changeset, of kind `atomic`, `linked` or `related` (§6.4). ID format `G<n>`. |
| **Item** | The smallest reviewable unit, a single change to one location. ID format `S<n>`, e.g. `S12`. |
| **Feedback** | Events the agent needs to know about: rejections, revision requests, comments, stale items, and more. |

Item, group and changeset IDs are short sequential numbers (`S12`, `G7`, `C4`) unique per repository, so people can refer to them in chat ("look at S12").

---

## 3. Architecture

```
 ┌──────────────┐  edits files   ┌──────────────────────┐
 │ Agent        │ ─────────────▶ │ Agent worktree       │  branch stet/<agent>
 │ (Claude Code,│                └──────────┬───────────┘
 │  Codex, …)   │  MCP (stdio) / CLI        │ submit
 │              │ ◀──────────────▶ ┌────────▼───────────┐
 └──────────────┘   feedback       │   stet core        │◀── VS Code extension
                                   │  (service layer)   │◀── Web UI (later: stet serve)
                                   └────────┬───────────┘◀── CLI
                                            │ accept → apply
                                   ┌────────▼───────────┐
                                   │ User working copy  │── git ── Overleaf remote
                                   │ (main branch)      │
                                   └────────────────────┘
```

### Packages (TypeScript monorepo)

| Package | Contents |
|---|---|
| `@stet/core` | Store, git operations, tokenizer and splitter, anchoring, replay, service API, event bus. Has no UI. |
| `stet-tex` (npm) → binary `stet` | CLI and MCP server (`stet mcp`). Later also `stet serve` (HTTP and web UI). |
| `@stet/ui` | Web components: item list, diff view, comment threads, preview viewer. Used by the VS Code webview and by the web UI. |
| `stet-vscode` | VS Code extension. Bundles the core and ui packages and adds native editor integration: decorations, CodeLens, the Comments API. |

**Runtime requirements:** git ≥ 2.28 (for the `reference-transaction` hook) and Node ≥ 20 (see §12 for a Node-free option). A TeX distribution with `latexmk` is needed only for PDF previews.

There is **no long-running daemon**. Every process (extension, MCP servers, CLI) works on the shared on-disk store, using a lock and filesystem events.

---

## 4. Storage layout

The store lives in the git *common* dir (`git rev-parse --git-common-dir`). That makes it per-person, shared by all worktrees, and never committed or pushed:

```
.git/stet/
  config.json            # repo config (§11)
  state.json             # counters (next S/C id), schema version
  agents/<agentId>.json  # agent records
  changesets/C<n>.json
  groups/G<n>.json
  items/S<n>.json
  events.jsonl           # append-only event log (feedback + UI live updates)
  previews/              # PDF preview cache
  lock                   # advisory lock file
```

**Worktrees** are placed *outside* the repository, so LaTeX tools, VS Code search and Overleaf never see them. The default is a sibling folder:

```
<parent>/<repoName>.stet/<agentId>/
```

This is configurable. Stet also adopts worktrees that other tools created, such as the Claude desktop app's session worktrees, when their branch starts with `agentBranchPrefix` (default `stet/`).

**Writes:** all writes are atomic (write to a temp file, then rename) and happen while holding `lock`. Readers never need the lock. The event log is append-only; each line carries an increasing `seq`.

---

## 5. Data model

### 5.1 Agent
```json
{
  "id": "claude-1",
  "kind": "claude-code",          // claude-code | codex | other
  "branch": "stet/claude-1",
  "worktree": "C:/…/paper.stet/claude-1",
  "baseCommit": "<sha of refs/stet/base at last replay>",
  "lastTip": "<agent branch tip at last submit or replay>",
  "replayedAt": "…",              // items resolved before this are gone from the agent branch
  "feedbackCursor": 118,          // last event seq acknowledged by the agent
  "createdAt": "2026-09-26T10:00:00Z",
  "state": "active"               // active | archived
}
```

### 5.2 Changeset
```json
{
  "id": "C4",
  "agent": "claude-1",
  "title": "Tighten the introduction",
  "rationale": "Shortened sentences, removed repetition of 'in this work'.",
  "submittedAt": "…",
  "items": ["S12", "S13", "S14"],
  "groups": ["G7", "G8"]
}
```

### 5.3 Group
```json
{
  "id": "G7",
  "agent": "claude-1",
  "changeset": "C4",
  "kind": "linked",               // atomic | linked | related  (§6.4)
  "title": "Rename sec:intro → sec:introduction",
  "rationale": "…",
  "source": "agent",              // agent | commit | auto
  "items": ["S12", "S15", "S16"],
  "state": "open"                 // open | resolved | broken
}
```
A group is `resolved` once all its members are in final states, and `broken` when a `linked` group has members in mixed outcomes (§6.4.5).

### 5.4 Item
```json
{
  "id": "S12",
  "agent": "claude-1",
  "changeset": "C4",
  "file": "sections/intro.tex",
  "kind": "modify",               // modify | add-file | delete-file | rename-file | binary
  "baseCommit": "<sha the offsets refer to>",
  "range": { "start": 1834, "end": 1851 },   // offsets in the base file (UTF-16 code units)
  "oldText": "which are used for",
  "newText": "which serve",
  "context": { "before": "…up to 80 chars…", "after": "…up to 80 chars…" },
  "fingerprint": "sha256:…",      // hash of file + normalized oldText + newText
  "note": null,                   // optional per-item rationale from the agent
  "groups": ["G7"],               // groups this item belongs to (§6.4)
  "status": "pending",
  "resolution": null,             // on accept: { "appliedText": "…", "edited": bool, "committed": "<sha>|null" }
  "supersedes": null,             // item id this revises
  "conflictsWith": [],            // other pending items overlapping the same base range
  "history": [ { "at": "…", "status": "pending", "by": "stet" } ],
  "thread": [ { "at": "…", "author": "user|agent", "text": "…" } ]
}
```

### 5.5 Item status

```
             ┌─────────── withdraw (agent) ──────────▶ withdrawn
             │
 pending ────┼─ accept (user) ──▶ accepted
    ▲        ├─ reject (user) ──▶ rejected
    │        ├─ request revision ─▶ needs_revision ──(agent resubmits)──▶ superseded
    │        ├─ replay fails to anchor ─▶ stale
    │        └─ agent resubmits changed region ─▶ superseded
    │
    └── new item created with supersedes = old id
```

- Final states: `accepted`, `rejected`, `withdrawn`, `superseded`, `stale`.
- `needs_revision` stays visible and remains in the agent branch until the agent revises it or withdraws it.
- Undo: an `accepted` item can be reverted from the UI. The revert is applied to the working copy like any other change, and the item goes back to `rejected`. A `rejected` item can be restored to `pending` if the agent hasn't removed it yet.
- Members of `linked` groups have extra rules for accept, reject and stale (§6.4.5).

---

## 6. Turning diffs into items

Input: the tree diff `refs/stet/base..stet/<agent>` for the newly submitted commits.

### 6.1 Per file
- **`.tex`, `.sty`, `.cls`, `.md`, `.txt`:** LaTeX-aware splitting (§6.2).
- **`.bib`:** one item per changed entry (`@type{key, …}`). New and removed entries are separate items.
- **Other text files:** one item per line hunk.
- **Binary, new, deleted and renamed files:** one item per file.

### 6.2 LaTeX-aware splitting
1. **Line diff:** histogram diff with zero context, giving changed regions.
2. **Tokenize** the old and new versions of each region into:
   - words (Unicode letters and digits, including internal `-` and `'`)
   - commands (`\[A-Za-z@]+`, or `\` followed by one character)
   - `{` and `}`
   - math delimiters (`$`, `$$`, `\(`, `\)`, `\[`, `\]`)
   - `%`-comments up to the end of the line (one token)
   - whitespace runs; a run with two or more newlines is a *paragraph break*
   - single punctuation characters
3. **Token diff:** Myers diff over the tokens.
4. **Merge** neighbouring edits when the gap between them has at most `mergeGap` non-whitespace tokens (default **2**) and contains no *boundary*. Boundaries are:
   - a paragraph break
   - a sentence end: `.`, `?` or `!` followed by whitespace, except after abbreviations on a configurable list (`e.g.`, `i.e.`, `et al.`, `Fig.`, `Eq.`, `Sec.`, `cf.`, `vs.`, …)
   - `\begin` / `\end`, sectioning commands, `\item`
5. **Grow each item** until it is safe to accept on its own:
   - Whole tokens only; an item never splits a token.
   - **Braces balanced** in both the old and the new text. If not, grow to the enclosing group.
   - **Math is atomic:** an edit touching inline math takes in the whole math span; an edit touching display math takes in the whole display block or environment.
   - **Key arguments are atomic:** an edit inside the argument of `\label`, the `\ref` and `\cite` families, `\input`/`\include`, `\includegraphics`, `\usepackage`, `\begin`/`\end` and similar takes in the whole command, e.g. `\label{sec:intro}` → `\label{sec:introduction}`.
   - Items that now overlap are merged.
6. **Coarsen for rewrites:** if more than `rewriteRatio` (default **0.5**) of a paragraph's tokens changed, its edits become a single item. The ratio is (deleted + inserted tokens) / (old + new tokens), whitespace excluded.
7. **Reflow filter:** edits that only change whitespace and never add or remove a paragraph break are dropped by default (`ignoreReflow: true`). Agent instructions also ask agents not to reflow text.

The defaults are tuned on real papers in M1. All thresholds live in `config.json`.

### 6.3 Changeset membership and supersession
- All items produced by one `submit` belong to that submission's changeset.
- Suppose a new submission changes a base range that overlaps a `pending` or `needs_revision` item from the same agent. The old item becomes `superseded` and the new item gets `supersedes` pointing to it.
- A new item whose fingerprint matches a rejected item is recorded as `rejected` straight away, with the note `repeat of S<n>`. The agent gets feedback that it re-proposed a rejected change. The UI hides such items by default.
- Overlap between items from *different* agents is recorded in `conflictsWith` and shown in the UI. Accepting one makes the other `stale` (§7.5).

### 6.4 Grouping

Splitting (§6.2) is purely mechanical. It doesn't know which items belong together. Groups add that structure, sitting between a changeset and its items.

#### 6.4.1 Group kinds

| Kind | Meaning | Effect |
|---|---|---|
| **atomic** | "These edits are one change." | The members are **merged into a single item** before review, so the reviewer sees one diff. |
| **linked** | "Accept all of these or none; a partial accept breaks the document." | Members stay separate items but are resolved together (§6.4.5). |
| **related** | "Same theme." | Grouped in the UI with a title and rationale, and can be accepted or rejected in one batch. Members stay independent. |

Typical `linked` cases: a `\label` rename plus its references, a new or renamed macro plus its uses, a changed citation key in `.bib` plus its `\cite`s, a symbol renamed consistently across a proof.

#### 6.4.2 Sources of grouping, in order of precedence

1. **Explicit agent hints** (`source: "agent"`): the `groups` parameter of `stet_submit`, and the `stet_group` / `stet_ungroup` tools (§10.1).
2. **Agent commits** (`source: "commit"`): if a submission contains more than one agent commit, each commit becomes a `related` group. The title is the commit subject and the rationale is the commit body. An item belongs to the last commit that touched its range. This source is **skipped when the submit has explicit `groups`**, since the agent has then chosen its own structure.
3. **Automatic detection** (`source: "auto"`), always on:
   - **Repeated substitution:** 3 or more items (`autoRepeatMin`) in the changeset with the same normalized (`oldText`, `newText`) become a `related` group titled `Replace "X" → "Y" (n×)`.
   - **Label rename:** an item changing `\label{a}` → `\label{b}`, together with the items changing `a` → `b` inside `\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref`, `\Cref`, `\nameref`, becomes a `linked` group.
   - **Macro definition and use:** an item that adds or renames a definition (`\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator`, `\def`, `\newenvironment`), together with items in the same changeset that introduce uses of it, becomes a `linked` group.
   - **Citation key:** a changed or added `.bib` key, together with items changing that key inside `\cite`-family commands, becomes a `linked` group.

   An auto group with exactly the same members and kind as an agent group is dropped as a duplicate. The agent can remove auto groups with `stet_ungroup`, and the user can remove them from the UI.

#### 6.4.3 Hint syntax (`where`)
Agents point at code by location in **their own worktree after their edits**. They know those line numbers reliably, whereas text snippets can be ambiguous.

- `"path"`: every item in that file, including file add, delete and rename items
- `"path:12"`: line 12
- `"path:12-20"`: lines 12–20 inclusive, 1-based

An item matches when its new-side range overlaps a `where` range. For a pure deletion, the new-side range is a point, and it matches if the point lies inside the range, inclusive. A `where` that matches nothing is returned as a warning in the submit result. After submit, `stet_group` takes item IDs directly.

#### 6.4.4 Membership rules
- **related:** many-to-many. An item may appear in several related groups and is shown in each.
- **linked:** transitive. If an item is in two linked groups, the groups are merged into one (titles joined, rationales concatenated).
- **atomic:**
  - All members must be in the **same file** and within one paragraph, or within one environment for math and float environments. Otherwise the hint is downgraded to `linked` and a warning is returned.
  - At submit time the merge happens *before* items are created, so the separate items never exist.
  - Via `stet_group` after submit, a new merged item is created and the originals become `superseded` by it.
  - The merged item covers the span from the first to the last member, unchanged text in between included.
- An item belongs to at most one atomic merge. An atomic group disappears once its merged item exists; the item keeps the group's title and rationale as `note`.

#### 6.4.5 Linked-group semantics
- **Accept:**
  - Accepting any member offers "accept all *n* linked items".
  - *Accept all* is all-or-nothing: every member is anchored first (§8), and if any member fails, nothing is applied and the UI shows which member failed.
  - The user may still override and accept a single member (with a warning). The group then becomes `broken`.
- **Reject:** rejecting a member offers either "reject all" or "reject this and ask for revision". The second option marks the other pending members `needs_revision`, with an automatic comment naming the rejected member.
- **Stale:** if a member becomes `stale`, the group becomes `broken`. The remaining members stay `pending`, but *accept all* is disabled until the agent revises or withdraws.
- **Broken groups** produce a `group_broken` feedback event listing each member and its status, so the agent can repair the document, for example by fixing now-dangling references.

---

## 7. Operations

### 7.1 Creating an agent
`stet agent new <id> [--kind claude-code|codex]`, or the VS Code command **Stet: New agent workspace**:
1. Create branch `stet/<id>` at `refs/stet/base` and add the worktree.
2. Write the guardrail files into the worktree (§9). They are kept out of git through `.git/info/exclude`.
3. Register the agent. Print or open the worktree path. From there the user opens that folder in the Claude desktop app, Claude Code, Codex or VS Code.

**Adoption:** the first time the MCP server runs in any worktree whose branch starts with `agentBranchPrefix`, Stet registers it automatically, deriving the id from the branch name. This covers worktrees made by the Claude desktop app when its branch prefix is set to `stet/`.

### 7.2 Submit (agent)
Precondition: the agent's worktree is at the latest replay, or can be fast-forwarded to it.
1. If the worktree has uncommitted changes, Stet commits them to the agent branch with the trailer `Stet-Agent: <id>`. Commits the agent made itself since the last submit are included too.
2. Diff from the previous submit point to the new tip and split into candidate items (§6.1–6.2).
3. Apply grouping (§6.4):
   - resolve explicit `groups` hints
   - merge `atomic` groups into single items
   - create commit groups
   - run automatic detection
   - apply the membership rules
4. Run supersession and repeat-rejection checks (§6.3). Create the changeset, groups and items.
5. Return the items with their group assignments, the ungrouped items and any hint warnings, so the agent can correct them with `stet_group` / `stet_ungroup`.
6. Append `items_submitted` events, which update the UI live.

Uncommitted agent edits count as **drafts** and are never shown for review until submitted.

### 7.3 Accept (user)
1. Relocate the item in the **current working-copy text**. In VS Code that is the open buffer, including unsaved edits (§8).
2. Replace the old text with `newText`, or with the user's edited text if they changed it in the review UI.
   - In VS Code this is a `WorkspaceEdit`, so undo works.
   - The file is saved if it had no unsaved changes before, and left unsaved otherwise.
3. Set the status to `accepted` and store `resolution.appliedText`.
4. **Commit** according to the `autoCommit` setting (default `"when-clean"`):
   - If every affected file matched `HEAD` before the accept batch, Stet commits right after the batch. The batch ends after 10 s without another accept, or on **Finish review**. The commit message is `stet: accept S12, S13 — Tighten the introduction (claude-1)` with trailer `Stet-Applied: S12,S13`.
   - Otherwise the change stays uncommitted and the user commits it along with their own edits. Stet notices later that the accepted text is in `HEAD` and sets `resolution.committed`.
   - The other value is `"never"`.
5. Items overlapping the accepted range get `stale` (§7.5). Linked-group rules apply (§6.4.5).
6. Add an `accepted` event. If the user edited the text, the event includes the final text, so the agent learns the preferred wording.

**Review base:** `refs/stet/base` = `HEAD` + accepted items whose text is not yet in `HEAD`. Stet keeps it as a synthetic commit and rebuilds it after accepts and whenever `HEAD` moves, so agents always see what the user accepted. The user's own **uncommitted** edits are *not* included; agents only see them once committed. The UI shows a hint when uncommitted edits touch lines that have pending items.

### 7.4 Reject, request revision, comment (user)
- **Reject** `(ids, reason?)`: status → `rejected`. For members of linked groups, see §6.4.5. Its fingerprint blocks identical re-proposals (§6.3) and a `rejected` event with the reason is added. The change leaves the agent branch at the agent's next sync.
- **Request revision** `(id, comment)`: status → `needs_revision`, and a `revision_requested` event is added.
- **Comment** `(id, text)`: appended to the item's thread, plus a `comment` event. The agent replies with `stet_reply`.

### 7.5 Stale detection
An item becomes `stale` when either:
- it can no longer be anchored in the review base (§8), or
- an overlapping item was accepted.

A `stale` event is added containing the item's old and new text plus the *current* surrounding text, so the agent can propose again.

### 7.6 Sync / replay (agent)
Replay moves an agent branch onto the current review base. Stet rebuilds the branch from scratch rather than running `git rebase`:

1. Precondition: the agent worktree is **clean**. If it isn't, sync fails and lists the dirty files; the agent has to submit or discard first.
2. Start from `refs/stet/base`.
3. Apply every item of this agent with status `pending` or `needs_revision`, relocating each in the new base. Items that fail to relocate become `stale`.
4. Commit the result as one commit on `stet/<id>` with trailer `Stet-Agent: <id>`, then hard-reset the worktree to it.
5. Update `agent.baseCommit` and return the stale items.

Outcome: accepted items are in the base, rejected, withdrawn and stale ones are gone, and pending ones sit on top. The worktree is always exactly "what the user has + what I'm still proposing".

Stet **never replays an agent's worktree on its own initiative**, because the agent may be mid-edit. When the base moves, the agent's status reports `syncNeeded: true`, and the instructions tell agents to sync before starting new work. Replay also runs automatically as part of `submit` when the worktree is clean except for the new edits: Stet first stashes the edits, replays, then re-applies them. If re-applying conflicts, submit fails with an explanation.

### 7.7 Withdraw (agent)
Status → `withdrawn`. The change disappears from the branch at the next replay.

---

## 8. Anchoring (relocating an item in changed text)

Given the target text `T` and an item (`oldText`, `context`, `range`, `baseCommit`):

1. **Fast path:** if `T` equals the base file, use `range` directly.
2. **Mapped path:** map `range` through the diff `base → T`. If the mapped span still equals `oldText`, use it.
3. **Search:** find `context.before + oldText + context.after` exactly in `T`. A unique hit is used.
4. **Fuzzy:** search for `oldText` near the mapped position, using Bitap / diff-match-patch matching with the context. Accept only a *unique* match at or above a similarity of 0.8.
5. Otherwise the item is **unanchored**, which means `stale` during replay. During accept, the UI shows "can't locate; accept manually?" and offers the diff.

Edge cases:
- For an `add-file` item, the target path must not exist.
- For `delete-file` and `rename-file`, the file content must equal `oldText` (checked via hash); otherwise the item is stale.

Anchoring is used for accepts, replay, and VS Code decorations on files the user is editing.

---

## 9. Guardrails (G1)

Threat model: an agent that tries to be helpful and edits the wrong file, merges its branch, or pushes. Not an adversary.

| Layer | Mechanism | Covers |
|---|---|---|
| **1. Isolation** | The agent's working folder is its worktree, which lives outside the repo. It contains no path into the user's working copy. | Normal edits: >99% of the risk. |
| **2. Agent permissions — Claude Code** | Stet writes `.claude/settings.json` into the worktree (Claude Code loads hooks and settings from the session folder; `settings.local.json` would be read from the *main* checkout on macOS/Linux). It contains: <ul><li>`deny` for `Edit` on the user's project (`Edit(//c/…/paper/**)`) and on Stet's own workspace files</li><li>`deny` for `Bash(git push *)`, `git merge`, `git rebase`, `git switch`, `git worktree`, `git update-ref`, `git branch -f/-D/-m/-M`</li><li>a `PreToolUse` hook `stet guard` (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell) that blocks writes outside the workspace (temp and scratchpad dirs allowed), edits to Stet's files, git commands that bypass review, pointing git elsewhere, and shell commands that write into the user's project</li><li>on macOS/Linux/WSL2: the Bash sandbox (`sandbox.enabled`), writable = workspace + temp + the repo's git dir. Native Windows has no sandbox.</li></ul> If the project tracks `.claude/settings.json`, Stet uses `.claude/settings.local.json` instead. | Absolute-path writes and git misuse. Applies in the CLI and the desktop app. |
| **2'. Agent permissions — Codex** | `.codex/config.toml` in the worktree sets `sandbox_mode = "workspace-write"` (project config needs the folder to be trusted). | Same. |
| **3. Git hooks** (installed in the common hooks dir, so they apply to all worktrees) | <ul><li>`reference-transaction`: rejects any update to `refs/heads/<main>` made from an agent worktree; any update of the main branch that brings in commits only agent branches have (fast-forward or merge commit); and any update to `refs/stet/*` not made by Stet (Stet sets `STET_INTERNAL=1`)</li><li>`pre-push`: rejects pushing from an agent worktree and pushing `stet/*` branches</li></ul> | Merges and pushes that bypass review, including an accidental "merge branch" button click in some UI. |

Hook installation chains existing hooks (kept as `<name>.stet-orig`) rather than replacing them, and `stet hooks uninstall` restores them. With a custom `core.hooksPath` (e.g. husky) nothing is installed unless forced. It can be turned off (`guardHooks: false`).

Known limitations:
- A shell command writing through an absolute path is stopped only by layers 2 and 2' (and only best effort on native Windows, where there is no sandbox).
- **Fast-forward merges:** git writes the working tree *before* any hook can object. The hook stops the branch from moving and prints how to undo the file changes (`git restore --staged --worktree :/`), but the files are already touched.

---

## 10. Agent protocol

### 10.1 MCP server
- **Launch:** `stet mcp` (stdio), started with absolute paths (`node …/cli/dist/index.js mcp`) so it works without PATH setup. Every workspace carries its own registration: `.mcp.json` for Claude Code (approved once per workspace; `enabledMcpjsonServers` is preset) and `.codex/config.toml` for Codex. `stet setup claude|codex` optionally registers it globally (user scope) via the tools' own CLIs.
- **Identity:** the agent is identified from the worktree's branch, using `STET_WORKSPACE` (set in the workspace MCP configs) or else the server's working directory. It can be overridden with `STET_AGENT`. If started outside any agent worktree, all tools return an error explaining how to create one.
- **Instructions:** the server sends a short protocol summary through the MCP `instructions` field, and §10.3 is additionally written to the worktree.
- **Implementation:** dependency-free newline-delimited JSON-RPC 2.0: `initialize` (protocol versions 2024-11-05 to 2025-11-25), `ping`, `tools/list`, `tools/call`.

| Tool | Parameters | Returns |
|---|---|---|
| `stet_status` | — | agent id, main branch, `syncNeeded`, counts by status, `unreadFeedback` |
| `stet_submit` | `title`, `rationale`, `groups?: [{kind, title, rationale?, where: string[]}]`, `notes?: [{where, note}]` | changeset id; items (`id`, `file`, `line`, short old→new preview, `groups`); ungrouped items; hint warnings |
| `stet_group` | `itemIds`, `kind`, `title`, `rationale?` | the group; for `atomic`, the new merged item |
| `stet_ungroup` | `groupId` | ok. The agent may remove its own groups and `auto` groups in its changesets. |
| `stet_sync` | — | new base sha, items that became stale |
| `stet_get_feedback` | `ack?: bool` (default true) | events since the cursor: `accepted` (with the final text if edited), `rejected` (reason), `revision_requested`, `comment`, `stale` (with current context), `repeat_rejected`, `group_broken` (member statuses) |
| `stet_list` | `status?`, `file?` | items with status |
| `stet_show` | `id` (item or group) | old/new text, note, groups, thread |
| `stet_reply` | `itemId`, `text` | ok |
| `stet_withdraw` | `itemIds`, `reason?` | ok |

`where` uses the syntax in §6.4.3. A `note` is attached to every item that its `where` matches.

All tools return concise text meant for the model, followed by a JSON block for machine use. Errors are phrased as instructions, e.g. "worktree has uncommitted changes in intro.tex — call stet_submit or discard them first".

### 10.2 CLI (the same operations)
- **Agent side:** `stet status | submit -t "…" -m "…" [--groups groups.json] | group | ungroup | sync | feedback | list | reply | withdraw`. Every command supports `--json`. Agents without MCP can use these through their shell.
- **User side:** `stet review` (list), `stet accept S12 S13 [--edit]`, `stet reject S12 -m "…"`, `stet revise S12 -m "…"`, `stet comment S12 -m "…"`, `stet agent new|list|archive`, `stet init`, `stet doctor`.

### 10.3 Agent instructions (draft)

Written into each worktree as `CLAUDE.local.md` (Claude Code) and `AGENTS.override.md` (Codex). Codex reads `AGENTS.override.md` *instead of* `AGENTS.md` in the same folder, so Stet prepends the project's own `AGENTS.md`. The files are refreshed after every sync and with `stet agent refresh`.

```markdown
# You are working under Stet review

You are in a *proposal workspace* for a LaTeX project. Nothing you change here
reaches the real document until a human accepts it.

- Edit files in this folder normally. Never touch files outside this folder,
  and never run git merge/push/checkout of other branches.
- Keep changes minimal and local. Do NOT reflow or rewrap lines, reorder
  unrelated text, or reformat whitespace — every such change becomes noise
  for the reviewer.
- When a coherent set of changes is done, call `stet_submit` with a short title
  and a rationale. Submit in logical batches (e.g. one per section or concern).
- Tell Stet how your changes belong together via `groups` in `stet_submit`
  (locations are file:line ranges in *your* folder after editing):
  - `linked` — REQUIRED whenever accepting only some of the edits would break
    or corrupt the document: label/ref renames, macro definition + uses,
    citation keys, notation changed consistently across places.
  - `atomic` — edits within one sentence/paragraph that only read well together.
  - `related` — optional thematic batches with a title and rationale.
- Check the submit result: fix wrong or missing groupings with `stet_group` /
  `stet_ungroup`.
- Before starting new work: call `stet_status`; if `syncNeeded`, call `stet_sync`.
- Call `stet_get_feedback` regularly. For each event:
  - rejected: do not propose the same change again; learn from the reason.
  - revision_requested: revise that passage, then submit.
  - comment: answer with `stet_reply` (and revise if asked).
  - stale: the text changed underneath you; re-propose against the current text if still relevant.
  - accepted with edited text: prefer the human's wording style from now on.
  - group_broken: some linked edits were applied without the others; propose
    whatever is needed to make the document consistent again.
- Use `stet_withdraw` for proposals you no longer believe in.
```

---

## 11. Configuration (`.git/stet/config.json`)

```json
{
  "mainBranch": "master",
  "agentBranchPrefix": "stet/",
  "worktreeRoot": "../{repo}.stet",
  "autoCommit": "when-clean",
  "split": {
    "mergeGap": 2,
    "rewriteRatio": 0.5,
    "ignoreReflow": true,
    "abbreviations": ["e.g.", "i.e.", "et al.", "Fig.", "Eq.", "Sec.", "cf.", "vs."]
  },
  "grouping": {
    "autoRepeatMin": 3,
    "autoDetect": ["repeat", "label", "macro", "cite"],
    "refCommands": ["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref"],
    "citeCommands": ["cite", "citep", "citet", "parencite", "textcite", "autocite"]
  },
  "files": { "tex": ["**/*.tex", "**/*.sty", "**/*.cls"], "bib": ["**/*.bib"] },
  "remote": { "name": "origin", "autoPull": false, "autoPush": false },
  "preview": { "rootFile": "main.tex", "engine": "latexmk -pdf", "enabled": true },
  "guardHooks": true
}
```

An optional **committed** `stet.json` in the repo root supplies team defaults (for example `rootFile` or abbreviations), with the local config taking precedence. It is optional so that Overleaf projects stay clean.

---

## 12. Frontends and service API

### 12.1 Service API (`@stet/core`), used by every frontend
- `listItems(filter)`, `getItem(id)`, `listChangesets()`, `listGroups(filter)`, `listAgents()`
- `accept(ids, {editedText?, overrideLinked?})`, `reject(ids, reason?)`, `requestRevision(id, text)`, `comment(id, text)`, `revertAccepted(id)`, `restore(id)`
- `acceptGroup(id)` (all-or-nothing for linked groups), `rejectGroup(id, reason?)`, `rejectAndRevise(id, reason)` (§6.4.5), `ungroup(id)`
- `preview(id) → {before: png, after: png, page}` (asynchronous, cached)
- `subscribe(listener)`: a live event stream, backed by watching `events.jsonl`
- `commitAccepted()`, `sync remote` (pull / push according to config)

The web UI will expose this API as REST plus Server-Sent Events on `localhost`, protected by a random token, with no other code changes.

### 12.2 VS Code extension (M3)
- **Stet panel** (a native VS Code tree view; see the M3 notes in §16 for why it is not a webview):
  - Tree: agent → changeset → group → item. Ungrouped items sit directly under the changeset, and an item in several related groups appears in each.
  - Linked groups get a chain icon, broken groups a warning icon, and auto-detected groups an "auto" tag that can be dismissed.
  - Filters, plus keyboard review: `j`/`k` to move, `a` accept, `r` reject, `e` edit, `c` comment, `A` / `R` accept or reject the whole group.
- **In the editor:**
  - pending items are highlighted inline (old text struck through, new text shown as ghost text)
  - CodeLens above each item: `✓ Accept · ✗ Reject · ✎ Edit · 💬`
  - hover shows the rationale
- **Threads:** item threads appear through the VS Code Comments API.
- **Commands:** `Stet: Set up project`, `New agent workspace`, `Open agent workspace in…`, `Finish review (commit)`, `Preview S<n> in PDF`.
- **Status bar:** number of pending items, with a warning when agents need a sync.
- **Setup without a command line:** `Set up project` runs the equivalent of `stet init`. MCP configs point at the extension's bundled `stet` entry point.
- **Node-free option (implemented in M3):** the extension launches the bundled server with VS Code's own Electron binary (`ELECTRON_RUN_AS_NODE=1`) when Node.js ≥ 20 is not on PATH (setting `stet.runtime`: `auto` | `node` | `vscode`), so users without Node still get the MCP server.

### 12.3 Web UI (M6)
`stet serve [--port] [--open]` serves `@stet/ui` as a full page with a read-only source view around each item. Features match the panel. Editor integration is replaced by a context view.

---

## 13. Overleaf

- An Overleaf project is used as a git remote (Overleaf's git integration), and the main branch is `master`.
- Stet never pushes `stet/*` branches; the `pre-push` hook enforces this.
- `remote.autoPull`: pull (with `--rebase` for local commits) before rebuilding the review base, so co-authors' browser edits are picked up. Edits by co-authors behave exactly like the user's own edits: items get re-anchored or become stale.
- `remote.autoPush`: push after Stet's accept commits.
- Both are off by default; the VS Code status bar offers "Pull from Overleaf" and "Push to Overleaf".

---

## 14. PDF previews (M5, on request)

1. The user clicks **Preview** on an item.
2. Stet builds two temporary trees: the review base, and the review base plus this item. It compiles them with `latexmk -synctex=1` in a cache directory, reusing auxiliary files between builds.
3. `synctex view` maps the item's line to a page and bounding box.
4. The matching region is rendered from both PDFs (pdf.js in the UI) and shown before/after.
5. Results are cached by (base sha, item id). If a build fails, the LaTeX error log is shown; that alone is useful ("this change breaks compilation").

Agents could later get a `stet_build` tool to compile their own worktree before submitting.

---

## 15. Concurrency

- **Writers:** extension, MCP servers (one per agent session), CLI. All mutations take `.git/stet/lock`, a lock file with PID and timestamp that is treated as stale after 30 s, and hold it only for the duration of a single operation.
- **Git access:** git operations on the main repo are serialized through the same lock. Agents' own git activity happens in their worktrees. Stet uses git plumbing (`commit-tree`, `update-ref`) for `refs/stet/base`, so it never touches the user's index or working tree except when applying accepts.
- **Parallel agents:** they share nothing except the review base. Overlaps between them are detected at the item level (§6.3).

---

## 16. Milestones and acceptance criteria

| M | Scope | Done when |
|---|---|---|
| **M1** ✅ | Core + CLI: store, tokenizer and splitter, anchoring, submit, accept, reject, replay, review base, stale detection | A test corpus of 3–5 real `.tex` papers with scripted agent edits produces sensible items. Accept, reject and replay round-trip correctly while the user edits in parallel. Passes on Windows, macOS and Linux in CI. |
| **M2** | MCP server, `init`, `agent new`, guardrails (permissions, hooks), agent instructions | End-to-end: Claude Code (desktop app **and** CLI) and Codex each complete a propose → reject-with-reason → revise → accept loop without human copy-paste. Guardrail tests: attempted writes to the user repo, merges and pushes are all blocked. |
| **M3** | VS Code extension (panel, decorations, CodeLens, threads, setup commands) | The full workflow runs from VS Code plus the desktop app, with no command line. |
| **M4** | Overleaf remote handling | A co-author's browser edit during review is pulled and re-anchored, or marks items stale. Accepted changes can be pushed. |
| **M5** | PDF previews | Before/after snippet for an item in under ~10 s on a medium paper with a warm cache. |
| **M6** | `stet serve` web UI, structural-change UX (file moves, large changesets), agent notification hooks | Feature parity with the VS Code panel. |

### M1 notes (implemented 2026-09-26)
- Done: everything in the M1 row plus grouping (§6.4) and `stet doctor`.
- Deferred: commit-based groups (§6.4.2 item 2), the macro definition/use auto-detector, undo/restore of resolved items, the git guard hooks (§9, moved to M2 with the other guardrails).
- Automatic detection looks at each item's text *including its context*, so a key cut by splitting is still recognized.
- Rejected fingerprints are derived from rejected items instead of a separate `rejected.json`.

### M2 notes (implemented 2026-09-26)
- Done: MCP server, workspace files (instructions, MCP configs, Claude Code guard settings, Codex config), `stet guard`, git hooks, `stet setup claude|codex`, `stet agent refresh`, `stet hooks`, doctor checks for all of it. Tested with automated tests (protocol, guard rules, hooks against real git, workspace files).
- **Live test with the Claude desktop app (2026-09-26): passed.** Only a folder-trust prompt, no MCP approval prompt (`enabledMcpjsonServers` works); all tools and instructions loaded; full propose → review → feedback → revise → accept loop without copy-paste, including linked groups, an edited accept, a rejected change not re-proposed, and a parallel user edit re-anchored. Guardrails: editing the project (guard hook), `git merge`/`push`/`checkout master` (guard hook), editing `.claude/settings.json` (deny rule), and merging/pushing the agent branch from the project (git hooks) were all blocked.
- Fixes from the live test: key-argument edits (`\label`, `\ref`, `\cite`) are never merged with neighbouring edits (merge gap, paragraph coarsening, touching ranges, atomic hints); a replacement item inherits the groups of the item it supersedes; auto-detection also looks at the agent's earlier pending items; superseded members no longer make a linked group "broken"; duplicate group titles are merged; the guard also blocks shell commands that change Stet's own workspace files.
- Still to do for the M2 acceptance criteria: live runs with Claude Code CLI and Codex (§17 item 2); plans in [live-tests.md](live-tests.md) §B–C.
- Ideas from the test: tell the agent in the sync result *what* changed in the document (it first guessed "another agent's edit"); an MCP server started before a Stet update keeps old code until the session restarts.
- Workspace files are untracked and excluded from submits; if the project tracks one of them, Stet leaves it alone.
- `pre-merge-commit` was dropped: `reference-transaction` catches both merge styles.

---

### M3 notes (implemented 2026-09-26)
- Done: `stet-vscode` extension with the Stet panel (tree agent → changeset → group → item, view badge, show/hide resolved), keyboard review (`a` `r` `e` `v` `c` `d`, `A`/`R` for groups, `j`/`k`), inline decorations (old text struck through, new text as ghost text), CodeLens actions, hovers with diff and action links, diff view (`stet-diff:` documents), item threads via the Comments API (replies go to the agent as comments), status bar, and the commands *Set up project* (creates a git repository and first commit if needed), *New agent workspace*, *Open agent workspace*, *Archive agent*, *Finish review*, *Check setup (doctor)*.
- **Tree view instead of a webview:** a native tree gives keyboard navigation, theming, accessibility and context menus for free and needs far less code. `@stet/ui` is deferred to the web UI (M6), which will need its own rendering anyway.
- **Runtime:** the extension bundles the CLI (`dist/stet.mjs`) and copies it to `.git/stet/bin/stet.mjs`, a path that survives extension updates; `config.cli` records it (with `env: {ELECTRON_RUN_AS_NODE: "1"}` when it runs on VS Code's runtime) and agent workspaces are rewritten when it changes. A `stet` configured by the user (e.g. an npm install) is left alone. The guard hook command uses a POSIX `VAR=value` prefix for that env; Claude Code runs hooks through a POSIX shell (Git Bash on Windows) — **unverified live** for the VS Code-runtime case.
- Core additions: `locateInText` (items in unsaved editor buffers), `uncommittedAccepted` / `commitAcceptedItems` (*Finish review*, CLI `stet commit`), `setCli`, `CliCommand.env`.
- Accepting saves open, modified documents of the affected files first, so unsaved edits are neither lost nor overwritten; the accept is then not auto-committed (the file had the user's own edits).
- Tests: unit tests for the view model; `npm run test:integration -w stet-vscode` starts the installed VS Code with a throwaway profile against a fixture project and checks activation, runtime install for both runtimes, an MCP handshake through the recorded command, CodeLens, hover, diff document, lenses following unsaved edits, accept, and go-to-change (18 checks, both runtimes pass). Not in CI (needs a VS Code install and a display).
- Still to do for the M3 acceptance criteria: a hands-on run of the full workflow from VS Code plus the desktop app (panel, dialogs, keyboard review, threads, setup from scratch, *Finish review*). Test plan: [live-tests.md](live-tests.md) §A; user guide: [vscode.md](vscode.md).
- Not done: *Preview in PDF* (M5), undo of accepted items, dismissing auto groups from the UI (use *Dissolve group*).

## 17. Open points to verify

1. **Claude desktop app:**
   - ~~Does it load the workspace's `.claude/settings.json` and `.mcp.json`?~~ Yes (live test 2026-09-26): hooks, deny rules, MCP server and `CLAUDE.local.md` all active; only a folder-trust prompt.
   - Can its "worktree per session" feature be pointed at the `stet/` prefix so Stet adopts those worktrees?
   - Does it offer to merge or create a PR from the session branch? The hooks must block that.
2. **Codex:**
   - ~~Which untracked instruction file it reads~~: `AGENTS.override.md`, which replaces `AGENTS.md` in that folder (handled).
   - Does the project `.codex/config.toml` (MCP server, `workspace-write`) apply without extra trust steps?
   - Whether the `workspace-write` sandbox lets the agent commit in a worktree. The worktree's `.git` is a pointer into the main repo's `.git`. If committing is blocked, submit still works, because Stet commits from the MCP server process. Also verify that MCP servers run outside the sandbox.
   - Whether Codex surfaces MCP `instructions`.
3. **Splitting thresholds:** tune `mergeGap`, `rewriteRatio` and the abbreviation list on the real corpus.
4. **Grouping in practice:**
   - How reliably do Claude Code and Codex supply `linked` hints unprompted, given only the instructions?
   - Is automatic detection plus "check the submit result" enough, or should submit *warn* when the auto-detectors find a linked pattern the agent didn't declare?
5. ~~Line endings~~: handled in M1 (LF internally, original endings preserved on write).
6. **VS Code extension:** whether `j`/`k` (bound to `list.focusDown`/`Up`) move the selection as well as the focus in the Stet tree, so the editor follows while reviewing by keyboard.
