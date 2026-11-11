# Stet on the command line — user manual

The `stet` command does everything the VS Code extension does, plus the agent side of the workflow. You can mix the two freely: they work on the same data (`.git/stet/` in your repository) and see each other's changes immediately.

The extension manual ([vscode.md](vscode.md)) explains the concepts in more detail: agent workspaces, changesets, groups, items and the review flow.

---

## 1. Installation

**Requirements:**
- Node.js 20 or newer
- git 2.28 or newer (on Windows: *Git for Windows*)

In a clone of the Stet repository:

```bash
npm install
npm run build
cd packages/cli && npm link      # optional: puts `stet` on your PATH
```

Without `npm link`, run `node <path-to-stet>/packages/cli/dist/index.js` wherever `stet` appears below.

All commands accept:
- `--help`
- `--json` for machine-readable output

Colours are switched off when the output is not a terminal, or when `NO_COLOR` is set.

---

## 2. Setting up a project

Run these in your LaTeX project, which must be a git repository with at least one commit.

| Command | What it does |
|---|---|
| `stet init [--main <branch>]` | Sets up Stet: creates `.git/stet/` and installs the git hooks that stop agent branches from being merged or pushed. The main branch defaults to the one checked out. |
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
| `stet agent archive <name> [--remove]` | Retires an agent: its pending changes are withdrawn. `--remove` also deletes the folder and branch. The agent is told on its next action. |

Names use letters, digits, `.`, `_` and `-`. What happens inside a workspace, and how Claude and Codex are set up, is described in [agents.md](agents.md).

---

## 4. Reviewing

Run these in your project folder. Changes have ids like `12.3`: change 3 of round 12, where a round is one submission by an agent (`C12` on the command line). Groups are `G3`. Changes from before this numbering keep their old ids (`S412`).

| Command | What it does |
|---|---|
| `stet review [--agent <a>] [--status <s>] [--all]` | Lists changes waiting for review (pending or revision requested), per agent → round → group. `--status` takes a comma-separated list (`pending,accepted,…`); `--all` shows everything. |
| `stet show <12.3\|G3\|C12\|N3>` | Shows a change with its context, a group or round with its members, or a note with its thread. |
| `stet accept <12.3\|G3\|G3.2>… [--text <t> \| --text-file <f>] [--force] [--commit \| --no-commit]` | Applies changes to your files. `G3.2` accepts part 2 of group G3. `--text`/`--text-file` accepts one item with your own wording. `--force` accepts part of a linked group (or of one of its parts) anyway, which marks the group broken. |
| `stet reject <12.3\|G3\|G3.2>… [-m <reason>] [--all \| --revise-rest \| --only]` | Rejects changes; the agent gets the reason. For a member of a linked group, choose `--all` (reject the whole group, or the whole part if the group has parts), `--revise-rest` (reject this one and ask for revisions of the rest) or `--only`. |
| `stet revise <12.3> -m <what to change>` | Asks the agent for a new version. |
| `stet comment <12.3\|N3> -m <text>` | Sends a message about a change, or in a note's thread; the agent can reply. |
| `stet note <agent> <file[:line[-line]]> -m <text>` | Leaves a note for one agent on a passage (a line range, or the whole file). The agent receives it at its next sync. |
| `stet note resolve <N3>` | Closes a note. |
| `stet notes [--agent <a>] [--all]` | Lists open notes (`--all`: resolved ones too). |
| `stet commit [-m <summary>]` | **Finishes the review:** commits all accepted changes in one commit. The summary line defaults to the changeset titles; the body lists the accepted changes and a `Stet-Applied:` trailer. |
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

Shared are your tracked files, files you staged with `git add`, and new `.tex`/`.bib` files. Other new files (`.aux`, `.pdf`, …) stay out unless you `git add` them. Your git staging area is not changed.

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

**Grouping hints for `submit --groups`:** a JSON list, from a file or `-` for standard input. Locations are `file`, `file:line` or `file:from-to`, in the workspace after the edits:

```json
[
  { "kind": "linked", "title": "Rename sec:intro → sec:introduction", "where": ["main.tex:3", "main.tex:12"] },
  { "kind": "atomic", "title": "Rewrite the first sentence", "where": ["main.tex:4-5"] },
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
| `shareEdits` | `manual` | Which of your own edits agents see: `manual` (after `stet share`), `saved` (always), `committed`. |
| `guardHooks` | `true` | Install the git hooks at `stet init`. |
| `split.mergeGap`, `split.rewriteRatio`, `split.abbreviations` | 2, 0.5, … | How edits are split into items (spec §6.2). |
| `grouping.autoRepeatMin`, `grouping.autoDetect`, … | 3, … | Automatic grouping (spec §6.4). |

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
