# Working with AI agents — user manual

Stet works with any agent that can edit files, and works best with agents that support MCP tools: the Claude desktop app, Claude Code and Codex. This page explains:
- how to connect each of them;
- what an agent sees in its workspace;
- how the review conversation works;
- what protects your project.

---

## 1. The workspace

Each agent session gets its own **agent workspace**:
- a git worktree of your project, next to it (`<project>.stet/<name>/`);
- on its own branch (`stet/<name>`).

The agent edits files there as it would anywhere else. Nothing it does reaches your files until you accept it.

Create a workspace with **Stet: New agent workspace** in VS Code, or `stet agent new <name>` on the command line. Stet writes these files into it (they are never part of a proposal):

| File | For | Contents |
|---|---|---|
| `CLAUDE.local.md` | Claude | The working rules (below). |
| `AGENTS.override.md` | Codex | The same rules. If your project has an `AGENTS.md`, its content comes first, because Codex reads this file *instead of* `AGENTS.md`. |
| `.mcp.json` | Claude | The Stet tools (MCP server), pre-approved. |
| `.codex/config.toml` | Codex | The Stet tools, and `sandbox_mode = "workspace-write"`. |
| `.claude/settings.json` | Claude | Guardrails: blocked edits and commands, the `stet guard` hook, and on macOS/Linux/WSL2 the Bash sandbox. |
| `.stet/inbox` | both | One line per thing that arrived for the agent (feedback, a note, a sync needed). Written by the Stet MCP server, read by `stet watch` (§4). |

**The working rules** tell the agent:
- to edit only inside the workspace, keep changes minimal, and not reflow text;
- to submit coherent batches with a title and rationale, and group edits that belong together;
- to sync before new work;
- to read feedback regularly and act on it.

The rules, the tool configuration and the guardrails are rewritten after every sync, with **Refresh** in the Stet panel (all active agents), and with `stet agent refresh <name>`.

---

## 2. Connecting an agent

| Agent | How | Notes |
|---|---|---|
| **Claude desktop app** (Code tab) | Choose the workspace folder as the session's folder. | Live-tested. Claude asks once to trust the folder; the tools need no approval. |
| **Claude Code** (CLI or IDE extension) | `cd` into the workspace and start `claude`, or open the folder in VS Code with the Claude Code extension. | Same configuration as the desktop app. Covered by automated tests; a live run is still to do ([live-tests.md](live-tests.md) §B). |
| **Codex** (CLI, app or IDE extension) | Open the workspace folder in Codex. | Codex may ask you to trust the folder so the project configuration applies. Covered by automated tests; a live run is still to do (§C). |
| **Other agents** | Anything that edits files and can run a command. | The agent submits with `stet submit -t "<title>" -m "<rationale>"` in the workspace and reads feedback with `stet feedback` ([cli.md](cli.md) §5). |

**Optional:** `stet setup claude` / `stet setup codex` registers the Stet tools for all folders. This isn't needed, because each workspace carries its own configuration.

**Several agents at once:** give each its own workspace (`claude-1`, `claude-2`, `codex-1`, …). Their proposals appear side by side in your review. If two agents change the same text, accepting one makes the other *stale*, and that agent is told.

---

## 3. Prompting

Ask for what you want, as usual:
- *"Tighten the wording of the introduction."*
- *"Rename the label `sec:intro` to `sec:introduction` everywhere."*
- *"Check the related-work section for claims that need a citation."*

The agent edits, then submits by itself. Some tips:
- **Batches:** ask for one topic per batch ("submit per section"). Small changesets are easier to review.
- **Style:** if you edit an agent's wording before accepting it, the agent is told, and its instructions say to prefer your wording from then on.
- **After reviewing:** say *"check your feedback"*. The agent reads your decisions and comments, answers them and revises. The instructions already ask it to check regularly.

---

## 4. The agent's tools

| Tool | What the agent does with it |
|---|---|
| `stet_status` | Sees its item counts, unread feedback, notes from you waiting for it, whether it must sync first, and accepted changes its copy lacks (rare; you are told too). |
| `stet_submit` | Submits its edits with a title, a rationale and optional groups. |
| `stet_sync` | Moves onto your latest text. Accepted changes become part of it, rejected ones disappear. Delivers your notes on passages. |
| `stet_get_feedback` | Reads your decisions: accepted (possibly with your wording), rejected with reason, revision requests, comments, stale items, broken linked groups and partly accepted ones. |
| `stet_list`, `stet_show` | Looks at its own items and groups. |
| `stet_reply` | Answers your comments and notes. |
| `stet_withdraw` | Withdraws proposals it no longer believes in. |
| `stet_group`, `stet_ungroup` | Fixes how its changes are grouped. |

