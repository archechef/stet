# Stet

*stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

Stet lets AI agents (Claude Code, Codex, …) propose changes to a LaTeX project while you review them one by one. Agents work in their own git worktree and never touch your files; a change reaches your document only when you accept it. See [docs/spec.md](docs/spec.md) for the design.

**Status:** M1 (core + command-line tool) and M2 (MCP server for agents, guardrails) are implemented. The VS Code extension (M3) comes next.

## Try it

Requirements: Node.js ≥ 20 and git ≥ 2.28.

```bash
npm install
npm run build
cd packages/cli && npm link # optional: puts `stet` on your PATH
```

Without `npm link`, run `node <path-to-repo>/packages/cli/dist/index.js` wherever `stet` appears below.

In your LaTeX project (a git repository with at least one commit):

```bash
stet init                   # also installs git hooks that stop agent branches from being merged or pushed
stet agent new claude-1     # prints the agent's workspace folder (use --kind codex for Codex)
```

Open the printed folder in the Claude desktop app (Code tab), Claude Code or Codex. The workspace already contains:

- the agent's instructions (`CLAUDE.local.md`, `AGENTS.override.md`),
- the Stet MCP server config (`.mcp.json`, `.codex/config.toml`), giving the agent tools like `stet_submit` and `stet_get_feedback`,
- guardrails (`.claude/settings.json`): a hook that blocks edits outside the workspace and git commands that would bypass review.

Claude Code asks once to approve the workspace's MCP server. Optionally register it for all workspaces with `stet setup claude` / `stet setup codex`.

Ask the agent to improve the paper; it submits its edits for review itself. (Without MCP, it can run `stet submit -t "Polish the introduction" -m "Shorter sentences"` in the workspace.)

Back in your project folder:

```bash
stet review                 # pending items, grouped by agent → changeset → group
stet show S3                # an item with its context
stet accept S3 S4           # or a whole group: stet accept G1
stet reject S5 -m "keep the original formula"
stet revise S6 -m "shorter, please"
```

The agent picks up your decisions with `stet_get_feedback` (or `stet feedback`) and moves onto your latest text with `stet_sync`. Run `stet doctor` if anything looks off, and `stet --help` for all commands.

## Development

```bash
npm run build     # tsc for packages/core and packages/cli
npm test          # vitest: unit tests + end-to-end tests on temporary git repos
```

- `packages/core` (`@stet/core`): store, git plumbing, LaTeX-aware splitting, anchoring, the review service, MCP server, guard, git hooks, workspace files, doctor.
- `packages/cli` (`stet-tex`): the `stet` command.
