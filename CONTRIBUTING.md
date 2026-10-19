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
- `stet-<version>.mjs`, the whole CLI in one file (`node stet-<version>.mjs`, Node.js 20 or newer);
- `SHA256SUMS.txt`;
- the changelog section as release notes.

**VS Code Marketplace** (publisher `archechef`): upload by hand.
1. Download `stet-vscode-<version>.vsix` from the GitHub release.
2. At [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), open the extension's **⋯** menu → **Update**, and upload the file. (The very first upload was **+ New extension → Visual Studio Code**.)
3. Microsoft checks the package; the new version is live a few minutes later.

Automatic publishing would need a Marketplace token. The tokens Azure DevOps offered for this ("all accessible organizations") are retired on 2026-12-01; their replacement, signing in with Microsoft Entra ID (`vsce publish --azure-credential`), needs an Azure subscription. Not worth it for occasional releases.

**Open VSX** (VSCodium, Cursor and others): the release workflow publishes there by itself once the repository secret `OVSX_PAT` exists (Settings → Secrets and variables → Actions), a token from open-vsx.org.

If a release fails after the tag was pushed, fix the problem, then move the tag: `git tag -f v0.4.0 && git push -f origin v0.4.0` (delete a half-created GitHub release first).

## Conventions

- **Language:** TypeScript (strict), ES modules, no runtime dependencies beyond `diff`.
- **Git:** always through `Repo` / `gitRaw` in `git.ts`, with arguments as arrays and never through a shell.
- **Errors meant for users:** `StetError` (`errors.ts`). Their message is shown as is.
- **Paths:** compared with `paths.ts` (`samePath`, `isInside`).
- **Files in user or agent folders:** written with `safefs.ts`, which never writes through links.
- **Commits:** end with the change's rationale. Record notable decisions in the spec's §16 notes.
