# Contributing to Stet

## Setup

**Requirements:** Node.js 22.12 or newer, git 2.28 or newer, and optionally VS Code for the extension.

```bash
npm install
npm run build        # core + CLI (tsc) and the VS Code extension (type check + esbuild)
npm test             # all unit and end-to-end tests (vitest)
```

With npm 11 (Node 24), `npm install` reports that some packages' install scripts were not run (esbuild, vsce). The build works regardless: esbuild's platform binary comes as a separate package.

## Working in a container

`.devcontainer/` sets up a development container for rootless [Podman](https://podman.io). Node.js, npm, the installed packages, npm's cache and the packages' install scripts then stay in the container; only the repository folder is shared with your machine.

**Once per machine:**
1. Install Podman (on Ubuntu: `sudo apt install podman`) and VS Code's **Dev Containers** extension.
2. In VS Code's user settings: `"dev.containers.dockerPath": "podman"`, and `"dev.containers.gitCredentialHelperConfigLocation": "none"` so VS Code doesn't pass your git credentials into containers.

**Then:** open the repository in VS Code and run **Dev Containers: Reopen in Container**. The first time, this builds the image and runs `npm ci` inside the container. `npm run build`, `npm test` and `npm run package:vscode` work in the container's terminal as usual.

**What the container does:**
- Your user is `node` inside (`--userns=keep-id`), so files written in the repository stay yours. It has no extra privileges (`--cap-drop=ALL`, `no-new-privileges`).
- `node_modules` (the root's and `packages/vscode`'s) and npm's cache are Podman volumes (`stet-node-modules`, `stet-node-modules-vscode`, `stet-npm-cache`), not folders in the repository on your machine. On your machine the two `node_modules` folders stay empty: the volumes are mounted on them (`initializeCommand` creates them before the container starts). `podman volume rm` removes the volumes.
- **No pushing from inside:** git there rewrites GitHub push URLs to a scheme that doesn't exist, and your SSH agent is not passed in. Commit and tag in the container; push from your own terminal.

**Not in the container:** the VS Code integration test needs VS Code and a display, so it runs on your machine. Build in the container first (`npm run build`, which also bundles the test's fixture), then run `node packages/vscode/test/integration/run.mjs` on your machine. It needs Node.js there, but no `node_modules`.

**Agents:** a Claude Code session started *inside* the container (in its terminal, or with the Claude Code extension in the container window) runs its commands there too. The Claude desktop app runs its commands on your machine, even for this folder.

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

What `@stet/core` exports (`packages/core/src/index.ts`) is what the command line and the extension use: the `Stet` service, the MCP server, the guard, setup and their types. Keep helpers internal; `Stet`'s parts are marked `@internal` and left out of the built types (`stripInternal`), and `packages/core/test/api.test.ts` checks the built `.d.ts`. Something a language does differently belongs in its profile (`packages/core/src/lang/`), not in shared code. What 1.x keeps stable is listed in the README (*Compatibility*). A change to how a record in `.git/stet/` is stored keeps the old shape readable: `upgradeItem` (`packages/core/src/model.ts`) turns every older format into today's as the store reads it, so the rest of the code sees one shape. Raise `STORE_SCHEMA` only for a change older versions can't read that way: they then refuse to write to the store.

Design and rationale: [docs/spec.md](docs/spec.md). The milestone notes in §16 record what was built, tested and reviewed, and why.

## Tests

- `npm test` runs everything under `packages/*/test` named `*.test.ts`. The test runner needs Node.js 22.12 or newer; Stet itself runs on Node.js 22 or newer. CI (`.github/workflows/ci.yml`) tests on Windows, macOS and Linux with Node.js 22, 24 and 26, and builds the `.vsix` as a downloadable artifact. The end-to-end tests create temporary git repositories and need `git` on the PATH. Some also use `sh`, which Git for Windows provides, and skip themselves without it.
- `npm run lint` checks the code with [Biome](https://biomejs.dev) (lint rules, formatting, import order; `biome.json`), and `npm run format` fixes what it can. `npm run typecheck` type-checks the tests of every package, which the build leaves out (`tsconfig.test.json`). CI runs both. The VS Code extension *Biome* (`biomejs.biome`) uses the same settings. The one-time reformat is listed in `.git-blame-ignore-revs`; `git config blame.ignoreRevsFile .git-blame-ignore-revs` makes `git blame` skip it.
- `npm run test:integration -w stet-vscode` starts your installed VS Code with a throwaway profile against a fixture project, once with each runtime (Node.js and VS Code's own), then against two projects in the language of an imported profile (`custom.cjs`): one with no LaTeX, Typst or Lean files, where Stet must start by itself, and one whose profile bundles LaTeX's preview backend under another id, which must compile and find a change on the page. `STET_IT_ONLY=proofs,latex-profile` (fixture kinds or runtimes) runs only some. The tests and the integration test use a profile library of their own (`STET_PROFILE_LIBRARY`), never yours. A window appears briefly. It is not part of CI. It starts the VS Code binary next to the `code` launcher (which can hand off to an open VS Code and return at once); `VSCODE_EXE` points it at another one. The suite (`packages/vscode/test/integration/suite.cjs`) is a list of named steps, each run on its own: a step that throws is reported as failed, and the next one still runs. What a later step needs from an earlier one is declared before the list.
- `npm run test:perf` times larger submissions (`*.perf.ts`: a linked group of 150 changes, a section of 60 paragraphs reordered, a 400-paragraph paper) and checks they still split right. Each prints its time; the limits are generous, to catch a slowdown by an order of magnitude. It is not part of `npm test` or CI, where machine speed varies too much. Run it before a release, or after changing splitting, moves or grouping.
- The hands-on tests that need a person or a logged-in agent are listed in [docs/live-tests.md](docs/live-tests.md).
- Test what the code does, not how its source reads. The extension's unit tests run without VS Code: vitest maps `vscode` to a small stand-in, `packages/vscode/test/fake-vscode.ts` (settings, status-bar messages, notifications), so keep logic worth testing in functions that take plain values (`model.ts`, `rows.ts`, `questions.ts`, `previewPage.ts`, …). Test changes come from `makeItem` in `packages/core/test/helpers.ts` and `packages/vscode/test/fixtures.ts`.
- A new `stet` command is an entry in `packages/cli/src/commands.ts`: its help lines, the options it takes (from `options.ts`), whether it opens the project and is the reviewer's, and `run`. `packages/cli/test/command-line.test.ts` checks that every option its help names is one it takes.
- Test files are named after what they test (`undo.test.ts`, `grouping.test.ts`, `safe-paths.test.ts`, the extension's `accept-questions.test.ts`, …), not after where a bug was found. A regression test for a finding from a test report or review goes into the file of its topic, and its name ends with the report and the finding, such as *(test report v0.16, D1)*.

**Security-relevant changes** (anything touching git calls in agent workspaces, paths, the guard, hooks or the store) need a regression test in the file of their topic in `packages/core/test`: `workspace-integrity.test.ts` (git in agent workspaces), `safe-paths.test.ts` (paths, links, special files), `guard.test.ts`, `setup.test.ts` (git hooks), `store-lock.test.ts`, `accept.test.ts`. See [SECURITY.md](SECURITY.md).

## Packaging the extension

```bash
npm run package:vscode    # → packages/vscode/stet-vscode.vsix
```

The `.vsix` contains the extension and its own copy of the `stet` CLI. Users need neither Node.js nor this repository.

## Releasing

1. Add the release's changes under `## Unreleased` in `CHANGELOG.md` (keep doing this as you go).
2. Set the version everywhere and date the changelog section:
   ```bash
   node scripts/release.mjs set 0.4.0
   ```
   This updates the three `package.json` files, the CLI's `VERSION`, the README and `package-lock.json`. Versions are `major.minor.patch` only, as the VS Code Marketplace requires.
3. Commit, tag and push:
   ```bash
   git commit -am "Release v0.4.0"
   git tag v0.4.0
   git push && git push origin v0.4.0
   ```

The tag starts `.github/workflows/release.yml`. It checks that every version matches the tag, builds, runs the tests and creates a GitHub release with:
- `stet-vscode-<version>.vsix`, the VS Code extension;
- `stet-<version>.mjs`, the whole CLI in one file (`node stet-<version>.mjs`, Node.js 22 or newer);
- `SHA256SUMS.txt`;
- the changelog section as release notes.

**VS Code Marketplace** (publisher `archechef`): the workflow's `marketplace` job publishes the same `.vsix` once the GitHub release exists, with `vsce publish --oidc`. It uses the Marketplace's Trusted Publishing: the publisher has a policy (Marketplace → *Manage* → `archechef` → **Trusted Publishing**) that trusts `release.yml` of `archechef/stet`, with no GitHub environment, so no token is stored anywhere. Only that job may request GitHub's OIDC token (`id-token: write`); it runs no tests or build scripts. Renaming the workflow file or the repository needs a new policy. A re-run after the version is already live succeeds (`--skip-duplicate`); Microsoft checks a new version for a few minutes before it is live.

If the job fails, upload by hand: download `stet-vscode-<version>.vsix` from the GitHub release, then at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) open the extension's **⋯** menu → **Update** and upload the file.

**Open VSX** (VSCodium, Cursor and others): the release workflow publishes there by itself once the repository secret `OVSX_PAT` exists (Settings → Secrets and variables → Actions), a token from open-vsx.org.

If a release fails after the tag was pushed, fix the problem, then move the tag: `git tag -f v0.4.0 && git push -f origin v0.4.0` (delete a half-created GitHub release first).

## Conventions

- **Language:** TypeScript (strict), ES modules, no runtime dependencies beyond `diff`.
- **Git:** always through `Repo` / `gitRaw` in `git.ts`, with arguments as arrays and never through a shell.
- **Errors meant for users:** `StetError` (`errors.ts`). Their message is shown as is.
- **Paths:** compared with `paths.ts` (`samePath`, `isInside`).
- **Files in user or agent folders:** written with `safefs.ts`, which never writes through links.
- **The store's lock:** operations that write the store run inside `store.withLock`. The store's writes check that they do; a function that must run under the lock without writing through the store (git refs, the user's files) calls `store.assertLocked` first.
- **Stored records:** `packages/core/src/records.ts` checks each record the store reads. A new field is optional there (older stores don't have it), and checked when present.
- **Handled failures in the extension:** a failure that is dealt with without a message goes to `warn` (`packages/vscode/src/log.ts`), which notes it in the output channel; an empty `catch` is only for what is expected (a file not there yet).
- **The panel's menus:** a row's `contextValue` comes from `contextValueOf` in `packages/vscode/src/rows.ts`, which lists its forms; `panel.test.ts` checks that every `viewItem` test in `package.json`'s menus matches one. A command reads what it was given with `commandTarget` (`model.ts`): a row, a change with its project, a key in a view, an id, or nothing.
- **VS Code settings:** read with `setting(key)` from `packages/vscode/src/settings.ts`. A new setting goes there and into `package.json`; `settings.test.ts` checks that the two agree.
- **Submit (`itemize` in `core/src/service/submit.ts`):** its steps (candidates, merges, items, supersedes, conflicts, notes, moves, groups) still read from git and pass state along, so each is tested only through whole submits. Don't rewrite it in one go: it decides which changes the reviewer sees, and the end-to-end tests pin that down. When a bug fix or feature touches one step, move that step into a function that takes texts and items and returns its result, with unit tests of its own. Its records go through `PendingWrites` (`service/pending.ts`), which writes them in one step at the end; keep new writes there too.
- **Comments:** say why the code is as it is, with the case that made it so ("an empty lock named no owner, which nobody took over"), not which report found it: the reports aren't in the repository. Tests name the report and finding in their titles (see Tests).
- **Commits:** end with the change's rationale. Record notable decisions in the spec's §16 notes.
