# Contributing to Stet

## Setup

**Requirements:** Node.js 20 or newer, git 2.28 or newer, and optionally VS Code for the extension.

```bash
npm install
npm run build        # core + CLI (tsc) and the VS Code extension (type check + esbuild)
npm test             # all unit and end-to-end tests (vitest)
```

With npm 11 (Node 24), `npm install` reports that some packages' install scripts were not run (esbuild, vsce). The build works regardless: esbuild's platform binary comes as a separate package.

## Layout

| Package | Contents |
|---|---|
| `packages/core` (`@stet/core`) | The review service and everything below it. |
| `packages/cli` (`stet-tex`) | The `stet` command, including `stet mcp` and `stet guard`. |
| `packages/vscode` (`stet-vscode`) | The VS Code extension, bundled with esbuild. |

The core in more detail:
- the store (`.git/stet/`) and git plumbing;
- LaTeX-aware splitting and anchoring;
- grouping;
- the MCP server and the guard;
- git hooks, workspace files and `doctor`;
- `AgentFiles`, the safe git access to agent workspaces.

Design and rationale: [docs/spec.md](docs/spec.md). The milestone notes in §16 record what was built, tested and reviewed, and why.

## Tests

- `npm test` runs everything under `packages/*/test`. The test runner needs Node.js 22.12 or newer; Stet itself runs on Node.js 20 or newer. CI (`.github/workflows/ci.yml`) tests on Windows, macOS and Linux with Node.js 22 and 24, checks Node.js 20, and builds the `.vsix` as a downloadable artifact. The end-to-end tests create temporary git repositories and need `git` on the PATH. Some also use `sh`, which Git for Windows provides, and skip themselves without it.
- `npm run test:integration -w stet-vscode` starts your installed VS Code with a throwaway profile against a fixture project, once with each runtime (Node.js and VS Code's own). A window appears briefly. It is not part of CI.
- The hands-on tests that need a person or a logged-in agent are listed in [docs/live-tests.md](docs/live-tests.md).

**Security-relevant changes** (anything touching git calls in agent workspaces, paths, the guard, hooks or the store) need a regression test in `packages/core/test/security.test.ts` or `review-findings.test.ts`. See [SECURITY.md](SECURITY.md).

## Packaging the extension

```bash
npm run package:vscode    # → packages/vscode/stet-vscode.vsix
```

The `.vsix` contains the extension and its own copy of the `stet` CLI. Users need neither Node.js nor this repository.

## Conventions

- **Language:** TypeScript (strict), ES modules, no runtime dependencies beyond `diff`.
- **Git:** always through `Repo` / `gitRaw` in `git.ts`, with arguments as arrays and never through a shell.
- **Errors meant for users:** `StetError` (`errors.ts`). Their message is shown as is.
- **Paths:** compared with `paths.ts` (`samePath`, `isInside`).
- **Files in user or agent folders:** written with `safefs.ts`, which never writes through links.
- **Commits:** end with the change's rationale. Record notable decisions in the spec's §16 notes.
