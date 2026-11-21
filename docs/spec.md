# Stet — M0 Specification

> *stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

Status: **v0.6** (M1 done; M2 live-tested with the Claude desktop app, CLI/Codex runs pending; M3 implemented; security audit and code review fixes; see §16 notes) · 2026-09-26

Stet lets AI agents (Claude Code, Codex, …) propose changes to a LaTeX or Typst project while a human reviews and accepts or rejects each change. Agents never write to the real files. Everything is git-native and runs on Windows, macOS and Linux.

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
| `@stet/core` | Store, git operations, splitter, anchoring, replay, service API, event bus, and the language profiles (§6.0) that hold everything it knows about LaTeX and BibTeX. Has no UI. |
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
  notes/N<n>.json        # reviewer notes to agents (§7.8)
  events.jsonl           # append-only event log (feedback + UI live updates)
  changed                # rewritten after an operation changes any record (UI live updates)
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
  "parts": [                      // linked groups only, optional (§6.4.6)
    { "title": "\\label{sec:intro} → \\label{sec:introduction}", "items": ["S12"] },
    { "title": "\\ref{sec:intro} → \\ref{sec:introduction} (2×)", "items": ["S15", "S16"] }
  ],
  "state": "open"                 // open | resolved | broken
}
```
A group is `resolved` once all its members are in final states, and `broken` when a `linked` group (or one of its parts) has members in mixed outcomes (§6.4.5, §6.4.6). Part `k` of group `G7` is addressed as `G7.k` (1-based).

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
  "resolution": null,             // on accept: { "appliedText": "…", "edited": bool, "committed": "<sha>|null", "headBlob": "<blob of the file in HEAD at the accept>|null" }
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

### 6.0 Language profiles
Everything Stet knows about a document language is in its **profile** (`packages/core/src/lang/`): `latex.ts` and `latex-preview.ts`, `typst.ts`, `bibtex.ts`, and `plain.ts` for any other text. The rest of Stet works on text, paragraphs, sentences and changes, and asks the file's profile for the rest. A profile has optional sections, and without one Stet falls back to what works for any text:

| Section | What it holds (LaTeX) | Used by | Without it |
|---|---|---|---|
| `syntax` | tokenizer; structure lines and boundaries (`\section`, `\begin`, `\item`); maths and key arguments kept whole; verbatim environments; what ends a sentence; nesting | splitting (§6.2), moves (§6.4.7), replacements in parts | changes are whole changed lines; moves see sentences only |
| `splitUnits` | (BibTeX) one item per entry | splitting (§6.1) | lines |
| `references` | keys defined (`\label`; BibTeX: entries) and used (`\ref`, `\cite` with the configured commands) | rename and *Add reference* groups (§6.4) | no such groups |
| `definitions` | macros, environments, TikZ styles: defined, used | macro groups; parts | none |
| `includes` | files read in (`\input`, `\includegraphics`, …) | *Add file and read it in* groups | none |
| `parts` | global changes (packages, classes, includes); what nests (braces, environments, maths) | parts of linked groups (§6.4.6); which changes complete a preview | none |
| `typesetter` | latexmk in TeX Live (or the image's), SyncTeX, the log's errors and missing files, the words the source typesets | PDF previews (§14), `stet doctor` | no previews |
| `agentTerms` | examples for agents (`\label` with its references, an undefined macro) | the agents' instructions, the MCP tools' descriptions | generic examples |

A file's profile is chosen by the config's patterns (`files.tex`, `files.bib`, `files.typ`); keys are matched by kind across languages (a `.bib` entry defines the citation key a `\cite` or a Typst `@key` uses). The config keeps its shape: `files.tex` and the `preview` settings are the LaTeX profile's. The project's own language (`language`: `latex` or `typst`) is detected from its files when Stet is set up; the agents' instructions, the MCP tools' examples and PDF previews follow it.

#### Typst
`lang/typst.ts`. Specified by `packages/core/test/typst.test.ts`, written before the profile and mirroring the LaTeX tests. It covers tokens, splitting, references and citations, parts, files read in, prose (raw text, rebuilt sentences, moved paragraph breaks), and six realistic revisions, each reviewed in every way it allows: polishing a paper, restructuring, moving a proof into an appendix, maths, a figure with a table, and scripting (`#let` data, `#for`, `#if`). `scenarios.test.ts` and `moves.test.ts` run in both languages (`DOC_LANGS` in `test/helpers.ts`). The decisions:

