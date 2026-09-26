# Stet

*stet* (Latin, "let it stand"): the proofreader's mark for undoing an edit.

Stet lets AI agents (Claude Code, Codex, …) propose changes to a LaTeX project while you review them one by one. Agents work in their own git worktree and never touch your files; a change reaches your document only when you accept it. See [docs/spec.md](docs/spec.md) for the design.

**Status:** milestone M1 — core library and command-line tool. The MCP server for agents (M2) and the VS Code extension (M3) come next.

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
stet init
stet agent new claude-1     # prints the agent's workspace folder
```

Open the printed folder in Claude Code or Codex and let the agent edit there. When it's done, it (or you, from that folder) runs:

```bash
stet submit -t "Polish the introduction" -m "Shorter sentences"
```

Back in your project folder:

```bash
stet review                 # pending items, grouped by agent → changeset → group
stet show S3                # an item with its context
stet accept S3 S4           # or a whole group: stet accept G1
stet reject S5 -m "keep the original formula"
stet revise S6 -m "shorter, please"
```

The agent picks up your decisions with `stet feedback` and moves onto your latest text with `stet sync`. Run `stet doctor` if anything looks off, and `stet --help` for all commands.

## Development

```bash
npm run build     # tsc for packages/core and packages/cli
npm test          # vitest: unit tests + end-to-end tests on temporary git repos
```

- `packages/core` (`@stet/core`): store, git plumbing, LaTeX-aware splitting, anchoring, the review service, doctor.
- `packages/cli` (`stet-tex`): the `stet` command.
