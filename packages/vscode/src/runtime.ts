/**
 * How agents' tools (MCP server, guard hook) run `stet` when it comes with the extension.
 * The bundled CLI is copied into the repository's Stet store (`.git/stet/bin/stet.mjs`), a
 * path that survives extension updates, and run with Node.js or with VS Code's own runtime.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { CliCommand } from "@stet/core";
import { nodeMajor } from "./model.js";

export type RuntimeMode = "auto" | "node" | "vscode";

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout.toString()));
  });
}

/** Absolute path of a Node.js ≥ 20 on PATH, or null. */
export async function findNode(): Promise<string | null> {
  const win = process.platform === "win32";
  const out = win ? await run("where.exe", ["node"]) : await run("/bin/sh", ["-c", "command -v node"]);
  const path = out?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  if (!path) return null;
  const v = await run(path, ["--version"]);
  const major = v ? nodeMajor(v) : null;
  return major !== null && major >= 20 ? path : null;
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
    if (mode === "node") throw new Error("Node.js 20 or newer was not found on PATH (setting stet.runtime is \"node\").");
  }
  // VS Code's own Electron binary behaves like Node with ELECTRON_RUN_AS_NODE.
  return { command: process.execPath.replace(/\\/g, "/"), args: [script.replace(/\\/g, "/")], env: { ELECTRON_RUN_AS_NODE: "1" } };
}
