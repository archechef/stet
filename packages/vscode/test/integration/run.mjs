// VS Code integration test: builds a fixture project, starts VS Code with a throwaway profile and
// the extension under development, and reports the checks from suite.cjs.
// Usage: node test/integration/run.mjs   (VS Code from PATH, or set VSCODE_EXE)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, "../..");

function vscodeExe() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  const which = process.platform === "win32" ? "where.exe" : "which";
  const cli = execFileSync(which, ["code"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  if (process.platform === "win32") return resolve(dirname(cli), "..", "Code.exe");
  if (process.platform === "darwin") return resolve(dirname(cli), "../../../MacOS/Electron");
  return cli;
}

let failedRuns = 0;
for (const runtime of ["auto", "vscode"]) {
  console.log(`\n— stet.runtime = ${runtime}`);
  failedRuns += runOnce(runtime) ? 0 : 1;
}
process.exitCode = failedRuns ? 1 : 0;

function runOnce(runtime) {
const tmp = mkdtempSync(join(tmpdir(), "stet-vscode-it-"));
try {
  const fixture = execFileSync(process.execPath, [join(here, "fixture.mjs"), tmp], { cwd: extDir, encoding: "utf8" }).trim().split("\n").pop();
  const { repo } = JSON.parse(fixture);
  const out = join(tmp, "results.json");
  // When started from another Electron app, this variable would make VS Code run as plain Node.
  const env = { ...process.env, STET_IT_OUT: out, STET_IT_FIXTURE: fixture, STET_IT_RUNTIME: runtime };
  mkdirSync(join(tmp, "user", "User"), { recursive: true });
  writeFileSync(join(tmp, "user", "User", "settings.json"), JSON.stringify({ "stet.runtime": runtime }));
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(
    vscodeExe(),
    [
      `--user-data-dir=${join(tmp, "user")}`,
      `--extensions-dir=${join(tmp, "ext")}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
      `--extensionDevelopmentPath=${extDir}`,
      `--extensionTestsPath=${join(here, "suite.cjs")}`,
      repo,
    ],
    { env, encoding: "utf8", timeout: 180_000 },
  );
  if (!existsSync(out)) {
    console.error("VS Code produced no results.", r.error ?? "", r.stdout, r.stderr);
    return false;
  }
  const results = JSON.parse(readFileSync(out, "utf8"));
  for (const c of results) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.ok ? "" : `\n    ${c.detail}`}`);
  const failed = results.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\nAll ${results.length} checks passed`);
  return failed === 0;
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
}
