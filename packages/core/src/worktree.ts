/**
 * Integrity check for agent workspaces (spec §9). Stet runs git inside agent worktrees from
 * processes the agent's sandbox does not cover (MCP server, CLI, VS Code). An agent could point
 * its worktree at a git directory of its own (by rewriting the `.git` file or `commondir`) whose
 * config runs commands (filters, hooks). So before running git there, Stet checks that the
 * worktree still belongs to the project's repository.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { StetError } from "./errors.js";
import { foldPath } from "./paths.js";

export class WorktreeIntegrityError extends StetError {}

async function real(p: string): Promise<string> {
  try {
    return foldPath(await realpath(p));
  } catch {
    return foldPath(resolve(p));
  }
}

/**
 * Verify that `worktree` is a linked worktree of the repository whose shared git dir is `commonDir`.
 * Returns the worktree's private git dir (`<commonDir>/worktrees/<name>`).
 */
export async function verifyAgentWorktree(worktree: string, commonDir: string): Promise<string> {
  const fail = (why: string): never => {
    throw new WorktreeIntegrityError(
      `Stet refuses to run git in ${worktree}: ${why}. The workspace's git link was changed; ` +
        `recreate the workspace (stet agent archive <name> --remove, then stet agent new <name>).`,
    );
  };
  const dotGit = join(worktree, ".git");
  const st = await lstat(dotGit).catch(() => null);
  if (!st) fail("it has no .git file");
  if (!st!.isFile()) fail(".git is not a plain file");
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, "utf8"));
  if (!m) fail(".git does not name a git directory");
  const gitDir = resolve(worktree, m![1]!);
  const common = await real(commonDir);
  const gd = await real(gitDir);
  if (foldPath(dirname(gd)) !== `${common}/worktrees`) fail(".git points outside the project's repository");
  const gst = await lstat(gitDir).catch(() => null);
  if (!gst?.isDirectory()) fail("its git directory is missing");
  const cd = (await readFile(join(gitDir, "commondir"), "utf8").catch(() => "")).trim();
  if (!cd || (await real(resolve(gitDir, cd))) !== common) fail("its git directory points to another repository");
  if (await lstat(join(gitDir, "config.worktree")).catch(() => null)) fail("it has its own git config (config.worktree)");
  return gitDir;
}