Every other tool's result also ends with a line when something arrived meanwhile: unread feedback, notes waiting, a sync needed.

**Waiting for you without polling:** while the agent's session runs, the Stet MCP server appends a line to `.stet/inbox` in the workspace for each thing that arrives: a decision or comment, a note, a sync needed after you commit or share, the workspace archived. It checks every few seconds, and at least every 30 seconds for saved edits you share. The agent's instructions give it the command to wait for these lines, `stet watch`, to run in the background:
- With a runtime that wakes the agent when a background command prints (such as Claude Code's monitor), it runs `stet watch` and reacts to each line.
- With one that wakes it when a background command ends, it runs `stet watch --once`, which exits after the first lines, and starts it again after acting.

`stet watch` only reads the inbox, so it works inside the sandbox, and the guard allows it although its path is inside your project's `.git` folder. `tail -n 0 -f .stet/inbox` works too. What wakes it is up to you as well: each kind of news (accepts, rejections, revision requests, comments, notes, commits and shares, saves) can be switched off per agent with *Notifications…* or `stet agent notify <name> --on <kinds>`; switched-off news still reaches the agent when it next checks. The megaphone next to the agent (or `stet agent ping <name>`) wakes it right away, whatever the settings. When the agent is woken is up to you, per agent: the bell next to it in the Stet panel, or `stet agent notify <name> now|batched|off`. *batched* (the default) waits until you have paused for half a minute, so the agent hears about a review all at once instead of after every click. *now* writes each line as it happens. *off* writes nothing until you switch it on again, then everything that arrived meanwhile. A woken agent starts working and using tokens without you prompting it, so *off* is also the way to keep it waiting for you.

**Grouping:**
- **Locations** name changes by line (`main.tex:12`) or by line and a quoted snippet of the new text (`main.tex:12 "suggestion"`). A paragraph is often a single line, so the snippet is what lets an agent put two changes of one paragraph into different parts; agents are told to use it.
- `linked` groups can only be accepted together, so they're kept for changes where accepting only some would break the document or lose text: a macro and its uses, a `\begin` and its `\end` in different changes, one symbol renamed across formulas, moves. Stet checks every linked group an agent declares: if it sees no such dependency between all of the changes, it makes the group *related* (you can still accept it all at once), links only the changes that need each other, and tells the agent. An agent can insist with a reason, which you see on the group as "Linked because: …".
- A large linked group can come in **parts**, which you accept or reject one at a time. A part is only kept if accepting it alone still compiles (warnings such as `??` for a missing reference are fine) and blocks no other part. Stet keeps identical changes, a macro and its uses, and changes to the same text in one part. A label rename it detects is split into the label and its references. If you accept some parts and reject others, the agent is told, so it can make the paper consistent again.
- Stet also detects label/ref renames, citation keys and repeated substitutions by itself.
- **Moves:** a passage the agent moves (a sentence of 7 words or more, a paragraph, an environment) is shown as one move, also with up to one changed word in ten, which Stet shows. Moved and rewritten more than that, it is a deletion and an insertion, linked as *Moved and rewritten*. Agents are asked to move text word for word where they can and to edit it in a later round. This is a strong preference, not a rule: a move may need a few adjusted words (a "below" that is now "above"), and Stet then lists them.

---

## 5. Archiving

When a task is done, archive the agent: right-click it in the panel → **Archive agent…**, or `stet agent archive <name> [--remove]`.
- Its pending proposals are withdrawn.
- On its next action the agent is told that the workspace was archived, which proposals were withdrawn, and to stop and ask you for a new workspace. This also works after the folder has been deleted.
- If you keep the folder, its instruction files are replaced by the same notice.

---

## 6. What protects your project

| Layer | macOS, Linux, WSL2 | Native Windows |
|---|---|---|
| Separate workspace outside your project | ✓ | ✓ |
| Agent tool's sandbox (Claude Code Bash sandbox, Codex `workspace-write`): only the workspace is writable; your project, its `.git` folder and Stet's data are read-only | ✓ | Claude Code: no sandbox |
| Guardrails in `.claude/settings.json`: blocked edits and git commands, plus the `stet guard` hook for shell commands | ✓ | ✓ (the main barrier) |
| Git hooks in your project: agent branches can't be merged into the main branch or pushed | ✓ | ✓ |
| Stet's own checks: submitted paths, the workspace's git link, ids, no hooks/filters/signing when handling agent files, all-or-nothing accept | ✓ | ✓ |

**On native Windows**, Claude Code runs shell commands without a sandbox. The guard hook reliably catches mistakes, but a deliberately evasive agent can get around it, for example one following instructions hidden in a source document. For untrusted material, run the agent in WSL2.

Details: [SECURITY.md](../SECURITY.md) and [spec.md](spec.md) §9.
