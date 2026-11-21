# Changelog

## Unreleased

**Typst projects.** Stet reviews Typst as it does LaTeX: changes are split by words and sentences, with maths, labels and references (`<a>`, `@a`, `#ref(<a>)`) kept whole; a renamed label or citation key is linked with its uses, a `#let` with the code that uses it, a new chapter or figure with the `#include` or `#image` that reads it in; moved paragraphs and blocks are moves. `@key` is a citation when the bibliography (a .bib file) has the key, else a reference. `stet init` and *Set up project* tell a Typst project by its files, and agents get Typst examples. In Typst a reference to a missing label or citation is an error, not LaTeX's `??`: a label or citation key and its references are never in separately acceptable parts, and a new label is linked with new references to it. No PDF previews for Typst yet; their entries are hidden for Typst changes. Also for LaTeX: a .bib entry whose key alone changed is one change, linked with the renamed `\cite`s.

Fixes from the security review and the test report of commit 5e4c6af (2026-11-21).

**Security**
- **An agent could make Stet run git hooks outside its sandbox.** By pointing its workspace's `.git` link at a repository of its own, an agent made the Stet MCP server (which runs outside the sandbox) run that repository's hooks. The MCP server and the guard now open the project from the folder recorded at setup and check the workspace's git link before running git there.
- **Agent text could add working Stet links to a change's hover**, through a group title in a link's tooltip, or hide Stet's own links behind a `~~~` fence and a lone carriage return. Agent text in hovers, link tooltips, notifications, panel labels, pickers and the inline text is now escaped, kept on one line where it must be, and can't form links in notifications.
- **Invisible characters are shown:** control characters, direction overrides, zero-width and tag characters, soft hyphens and byte-order marks in agent text are shown as markers such as `⟨U+202E⟩`, in the terminal and in VS Code; they were dropped from the display but still written into your file. A lone carriage return shows as a line break, and Stet's own colours can no longer be faked in `stet review`. Titles and replies on several lines can't pass for rows of their own. Commit messages get agent titles on one line, without control characters.
- **The guard fails closed:** when it can't check a tool call it blocks it (it let every call through). Links whose target doesn't exist yet are followed.
- `stet show` says when it shows only the first 40 lines of an added or deleted file; `--full` shows them all.

**Your files and decisions**
- **Typst: accepting a label's part alone broke the document.** A label or citation-key rename was split into parts as in LaTeX, where a missing reference is only `??`; in Typst it stops the build. They are now one unit, and Stet says "the document may not compile" when you accept only some.
- **Multi-select Accept asks about the other parts of the changes' linked groups**, as a single Accept does.
- **Escape in "which one?" decides nothing:** it accepted (rejected, revised) the change selected in the panel, in another file.
- **A sentence added before a new heading or code block** came out as the old sentence replaced by the text after the heading; accepting some of the changes lost or doubled a sentence. Each change now only inserts.
- **A new label and a new reference to it** (Typst) are linked, also with a pending rename of the label from an earlier round.
- **A new image read in by a relative path** (`../figures/x.png` from a chapter in a subfolder, or `/figures/x.png`) is grouped with the `#image` that reads it.
- **A re-indented code block is one change**, not one per line (accepting one line left broken code).
- **A renamed `@key` next to a maths edit is a change of its own**, not merged with it.

**Bugs**
- Linked groups listed changes twice in their parts, and joined titles grew with every revision; `stet accept G1.1` could fail for parts an agent declared.
- Typst comments and strings in code no longer count as labels or references.
- **Set up PDF previews**, the panel's *PDF preview* and `p` are gone for Typst changes and projects (they pretended to build or opened an empty panel). *Don't show again* on a preview notice applies to one project and reason.
- Opening a decided change from History marks its replies as read.
- **Undo of a large accept is one operation**, with progress: 400 changes took 16 s, one at a time.
- *Reopen note* is no longer in the Command Palette, where it did nothing.
- Deleting the last entry of a `.bib` file left a blank line at its end.

