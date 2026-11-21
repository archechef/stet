/**
 * Git operations on an agent's files that never use the agent worktree's own git metadata.
 *
 * An agent can change its worktree's `.git` link, private git dir (`commondir`, `HEAD`, index…)
 * at any moment, including between a check and the git call that follows it. So Stet runs git
 * against the project's repository (`GIT_DIR` = the shared git dir, whose config the agent cannot
 * write), treats the agent folder only as a work tree of files, and uses an index file of its own.
 * Filters, hooks, submodules and signing are switched off, since the agent chooses the files and
 * `.gitattributes` that git reads.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StetError } from "./errors.js";
import { filterOverrides, gitRaw, Repo, STET_IDENTITY, untrustedWorktreeConfig } from "./git.js";
import type { Agent } from "./model.js";
import { replaceFile } from "./safefs.js";
import { WORKSPACE_EXCLUDES } from "./workspace.js";
import { verifyAgentWorktree } from "./worktree.js";

export class AgentFiles {
  private constructor(
    private readonly main: Repo,
    private readonly commonDir: string,
    readonly agent: Agent,
    /** The worktree's private git dir (only its index is written, to keep `git status` there tidy). */
    private readonly gitDir: string,
    private readonly config: string[],
  ) {}

  static async open(main: Repo, commonDir: string, agent: Agent): Promise<AgentFiles> {
    // Still verified, so a tampered workspace is reported clearly (not for the git calls below).
    const gitDir = await verifyAgentWorktree(agent.worktree, commonDir);
    const head = (await readFile(join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
    if (head !== `ref: refs/heads/${agent.branch}`) {
      throw new StetError(
        `The agent workspace is not on its branch '${agent.branch}' (${head.replace(/^ref: refs\/heads\//, "") || "detached"}). Switch it back first.`,
      );
    }
    const config = [...untrustedWorktreeConfig(join(commonDir, "stet", "config.json")), ...(await filterOverrides(main))];
    return new AgentFiles(main, commonDir, agent, gitDir, config);
  }

  get branchRef(): string {
    return `refs/heads/${this.agent.branch}`;
  }

  /** The agent branch's tip, read from the project's repository. */
  async tip(): Promise<string> {
    const t = await this.main.revParse(this.branchRef);
    if (!t) throw new StetError(`The agent branch '${this.agent.branch}' is missing.`);
    return t;
  }

  /** Run `fn` with git bound to the agent's files and a fresh index of Stet's own. */
  private async withIndex<T>(fn: (git: Repo, env: Record<string, string>, index: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "stet-agent-"));
    const index = join(dir, "index");
    const env = { GIT_DIR: this.commonDir, GIT_WORK_TREE: this.agent.worktree, GIT_INDEX_FILE: index };
    try {
      return await fn(new Repo(this.agent.worktree, this.config), env, index);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Stage the whole workspace (Stet's own files excluded) on top of `tip`; returns the tree and changed paths. */
  private async stage(git: Repo, env: Record<string, string>, tip: string): Promise<{ tree: string; changed: string[] }> {
    await git.run(["read-tree", tip], { env });
    // git refuses some paths outright (a folder named .GIT, say): say which, not git's error.
    const added = await gitRaw(["add", "-A", "--", ".", ...WORKSPACE_EXCLUDES], { cwd: git.cwd, config: git.config, env, allowFail: true });
    if (added.code !== 0) {
      const bad = [...added.stderr.matchAll(/invalid path '([^']+)'/g)].map((m) => m[1]!);
      if (bad.length)
        throw new StetError(
          `The path${bad.length > 1 ? "s" : ""} ${bad.map((b) => `'${b}'`).join(", ")} ${bad.length > 1 ? "are" : "is"} not allowed in a workspace (git refuses ${bad.length > 1 ? "them" : "it"}; a folder named .git in any spelling). Remove or rename ${bad.length > 1 ? "them" : "it"}, then try again.`,
        );
      throw new StetError(`Stet could not read the workspace's files: ${added.stderr.trim().split("\n").pop()}`);
    }
    const tree = await git.run(["write-tree"], { env });
    const changed = (await git.run(["diff-index", "--cached", "--name-only", "-z", tip], { env })).split("\0").filter(Boolean);
    return { tree, changed };
  }

  /** Paths the agent changed but did not submit yet. */
  async uncommitted(): Promise<string[]> {
    const tip = await this.tip();
    return this.withIndex(async (git, env) => (await this.stage(git, env, tip)).changed);
  }

  /** Commit everything the agent changed onto its branch; returns the new tip (or the old one if nothing changed). */
  async commitAll(message: string): Promise<string> {
    const tip = await this.tip();
    return this.withIndex(async (git, env, index) => {
      const { tree, changed } = await this.stage(git, env, tip);
      if (!changed.length) return tip;
      const commit = await git.run([...STET_IDENTITY, "commit-tree", tree, "-p", tip, "-m", message], { env });
      await git.run(["update-ref", this.branchRef, commit, tip], { env });
      await this.publishIndex(index);
      return commit;
    });
  }

  /** Replace the workspace's files with `to` (the agent branch moves there). Local changes must be committed first. */
  async checkout(to: string): Promise<void> {
    const from = await this.tip();
    await this.withIndex(async (git, env, index) => {
      await git.run(["read-tree", from], { env });
      // Record which files still match `from`, so only files that differ are rewritten.
      await git.tryRun(["update-index", "-q", "--refresh"], { env });
      await git.run(["read-tree", "-u", "--reset", to], { env });
      await git.run(["update-ref", this.branchRef, to, from], { env });
      await this.publishIndex(index);
    });
  }

  /** Give the worktree an index matching its branch, so `git status` there shows no false changes. */
  private async publishIndex(index: string): Promise<void> {
    await replaceFile(join(this.gitDir, "index"), await readFile(index)).catch(() => undefined);
  }
}
