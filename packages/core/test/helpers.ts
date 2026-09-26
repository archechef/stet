import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { Stet } from "../src/service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

export function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** Replace text in a file, failing loudly if the text isn't there. */
export function edit(root: string, path: string, from: string, to: string) {
  const s = read(root, path);
  if (!s.includes(from)) throw new Error(`'${from}' not found in ${path}`);
  write(root, path, s.replace(from, to));
}

/** A fresh repository with one commit on `master` and Stet initialized. */
export async function setup(
  files: Record<string, string>,
  opts: { cli?: { command: string; args: string[] } } = {},
): Promise<{ stet: Stet; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), "stet-test-"));
  dirs.push(root);
  const repo = join(root, "paper");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.name", "Test User");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "core.autocrlf", "false");
  for (const [p, c] of Object.entries(files)) write(repo, p, c);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const stet = await Stet.init(repo, opts.cli ? { cli: opts.cli } : {});
  return { stet, repo };
}

/** Run git expecting failure; returns stderr. */
export function gitFails(cwd: string, ...args: string[]): string {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    return String(e.stderr ?? e.message);
  }
  throw new Error(`git ${args.join(" ")} unexpectedly succeeded`);
}

/** Path of the built CLI (tests that spawn it are skipped when it isn't built). */
export const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/index.js");

export const PAPER = `\\documentclass{article}
\\begin{document}
\\section{Introduction}\\label{sec:intro}
In this work we study the problem of reviewing changes. The changes are proposed by an AI.

We show that this approach is effective in practice. It scales to large documents.

As shown in Section~\\ref{sec:intro}, the approach works. The formula $a+b=c$ holds.
\\end{document}
`;
