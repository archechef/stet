/**
 * How agents' tools (MCP server, guard hook) run `stet` when it comes with the extension.
 * The bundled CLI is copied into the repository's Stet store (`.git/stet/bin/stet.mjs`), a
 * path that survives extension updates, and run with Node.js or with VS Code's own runtime.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import type { CliCommand } from "@stet/core";
import { nodeMajor } from "./model.js";
import type { Settings } from "./settings.js";

export type RuntimeMode = Settings["runtime"];

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.toString()));
  });
}

/**
 * Absolute path of a Node.js ≥ 20 found on PATH, or null. Only absolute PATH entries are
 * searched: never the current folder (Windows' `where` looks there first, so a `node.exe`
 * inside an opened project could otherwise become the runtime of the agents' tools).
 */
export async function findNode(): Promise<string | null> {
  const win = process.platform === "win32";
  const names = win ? ["node.exe"] : ["node"];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    for (const n of names) {
      const path = join(dir, n);
      if (
        !(await stat(path).then(
          (s) => s.isFile(),
          () => false,
        ))
      )
        continue;
      const v = await run(path, ["--version"]);
      const major = v ? nodeMajor(v) : null;
      if (major !== null && major >= 20) return path;
    }
  }
  return null;
}

export const managedCliPath = (storeRoot: string) => join(storeRoot, "bin", "stet.mjs");

/** Whether `cli` is the copy this extension manages (so it may replace it). */
export function isManaged(cli: CliCommand | undefined, storeRoot: string): boolean {
  if (!cli) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
  return cli.args.some((a) => norm(a) === norm(managedCliPath(storeRoot)));
}

/** Copy the bundled CLI into the store when it differs. */
export async function installCli(bundled: string, storeRoot: string): Promise<string> {
  const dest = managedCliPath(storeRoot);
  const [a, b] = await Promise.all([readFile(bundled), readFile(dest).catch(() => null)]);
  if (!b || !a.equals(b)) {
    await mkdir(join(storeRoot, "bin"), { recursive: true });
    const tmp = dest + ".tmp";
    await copyFile(bundled, tmp);
    await rename(tmp, dest);
  }
  return dest;
}

/** The command agents' tools use to run the managed CLI. */
export async function cliCommand(mode: RuntimeMode, script: string): Promise<CliCommand> {
  if (mode !== "vscode") {
    const node = await findNode();
    if (node) return { command: node.replace(/\\/g, "/"), args: [script.replace(/\\/g, "/")] };
    if (mode === "node") throw new Error('Node.js 20 or newer was not found on PATH (setting stet.runtime is "node").');
  }
  // VS Code's own Electron binary behaves like Node with ELECTRON_RUN_AS_NODE.
  return { command: process.execPath.replace(/\\/g, "/"), args: [script.replace(/\\/g, "/")], env: { ELECTRON_RUN_AS_NODE: "1" } };
}