**Reviewing in VS Code**
- *Set up project* and `stet init` say which language Stet found (LaTeX or Typst).
- Without a Typst extension, `.typ` files open as plain text: Stet no longer offers to change a setting for every plain-text file, and says what helps.
- Several projects in one window: results, the Finish review question and Undo name the project; projects are named after their workspace folder; `navigationOrder: document` goes through projects in the panel's order.
- With several changes selected, Revise, Comment, Edit and Diff say which one change they act on.
- "Which one?" names changes by their full id (2.1, not 1).
- A failed accept says "change", not "item", and that you edited its text or the text around it.
- Every panel row is read out in words by screen readers (messages, warnings), not only change rows; the High Contrast offer no longer implies that either style is read out.

Decisions on the open points of the 5e4c6af reports.

**Security**
- **Stet's MCP server refuses to work in a workspace whose tool settings were changed** (`.mcp.json`, `.codex/config.toml`, the Claude settings): they start programs outside the sandbox. Stet keeps a hash of what it wrote and checks it at every start; `stet agent refresh` writes them again.
- **Files that take effect are flagged** (`.latexmkrc`, `.gitattributes`, `.vscode/`, agent settings, `CLAUDE.md`, `AGENTS.md`, workflows, Makefiles, …): the review says what they set off and shows their content, and accepting one needs `stet accept --confirm` or a confirmation in VS Code.
- **A text file with bytes that aren't UTF-8 is shown as text**, each such byte as `⟨0xFF⟩`, instead of as a binary file without content; accepting it still writes it byte for byte.
- Files are written through a newly created temporary file, and Stet checks that they landed where it meant; automatic detection of the main LaTeX file skips names starting with `-`.
- A very large round (1000 changes or 200 files) gets a warning, for the agent and in `stet review` and the panel.

**Reviewing**
- **A folder with both LaTeX and Typst files:** *Set up project* asks which language; `stet init` takes the one with more files, says so, and takes `--language latex|typst`.
- **Accept says the same thing everywhere:** *Accept part 1 of 2*, *Accept all of G1*, *Accept only 1.10 (breaks G1)*, in the CodeLens, the hover, the panel and the questions.
- **Shorter summaries:** a change's row starts at the argument or field that changed, a key-only change of a `.bib` entry shows only its key line, and a changed call names the call. Diffs of long changes show the changed lines with a little context.
- **Spoken maths says only what differs**, with labels and references read out in words.
- **A failed accept of a change that can't be found** offers *Reject…* and *Revise…* in its message.
- **A project folder with `%` in its name** (`50% done`) broke diffs, the Review file and the edit tab in VS Code: its path was decoded twice.

Fixes from the test report of Stet v0.16.0 (2026-11-20, three testers, VS Code focus).

**Your files and decisions**
- **Fix: undoing an accept could revert a different accepted change.** With two accepted changes of the same words (both "in every round" → "all rounds") and the second one edited since, `stet undo` of the second one reverted the first one instead. Undo now refuses when an accepted change is no longer as accepted.
- **Edit & accept in VS Code shows where the change is.** The input box holds the change in the words around it on its line, with the change selected, and only that part can be edited: a reworded phrase no longer doubles the words next to it ("a simplea simple idea").
- **Accepting one part of a linked group warns that the rest is still to decide** (a renamed `\label` without its `\ref`s), in `stet accept` and VS Code. In VS Code every Accept of a linked change asks what to accept (its part, the whole group, or only it), from the CodeLens, the hover and *Edit & accept* too; *Edit & accept* took a whole group of 57 changes along without asking.
- **Accepting saves your unsaved wording first**, in the Review file and in a change's own tab: `a` in the panel used the agent's wording.
- **Finish review says what it commits:** the files with edits of yours, that undo ends there, and which files have unsaved edits; those are no longer saved and committed without asking (*Save and commit* does).
- **A failed accept no longer saves your unsaved edits first.** VS Code checks the accept against the editor's text, and saves only for one that works.

