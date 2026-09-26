/** Thin wrapper around the git CLI. */
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEol, toLf, type Eol } from "./text.js";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${code}): ${stderr.trim()}`);
  }
}

export interface RunOptions {
  cwd: string;
  input?: string | Buffer;
  env?: Record<string, string>;
  allowFail?: boolean;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** Identity for commits Stet makes on its own refs and agent branches. */
export const STET_IDENTITY = ["-c", "user.name=Stet", "-c", "user.email=stet@localhost"];

/**
 * Options for every git call Stet makes. Stet runs git in agent workspaces from outside any
 * sandbox, so nothing configured there may run commands: no filesystem monitor.
 */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false"];

export function gitRaw(args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [...SAFE_CONFIG, ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", STET_INTERNAL: "1", ...opts.env },
        encoding: "buffer",
        maxBuffer: 1 << 30,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
        if ((err as any)?.code === "ENOENT") return reject(new Error("git executable not found on PATH"));
        const res = { stdout: stdout as Buffer, stderr: (stderr as Buffer).toString("utf8"), code };
        if (code !== 0 && !opts.allowFail) reject(new GitError(args, code, res.stderr));
        else resolve(res);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function git(args: string[], opts: RunOptions): Promise<string> {
  return (await gitRaw(args, opts)).stdout.toString("utf8").replace(/\n$/, "");
}

export async function tryGit(args: string[], opts: Omit<RunOptions, "allowFail">): Promise<string | null> {
  const r = await gitRaw(args, { ...opts, allowFail: true });
  return r.code === 0 ? r.stdout.toString("utf8").replace(/\n$/, "") : null;
}

export async function gitVersion(): Promise<string | null> {
  try {
    const out = await git(["--version"], { cwd: process.cwd() });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** A repository location: commands run in `cwd` (any worktree of the repo). */
export class Repo {
  constructor(readonly cwd: string) {}

  run(args: string[], opts: Partial<RunOptions> = {}) {
    return git(args, { cwd: this.cwd, ...opts });
  }
  tryRun(args: string[], opts: Partial<RunOptions> = {}) {
    return tryGit(args, { cwd: this.cwd, ...opts });
  }

  revParse(rev: string) {
    return this.tryRun(["rev-parse", "--verify", "--quiet", rev + "^{commit}"]);
  }

  async readBlob(rev: string, path: string): Promise<Buffer | null> {
    const r = await gitRaw(["cat-file", "blob", `${rev}:${path}`], { cwd: this.cwd, allowFail: true });
    return r.code === 0 ? r.stdout : null;
  }

  async readText(rev: string, path: string): Promise<{ text: string; eol: Eol } | null> {
    const buf = await this.readBlob(rev, path);
    if (!buf) return null;
    const raw = buf.toString("utf8");
    return { text: toLf(raw), eol: detectEol(raw) };
  }

  async blobId(rev: string, path: string): Promise<string | null> {
    return this.tryRun(["rev-parse", "--verify", "--quiet", `${rev}:${path}`]);
  }

  /** Changed paths between two commits (renames detected). */
  async diffNames(a: string, b: string): Promise<{ status: string; path: string; oldPath?: string }[]> {
    const out = await gitRaw(["diff", "--name-status", "-z", "-M", a, b], { cwd: this.cwd });
    const parts = out.stdout.toString("utf8").split("\0");
    const res: { status: string; path: string; oldPath?: string }[] = [];
    for (let i = 0; i < parts.length; ) {
      const st = parts[i++]!;
      if (!st) continue;
      if (st.startsWith("R") || st.startsWith("C")) {
        const oldPath = parts[i++]!;
        const path = parts[i++]!;
        res.push({ status: st[0]!, path, oldPath });
      } else res.push({ status: st[0]!, path: parts[i++]! });
    }
    return res;
  }

  /** Porcelain status lines (empty = clean). Untracked files count as dirty. */
  async status(paths: string[] = []): Promise<string[]> {
    const out = await this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...paths]);
    return out.split("\0").filter(Boolean);
  }

  /**
   * Create a commit whose tree is `baseRev`'s tree with `changes` applied
   * (content = new file content, null = delete). Never touches the real index.
   */
  async buildCommit(opts: {
    parents: string[];
    baseRev: string;
    changes: Map<string, string | Buffer | null>;
    message: string;
  }): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "stet-idx-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      await this.run(["read-tree", opts.baseRev], { env });
      for (const [path, content] of opts.changes) {
        if (content === null) {
          await this.run(["update-index", "--force-remove", "--", path], { env });
          continue;
        }
        const sha = await this.run(["hash-object", "-w", "--stdin"], { input: content });
        const mode = (await this.tryRun(["ls-tree", opts.baseRev, "--", path]))?.split(" ")[0] || "100644";
        await this.run(["update-index", "--add", "--cacheinfo", `${mode},${sha},${path}`], { env });
      }
      const tree = await this.run(["write-tree"], { env });
      const parentArgs = opts.parents.flatMap((p) => ["-p", p]);
      return await this.run([...STET_IDENTITY, "commit-tree", tree, ...parentArgs, "-m", opts.message]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async worktrees(): Promise<{ path: string; head: string | null; branch: string | null }[]> {
    const out = await this.run(["worktree", "list", "--porcelain"]);
    const res: { path: string; head: string | null; branch: string | null }[] = [];
    for (const block of out.split(/\n\n+/)) {
      const path = /^worktree (.*)$/m.exec(block)?.[1];
      if (!path) continue;
      res.push({
        path,
        head: /^HEAD (.*)$/m.exec(block)?.[1] ?? null,
        branch: /^branch refs\/heads\/(.*)$/m.exec(block)?.[1] ?? null,
      });
    }
    return res;
  }
}