- **Files:** `files.typ` (default `*.typ`); code blocks fenced as `typst`. The tokenizer follows Typst's three modes (markup, code, maths): `#name` is a command; `[ ]` nest everywhere, `( )` and `{ }` in code; `$…$` is maths (inline or display); `//` and `/* */` are comments; raw text (backticks) and strings are words only, and raw text keeps its spaces; `\#`, `\$`, `\@` are plain characters. A label `<a>` and a reference `@a` are one token each. Headings (`=`, `==`, …), list and term markers, statements (`#let`, `#set`, …) and block calls (`#figure`, `#table`, …) are structure lines; a line of closing brackets (`] <thm:main>`) is one too. In code, `,` and `;` end a unit as a sentence's full stop does: table cells and arguments are changes of their own.
- **References and citations:** `<key>` after markup defines a label (not a label passed to a function); `@key` and `#ref(<key>)` use it, and `#ref(<key>)` is taken whole like `\ref{key}`. `@key` and `#cite(<key>)` are citations when the bibliography defines the key, so whether `@key` is a reference or a citation follows from what the project defines, not from its syntax. Bibliographies are BibTeX (`.bib`, the existing profile) for now. Hayagriva (`.yml`) is to come later as a profile of its own whose entries define citation keys: nothing may assume that citation keys come only from `.bib` files. (Renaming an entry's key, and nothing else, is one change of the .bib file now, so it links with the renamed citations: for LaTeX too.)
- **Definitions and parts:** `#let` defines a name (with or without parameters), used as `#name` or by name in maths, and is joined with its uses in parts. `#import`, `#set` and `#show` are global. A reference to a missing label or citation is an error in Typst, not a `??` warning (the profile's references are *strict*): a label or bibliography entry and its references are never in separate parts, a detected rename is linked without parts, and a new label is linked with new references to it (test report 5e4c6af, D1, D5). Comments and strings in code are neither labels nor references.
- **Includes:** `#include "…"`, `#import "…"` (a local file), `#image("…")`, `#bibliography("…")` and the data loaders (`read`, `json`, `csv`, `yaml`, …) read files in.
- **Project language:** detected at setup from the files (`.typ` and no `.tex` → Typst, otherwise LaTeX) and kept in the config as `language`. `documentProfile(cfg)` follows it, and so do the agents' instructions ("for a Typst project", with Typst examples).
- **No PDF previews yet:** Typst has no SyncTeX to find a change on the page. The preview status is *unavailable* with a message saying so; VS Code shows no preview entries for Typst changes and projects.
- **Moves:** a whole block (`#figure(…)[…] <a>`, `#block[…]`, a display formula) moved is named by what it is: "(figure, unchanged)".

### 6.1 Per file
- **Files of `files.tex`** (default `*.tex`, `*.sty`, `*.cls`, `*.ltx`, `*.dtx`): the LaTeX profile's splitting (§6.2).
- **Files of `files.typ`** (default `*.typ`): the Typst profile's splitting, by the same steps (§6.2).
- **Files of `files.bib`** (default `*.bib`): one item per changed entry (`@type{key, …}`). New and removed entries are separate items; an entry whose key alone changed, in its place, is one item.
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
3. **Token diff:** Myers diff over the tokens, with the common prefix and suffix anchored first.
   - **Paragraphs paired by similarity:** changed regions only blank lines apart are diffed together. Where a region has several paragraphs on a side, old and new paragraphs are first paired in order by word similarity (shared words in order, at least 0.5; `PAIR_MIN`), and diffed pair by pair; what lies between pairs is diffed on its own, and edits don't cross a pair's edges. A paragraph split in two (or two merged) pairs with both. Before 2026-11-19, lines were paired by position: a paragraph inserted before one edited in place showed as "old → new paragraph" plus the edited one inserted again (bug report C42).
   - **Unrelated replacements:** a change whose old and new text are less alike than that, and cover whole paragraphs, is widened to the whole paragraphs and keeps its two halves (a deletion and an insertion, each with a paragraph break). At submit, the halves replace it when one of them may belong to a move (§6.4.7: a pure deletion or insertion elsewhere at least 0.5 alike); otherwise it stays one replacement.
   - **Structure lines:** for this pairing, a sectioning line or `\begin`/`\end` line is a paragraph of its own, so a heading isn't glued to the paragraph after it. A paragraph also pairs with one that holds at least 80% of it in order (most sentences deleted, or many added).
   - **Several paragraphs replaced by unrelated text** (between pairs, or in a region without pairs) are one replacement, not a token diff that matches stray words.
   - **Sliding:** an insertion or deletion that could sit a few tokens earlier or later goes where the whitespace around it matches exactly, then where it starts a sentence, after a space. A sentence moved inside its paragraph then comes out as whole sentences.
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
5a. **One change per paragraph:** a pure insertion or deletion of several paragraphs is cut into one change per paragraph, and per heading or environment (an environment the run opens stays whole, with its contents), each taking a paragraph break along, so each can be decided alone. A deletion right next to an insertion is one replacement, and a change of whitespace only goes with its neighbour.
6. **Coarsen for rewrites:** if more than `rewriteRatio` (default **0.5**) of a paragraph's tokens changed, its edits become a single item. The ratio is (deleted + inserted tokens) / (old + new tokens), whitespace excluded. The same for a **sentence**: more than 0.4 of it changed, or four or more pieces in it, make it one item (bug report C31: its pieces rarely read right alone). So do two edits of one sentence at most six words apart when one of them rebuilds it, changing its punctuation (`,` `;` `:` brackets, dashes) or a word's capitals ("Plants are … and therefore" → "Because plants are …, they": either alone broke the sentence; test report 2026-11-20). Plain word swaps a few words apart stay separate items. A paragraph break that moves past a sentence (a sentence that ended one paragraph starts the next, or the reverse) is one item too, *paragraph break moved*: paragraphs are paired before their words, so the sentence came out deleted from one paragraph and inserted into the next, a move "word for word" of text that never moved (test report 2026-11-20). A deletion and an insertion next to each other are joined when together they keep the words in order (with whitespace only between them: all but a few) and a paragraph break moves. Summaries show each side at its break, and the inline diff only the breaks. Line breaks `\\`, `&`, `;` and the boundary commands of step 4 end a "sentence" too, so formulas, tables, pseudocode and TikZ stay fine-grained.
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
| **linked** | "Accept all of these or none; a partial accept breaks the document." | Members stay separate items but are resolved together (§6.4.5), or part by part when the group has parts (§6.4.6). |
| **related** | "Same theme." | Grouped in the UI with a title and rationale, and can be accepted or rejected in one batch. Members stay independent. |

Typical `linked` cases: a `\label` rename plus its references, a new or renamed macro plus its uses, a changed citation key in `.bib` plus its `\cite`s, a symbol renamed consistently across a proof.

#### 6.4.2 Sources of grouping, in order of precedence

1. **Explicit agent hints** (`source: "agent"`): the `groups` parameter of `stet_submit`, and the `stet_group` / `stet_ungroup` tools (§10.1).
2. **Agent commits** (`source: "commit"`): if a submission contains more than one agent commit, each commit becomes a `related` group. The title is the commit subject and the rationale is the commit body. An item belongs to the last commit that touched its range. This source is **skipped when the submit has explicit `groups`**, since the agent has then chosen its own structure.
3. **Automatic detection** (`source: "auto"`), always on:
   - **Repeated substitution:** 3 or more items (`autoRepeatMin`) in the changeset with the same normalized (`oldText`, `newText`) become a `related` group titled `Replace "X" → "Y" (n×)`.
   - **Label rename:** an item changing `\label{a}` → `\label{b}`, together with the items changing `a` → `b` inside `\ref`, `\eqref`, `\pageref`, `\autoref`, `\cref`, `\Cref`, `\nameref`, becomes a `linked` group. Each item is proposed as its own part (§6.4.6): a missing label is only a warning. Detection compares how often each key occurs in an item's old and new window, since the window's context is the original text and may contain an unchanged reference nearby.
   - **Definitions and uses** (`macro`): an item that adds, removes or renames a definition, together with the items that start using the new name or stop using the old one, becomes a `linked` group (*Rename macro \est → \estim*, *Define \R and use it*): a use without its definition is an error, not a warning. Definitions are commands (`\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator`, xparse forms, `\def`, `\let`, …), environments (`\newenvironment`, `\newtheorem`, …) and TikZ styles (`name/.style=`, `\tikzstyle`; used in option lists). Until 2026-11-19 this was described here but not implemented.
   - **Citation key:** a changed or added `.bib` key, together with items changing that key inside `\cite`-family commands, becomes a `linked` group, again with one proposed part per item.

   An auto group with exactly the same members and kind as an agent group is dropped as a duplicate, and so is an automatic related group whose changes are all in one linked group. The agent can remove auto groups with `stet_ungroup`, and the user can remove them from the UI.

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
**When a group is linked.** All-or-nothing is tiring to review, so `linked` is kept for changes where accepting only some would break the document or lose text. Stet links what it detects itself: moves and passages moved and rewritten (§6.4.7), label and citation-key renames (with a part per change, §6.4.6), and a file added or deleted with the `\input`, `\include` or `\includegraphics` that reads it in (`autoDetect: "input"`). An agent's linked group (2026-11-19) is checked: Stet finds the sets of changes that need each other by the joining rules of §6.4.6, starting from single changes, plus **the same symbol or term replaced** (`$n$` → `$m$`, `\alpha` → `\beta`, a word of four letters or more; short words only in math; never the keys of a rename). Identical changes and the same symbol count only within one of the agent's parts, so a notation change it split by section stays split.
- If all changes form one set, the group stays linked.
- Otherwise, in `stet_submit`, the group becomes `related` (title and rationale kept, so *Accept all* still works), each set of two or more changes becomes a linked group of its own (titled after the agent's part, if it lies in one), and the submit result tells the agent, with the way out. `stet_group` refuses such a linked group instead, naming the sets.
- The way out: a `reason` on the hint (`stet_group`: `reason`; CLI: `--reason`), one sentence on why accepting only some breaks the document. The group then stays linked as given, and its rationale starts with "Linked because: …" for the reviewer.

- **Accept:**
  - Accepting any member offers "accept all *n* linked items".
  - *Accept all* is all-or-nothing: every member is anchored first (§8), and if any member fails, nothing is applied and the UI shows which member failed.
  - The user may still override and accept a single member (with a warning). The group then becomes `broken`.
- **Reject:** rejecting a member offers either "reject all" or "reject this and ask for revision". The second option marks the other pending members `needs_revision`, with an automatic comment naming the rejected member.
- **Stale:** if a member becomes `stale`, the group becomes `broken`. The remaining members stay `pending`, but *accept all* is disabled until the agent revises or withdraws.
- **Broken groups** produce a `group_broken` feedback event listing each member and its status, so the agent can repair the document, for example by fixing now-dangling references.

#### 6.4.6 Parts of linked groups
Agents tend to link long lists of changes (notation changed across a paper, a label and dozens of references). All-or-nothing review of such a list is hard, so a linked group can be split into **parts** that are decided one at a time. Every part must satisfy two conditions:

1. **Accepting it alone keeps the document compiling.** In LaTeX warnings are fine (an undefined reference or citation prints `??`), errors are not (an undefined macro or environment). In Typst an undefined reference or citation is an error too.
2. **Accepting it does not keep any other part from being accepted later.**

Changes that can't be shown to meet them are not split. Parts come from:
- the agent: `parts: [{title, where}]` in a `linked` hint of `stet_submit`, or `parts: [{title, itemIds}]` in `stet_group`. Changes of the group that no part names form one more part, "Other changes";
- automatic label-rename and citation-key groups: one proposed part per item;
- merging: when linked groups merge, their parts are kept (a group without parts counts as one part).

Stet then joins proposed parts, and reports each join in the submit result:
- **Same change:** items with the same old and new text (whitespace-normalized) always end up in one part. Forty copies of `\mathcal{A}` → `\mathsf{A}` are reviewed as one unit.
- **Definitions and uses:** an item whose changed lines define a command (`\newcommand`, `\renewcommand`, `\providecommand`, `\DeclareMathOperator`, `\DeclareRobustCommand`, xparse forms, `\def`, `\let`, `\newif`, `\newlength`, …) or an environment (`\newenvironment`, `\newtheorem`, …) is joined with every item whose changed lines use it.
- **Whole-file and global changes:** if any item adds, deletes, renames or replaces a whole file, or changes `\usepackage`, `\RequirePackage`, `\documentclass`, `\input`, `\include` or library loads, Stet can't tell what depends on it: the group stays one unit.
- **Balance:** parts whose braces, environments, `\[ \]`, `\( \)` or `$` only balance together are joined.
- **Independence:** on the review base the members were made against, Stet applies each part alone and checks every other part: if one of its items overlaps an applied change (accepting would make it stale) or can't be located afterwards, the two parts are joined. Repeated until nothing changes.
- Parts with nothing pending are decided and stay as they are; only parts with pending items are joined (except when they share an item).

If one part is left, the group has no parts. Parts are settled again when a member is superseded (the replacement takes its place) or merged into an atomic item.

**Review:** each part is accepted or rejected on its own (`G7.2`), and the rules of §6.4.5 apply within it: accepting or rejecting a single item of a part asks for the rest of that part. A part with mixed outcomes makes the group `broken`. Parts decided differently from each other don't: once every part is decided and some were accepted while others were not, the group is `resolved` and the agent gets a `group_partial` event listing each part and its outcome, since the document compiles but may be inconsistent.

The two halves of a move (§6.4.7) always end up in one part.

#### 6.4.7 Moves
Moving a passage gives a deletion in one place and an insertion in another. Reviewed as two unrelated changes, that is hard to read, and the reviewer can't easily tell whether the text changed on the way. At submit, Stet pairs them as a **move** (`moves.ts`, `detectMoves`):
- **Same agent:** a pure deletion and a pure insertion among the agent's pending items, in the same file or another one, of this round or earlier ones. Until 2026-11-13 only items of one submission were paired; but a later submit re-splits pending items (§6.3), which can leave the two sides of a move in different rounds.
- **Long enough:** at least `grouping.moves.minWords` words (7), and a sentence or more (sentence ends as in §6.2, abbreviations excluded) or a whole paragraph (blank lines, or a structure line such as `\section` or `\begin`, on both sides) or environment (`\begin{X}` … `\end{X}`). A handful of moved words stays a deletion and an insertion. (Until 2026-11-19: 15 words and two sentences.)
- **Nearly word for word:** words are compared with spacing and line breaks ignored. One changed word per 10 words, at least one, still makes a move, with `changed` set; `maxChangedWords`, if set, caps that (default: no cap; until 2026-11-19 one per 20 words, at most 3). For each differing stretch, the longer side counts.
- **Headings and environment lines** moved as they are count as moves however short: alone, the deletion or insertion would lose or duplicate them.
- **Neighbouring blocks:** moves whose deletions are next to each other and whose insertions follow each other at one place, in the same order, are one move (each paragraph is a change of its own, §6.2 step 5a). Paragraphs that only leave together or only land together are separate moves, so a reordered section is a move per paragraph, not one all-or-nothing change. For this, paragraphs between pairs (§6.2 step 3) that have a counterpart among the other side's unpaired paragraphs are removed and inserted paragraph by paragraph, and the halves of an unrelated replacement come apart paragraph by paragraph.
- **Moved and rewritten:** a deletion and an insertion that miss that but are at least 0.5 alike (word similarity, each a sentence or more of at least `minWords` words) are not a move, but are linked, as *Moved and rewritten "…"* (`detectRewritten`): accepting only one would lose or duplicate the passage.
- Exact moves are paired first; each item is in at most one move. `grouping.moves.enabled: false` turns detection off.
- **Several blocks** (bug report 2026-11-13): blocks moved from different places that land next to each other form one insertion, and blocks next to each other that go to different places one deletion. Stet finds the deletions (insertions) of at least 5 words each that occur, in one stretch each, inside one insertion (deletion), and makes them one move if together they cover it, with the thresholds above applied to the whole.
- **Reordered blocks:** a deletion and an insertion that hold the same paragraphs (split at blank lines) in another order are one move too. This happens when two blocks that were next to each other move together and swap places, or when a block moves next to another one's pending move: re-splitting joins both deletions and both insertions. Each paragraph of the insertion is compared with the closest one of the deletion; the changed words of all pairs count against the thresholds, and the display compares paragraph with paragraph.
- **Superseded and withdrawn items:** when an item of a move is superseded at a later submit or withdrawn, the move is dissolved (`dissolveMoves`): its automatic group is deleted and the other items lose `move`, so the group isn't inherited by a replacement that moves something else. Detection then runs again over all pending items of the agent and pairs what is still a move.

All items of a move get `move: {from: [...], to: [...], changed}` (ids in text order: `from` as the blocks appear in the insertion, `to` as they appear in the deletion; Stet 0.7.0 stored single ids, still read), and an automatic linked group *Move "…" (3 sentences, unchanged)* or *(…, 1 word changed)* links them (it merges with an agent's linked group like any other). Accepting or rejecting one item of a move always takes the rest along, also without the group (`withMovePartners`, `linkedMembers`): half a move would drop or duplicate the passage. Parts never separate the halves (§6.4.6). The submit result reports each move to the agent, and asks it to check that changed words are intended.

Since items are immutable, a move without changed words inserts exactly the text it removes; the user can still edit the inserted half when accepting (`e`). A source passage the user edited in the meantime makes the deletion stale, like any other item.

**Display:** the panel shows the move group with the halves *⇣ moved out* and *⇡ moved in* (with *· n words changed*). In the editor, the moved-out passage is struck through with a note *⇣ moved to line N*; the insertion point shows *⇡ moved here from line N, word for word* instead of the text, or, in the editor's warning colour, *… with 1 word changed: "small" → "short"*. The hover shows the passage and the changes; the CodeLens reads *Accept move* / *Reject move* with a link to the other half. The CLI prints `moved out` / `moved in … word for word` and, in `stet show`, the changed words.

**Not detected:** a passage moved within its own paragraph is usually one rewritten item of that paragraph (§6.2), not a deletion and an insertion. Nor is a move whose insertion also holds new text beyond the allowed changed words.

**Splitting (§6.2):** changed line regions are widened to whole paragraphs only where the change is part of a paragraph: a region that starts (ends) with a paragraph break on both sides isn't widened in that direction. Before 2026-11-13, a deleted paragraph followed by a heading was widened into the heading's paragraph and merged with a change below it, so the move came out as one rewritten item.

**Token diff (§6.2, `splitSegment`):** before the token diff, a segment's common prefix and suffix are taken off, and if one side is a suffix of the other, the rest is a pure insertion (deletion) in front. jsdiff matches greedily from the front: for a block inserted before a paragraph whose first words also occur in the block, it matched those words inside the block, and the insertion came out as a replacement such as `"The algorithm " → "<block> The algorithm "`, which isn't paired as a move (bug report 2026-11-13).

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
4. **Commit** according to the `autoCommit` setting:
   - `"on-finish"` (default since 2026-09-27; per-accept commits made the history noisy): accepting only writes the working copy. **Finish review** (`stet commit`) commits all accepted-but-uncommitted items in one commit. The summary line is the changeset title(s), editable by the user; the body lists the accepted items per changeset, with the trailer `Stet-Applied: S12,S13,…`. The affected files are committed as they are, including the user's own edits in them.
   - `"when-clean"`: commit right after each accept whose files matched `HEAD` beforehand; otherwise the change waits for Finish review.
   - Either way, the user may also commit accepted changes themselves; Stet notices that the accepted text is in `HEAD` and sets `resolution.committed`.
   - Only settings that differ from the defaults are written to `config.json`, so improved defaults reach existing repositories.
5. Items overlapping the accepted range get `stale` (§7.5). Linked-group rules apply (§6.4.5).
6. Add an `accepted` event. If the user edited the text, the event includes the final text, so the agent learns the preferred wording.

**Review base:** `refs/stet/base` = the user's text as agents should see it + accepted items not yet in it. Stet keeps it as a synthetic commit (parent: `HEAD`) and rebuilds it after accepts and whenever `HEAD` or the shared edits change, so agents always see what the user accepted. Which of the user's own **uncommitted** edits are included is the setting `shareEdits` (added 2026-10-15; before, agents only ever saw committed text, which forced users to commit drafts just so agents could see them):

| `shareEdits` | Agents see |
|---|---|
| `manual` (default) | The saved project files as of the user's last **Share my edits** (`stet share`). A new commit on main replaces an older share. |
| `saved` | The saved project files whenever an agent syncs or submits. |
| `committed` | `HEAD` only (the behaviour before 2026-10-15). |

The snapshot of "saved project files" is taken with a temporary index (a copy of the user's, so git re-reads only changed files; the user's index is never touched): tracked files and files staged with `git add`, as on disk, plus new **TeX/BibTeX** files that `.gitignore` doesn't exclude. Other new files (build output such as `.aux` or `.pdf`) stay out; staging one shares it. Unsaved editor buffers are not included (the extension saves the project's files before sharing). The snapshot requires the project folder to have the main branch checked out. The share is stored in `state.json` as `shared: {head, tree, at}`.

Which accepted items are added on top (fixed 2026-11-12):
- **Not yet committed** means `HEAD`'s file is still what it was at the accept (`resolution.headBlob`): accepting writes only the working copy. Once the user commits the file, it holds the change or whatever they made of it since (edited, moved, removed), and the item is marked committed. Items accepted before 0.6.1 have no `headBlob`: a commit touching the file after the accept counts; without one, `HEAD`'s file is recorded then.
- **On top of shared edits:** the shared edits already hold every item accepted before they were taken, or the user's later version of it, so those items are not added again. With `saved` that is every item; with `manual`, items accepted after the share (`at`) are added. A share from before 0.6.1 has no `at`; its items are added if their old text is found, as before.

`manual` is the default because sharing everything automatically shows agents half-written drafts, which they may "fix" or build proposals on that later go stale. The UI shows when saved edits exist that agents don't see.

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

### 7.8 Reviewer notes (user → one agent)
A **note** asks one agent for something about a passage that has no proposed change yet ("shorten this paragraph", "check this proof"). Record `notes/N<n>.json`: `agent`, `file`, the passage `text` with its `range` and `context` (as for items, so it can be found again; taken from the reviewer's view, unsaved editor text included), `body`, `state` (`open` | `resolved`), `deliveredAt`, and a `thread`.
- **Leaving one:** `addNote(agent, {file, start/end or fromLine/toLine, text?}, body)`. Only active agents; paths inside the project; a `note_added` event (not feedback).
- **Delivery at the next sync:** `stet_sync` delivers every open, undelivered note of the agent, located (§8, without a reference text) in the agent's workspace as it is after the sync, with its `file:line` range, the quoted passage, and any replies written before delivery. A passage that can't be found is delivered with its quote and a remark. A note is delivered once (`deliveredAt`). Notes don't change the base, so `stet_status` reports `notesWaiting` and the instructions tell agents to sync then. Sync still refuses a workspace with unsubmitted edits, but delivers the waiting notes in its refusal: a note should not wait until the agent's current work is done.
- **Afterwards:** a conversation like an item's. The agent answers with `stet_reply N3` (`note_reply`); the reviewer's replies are `note_comment` feedback, and *Resolve* gives `note_resolved` feedback, and *Reopen* (from History) `note_reopened`. Note events from before the delivery are not repeated as feedback, since the delivery included them. Resolved notes are never delivered. Archiving an agent resolves its open notes.

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

Threat model:
- **Primary:** an agent that tries to be helpful and edits the wrong file, merges its branch, or pushes.
- **Secondary:** an agent steered by text in the document or its sources (prompt injection) that tries to get changes past the reviewer. Where the agent tool has an OS sandbox (Claude Code on macOS/Linux/WSL2, Codex), Stet must hold against this too. Without a sandbox (Claude Code on native Windows), the agent runs shell commands as the user; the guard hook catches mistakes, not a determined adversary (see *Known limitations*).

**Invariant:** an agent can write only its worktree (plus temp dirs) and the worktree's private git dir. The project folder, the shared git dir (config, hooks, objects, refs) and Stet's store in it are read-only to the agent. Stet's own processes (MCP server, CLI, VS Code), which the agent's sandbox does not cover, do all writes on the agent's behalf and treat everything the agent controls as untrusted.

| Layer | Mechanism | Covers |
|---|---|---|
| **1. Isolation** | The agent's working folder is its worktree, which lives outside the repo. It contains no path into the user's working copy. | Normal edits: >99% of the risk. |
| **2. Agent permissions — Claude Code** | Stet writes `.claude/settings.json` into the worktree (Claude Code loads hooks and settings from the session folder; `settings.local.json` would be read from the *main* checkout on macOS/Linux). It contains: <ul><li>`deny` for `Edit` on the user's project (`Edit(//c/…/paper/**)`) and on Stet's own workspace files</li><li>`deny` for `Bash(git push *)`, `git merge`, `git rebase`, `git switch`, `git worktree`, `git update-ref`, `git branch -f/-D/-m/-M`</li><li>a `PreToolUse` hook `stet guard` (Edit, Write, MultiEdit, NotebookEdit, Bash, PowerShell) that blocks writes outside the workspace (temp and scratchpad dirs allowed), writes into the shared git dir, edits to Stet's files and to the worktree's `.git` link (case-insensitive on Windows), git commands that bypass review, `git config`/`git remote`/`git submodule` changes, pointing git elsewhere (`--git-dir`, `GIT_DIR`/`GIT_CONFIG_*`, `core.hooksPath`, aliases), and shell commands that write into the user's project</li><li>on macOS/Linux/WSL2: the Bash sandbox (`sandbox.enabled`), writable = workspace + temp + the worktree's *private* git dir (`.git/worktrees/<name>`: index, HEAD). The shared git dir stays read-only, so agents cannot commit themselves; `stet_submit` commits for them. Native Windows has no sandbox.</li></ul> If the project tracks `.claude/settings.json`, Stet uses `.claude/settings.local.json` instead. | Absolute-path writes and git misuse. Applies in the CLI and the desktop app. |
| **2'. Agent permissions — Codex** | `.codex/config.toml` in the worktree sets `sandbox_mode = "workspace-write"` (project config needs the folder to be trusted). | Same. |
| **3. Git hooks** (installed in the common hooks dir, so they apply to all worktrees) | <ul><li>`reference-transaction`: rejects any update to `refs/heads/<main>` made from an agent worktree; any update of the main branch that brings in commits only agent branches have (fast-forward or merge commit); and any update to `refs/stet/*` not made by Stet (Stet sets `STET_INTERNAL=1`)</li><li>`pre-push`: rejects pushing from an agent worktree and pushing `stet/*` branches</li></ul> | Merges and pushes that bypass review, including an accidental "merge branch" button click in some UI. |

Hook installation chains existing hooks (kept as `<name>.stet-orig`) rather than replacing them, and `stet hooks uninstall` restores them. With a custom `core.hooksPath` (e.g. husky) nothing is installed unless forced. It can be turned off (`guardHooks: false`).

**Stet-side checks** (they hold even when layer 2 is bypassed):
- **No git through the agent's metadata:** an agent can change its worktree's `.git` link and private git dir at any moment, also between a check and the git call after it. So Stet never runs git through them: it works on an agent's files (submit, sync, doctor) with `GIT_DIR` = the project's shared git dir (config the agent cannot write), the agent folder as `GIT_WORK_TREE`, and an index file of its own (`AgentFiles`); the agent branch is read and moved in the project's repository, and the resulting index is copied into the worktree afterwards so `git status` there stays tidy. Tracked workspace files are looked up in the agent branch, not the worktree's index. Stet still verifies the `.git` link, `commondir` and the absence of `config.worktree`, to report a tampered workspace clearly.
- **No `core.fsmonitor`** for any git command Stet runs (`-c core.fsmonitor=false`).
- **No hooks, no submodules in agent worktrees:** git calls there run with `core.hooksPath` set to a path that cannot contain hooks (a relative hooks path such as `.hooks` would otherwise resolve to the agent's files; `--no-verify` does not stop `post-commit` or `prepare-commit-msg`), with submodules ignored (their config is agent-writable), with commit/tag signing off (a relative signing program would be the agent's file; Stet's internal commits are never signed), and with every configured filter driver switched off (`filter.<name>.clean/smudge/process` empty): the agent writes `.gitattributes` there, so it could attach any configured filter to its files, and a relative filter command would run the agent's own script. Files in agent branches are therefore stored unfiltered.
- **No writes through links:** Stet never writes through a symlink or junction, like git. In the agent worktree (workspace files) it replaces planted links with real files and folders; in the project (accept) it refuses, and it checks the real location of every destination (inside the project, not in `.git`). Working-copy reads do not follow links either.
- **Paths:** submitted and accepted paths must be relative, without `.`/`..` segments, and must not reach the git dir on any platform (`.git`, `GIT~1`, `.git.`, `:` streams). Accept re-checks this, since the store is plain files.
- **Ids** from agents are validated before they are used as file names in the store.
- **UI:** agent-written text is escaped in Markdown (hovers, tooltips) and shown as plain text in comment threads; only Stet's own action links are trusted.

Known limitations:
- **Native Windows (Claude Code):** there is no OS sandbox, so layer 2 is the only barrier for shell commands, and it parses commands heuristically. Indirection (`cd` chains, shell variables, `~`, paths assembled inside a script) gets past it (security audit 2026-09-26). An agent that deliberately does so can write the project's git dir or Stet's store, e.g. forge a proposal or replace the bundled CLI (the VS Code extension restores it on its next start). For documents or sources that may contain prompt injection, run the agent in WSL2 or another sandboxed setup.
- A shell command writing through an absolute path is stopped only by layers 2 and 2'.
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
| `stet_submit` | `title`, `rationale`, `groups?: [{kind, title, rationale?, where: string[], parts?: [{title, where}]}]`, `notes?: [{where, note}]` | changeset id; items (`id`, `file`, `line`, short old→new preview, `groups`); groups with their parts; ungrouped items; hint warnings, including joined parts |
| `stet_group` | `itemIds`, `kind`, `title`, `rationale?`, `parts?: [{title, itemIds}]` | the group with its parts and warnings; for `atomic`, the new merged item |
| `stet_ungroup` | `groupId` | ok. The agent may remove its own groups and `auto` groups in its changesets. |
| `stet_sync` | — | new base sha, items that became stale, reviewer notes delivered (§7.8) |
| `stet_get_feedback` | `ack?: bool` (default true) | events since the cursor: `accepted` (with the final text if edited), `rejected` (reason), `revision_requested`, `comment`, `stale` (with current context), `repeat_rejected`, `group_broken` (member statuses), `group_partial` (each part and its outcome), `note_comment`, `note_resolved`, `note_reopened`, `reopened` (a decision undone) |
| `stet_list` | `status?`, `file?` | items with status |
| `stet_show` | `id` (item, group or delivered note) | old/new text, note, groups, thread; for a group its parts and members; for a note its passage and thread |
| `stet_reply` | `itemId` (an item, or a delivered note `N3`), `text` | ok |
| `stet_withdraw` | `itemIds`, `reason?` | ok |

`where` uses the syntax in §6.4.3. A `note` is attached to every item that its `where` matches.

All tools return concise text meant for the model, followed by a JSON block for machine use. Errors are phrased as instructions, e.g. "worktree has uncommitted changes in intro.tex — call stet_submit or discard them first".

### 10.2 CLI (the same operations)
- **Agent side:** `stet status | submit -t "…" -m "…" [--groups groups.json] | group | ungroup | sync | feedback | list | reply | withdraw`. Every command supports `--json`. Agents without MCP can use these through their shell.
- **User side:** `stet review` (list), `stet accept S12 S13 [--edit]`, `stet reject S12 -m "…"`, `stet revise S12 -m "…"`, `stet comment S12 -m "…"`, `stet agent new|list|archive`, `stet init`, `stet doctor`.

### 10.3 Agent instructions (draft)

Written into each worktree as `CLAUDE.local.md` (Claude Code) and `AGENTS.override.md` (Codex). Codex reads `AGENTS.override.md` *instead of* `AGENTS.md` in the same folder, so Stet prepends the project's own `AGENTS.md`. The files are refreshed after every sync, with `stet agent refresh`, and for all active agents with the extension's **Refresh** (`refreshWorkspaces`; one agent's failure, e.g. a deleted folder, doesn't stop the others).

```markdown
# You are working under Stet review

You are in a *proposal workspace* for a LaTeX project. Nothing you change here
reaches the real document until a human accepts it.

- This file is written by Stet and rewritten at every sync: don't edit it or
  suggest that the reviewer add instructions to it.
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
    Split a large linked group into `parts` when every part can be accepted
    on its own: the document still compiles (warnings are fine) and no other
    part is blocked. Make parts as small as that allows (a sentence, a
    formula, a label with its references), not one per paragraph or section.
    Stet keeps identical changes, a definition and its uses, and changes
    touching the same text in one part.
  - `atomic` — edits within one sentence/paragraph that only read well together.
  - Moving a passage: strongly prefer moving it word for word and editing it
    in a later round; a few adjusted words are shown as part of the move (§6.4.7).
  - `related` — optional thematic batches with a title and rationale.
- Check the submit result: fix wrong or missing groupings with `stet_group` /
  `stet_ungroup`.
- Before starting new work: call `stet_status`; if `syncNeeded` or notes are
  waiting, call `stet_sync` (waiting notes arrive even when it refuses).
- Notes from the reviewer (N3) point at a passage and ask for something. Act
  on them like a request; answer with `stet_reply` if unclear or when done.
- Call `stet_get_feedback` regularly. For each event:
  - rejected: do not propose the same change again; learn from the reason.
  - revision_requested: revise that passage, then submit.
  - comment: answer with `stet_reply` (and revise if asked).
  - stale: the text changed underneath you; re-propose against the current text if still relevant.
  - accepted with edited text: prefer the human's wording style from now on.
  - group_broken: some linked edits were applied without the others; propose
    whatever is needed to make the document consistent again.
  - note_comment / note_resolved / note_reopened: the reviewer wrote in a
    note's thread, closed the note, or opened it again.
  - group_partial: some parts of a linked group were accepted, others not;
    propose what makes the document consistent.
- Use `stet_withdraw` for proposals you no longer believe in.
```

---

## 11. Configuration (`.git/stet/config.json`)

```json
{
  "mainBranch": "master",
  "agentBranchPrefix": "stet/",
  "worktreeRoot": "../{repo}.stet",
  "autoCommit": "on-finish",
  "shareEdits": "manual",
  "split": {
    "mergeGap": 2,
    "rewriteRatio": 0.5,
    "ignoreReflow": true,
    "abbreviations": ["e.g.", "i.e.", "et al.", "Fig.", "Eq.", "Sec.", "cf.", "vs."]
  },
  "grouping": {
    "autoRepeatMin": 3,
    "autoDetect": ["repeat", "label", "macro", "cite", "input"],
    "moves": { "enabled": true, "minWords": 7, "maxChangedWords": null },
    "refCommands": ["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref"],
    "citeCommands": ["cite", "citep", "citet", "parencite", "textcite", "autocite"]
  },
  "files": { "tex": ["**/*.tex", "**/*.sty", "**/*.cls"], "bib": ["**/*.bib"], "typ": ["**/*.typ"] },
  "language": "latex",
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
- `acceptGroup(id)` (all-or-nothing for linked groups; `G7.2` accepts one part), `groupTarget(id)` (a group or part and its pending items), `rejectGroup(id, reason?)`, `rejectAndRevise(id, reason)` (§6.4.5), `ungroup(id)`
- `preview(id) → {before: png, after: png, page}` (asynchronous, cached)
- `subscribe(listener)`: a live event stream, backed by watching `events.jsonl`; frontends that show records reload when `changed` is rewritten, since not every change appends an event (merging changes into one, removing a group)
- `commitAccepted()`, `sync remote` (pull / push according to config)

The web UI will expose this API as REST plus Server-Sent Events on `localhost`, protected by a random token, with no other code changes.

### 12.2 VS Code extension (M3)
- **Stet panel** (a native VS Code tree view; see the M3 notes in §16 for why it is not a webview):
  - Tree: agent → changeset → group → item. Ungrouped items sit directly under the changeset, and an item in several related groups appears in each. A linked group with parts shows "Part n: title" nodes between the group and its items, each with its own *Accept all* / *Reject all*; a part disappears from the Review panel once decided.
  - Linked groups get a chain icon, broken groups a warning icon, and auto-detected groups an "auto" tag that can be dismissed.
  - Filters, plus keyboard review: `j`/`k` to move, `a` accept, `r` reject, `e` edit, `c` comment, `A` / `R` accept or reject the whole group.
- **In the editor:**
  - pending items are highlighted inline (old text struck through, new text shown as ghost text)
  - CodeLens above each item: `✓ Accept · ✗ Reject · ✎ Edit · 💬`
  - hover shows the rationale
- **Threads:** item threads appear through the VS Code Comments API. Any line of a project file can take a thread: on a proposed change it is a comment, elsewhere it becomes a note for an agent (§7.8; the agent is asked for when there are several). Open notes show as threads at their passage and under their agent in the panel, with *Resolve*; *Stet: Note for agent…* (editor context menu) notes the selection.
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

What compiles the document and finds a change on its pages is the document language's **typesetter** (§6.0; LaTeX's in `lang/latex-preview.ts`); `preview.ts` holds the rest: isolation, the build cache, pages and the words on them. The steps for LaTeX:

1. The user clicks **Preview** on an item.
2. Stet builds two temporary trees: the review base, and the review base plus this item. It compiles them with `latexmk -synctex=1` in a cache directory, reusing auxiliary files between builds.
3. `synctex view` maps the item's line to a page and bounding box.
4. The matching region is rendered from both PDFs (pdf.js in the UI) and shown before/after.
5. Results are cached by (base sha, item id). If a build fails, the LaTeX error log is shown; that alone is useful ("this change breaks compilation").

**Page view (built):** the Preview panel shows the change's whole page, rendered by Poppler in the container like everything else, with the changed words marked from a word diff of the two versions (`pdftotext -bbox`, three pages on each side so text moving across a page break isn't marked). Words compare as typeset, punctuation included (an equation number "(2)" is not an exponent 2) but not hyphens, which reflowing adds. Maths compares by its pieces (letters, digits, each symbol), a run of it between two prose words as one formula whose pieces may come in any order; a formula that stays while the words around it change is no change. pdftotext's lines are rebuilt per block from the word positions (usual-size words on one level make a line, sub- and superscripts join the line their middle is in, left to right): around maths it cuts a printed line into pieces in no stable order, so the same formula read differently in the two versions. A long change is searched for in a stretch of the page as long as all of it (it was found by its end only). Only differences where a shown change is on the page are marked, between the context words found around it (the same search that crops the hover image): elsewhere they are consequences, such as a renumbered equation or reference. A change the editor shows whole (`inlineDiff`: mostly rewritten) is marked whole, from its first word to its last. Checked on real builds (2026-11-20): word edits, a rewritten sentence, inserted and deleted paragraphs, an inserted equation, an exponent, a citation added, a comma added, the same sentence twice, a change across a page break. Other pages are rendered on demand and cached; the base's pages are shared by every change on that base.

**Later, optional: a real PDF viewer (pdf.js).** Instead of page images, the panel could embed pdf.js: vector rendering sharp at any zoom, smooth scrolling through the whole document, text selection and search, with the same marks on top. It is a new dependency (~2 MB) and would parse the agent-influenced PDF in the webview rather than in the container (pdf.js had a code-execution bug in 2024, CVE-2024-4367), so it would be opt-in, kept current, with scripting off. Decided 2026-11-19: page images (A) now, pdf.js (B) as a possible opt-in later.

Agents could later get a `stet_build` tool to compile their own worktree before submitting.

---

## 15. Concurrency

- **Writers:** extension, MCP servers (one per agent session), CLI. All mutations take `.git/stet/lock` and hold it only for the duration of a single operation. The lock file names its owner (host, PID, random token); the owner refreshes its time every 5 s while holding it. It is taken over only when its owner process is gone (same host), or its heartbeat stopped for 30 s (owner on another host) or 10 minutes (owner still running here, i.e. hung), by renaming exactly that file away (so two waiters cannot both take it). It is removed only by the owner whose token it holds, and every store write and every accept checks the token first (fencing): an owner whose lock was taken over stops instead of writing next to the new owner.
- **Accepts are all-or-nothing:** every destination is checked before anything is written, the original contents are journaled in `.git/stet/txn.json`, and a failed write restores all files. An accept cut off by a crash is undone (if it was still writing) or completed (if all files were written) by the next Stet operation. The journal also records content hashes before and after Stet's write; undo restores a file only while it still holds exactly what Stet wrote, so edits the user made after the interruption are never overwritten.
- **Git access:** git operations on the main repo are serialized through the same lock. Agents' own git activity happens in their worktrees. Stet uses git plumbing (`commit-tree`, `update-ref`) for `refs/stet/base`, so it never touches the user's index or working tree except when applying accepts.
- **Parallel agents:** they share nothing except the review base. Overlaps between them are detected at the item level (§6.3).

---

## 16. Milestones and acceptance criteria

| M | Scope | Done when |
|---|---|---|
| **M1** ✅ | Core + CLI: store, tokenizer and splitter, anchoring, submit, accept, reject, replay, review base, stale detection | A test corpus of 3–5 real `.tex` papers with scripted agent edits produces sensible items. Accept, reject and replay round-trip correctly while the user edits in parallel. Passes on Windows, macOS and Linux in CI. |
| **M2** | MCP server, `init`, `agent new`, guardrails (permissions, hooks), agent instructions | End-to-end: Claude Code (desktop app **and** CLI) and Codex each complete a propose → reject-with-reason → revise → accept loop without human copy-paste. Guardrail tests: attempted writes to the user repo, merges and pushes are all blocked. |
| **M3** ✅ | VS Code extension (panel, decorations, CodeLens, threads, setup commands) | The full workflow runs from VS Code plus the desktop app, with no command line. |
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

### Security audit (2026-09-26)
An independent audit (read-only, with reproductions against scratch repositories) found the shared git dir writable to agents: the guard exempted it for shell commands, and the macOS/Linux sandbox allowed it. Confirmed consequences: `git config core.fsmonitor '<cmd>'` from the agent ran `<cmd>` on the user's next `git status` and modified the real file; the bundled CLI and the store could be overwritten. Fixed: sandbox and guard now keep the shared git dir read-only (see §9), `git config`/`remote`/`submodule` writes and case variants/aliases are blocked, worktree integrity is verified before Stet runs git there, `core.fsmonitor` is disabled for Stet's git calls, paths and ids are validated, agent text in the UI is escaped. Remaining (documented in §9): guard indirection bypasses on native Windows. Regression tests: those marked *(security audit 2026-09)* in `packages/core/test` (mainly `workspace-integrity.test.ts` and `safe-paths.test.ts`), and the guard tests.

### Code review (Codex, 2026-09-26)
A second review (a local Codex report, not kept in the repository) reproduced seven issues, all fixed with regression tests marked *(Codex review 2026-09, F1)* to *F7* in `packages/core/test` (each fails on the previous code):
- **F1** hooks from the agent worktree ran during `stet_submit` when the project uses a relative `core.hooksPath` → no hooks and no submodules for git calls in agent worktrees.
- **F2** workspace refresh wrote through a planted `.claude` junction → links in the worktree are replaced, writes go through a temp file + rename.
- **F3** accept wrote through a junction in the project → no writes or reads through links; real destination must be inside the project and outside `.git`.
- **F4** a failing write left a linked group half-applied with all items pending → preflight, journal, rollback, crash recovery.
- **F5** a stale-lock timeout let a second owner in while the first was still working → owned lock with heartbeat, liveness check and token-checked release.
- **F6** an accepted binary replacement was marked committed because the file existed → whole-file items compare content (and, for renames, that the old path is gone).
- **F7** a JSON `null` message stalled the MCP server → envelope validation, per-request error isolation, runtime validation of tool arguments.
- Follow-ups: recovery of an accept interrupted before writing restored old content over a later user edit → undo only files that still hold Stet's write; a configured clean filter ran during `stet_submit` with agent-chosen `.gitattributes` → filter drivers are off in agent worktrees.

### Hands-on test and optimization pass (2026-09-27)
- **Hands-on test A (VS Code extension): passed**, with these changes: `j`/`k` run *Stet: Next/Previous change* (they only moved the focus); `stet.runtime` applies immediately; accepted changes are committed on **Finish review** in one commit with an editable summary line (`autoCommit: "on-finish"`, the new default; per-accept commits made the history noisy); `config.json` stores only settings that differ from the defaults.
- **Archiving an agent** now tells everyone what happened. The agent record keeps `archived: {at, withdrawn, worktreeRemoved}` and an `archived` event is logged. The agent's next tool call (MCP) and the guard hook answer with an explanation (archived on …, proposals S… withdrawn, folder deleted, ask for a new workspace), also when the folder is gone: workspace configs carry `STET_PROJECT` and `STET_AGENT` for that. A kept folder gets the same notice in place of its instructions. The reviewer sees a summary (VS Code message, CLI output).
- **Optimization pass**, measured on a 3,000-line paper with 300 proposals (Windows):

  | Operation | Before | After |
  |---|---|---|
  | accept one change | 1.9 s | 0.16 s |
  | accept 50 changes at once | 2.3 s | 0.6 s |
  | relocate all changes after an edit (editor, per keystroke) | 650 ms | 5 ms |
  | sync | 2.3 s | 1.0–1.6 s |

  Changes: line-diff mappers are cached per text pair and searched by bisection (relocating many items against the same two texts costs one diff); accept locates all overlapping items in one pass and reads each file once; the store caches records for the duration of a locked operation (copies handed out, writes go through); the review base is rebuilt lazily when an agent needs it instead of after every accept; the extension shows the review state before computing which agents are behind.
- Code: path comparison helpers consolidated in `paths.ts` (seven copies before).

### Pre-release review (2026-09-27)
A review pass for security, efficiency and duplication before publishing the extension:
- **Security:** the guard hook command quotes every part with single quotes (a folder name containing `$(…)` or backticks was expanded by the shell inside double quotes); the git hooks quote the agent branch prefix and run a chained pre-existing hook the way git does (only if executable, with its own interpreter); config values that reach git or hook scripts are validated (`mainBranch`, `agentBranchPrefix`, `autoCommit`), and agent workspaces must lie outside the project; the extension finds Node.js on absolute PATH entries only (Windows' `where` also searched the current folder) and `stet setup` runs `claude`/`codex` with `NoDefaultCurrentDirectoryInExePath`; the extension declares `untrustedWorkspaces: false` (it stays off in VS Code's Restricted Mode) and opens only project-relative item paths; `stet_show` shows only the agent's own items and groups, and `stet_list` validates its status filter; a damaged record file is skipped (and reported by `stet doctor`) instead of breaking every listing. Checked and not an issue: running `git` by name does not pick up a `git.exe` from the current folder (Node 22/24 and VS Code's runtime tested).
- **Efficiency:** commit building batches `ls-tree` and `update-index` over all files; store listings read records in parallel batches (listing 300 items: 91 → 46 ms); the event log is parsed incrementally; submit's candidate matching no longer scans quadratically.
- **Codex review (in parallel):** commit signing could run an agent-replaceable signing program → signing off for Stet's commits; check/use race on the worktree's git link → `AgentFiles` (above); *Accept all linked* from the editor could resolve `G1` in the wrong project → CodeLens and hover links pass `{path, id}` and resolve within that project; renamed binary files could not be accepted → handled (source checked, destination free, source removed); a live but stalled lock owner could be displaced → kept for 10 minutes, plus fencing; refresh computed each agent's status separately → `agentStatuses()` from one read. Regression tests marked *(Codex review 2026-09)* in `packages/core/test`, and the VS Code integration run.
- **Duplication:** one `oneLine`, one `pathExists`, one `shQuote`, one feedback formatter (`describeFeedback` with a style for the CLI), the extension uses the core's git runner, *Accept all* / *Reject all* share their target resolution, `StetError` lives in `errors.ts` (so the worktree check needs no wrapping).

### Sharing the user's edits (2026-10-15)
- Committing just so agents could see one's own edits was inconvenient in practice. New setting `shareEdits` (`manual` default, `saved`, `committed`) and *Share my edits* / `stet share` (§7.3). `ensureBase` still decides "accepted but not committed" against `HEAD` (so *Finish review* finds those items), but builds the base from the shared tree, applying only accepted items not already in it.
- Extension: setting `stet.shareEdits` (written to the project's config when set, so the agents' `stet` and the CLI follow it), command *Share my edits with agents* in the panel title, with a status bar icon while saved edits are unshared (checked after each save). CLI: `stet share [mode]`, and `stet review` mentions unshared edits.
- Tests: `share.test.ts` (modes, the user's index untouched, build output excluded, accepted items not applied twice, proposals on shared text acceptable, a commit replacing an older share, another branch checked out); the integration suite checks the command.

### Long proposals in the editor (2026-10-15)
- Ghost text is a single-line decoration, so multi-line or long new text was cut to 80 characters (⏎ for line breaks), and the full text needed the hover or *Show diff*. Such items now get a comment thread whose first entry is the full new text (fenced, never rendered as Markdown), opened by default directly under the change. VS Code offers no other way to show multi-line content between editor lines. Setting `stet.longChanges`: `expanded`, `collapsed`, `hover` (old behaviour). The default was `expanded` until 2026-11-12 and is now `collapsed`: open panels for every long change crowded the editor.

### Review flow fixes (2026-10-19)
- **Auto-advance:** after a decision (accept, reject, edit, revise, also for whole groups) the panel selects the next pending change in panel order and the editor shows it; from the panel the focus stays there, from CodeLens/hover only the editor moves (a closed panel stays closed). Nothing moves after a cancel or failure. Setting `stet.autoAdvance`.
- **Word wrap:** decoration `after` text is drawn outside VS Code's line layout, so word wrap ignored it and long proposals ran off the screen. The new text is now an inlay hint, which takes part in wrapping (integration test: a line that fits on its own wraps with the hint). Inlay hints are cut at 43 characters by default, so the extension sets `editor.inlayHints.maximumLength: 0` for `latex`, `tex` and `bibtex`. With word wrap on, single-line proposals up to 400 characters stay inline; the panel (`stet.longChanges`) takes the rest.
- **Changes inside an item:** math spans are kept whole (§6.2), so a changed exponent in an `align` made the whole block one struck-through span plus its full replacement, and the actual difference was hard to see. The editor now shows a token-level diff inside the item (`inlineDiff` in the core): only removed tokens are struck, inserted text appears as inlay hints at its position. Whitespace is left out of the matching (re-wrapped lines are no change); hunks separated only by whitespace are merged; when less than half of the old tokens survive, the item is shown as one replacement, which reads better than scattered fragments. The panel for long proposals (`stet.longChanges`) opens only when an inserted part, not the whole new text, is too long for the line. Review and accept are unchanged: the item stays whole.
- **Colours and speed (2026-10-20):** inlay hints can't be coloured per hint, only per kind through the user's `workbench.colorCustomizations`. So new text is a green decoration when word wrap is off (wrapping doesn't matter there) and an inlay hint of kind *parameter* when it is on; the panel button *Highlight proposed text in green* sets `editorInlayHint.parameterForeground/Background` in the user settings and restores the previous values when switched off. `stet.newTextStyle` overrides the choice (Alt+Z toggles wrap without changing the setting). Contributed colours: `stet.insertedText.*`, `stet.removedText.*`. Moving to the next change took ~2 s because the refresh after a decision waited for the agent-status check (rebuilds the review base) and the share check (snapshots the project), twice; both now run in the background, debounced (0.8 s), and the move takes ~0.3 s.

### Fix: accepted items applied twice (2026-10-21)
- **Report:** after `stet_sync`, the review base contained `\\Hashash` and `\\pk` where the document had `\Hash` and `\pk`. Accepted, uncommitted items are applied on top of the shared edits (or `HEAD`) only if their old text is still there. For items whose new text contains the old text (`pk` → `\pk`), the old text is still found inside the applied new text, so the item was applied again. Affected: shared edits (§7.3, since 2026-10-15) and `HEAD` after the user committed accepted items with git. Not affected: `HEAD` with the items uncommitted (the usual case before sharing existed).
- **Fix:** `anchor` returns null when the old text it finds is part of an occurrence of the item's new text (`insideNewText`); for accepted items the new text is the applied text. This covers building the review base, the editor's locating of pending items, and accept (a pending item whose change is already in the text is refused instead of applied twice). Already corrupted review bases are rebuilt on the next `ensureBase` (the set of items to apply changes), and the agent's proposals against the corrupted text become stale at its next sync.
- Tests: `review-base.test.ts` (the reported macros outside math, shared edits, git commit by hand, saved mode, accept of an already-made change; `insideNewText` cases). Four of them fail without the fix.

### Moves (2026-11-13)
- **Why:** a moved paragraph was reviewed as an unrelated deletion and insertion, hard to read and hard to check for changes on the way. Only longer passages (sentences, paragraphs, environments), not a few words. Small changes on the way are allowed and shown clearly; the agent instructions prefer moving word for word without forbidding adjustments.
- **Where:** `moves.ts` (`detectMoves`, `changedWords`, `moveChanges`), `Item.move`, `movePartner`, submit (auto linked group, `SubmitResult.moves`), `withMovePartners` in accept/reject, `linkedMembers`, `settleParts` (halves joined). Extension: `TreeModel.withMove` / `partner` / `isMove`, `moveNote`, decorations `moveLabel` / `moveChanged`, CodeLens *Accept move*; long-change panels are not shown for moves. CLI: `itemSummary`, `stet show`.
- Tests: `moves.test.ts` (paragraph move accepted from one half, also ungrouped; reject from one half; two sentences vs. a few words; one changed word shown, two in a 27-word paragraph not a move; move into another file inside a linked group with parts; parts joined), extension `model.test.ts` (labels, linking, editor notes).
- **Several blocks (2026-11-13):** an agent found that moves were missed as soon as two moved blocks landed next to each other. Two causes: paragraph widening in `splitLatex` merged a moved block with a heading and a change below it; and blocks landing together form one insertion, which matched no single deletion. Fixed by widening only into paragraphs a change is part of, and by matching several blocks into one insertion (or out of one deletion), `MoveInfo` with id lists. Tests: two blocks from different places landing together (reject from one of them restores the text), two adjacent blocks going to different places, a changed word in one of several blocks shown at that block; extension notes naming several sources.

### Fix: edited accepted changes applied again (2026-11-12)
- **Report:** agents' copies contained an accepted remark and a corollary twice; the user's file had them once. The items were accepted, then edited or moved by the user (and committed with git, or only saved). Building the review base decided "still open" by finding the item's old text: a pure insertion's old text is empty and a newline is found anywhere, and the applied text was no longer there verbatim (`insideNewText` only catches the exact text). So the item was applied again, on `HEAD` and on the shared edits. The same kept accepted changes the user had undone visible to agents.
- **Fix:** `resolution.headBlob` (HEAD's file at the accept, `committedSinceAccept`) decides whether an item is committed; shared edits get only items accepted after they were taken (`shared.at`; `saved`: none). The old-text search remains only for items accepted after a manual share and for legacy shares.
- Tests: `accepted-base.test.ts` (edited insertion with `saved`, `committed` and `manual`, undone accept, commit of another file, items without `headBlob`). Five of the six fail without the fix.

### Accept performance and review (2026-10-21)
- **Accept:** on a 3,000-line paper with 300 proposals, `accept` took ~95 ms, mostly git processes: a `git status` per file (only needed for `autoCommit: "when-clean"`, now only then) and `git symbolic-ref` for the branch check (now read from the main worktree's `HEAD` file, `projectBranch`). Now ~42 ms.
- **Extension:** accept and move on measured 250–860 ms in the integration test, now 125–165 ms. The panel fires its tree change before setting context keys (in parallel); background checks (agent status ~0.6 s, share status ~0.3 s on the large paper, both under the store lock) wait for a 2-second pause instead of 0.8 s, so they don't fall between two decisions.
- **Ordering:** decision commands (`accept`, `reject`, `edit`, `revise`, group variants, `next`/`previous`) run one after another. A second `a` before the panel moved on acted on the stale selection: one change stayed pending (integration check *two quick accepts accept two changes*, fails without the queue).
- **Review of the code since the pre-release review:** shared-edit snapshots run git in the user's project with the user's own config (filters from the user's `.gitattributes`); fsmonitor is off for all of Stet's git calls, and agents can't change the project's config or attributes under a sandbox (on native Windows the guard is best effort, as before). Markdown from agents stays fenced and untrusted in panels and tooltips; the colour button only writes its two keys and restores the user's previous values. `npm audit`: runtime dependencies clean; a high-severity advisory in `vite` (dev only, via the test runner) fixed by updating the lockfile.

### Reviewer notes (2026-11-11)
- **Why:** the reviewer wanted to ask one agent for something about a passage without a proposed change, and have it arrive through sync (§7.8).
- **Where:** `notes.ts` (`describeNote`, shared by MCP and CLI), `Stet.addNote` / `deliverNotes` / `replyNote` / `resolveNote` / `locateNoteInText`, `notesWaiting` in agent status, `notes/` in the store (created on first write for older stores; `nextNote` defaults to 1). Sync refusals carry waiting notes. Extension: note threads in `comments.ts`, note nodes under agents (`TreeModel.openNotes`), commands *Note for agent…*, *Resolve note*, *Go to note*; CLI `stet note`, `stet note resolve`, `stet notes`, `N3` in `show`, `comment`, `reply`.
- Tests: `notes.test.ts` (delivery once and per agent, delivery with a refused sync and moved text, unfound passage, early and late replies, resolve and archive, path checks), extension `model.test.ts` (note nodes).

### Parts of linked groups (2026-11-11)
- **Why:** agents link long lists of changes, and linked groups could only be accepted whole or item by item (breaking the group). Parts (§6.4.6) are reviewable on their own, under two conditions from the user: accepting one part alone still compiles (warnings fine), and blocks no other part. Identical changes stay together.
- **Where:** `parts.ts` (`settleParts`: union-find over proposed parts with the joining rules; `combineParts` for merges), `Stet.settleParts` / `interference` (simulated accepts on the review base), `linkedUnit` in `model.ts` (what an item must be decided with) used by accept/reject and the extension, `group_partial` in `updateGroups`. Auto label/cite groups propose one part per item.
- **Fix found on the way:** label-rename detection missed references whose window (original-text context) contained another, unchanged reference to the old key nearby; it now compares key counts between the old and new window.
- **Not covered:** the compile condition is checked by rules, not by compiling. A part relying on something only another part's changed line provides in a way the rules don't see (say, a counter or a `\makeatletter` block) is not detected.
- Tests: `parts.test.ts` (rules, label rename review with `group_partial`, agent parts per section with and without a repeated change, `stet_group` parts), `workflow.test.ts` (auto label group parts; agent-linked groups without parts still all-or-nothing), extension `model.test.ts` (part nodes, `linkedRest` per part).

### Splitting and linking, from scenarios (2026-11-19)
- **Why:** bug reports C42, C38, C31 and C36: a paragraph inserted next to one edited in place showed as "old → new paragraph" plus a re-insertion (lines paired by position), which hid moves and made partial accepts drop or duplicate text; a heavily rewritten sentence came as seven fragments; a sync during submit then left a paragraph twice in the agent's workspace (the re-insertion was replayed while the replacement went stale). The reviewer also found agents' linked groups too large: all-or-nothing for changes that merely belong together.
- **Where:** `split.ts` (`alignTokens`, `pairBlocks`, `slide`, sentence coarsening, `unrelated` with `Edit.halves`), `moves.ts` (`allowedChanges`, single sentences, `detectRewritten`, `separateMoved`), `parts.ts` (`replacements`, rules restricted to the agent's parts on request), `Stet.dependencies` and the linked check in `itemize` and `group`, `describeSubmit` (what a stale change means for the workspace), the guard (`isStetReadOnly`: help; `onlyReads`: chains of reading commands, output thrown away).
- **Decided with the user:** an unrelated paragraph replacing another is one change; one changed word per 10 (at least one, no cap) still makes a move; a passage moved and rewritten beyond that is linked; a sentence of 7 words or more counts as a move; an agent's linked group without a dependency Stet sees is made related and the agent told, unless it gives a reason.
- Tests: `scenarios.test.ts` (one scenario per kind of edit, each with the most natural outcome, accepting subsets alone, the C36 sync), plus updated `moves.test.ts` and guard checks in `inbox.test.ts`.
- **Real-world revisions** (`realworld.test.ts`): five submissions with many kinds of change at once: polishing a paper with its bibliography; restructuring with every kind of move and the agent's own groups; moving a proof into an appendix file; a section full of math (align, cases, labelled equations, a new macro); a TikZ figure. Besides what each change should be, they check that accepting everything gives the agent's text, and that accepting any one decision unit alone, or all but it, gives a well-formed document: no paragraph twice; environments, braces, `$` and `\left`/`\right` balanced; no defined macro missing. They found:
  - headings glued to the next paragraph in pairing;
  - several paragraphs replaced by unrelated text, token-diffed into fragments;
  - a paragraph with most sentences deleted not counted as the same paragraph;
  - runs of new paragraphs as one change (decided with the user: one per paragraph);
  - macro, environment and TikZ-style renames not linked (described in §6.4.2, never implemented);
  - a TikZ picture coarsened into one change;
  - a whitespace-only change split off a new line.

### One set of actions on a change (2026-11-19)
- **Why:** the same action had different names in different places ("Edit" / "Edit and accept…", "Revise" / "Request revision…", "PDF" / "Preview in PDF"), each place showed a different subset, and *Accept* on a linked change accepted the group from the CodeLens but asked from the hover. Settings were split between View options and a separate title-bar button.
- **Where:** `actions.ts` (`changeActions`, `acceptAction`): one list of actions per change, with name, codicon, panel key and order (decide, talk, view, other). The hover, the CodeLens (Accept, Reject…, More…), *More…* (`stet.changeActions`, a quick pick) and a Quick Fix provider (Ctrl+.) all use it; the panel's context menu and keys follow the same names and order in `package.json`. Accept is scoped the same way everywhere (the move, linked group or part); the panel's button and `a`, which can't show the scope, ask; `stet.acceptOnly` breaks the group on purpose.
- **Panel title:** only state-driven actions (Share my edits, Finish review) and View options; the rest is in the `…` menu. The green-text switch and `stet.newTextStyle` moved into View options.
- **Agents:** one inline icon (notifications, showing their state); *Notify now* is a button in that checklist and in the context menu.
- Tests: integration suite (CodeLens set, Ctrl+. list, hover links, highlight toggle, new commands).

### Rounds and history (2026-10-21)
- **Ids:** with hundreds of changes the global numbering (S412) got long and the panel crowded. A round is one submission (changeset `C12` → round 12); new items are `<round>.<n>` (`12.3`), numbered at submit; a merged (atomic) item gets the next free number of its round. Old `S` ids stay valid; `compareItemIds` sorts both (old first). Ids stay plain strings for the store, CLI and MCP (`SAFE_ID` already allows dots; the CLI and MCP tell groups and rounds apart by their `G`/`C` prefix).
- **Panel:** rounds are labelled "Round 12: title", changes by their number within the round (`shortId`); full ids appear in CodeLens, hovers and messages.
- **History view** (`stet.history`, collapsed by default): the same tree model in `history` mode shows decided items (not live), rounds collapsed and summarised (`outcome`). Clicking a decided item opens a diff of the change in its original context (`context.before + old/applied + context.after`), since the current file no longer contains the old text. Replaces the *Show/Hide resolved* toggle.
- Panel title buttons had the same `navigation@3` position (highlight and show/hide resolved) and VS Code ordered them by title, so they swapped when toggled; each button now has its own position.

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
6. ~~VS Code extension: whether `j`/`k` move the selection~~: they only moved the focus (hands-on test 2026-09-27). Now bound to *Stet: Next/Previous change*, which select and show the change; covered by the integration test.