**Bugs**
- **Set up project** asks for your name and email when git has none (saved for this project), instead of failing with git's message and leaving a repository without a commit and with staged files. In an agent's workspace it offers to open the project instead of setting it up again.
- **The VS Code panel redraws much faster with many changes:** the lines of all changes are found in one go (424 changes: about 6.5 s per decision before). While it redraws, keys act on the change you had selected.
- `j`/`k` on a round or group row go to the change after or before it, not to the top or bottom of the panel.
- **Undo goes back further:** `u` takes back one decision per press, revision requests included (`stet undo` takes back a revision request the agent hasn't answered yet). Finish review clears the accepts it committed from it, and the Undo button with them.
- Commands from the palette or your own key bindings leave the focus where it is, and act on the change at the cursor when a round or group is selected in the panel.
- **Share my edits set from View options** applies to one project in a window with several (it changed both projects' setting).
- **Rewording a change as a whole in the Review file** is saved: words retyped right next to a change become part of it. It was refused as "outside the proposed changes".
- An archived agent no longer shows as "behind your latest text" in the status bar.
- Hovers with your wording show it as a code block again; small wording slips ("when i pause", "speed.. Do not", the change's number twice in the More… title).
- Agent and round rows count changes waiting for the agent's revision apart ("3 pending · 1 awaiting revision").
- When an accept fails because the text around a change was edited since, the message says what to do next.

**Reviewing in VS Code**
- **Agent replies are marked until you see them:** "💬 3 (1 new)" and a speech-bubble icon on the change or note, a count on the agent's row and in the status bar. Going to the change or note marks them seen.
- **A change that can't be found in your file any more says so** on its row (⚠ *not found in main.tex*), and its actions offer Reject and Revise first; accepting it can't work.
- **Several changes can be selected** (Ctrl/Shift+click) and accepted or rejected together, with one reason; Stet asks whether to take along what they are linked with.
- **Resolved notes are in History**, with their replies, and can be reopened (the agent gets `note_reopened`).
- **Undo my last decision** is a button in the panel's title while there is something to undo.
- With the cursor in two overlapping changes, palette commands and *More…* ask which one.
- `stet.navigationOrder`: `j`/`k` go through the changes as the panel lists them (default) or by file and line.
- **Set up project:** one question for a new repository and its first commit, with an offer to leave LaTeX's build files out (a `.gitignore`); a question for a folder without `.tex` files; the CLI's warning about uncommitted edits; and a short message when it was set up already.
- An agent without proposals says *no proposals yet*, and its tooltip what to do next.
- Several projects in one window: project names on threads, diffs and the PDF preview, counts per project on its row and in the status bar's tooltip, the project next to each agent in agent pickers, and Finish review offers only projects with something to commit.
- Dissolving a related group asks first, as it can't be undone; with several changes on a line, *Reject…* and *More…* name theirs; messages without command-line jargon (`stet_sync`, `stet undo`, "C1" for round 1, the main branch).
- Locating changes while you type no longer reads every change from disk each time: it took seconds while background checks ran.

**Agents and the command line**
- Ids are listed in order: 1.2 before 1.10.
- Agents no longer get "joined parts … both contain 1.60" when a new linked group is merged with an earlier one it overlaps.

**Accessibility**
- The PDF preview turns pages with Page Up/Down and shows after and before with A/B, and its picture's text says what the change is.
- In a High Contrast theme, where proposed text that wraps with the line has no border and isn't read, Stet offers once to use the highlighted style.
- Results reach screen readers (as notifications when VS Code's screen-reader mode is on), and comments, revision requests, replies and resolved notes say they were sent.
- "Your wording for … is saved" reaches screen readers too; it went only to the status bar.
- A change's spoken label says what its row says: *revision requested*, *your wording*, the number of messages, and the wording a change was accepted with.
- The PDF preview's title names the project in a window with several; the Reject… CodeLens has a tooltip.
- Setting texts match what is shown (`stet.codeLens`, `stet.longChanges`, `stet.shareEdits`).

- **Internal: no logic reads message text any more.** Errors carry a code (`usage`, `not_found`, `not_applied`, `linked`), which sets the command line's exit code, adds the advice to a refused reject, and gives VS Code's failed accept its Reject… and Revise… buttons. An accept by hand is stored as `committedWithEdits`, and a change an accept made stale names that accept (`staleBy`); older stores are read in this shape. Events have one typed payload per kind. `stet` exits with 3 for an unknown change id (`Unknown change '9.9'`) too, like for other unknown ids.
- **Internal: the VS Code extension in parts.** `extension.ts` (2,900 lines) is now a hub of 850: the projects, the views and what every command needs. The panel's rows (`tree.ts`), Undo, unread replies, PDF preview commands, *Set up project* and the commands (`commands/`: review, notes, navigation, agents, view options) are classes of their own. Nothing changes in use.
- **Internal: the command line is a table of commands.** Each command (`packages/cli/src/commands.ts`) carries its help lines and the options it takes; `stet --help` is made from the table, and an option another command takes is refused: `stet review --commit` says "`stet review` has no option --commit" (it was ignored). `main(argv, io)` returns the exit code and nothing runs on import, so tests call the CLI in their own process.
- **Internal: one copy of the rules both front ends use.** Reading ids (G3, G3.2, C12, N4, 12.3), which changes go with a linked change or a move, which decisions can be undone, a round's pending changes, what a change's description says (what it revises, your wording, its move, a whole file's first lines) and what setting up a folder finds (set up already, an agent's workspace, its languages, uncommitted edits) are now in core; `stet show`, the MCP server and the extension use them. Differences that come with it: a whole file shows its first 40 lines in the hover too (was 60), and a file that isn't UTF-8 its first 40 changed lines in `stet show` (was 80; `--full` shows all). VS Code asks about the linked group of a move's other end before accepting, as `stet accept` does, and *Set up project* keeps another `stet` only when its script is there, as on startup.
- **Internal: the extension's tests check behaviour, not source text.** They call what the extension draws and decides (the preview page and its keys, row and status-bar texts, menu entries, the High Contrast offer, which change a command acts on) instead of searching the source for strings; these parts moved into functions of their own, and the tests use a small stand-in for the `vscode` module. Both packages build test changes with one shared helper. The preview page's script nonce comes from `crypto`.
- **Internal: tests sorted by topic.** Test files are named after what they test (undo, linked groups, paths and links, the MCP server, …) instead of the report that found a bug; each regression test names its report and finding.
- **Internal: language profiles.** Everything Stet knows about LaTeX and BibTeX (tokens, structure, maths, labels, citations, macros, included files, and PDF previews with latexmk and SyncTeX) is now in one place per language, `packages/core/src/lang/`, and the rest of Stet asks the file's profile. Nothing changes in use: same items, groups, parts and previews, and `config.json` keeps its shape. This is the groundwork for other document languages (Typst).

## 0.16.0 — 2026-11-20

Fixes from the test report of 2026-11-20 (three testers, Stet 0.14.0).

**Your files and decisions**
- **Fix: accepting a change in a file that isn't UTF-8 (Latin-1, say) damaged the whole file.** Every character outside ASCII became �, on every line, for good. Such files are now proposed and accepted whole, byte for byte; a file you saved in another encoding since is left alone, with a message.
- **Fix: undoing one part of a linked group you accepted whole undid only that part** (a `\label` renamed back, its `\ref`s not). Everything the accept took along is undone together. Undoing a rejection made with `--revise-rest` also takes back the revision requests it sent.
- **A linked group decided differently in its parts now tells you** (a `\ref` accepted, its `\label` rejected), when you accept or reject, and in `stet show G1`. Only the agent was told before.
- **Archiving an agent with its folder no longer deletes its unsubmitted work without asking.** `stet agent archive --remove` refuses while the agent has changes it didn't submit (`--force` deletes them anyway); in VS Code, *Archive, keep folder* is the first button (Enter), and the delete button says how many files it loses.
- **A new file and the `\input` (or `\include`, `\includegraphics`) that reads it in are linked**, as are a deleted file and the `\input` taken out: the command alone stopped LaTeX.
- **Fix: changes of spaces inside `verbatim`, `lstlisting`, `minted` and the like were dropped**, and the agent's next sync undid them silently. Spaces there are content now; elsewhere, reflowed text is still ignored.
- **`stet commit` names the files where it also commits your own edits** (it commits whole files), in its output and in the commit message.
- **Changes whose commit was dropped from your branch (`git reset --hard`) no longer count as committed.** Gone from your file, they are pending again (the agent is told); still in it, they are accepted but uncommitted again, so undo works.
- **Two edits that rebuild one sentence together are one change** ("Plants are … and therefore" → "Because plants are …, they"): edits at most six words apart, one of which changes the sentence's punctuation or a word's capitals. Either alone left a broken sentence. Plain word swaps stay separate.
- **A sentence that only changes paragraph is one change, not a move.** When the agent moved a paragraph break past a sentence (it ended one paragraph and now starts the next), the sentence showed as moved "word for word". It is now one change, *paragraph break moved*, and the editor and `stet show` mark just the breaks; splits and joins are named as such (`paragraph split`, `paragraphs joined`), with ¶ and ␣ for the breaks instead of invisible whitespace.
- **Files larger than 20 MB are refused** at submit (`maxFileMB` in the config); `stet review` shows the size of new and deleted files.
- **Reviewer commands are refused in an agent's workspace** (`stet accept` and the like): an agent without a sandbox could have accepted its own proposals.

**Bugs**
- **Much faster with many changes in one file:** 750 changes in a 3000-line file took 160 s to submit and 25 s to list; now under a second each. Accepting one of them took 4 s, now 0.1 s.
- **The command line:** a wrong option gives a one-line error instead of a stack trace; `stet --version`; exit codes tell a wrong command line (2) and an unknown id (3) from other errors (1); `--status` and `--agent` with a typo are refused instead of finding nothing.
- **An archived agent's name can be used again** once its folder and branch are gone, as the manual says for recreating a workspace.
- **A revision says what it revises** (`revises 2.3`) in `stet review`, the panel and the hover, and `stet show` gives what you asked for there. `stet show` gives the wording you accepted (or saved) next to the agent's.
- **Summaries show where a change differs**, not the same cut-off start on both sides, and make whitespace visible (`"␣" → "~"`, `¶` for a paragraph break).
- MCP tools refuse calls without their required arguments; a path git won't take (`sub/.GIT/config`) gets a clear message; `stet doctor` accepts a git identity from `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
- **VS Code:** a command from the palette acts on the change you picked last (in the panel, or at the cursor), and at the cursor on the change it is in or the nearest one on the line, not the line's first. `u` in History undoes the History item (it used the panel's selection). An agent's own window says where to review instead of "not set up".

**Using it**
- `stet accept C3` / `stet reject C3` decide a whole round. `stet review` mentions accepted changes not committed yet, marks changes no longer found in your file (with what to do), suggests next steps, and reminds you of `stet share` only when there are agents. `stet init` says when Stet is already set up, and warns about uncommitted edits. Statuses read as words, times in your time zone, and `stet show` explains `[-…-]{+…+}`.
- **VS Code: undo your last decision.** `u` in the Review panel (or *Stet: Undo my last decision*) takes back your last accept or reject, with everything it decided; for 15 seconds after each decision the status bar shows an **Undo** button too.
- **VS Code: filter and search the panel** (`/`, or the funnel in its title): by agent, file, waiting for you or for a revision, or words in a change, its note or its conversation. ✕ shows everything again; `j`/`k` move through what is shown.
- **VS Code:** long round titles are shortened at a word in the panel, and a decided change's hover shows its whole conversation (a pending one its last three messages, with a note that there are more).
- **VS Code:** *Accept all* and *Reject all* ask first whenever they decide more than one change (except a linked group, which goes together anyway); dissolving a linked group asks first. The counts include only changes waiting for you, not those waiting for the agent's revision.
- **Accessibility:** changes and the status bar are read out in words by screen readers; inserted text has a border in high-contrast themes; the PDF preview names its buttons and pictures, marks the pressed version, announces the page, and moves and zooms from the keyboard.
- **Docs:** a glossary in the command-line manual (with the panel's names), the README's example is real `stet review` output, and outdated names in the manuals and settings are fixed.

## 0.15.0 — 2026-11-20

- **Fix: Stet could stop accepting anything ("Timed out waiting for the Stet lock").** A Stet process stopped just as it took the store's lock (a window reloaded, a command killed) left an empty lock behind that named no owner, and nobody took it over: every decision timed out while hovers and previews kept working. The lock is now written whole before it appears, and an empty or unreadable lock older than 30 seconds is taken over.
- **Fix: PDF previews of long rewrites highlighted only their end.** A change of more than about 80 words was searched for on the page in too short a stretch, so only the edits near its end were marked. All of it is found now.
- **Diffs show your text on the left, not your text with the proposals in it.** The left side of Diff and Review file is your text as it is, read-only, with what the changes remove in red. **View options → Diffs: your side shows the proposals too** brings back your file itself there (editable, marked as in the editor).
- **Save your wording without accepting.** Editing a longer change opens an editor of its own instead of an untitled tab and a notification: Ctrl+S keeps your wording (the change stays pending), and Accept with this wording, Agent's wording and More… are above the text and in the title bar. The input box for short changes has a save button for the same.
- **Going to a change uses the tab that has its file open,** in whichever editor group, instead of opening the file again in the focused one; and it no longer covers the PDF preview.
- **PDF previews read maths alike in both versions.** pdftotext breaks lines around formulas into pieces in no stable order, and splits `p+i` or not depending on the line's spacing, so unchanged formulas were marked. Lines are rebuilt from where the words are, maths compares symbol by symbol, and a formula that only moved because the words around it changed isn't marked.

## 0.14.0 — 2026-11-20

- **Faster submits of large revisions:** paragraphs are paired from the words they share, counted once for the whole region, and the word-by-word comparison runs only for pairs that can be alike. Move detection skips pairs with too few words in common the same way. A section of 60 paragraphs reordered takes 0.2 s instead of 1.2 s, a 400-paragraph paper with an edit in every paragraph 0.3 s instead of 2 s, with the same results.
- **Fewer git calls:** opening a project takes one git call instead of four from the project folder, and two from an agent workspace (`stet` commands, the agent guard on every tool call, the extension). The guard no longer looks up the repository twice. A submit reads each file and the list of changed files once.
- **Edit & accept** uses the small input box only for changes of one short line (up to 80 characters, what the box shows); longer ones open in a tab right away. The box has a button to continue in a tab, keeping what you typed.
- **Diff works like Review file:** on a pending change it opens an editable review of just that change (plus what accepting it takes along: its linked group, a move's other half), instead of a read-only diff. Decided and whole-file changes keep the read-only diff.
- **Decide in the review with the same actions as in your file:** the buttons above a change now say *Accept move* or *Accept all 3 linked* where the change must be decided that way, and the hover (with its PDF preview) and Ctrl+. work in the review too. Every action there saves your unsaved edits in the review first, so a decision uses the wording you see.
- **Edit & accept** starts from your wording when you have one from a review.
- **Fix: the Stet panel kept changes and groups that were gone** after an agent merged changes into one (`stet_group` atomic) or removed a group, until something else reloaded it. Those changes append no event, and the panel only watched the event log. The store now rewrites a `changed` file after every operation that changes its records, and the panel reloads on it.
- **PDF previews highlight the change, and only it.** The page view no longer marks what a change merely causes (equations and references renumbered further down). Words compare as typeset, so a change in a formula (`k` → `k^2`) marks the exponent, not the equation number that looked the same without its brackets, and a comma added is marked. A mostly rewritten sentence is marked whole, as the editor shows it, instead of in fragments around common words like "the".
- Tests: the real-world review checks run four at a time and build their repositories with fewer git calls. One of them hit the 120 s limit where starting git is slow.

## 0.13.0 — 2026-11-19

- **Fix: a paragraph inserted next to one edited in place** showed as "old paragraph → new paragraph" plus the edited paragraph inserted again, so accepting only some of them dropped or duplicated text (bug report C42). Paragraphs are now paired by similarity, not position: you get an insertion, and small edits in place. An unrelated paragraph replacing another is still one replacement, unless the old one moved elsewhere: then it's an insertion and a move.
- **Moves:** a short paragraph with a changed word, or a single sentence of 7 words or more, is a move now. One changed word per 10 words (at least one) is allowed, with no upper limit. A passage moved and rewritten beyond that is a linked deletion and insertion (*Moved and rewritten*), so accepting one alone can't lose or duplicate it (bug report C38).
- **A heavily rewritten sentence is one change** instead of word-sized fragments that don't read on their own (bug report C31). A sentence moved inside its paragraph comes out as whole sentences.
- **Smaller linked groups:** "linked" (all or nothing) is kept for changes that break the document without each other: a macro and its uses, a `\begin` and its `\end`, one symbol renamed across formulas, moves. An agent's linked group without such a dependency becomes a related group (Accept all still works), with only the changes that need each other linked, and the agent is told. It can insist with a reason, which you see on the group. The agents' instructions say this more plainly.
- **Fix: a sync during submit** could leave a paragraph twice in the agent's workspace (a consequence of the C42 pairing). The submit result now also says which changes went stale and that they are no longer in the workspace (bug report C36).
- **One change per new paragraph:** several paragraphs inserted (or deleted) in a row are one change each, and so is a heading; an inserted environment stays whole. Paragraphs that move together, in the same order, are one move; a reordered section is a move per paragraph (it came out as a few huge changes), not one all-or-nothing change.
- **Macro renames are linked automatically** with the changes that use them: a renamed or new `\newcommand`, environment, or TikZ style (`vertex/.style`). Accepting a use without its definition is a LaTeX error.
- **Fix: headings stuck to the paragraph after them** when paragraphs were paired, so a paragraph inserted after a heading showed as heading plus paragraph inserted and the old heading deleted. A moved heading is a move.
- **Fix: TikZ pictures** with several small edits came out as one change; statements (`;`) are kept apart now. Several paragraphs replaced by unrelated text are one replacement instead of fragments.
- **Guard:** the Stet command's `help` and `--help`, and reading `.stet/` with output thrown away (`2>/dev/null`) or in a chain of reading commands, are no longer blocked. `find -delete` and `find -exec` count as writes.
- **One set of actions on every change, everywhere.** The hover, the row above a change, the Stet panel and the new lists all offer the same actions under the same names, in the same order: Accept, Reject…, Edit & accept…, Revise…, Comment…, Diff, PDF preview, Review file, Use agent's wording, Undo. "…" means it asks you something first.
  - **Above a change:** Accept · Reject… · More…, a shorter line.
  - **More…** lists every action on a change with its key and what it does; **Ctrl+.** (Cmd+.) in a change shows the same list in VS Code's Quick Fix menu.
  - **Keys in the panel** for the rest: `p` PDF preview, `f` Review file, `u` Undo, `.` More… (and `d`, `u` in the History view).
  - **Accept on a linked change** accepts its group (or part) wherever its label can say so; the panel's button and `a` still ask. *Accept only 2.3* breaks the group on purpose.
- **Tidier panel title:** only Share my edits and Finish review (when they apply) and View options; New agent workspace, Refresh, Set up PDF previews, Check setup and Set up project are in the `…` menu.
- **View options** now also hold how new text is drawn (`stet.newTextStyle`) and the green colour for wrapping text, which was a separate title-bar button.
- **Agents:** one icon per agent (the notification bell); *Notify now* is the megaphone in the bell's checklist, and in the right-click menu.
- **New Marketplace page:** the extension's README describes reviewing, PDF previews, notifications, notes, View options and all settings.
- **Fix: hovers that were hard to open and closed at the slightest movement.** A change's hover answered only to the struck-through old text, so short changes were hard to hit and insertions (no old text) could hardly be hit at all; and it closed as soon as the mouse left that text. It now answers to the change and the word before and after it, and stays open while the mouse is anywhere in that area.
- **The green proposed text has the full hover**, with the actions and the PDF preview, instead of only the proposed text (with word wrap on, where it is an inline hint).
- **Fix: the hover changed size when its preview loaded.** The preview image now has its size from the start.
- **Faster first hovers:** where the changes are in a file is looked up again only when its changes change (a new proposal, a decision, a reply), not on every refresh of the project.
- Integration test: on Linux it starts VS Code's binary rather than the `code` script, which could hand off to an open VS Code and return without running the test.

## 0.12.0 — 2026-11-19

- **Page view in the Preview panel:** the whole page with the change, opened at it, with the changed words highlighted (inserted in green, removed in red), from a word diff of the two versions that ignores reflowed text. **After | Before** flips at the same zoom and position, ◀ ▶ turn pages (rendered on demand). `stet preview <id> --page <n> [--before]` gives a whole page on the command line. The hover still shows the region.
- **Fix: previews show the right part of the page.** The region came from SyncTeX, which maps source lines to the page; a LaTeX paragraph is often one source line, so a change deep in a long paragraph got the whole paragraph, from the page where it starts. Stet now finds the change's words on the page (with Poppler's word positions) and crops to them, with a few lines of context, falling back to SyncTeX where the words can't be found. A preview that shows several changes together (a linked part, or the changes completing it) now crops to all of them, in *before* as in *after*.
- **Preview zoom like a PDF viewer:** zooming enlarges the page inside its frame instead of the whole panel. Ctrl/Cmd + wheel zooms around the pointer, dragging moves the page (as does the wheel when zoomed in), and double-click zooms in on a spot or back. *After* and *Before* move together.
- **Review all changes in a file:** a diff of your file against the same file with all its pending changes applied, with real line breaks and word wrap. The right side is editable: saving keeps your wording for those changes, which stay pending; ✓ Accept above each change accepts it with your wording (as does accepting it anywhere else), ↺ Agent's wording drops yours, and edits outside the proposed changes are refused. Open it from the editor title bar, the editor's context menu, *All changes* in the hover, or the Stet panel.
- **Missing packages in previews:** a preview that fails because LaTeX can't find a file now names it (`dsfont.sty isn't in the preview's TeX`). With the image that brings its own TeX, Stet asks once whether to install TeX's extra fonts (dsfont, bbm, bbold and many more, about 2 GB more; Debian packs them together), and the preview panel offers the same as a button. The image stays small unless you agree. `stet preview setup --extras` does the same on the command line. With your own TeX, the message points to installing the package there.
- **Fix: release build of 0.11.1.** The same preview-setup test expected Podman in its message on Windows too, where Stet says previews aren't supported yet. It now expects each platform's own message. This release contains all changes of 0.11.0 and 0.11.1, whose release builds stopped at that test.

## 0.11.1 — 2026-11-19

- **Fix: release build of 0.11.0.** A test of the preview setup assumed Podman wasn't installed, and failed on build machines that have it. It now rules Podman out itself. 0.11.1 contains all changes of 0.11.0.

## 0.11.0 — 2026-11-19

- **Previews on macOS:** previews used your own TeX inside the container, which works only on Linux (MacTeX's programs can't run in Podman's Linux machine), so macOS only got a message. Where your TeX can't be used (macOS, or Linux with a distribution's TeX), the preview image now brings its own TeX Live (about 1.5 GB, built once with Set up). Stet also finds Podman where its macOS installers put it, and says so when Podman's machine isn't running.
- **Zoom in previews:** zoom buttons, Ctrl/Cmd + wheel and double-click in the preview panel; images are rendered at 200 dpi so they stay sharp.
- **Proposed text with word wrap:** inline proposals wrap with the line (now up to 2000 characters before the panel takes over). If your VS Code settings cut inline text (`editor.inlayHints.maximumLength`) or hide it (`editor.inlayHints.enabled`) for your LaTeX files, Stet says so once and offers to fix them for that language. Line breaks can't be shown inline (⏎); the panel under the change shows them.
- **Fix: previews of changes that only work together.** A preview applied the change alone, so one end of a pair (a `\begin{proof}` removed in one change and its `\end{proof}` in another, or the two ends of a move) failed with "\begin{proof} … ended by \end{document}". A preview now applies what accepting the change would apply, then the changes of its round that complete it, then the whole round, and says which it shows.
- **Fix: previews of papers with an error elsewhere.** Builds stopped at the first LaTeX error, so a document with any error got no previews at all. They now continue like a normal compile; errors that only the change brings are shown next to its preview.
- **Previews in the hover:** a change's hover shows its PDF preview once it is built (selecting a change starts building it). The setting `stet.pdfPreviews` (also under View options) chooses where previews appear: hover and panel, one of them, or off.

## 0.10.0 — 2026-11-19

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
