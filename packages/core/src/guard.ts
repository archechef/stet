/**
 * `stet guard`: Claude Code PreToolUse hook (spec §9, layer 2).
 * Best effort: blocks writes outside the agent workspace and git commands that
 * would bypass review. It guards against accidents, not against an adversary.
 */
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { isInside } from "./paths.js";
import { WORKSPACE_FILES } from "./workspace.js";

export { isInside };

export interface GuardContext {
  /** Root of the agent workspace (worktree). */
  worktree: string;
  /** The user's project folder (main worktree). */
  mainPath: string;
  /** Shared git dir of the repository. */
  commonDir: string;
  /** Extra writable locations (temp dirs, scratchpads). */
  writable?: string[];
}

export interface HookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  scratchpad_dir?: string;
}

/** Convert Git Bash style `/c/Users/...` paths to native ones on Windows. */
function nativePath(p: string): string {
  if (process.platform === "win32") {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1]}:${m[2] ?? "/"}`;
  }
  return p;
}

/** Resolve `p` (possibly relative to `cwd`) to an absolute native path. */
function abs(p: string, cwd: string): string {
  const n = nativePath(p.replace(/^["']|["']$/g, ""));
  return isAbsolute(n) ? resolve(n) : resolve(cwd, n);
}

const GIT_OPTS = String.raw`\bgit\b(?:\s+(?:-c\s+\S+|-C\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;
const GIT_BLOCKED = new RegExp(GIT_OPTS + String.raw`(push|merge|rebase|switch|worktree|update-ref|filter-branch|filter-repo|replace|symbolic-ref|submodule)\b`);
const GIT_CHECKOUT = new RegExp(GIT_OPTS + String.raw`checkout\b(?![^;&|]*\s--(\s|$))`);
const GIT_BRANCH_WRITE = /\bgit\b(?:\s+\S+)*?\s+branch\b[^;&|]*\s(-[a-zA-Z]*[fdDmMcC][a-zA-Z]*|--force|--delete|--move|--copy)\b/;
/** Git config is shared with the user's project: writing it could make the user's git run commands. */
const GIT_CONFIG_WRITE = new RegExp(
  GIT_OPTS + String.raw`config\b(?![^;&|]*\s(?:--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l|get|list)(?:\s|$))`,
);
const GIT_REMOTE_WRITE = new RegExp(GIT_OPTS + String.raw`remote\s+(add|set-url|rename|remove|rm|set-head|set-branches|prune|update)\b`);
// Config keys are case-insensitive (core.HOOKSPATH); aliases would get around the verb checks.
const GIT_DIR_OVERRIDE =
  /\bgit\b[^;&|]*\s(--git-dir|--work-tree)\b|\bGIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG\w*)=|core\.hooksPath|\balias\.|STET_INTERNAL/i;
const READ_ONLY_START = /^\s*(cat|less|more|head|tail|ls|dir|grep|rg|find|wc|type|file|stat|Get-Content|Get-ChildItem|Select-String|diff|cmp)\b/i;
const WRITE_HINT = /(^|[^<>])>{1,2}(?!&)|\|\s*tee\b|\b(rm|mv|cp|touch|mkdir|rmdir|sed\s+-i|perl\s+-i|truncate|dd|ln|chmod|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item)\b/i;

/**
 * Files in the worktree that belong to Stet: its settings and instructions, the `.claude` and
 * `.codex` folders, and the `.git` link. Case-insensitive on Windows (`.CLAUDE/settings.json`
 * is the same file there).
 */
function isOwnFile(rel: string): boolean {
  const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const r = fold(rel);
  return (
    WORKSPACE_FILES.some((f) => fold(f) === r) ||
    [".claude", ".codex", ".git"].some((d) => r === d || r.startsWith(d + "/"))
  );
}

/** Returns a reason to block, or null to allow. */
export function checkToolUse(input: HookInput, ctx: GuardContext): string | null {
  const cwd = input.cwd ?? ctx.worktree;
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const writable = [ctx.worktree, tmpdir(), ...(ctx.writable ?? []), ...(input.scratchpad_dir ? [input.scratchpad_dir] : [])];

  const checkWrite = (file: string): string | null => {
    const p = abs(file, cwd);
    if (isInside(p, ctx.commonDir)) return `Stet: ${file} is inside the project's git directory, which agents must not change.`;
    if (isInside(p, ctx.mainPath) || !writable.some((w) => isInside(p, w))) {
      return (
        `Stet: ${file} is outside your proposal workspace (${ctx.worktree}). ` +
        `Only edit files inside that folder; the reviewer applies accepted changes to the real project.`
      );
    }
    if (isInside(p, ctx.worktree)) {
      const rel = relative(ctx.worktree, p).replace(/\\/g, "/");
      if (isOwnFile(rel)) return `Stet: ${rel} is managed by Stet and must not be edited.`;
    }
    return null;
  };

  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const files = [ti.file_path, ti.notebook_path, ...(Array.isArray(ti.edits) ? ti.edits.map((e: any) => e?.file_path) : [])].filter(
      (f): f is string => typeof f === "string" && f.length > 0,
    );
    for (const f of files) {
      const r = checkWrite(f);
      if (r) return r;
    }
    return null;
  }

  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(ti.command ?? "");
    const gitMsg = (what: string) =>
      `Stet: ${what} is not allowed in a proposal workspace. Submit your changes with stet_submit instead; ` +
      `the reviewer merges them.`;
    if (GIT_BLOCKED.test(cmd)) return gitMsg(`\`git ${GIT_BLOCKED.exec(cmd)![1]}\``);
    if (GIT_CHECKOUT.test(cmd)) return gitMsg("switching branches with `git checkout`") + " To discard a file's changes use `git restore <file>`.";
    if (GIT_BRANCH_WRITE.test(cmd)) return gitMsg("changing branches with `git branch`");
    if (GIT_DIR_OVERRIDE.test(cmd)) return gitMsg("pointing git at another repository, hooks path or alias");
    if (GIT_CONFIG_WRITE.test(cmd)) return gitMsg("changing git config (it is shared with the reviewer's project)") + " Reading it with `git config --get <key>` is fine.";
    if (GIT_REMOTE_WRITE.test(cmd)) return gitMsg("changing git remotes");

    // Paths mentioned in the command that lead into the user's project.
    const tokens = cmd.match(/"[^"]*"|'[^']*'|[^\s;&|<>()]+/g) ?? [];
    const pathLike = tokens.map((t) => t.replace(/^["']|["']$/g, "")).filter((t) => /[\\/]/.test(t) && !/^https?:/.test(t));
    // The git dir counts as part of the project: its config and hooks run in the reviewer's git.
    const touchesMain = pathLike.some((t) => {
      try {
        const p = abs(t, cwd);
        return isInside(p, ctx.mainPath) || isInside(p, ctx.commonDir);
      } catch {
        return false;
      }
    });
    const gitC = /\bgit\s+-C\s+("[^"]*"|'[^']*'|\S+)/.exec(cmd);
    if (gitC && !isInside(abs(gitC[1]!, cwd), ctx.worktree)) return gitMsg("running git in another folder");
    if (touchesMain && (WRITE_HINT.test(cmd) || !READ_ONLY_START.test(cmd))) {
      return (
        `Stet: this command refers to the reviewer's project folder (${ctx.mainPath}). ` +
        `Work only inside your proposal workspace (${ctx.worktree}).`
      );
    }

    // Stet's own workspace files (settings, MCP config, instructions) may be read but not changed.
    // Match the names anywhere, including inside quoted code such as python -c "open('.claude/…')".
    // The worktree's `.git` file links it to the repository; changing it would redirect Stet's git calls.
    const names = cmd.match(/[\w:.\/\\~-]*?(?:\.claude|\.codex|CLAUDE\.local\.md|AGENTS\.override\.md|\.mcp\.json|\.git\b)[\w.\/\\-]*/gi) ?? [];
    const touchesOwn = names.some((t) => {
      try {
        const p = abs(t, cwd);
        if (!isInside(p, ctx.worktree)) return false;
        return isOwnFile(relative(ctx.worktree, p).replace(/\\/g, "/"));
      } catch {
        return false;
      }
    });
    if (touchesOwn && (WRITE_HINT.test(cmd) || /\b(python3?|node|perl|ruby|powershell|pwsh)\b/i.test(cmd) || !READ_ONLY_START.test(cmd))) {
      return `Stet: this command would change files that Stet manages in this workspace (settings, MCP config, instructions). Leave them as they are.`;
    }
    return null;
  }
  return null;
}
