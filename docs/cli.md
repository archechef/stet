# Stet on the command line — user manual

The `stet` command does everything the VS Code extension does, plus the agent side of the workflow. You can mix the two freely: they work on the same data (`.git/stet/` in your repository) and see each other's changes immediately.

The extension manual ([vscode.md](vscode.md)) explains the concepts in more detail: agent workspaces, changesets, groups, items and the review flow.

---

## 1. Installation

**Requirements:**
- Node.js 22 or newer
- git 2.28 or newer (on Windows: *Git for Windows*)

**From a release (the usual way):** every [release](https://github.com/archechef/stet/releases) has `stet-<version>.mjs`, the whole command in one file, and `SHA256SUMS.txt` to check it. Save it somewhere permanent (here `~/bin`, for version 0.18.0) and run it with Node.js:

```bash
node ~/bin/stet-0.18.0.mjs --help
```

To type `stet` instead, put a small script on your PATH. On Linux and macOS, `~/bin/stet`, made executable with `chmod +x ~/bin/stet`:

```bash
#!/bin/sh
exec node "$HOME/bin/stet-0.18.0.mjs" "$@"
```

On Windows, `stet.cmd` in a folder on your PATH: `@node "%USERPROFILE%\bin\stet-0.18.0.mjs" %*`.

The VS Code extension brings its own copy for the agents and doesn't need this one.

**From the source:** in a clone of the Stet repository, `npm install`, `npm run build`, then `cd packages/cli && npm link` puts `stet` on your PATH. Without `npm link`, run `node <path-to-stet>/packages/cli/dist/index.js` wherever `stet` appears below.

All commands accept:
- `--help`, and `--version` (or `stet version`)
- `--json` for machine-readable output

The exit code is 0 on success, 2 for a wrong command line (an unknown option, a missing argument), 3 for an unknown id or name (`stet show 9.9`), and 1 for any other error.

Colours are switched off when the output is not a terminal, or when `NO_COLOR` is set.

---

## 2. Setting up a project

Run these in your LaTeX, Typst or Lean project, which must be a git repository with at least one commit.

| Command | What it does |
|---|---|
| `stet init [--main <branch>] [--language <latex\|typst>]` | Sets up Stet: creates `.git/stet/` and installs the git hooks that stop agent branches from being merged or pushed. The main branch defaults to the one checked out. The language (agents' instructions follow it) is the one with more files, LaTeX on a tie; `stet init` says which, and warns when there are both. `--language` chooses it. |
| `stet doctor` | Checks your setup and prints a fix for each problem it finds. It covers git, the hooks, the agent workspaces and Stet's data. The exit code is 1 if there are errors. |
| `stet hooks install [--force]` / `uninstall` / `status` | Manages the git hooks. Hooks you already had are kept and still run. With a custom `core.hooksPath` (e.g. husky), nothing is installed unless you pass `--force`. |
| `stet setup claude` / `stet setup codex` `[--print]` | Optional: registers the Stet tools with Claude Code or Codex for all folders. Every agent workspace already carries its own configuration. `--print` only shows the command. |

---

## 3. Agent workspaces

| Command | What it does |
|---|---|
| `stet agent new <name> [--kind claude-code\|codex\|other] [--path <dir>]` | Creates a workspace folder and prints its path; the default is `<project>.stet/<name>`. Open that folder in the Claude desktop app, Claude Code or Codex. |
| `stet agent list` | Lists all agents with their state and folder. |
| `stet agent refresh <name>` | Rewrites the agent's instructions, tool configuration and guardrails, e.g. after a Stet update. |
| `stet agent archive <name> [--remove [--force]]` | Retires an agent: its pending changes are withdrawn. `--remove` also deletes the folder and branch; it refuses while the agent has changes it did not submit, unless you add `--force`. The agent is told on its next action. |
| `stet agent notify <name> [now\|batched\|off] [--on <kinds>\|all]` | When an agent waiting with `stet watch` is woken: `batched` (default) once you have paused for half a minute, `now` at each decision, `off` not at all (switching back on delivers what arrived meanwhile). `--on` chooses what wakes it, from `accepted`, `rejected`, `revision`, `comment`, `note`, `document` (commits and shared edits) and `save` (saves, when agents see saved edits), comma-separated, or `all`. Without options, shows the current settings. |
| `stet agent ping <name> [-m <text>]` | Wakes a watching agent now, whatever its notification settings, optionally with a message. |

Names use letters, digits, `.`, `_` and `-`. What happens inside a workspace, and how Claude and Codex are set up, is described in [agents.md](agents.md).

---

## 4. Reviewing

Run these in your project folder (in an agent's workspace they are refused, so an agent can't decide its own proposals). Changes have ids like `12.3`: change 3 of round 12, where a round is one submission by an agent (`C12` on the command line). Groups are `G3`. Changes from before this numbering keep their old ids (`S412`).

**Words used here**, with the panel's name where it differs:

| Term | Meaning |
|---|---|
| round (`C12`, "changeset") | One submission by an agent: its title, rationale and changes. |
| change (`12.3`, "item") | One edit you accept or reject on its own. |
| group (`G3`) | Changes that belong together: *linked* ones go together (accepting only some would break the document), *related* ones share a theme. `[auto]`: Stet found the group itself. |
| part (`G3.2`) | A piece of a large linked group that can be decided on its own and still leaves the document compiling. |
| broken | A linked group decided inconsistently; the agent is asked to repair the document. |
| pending / needs revision | Waiting for you / waiting for the agent's new version. |
| stale | No longer applies to your text (another change overlapped it); the agent is told to redo it. |
| superseded | Replaced by the agent's newer version of the change (`revises 12.3`). |
| withdrawn | Taken back by the agent, or by archiving it. |
| share (*Share my edits*) | Let agents see your saved, uncommitted edits. Accepted changes always reach them. |
| sync | The agent catching up with your latest text (`stet sync`, or its tool). |
| `stet commit` (*Finish review*) | Commit everything accepted, in one commit. |
| `stet ungroup` (*Dissolve group*) | Remove a group; its changes stay. |
| `notify now` / `batched` (*Right away* / *When I pause*) | When an agent is woken by news: at each decision, or once you've paused for half a minute. |

| Command | What it does |
|---|---|
| `stet review [--agent <a>] [--status <s>] [--all]` | Lists changes waiting for review (pending or revision requested), per agent → round → group. `--status` takes a comma-separated list (`pending,accepted,…`); `--all` shows everything. |
| `stet show <12.3\|G3\|C12\|N3> [--full]` | Shows a change with its context, a group or round with its members, or a note with its thread. Added and deleted files show their first 40 lines and say how many more there are; `--full` shows them whole. |
| `stet accept <12.3\|G3\|G3.2\|C12>… [--text <t> \| --text-file <f>] [--force] [--confirm] [--commit \| --no-commit]` | Applies changes to your files. `G3.2` accepts part 2 of group G3; `C12` accepts every pending change of round 12. `--text`/`--text-file` accepts one item with your own wording. `--force` accepts part of a linked group (or of one of its parts) anyway, which marks the group broken. `--confirm` is needed for changes to files that take effect: a `latexmkrc` (run by latexmk), `.gitattributes`, `.vscode/`, `CLAUDE.md`/`AGENTS.md`, agent tool settings, a Makefile; `stet review` and `stet show` flag them with ⚠. |
| `stet reject <12.3\|G3\|G3.2\|C12>… [-m <reason>] [--all \| --revise-rest \| --only]` | Rejects changes (`C12`: every pending change of round 12); the agent gets the reason. For a member of a linked group, choose `--all` (reject the whole group, or the whole part if the group has parts), `--revise-rest` (reject this one and ask for revisions of the rest) or `--only`. |
| `stet undo <12.3>` | Undoes a rejection, a revision request the agent hasn't answered yet, or an accept until you commit it (the change is taken out of your file again): the change is pending again, and so are changes the accept made stale. Changes decided together (a linked group, a move) are undone together. The agent is told. A rejection is undone only while the change still applies to your file and no pending change of the agent competes for the same text; else nothing is undone, and it says why. |
| `stet preview <12.3>` | PDF preview of a change: writes images of the page region after and before the change and prints their paths. Says so when the change has no place on the page, or when the document doesn't compile. |
| `stet preview <12.3> --page <n> [--before]` | A whole page of the preview as an image: of the version with the change, or `--before` it. |
| `stet preview status` | What PDF previews can use here, and what is missing. |
| `stet preview setup` | Builds the container image previews compile in (downloads Debian, Perl and Poppler, about 150 MB). Only ever on this command. |
| `stet preview setup --extras` | Adds TeX's extra fonts (dsfont, bbm, bbold, …, about 2 GB) to the preview image with its own TeX, and uses it from then on. A preview that fails over a missing file suggests it. |
| | **Moves:** `stet review` shows a moved passage as `moved out` and `moved in … word for word` (or with the number of changed words, listed by `stet show`). Accepting or rejecting either half decides both. A sentence that only changes paragraph (the break before or after it moved) is no move: one change, `paragraph break moved`, and `stet show` marks just the breaks (`[-␣-]{+¶+}`). Splits and joins say `paragraph split` / `paragraphs joined`. |
| `stet revise <12.3> -m <what to change>` | Asks the agent for a new version. |
| `stet comment <12.3\|N3> -m <text>` | Sends a message about a change, or in a note's thread; the agent can reply. |
| `stet note <agent> <file[:line[-line]]> -m <text>` | Leaves a note for one agent on a passage (a line range, or the whole file). The agent receives it at its next sync. |
| `stet note resolve <N3>` | Closes a note. |
| `stet notes [--agent <a>] [--all]` | Lists open notes (`--all`: resolved ones too). |
| `stet commit [-m <summary>]` | **Finishes the review:** commits all accepted changes in one commit. The summary line defaults to the changeset titles; the body lists the accepted changes and a `Stet-Applied:` trailer. It commits the changed files whole, so your own uncommitted edits in them are committed too: Stet names those files in its output and in the commit message. |
| `stet share` | Lets agents see your saved edits (they pick them up at their next sync). See *What agents see* below. |
| `stet share manual\|saved\|committed` | Sets when agents see your edits. |
| `stet group <12.1> <12.2>… --kind atomic\|linked\|related -t <title> [-m <rationale>] [--parts <file.json\|->]` | Groups changes yourself. `--parts` splits a linked group into parts: `[{"title": "Section 2", "items": ["12.1", "12.4"]}, …]`. |
| `stet ungroup <G3>` | Dissolves a group; its changes stay. |

**Linked groups** are all-or-nothing:
- `stet accept G3` applies all members or none.
- `stet accept 2.5` on a member is refused unless you add the rest or `--force`.

**What agents see of your own edits:** changes you accept always reach agents. Your own edits reach them depending on `shareEdits`:
- `manual` (default): when you run `stet share`. Agents then see your saved files as they are at that moment; `stet review` reminds you when you've saved edits since. A new commit replaces an older share.
- `saved`: automatically, whenever an agent syncs.
- `committed`: only once you commit them.

Shared are your tracked files, files you staged with `git add`, and new `.tex`, `.typ` and `.bib` files. Other new files (`.aux`, `.pdf`, …) stay out unless you `git add` them. Your git staging area is not changed.

**When changes are committed:** by default, accepting only writes your files, and `stet commit` makes one commit for the whole review. With `"autoCommit": "when-clean"` in `.git/stet/config.json`, each accept is committed right away, unless the file had your own uncommitted edits.

**Example:**

```bash
stet review
stet show 2.1
stet accept 2.1 2.2
stet accept G1                            # a whole group
stet reject 2.3 -m "keep the original formula"
stet revise 2.4 -m "shorter, please"
stet accept 2.5 --text "our revised wording"
stet commit -m "Polish the introduction"
```

---

## 5. The agent side

Agents normally use the Stet tools through MCP (see [agents.md](agents.md)). The same actions are available as commands, run inside the agent's workspace. Elsewhere, add `--agent <name>`.

| Command | What it does |
|---|---|
| `stet status` | Item counts, unread feedback, and whether the agent must sync before new work. |
| `stet submit -t <title> [-m <rationale>] [--groups <file.json\|->] [--notes <file.json>]` | Submits the workspace's edits for review (Stet commits them). |
| `stet sync` | Moves the workspace onto your latest text: accepted changes become part of it, rejected ones disappear, pending ones stay. Also prints the reviewer's notes waiting for this agent. |
| `stet feedback [--peek]` | New decisions and comments since the last call; `--peek` leaves them unread. |
| `stet list [--status <s>]` | The agent's own items. |
| `stet reply <12.3\|N3> -m <text>` | Answers a reviewer comment or note. |
| `stet withdraw <12.3>… [-m <reason>]` | Withdraws the agent's own pending items. |
| `stet watch [--once]` | Waits for the reviewer: prints one line whenever something arrives for this agent (feedback, a note, a sync needed), from the workspace's `.stet/inbox`. `--once` exits after the first lines. Read-only, so it works in the agent's sandbox. The inbox is written while the agent's Stet MCP server runs. |

**Grouping hints for `submit --groups`:** a JSON list, from a file or `-` for standard input. Locations are `file`, `file:line` or `file:from-to`, in the workspace after the edits. A quoted snippet of the new text after a location picks one change on that line, e.g. `main.tex:4 "suggestion"`: a paragraph is often one line, and only the snippet can put two of its changes into different parts:

```json
[
  { "kind": "linked", "title": "Rename sec:intro → sec:introduction", "where": ["main.tex:3", "main.tex:12"] },
  { "kind": "atomic", "title": "Rewrite the first sentence", "where": ["main.tex:4-5"] },
  { "kind": "linked", "title": "Terms", "where": ["main.tex:6"], "parts": [
    { "title": "base", "where": ["main.tex:6 \"shared base\""] },
    { "title": "proposal", "where": ["main.tex:6 \"suggestion\""] } ] },
  { "kind": "related", "title": "Consistent spelling", "rationale": "British English", "where": ["main.tex"] }
]
```

**Notes for `--notes`:** a list of `{ "where": "main.tex:7", "note": "why this change" }`.

---

## 6. Internal commands

These are started by the agent tools; you don't run them yourself.
- `stet mcp`: the MCP server over stdio.
- `stet guard`: Claude Code's PreToolUse hook. Exit code 2 blocks the tool call.

They read these environment variables:

| Variable | Meaning |
|---|---|
| `STET_WORKSPACE` | The agent workspace folder (MCP server). |
| `STET_AGENT` | The agent's name. |
| `STET_PROJECT` | The reviewer's project folder, so an archived workspace can still be explained after its folder is gone. |
| `ELECTRON_RUN_AS_NODE` | Set when Stet runs on VS Code's own runtime instead of Node.js. |

---

## 7. Configuration

Settings live in `.git/stet/config.json`. Only settings that differ from the defaults are stored there.

| Setting | Default | Meaning |
|---|---|---|
| `mainBranch` | the branch at `stet init` | The branch accepted changes go to. |
| `agentBranchPrefix` | `stet/` | Prefix of agent branches. |
| `worktreeRoot` | `../{repo}.stet` | Where agent workspaces are created. It must be outside the project. |
| `autoCommit` | `on-finish` | `on-finish`: `stet commit` / *Finish review* commits. `when-clean`: commit after each accept. |
| `maxFileMB` | `20` | The largest file an agent can propose; a submit with a larger one is refused. |
| `shareEdits` | `manual` | Which of your own edits agents see: `manual` (after `stet share`), `saved` (always), `committed`. |
| `guardHooks` | `true` | Install the git hooks at `stet init`. |
| `split.mergeGap`, `split.rewriteRatio`, `split.abbreviations` | 2, 0.5, … | How edits are split into items (spec §6.2). |
| `grouping.autoRepeatMin`, `grouping.autoDetect`, … | 3, … | Automatic grouping (spec §6.4). |
| `grouping.moves` | `{"enabled": true, "minWords": 15, "maxChangedWords": 3}` | Moved passages shown as one move (spec §6.4.7). |

The full list is in [spec.md](spec.md) §11. Invalid values (e.g. a branch name with shell characters) are reported instead of used.

---

## 8. Troubleshooting

Run `stet doctor` first. Common messages:

| Message | Meaning |
|---|---|
| `Stet is not set up in this repository` | Run `stet init` in the project folder. |
| `… is linked with …` | Accept or reject the whole group, or pass `--force`, `--all`, `--revise-rest` or `--only`. |
| `Your project folder is on '…', not 'master'` | Switch back to the main branch before accepting or committing. |
| `Nothing was applied: …` | An accept could not write every file (e.g. a path is a link or a file is locked). All files were restored. |
| `Stet refuses to run git in …` | The workspace's git link was changed. Recreate the workspace (`stet agent archive <name> --remove`, then `stet agent new <name>`). |
| `the reviewer archived this workspace` | The agent's workspace is archived. Create a new one. |
