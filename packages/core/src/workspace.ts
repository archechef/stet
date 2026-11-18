/** Files Stet writes into agent workspaces: instructions, MCP config, guardrails (spec §9, §10). */
import { appendInside, readInside, writeInside } from "./safefs.js";
import { shQuote } from "./text.js";
import { Repo } from "./git.js";
import { agentInstructions, STET_MARKER } from "./instructions.js";
import type { Agent } from "./model.js";

/** How to invoke the `stet` CLI (absolute paths, so it works without PATH setup). */
export interface CliCommand {
  command: string;
  args: string[];
  /** Extra environment, e.g. ELECTRON_RUN_AS_NODE when running on VS Code's own runtime. */
  env?: Record<string, string>;
}

/** Untracked files Stet manages in a workspace. They are never part of proposals. */
export const WORKSPACE_FILES = [
  "CLAUDE.local.md",
  "AGENTS.override.md",
  ".mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/config.toml",
  ".stet/inbox",
] as const;

export function isWorkspaceFile(path: string): boolean {
  return (WORKSPACE_FILES as readonly string[]).includes(path.replace(/\\/g, "/"));
}

/** Pathspecs that exclude the workspace files (for `git add` / `git status`). */
export const WORKSPACE_EXCLUDES = WORKSPACE_FILES.map((f) => `:(exclude)${f}`);

const fwd = (p: string) => p.replace(/\\/g, "/");

/** Claude Code absolute path rule: `//c/Users/...` on Windows, `//home/...` elsewhere. */
export function claudeAbsPath(p: string): string {
  const f = fwd(p);
  const m = /^([A-Za-z]):\/(.*)$/.exec(f);
  return m ? `//${m[1]!.toLowerCase()}/${m[2]}` : `/${f}`;
}

export interface WorkspaceResult {
  written: string[];
  skipped: { file: string; reason: string }[];
}

export interface WorkspaceContext {
  agent: Agent;
  mainPath: string;
  commonDir: string;
  /** The worktree's private git dir (`<commonDir>/worktrees/<name>`), already verified. */
  gitDir: string;
  cli: CliCommand;
  platform?: NodeJS.Platform;
}

/**
 * A shell command running the Stet CLI with `sub` (POSIX shell: Git Bash on Windows too, so
 * `VAR=value cmd` works everywhere). Single quotes: a folder name containing `$(…)` or backticks
 * must not be run by the shell.
 */
export function cliShellCommand(cli: CliCommand, sub: string, env: Record<string, string> = {}): string {
  const all = { ...cli.env, ...env };
  const envPrefix = Object.entries(all).map(([k, v]) => `${k}=${shQuote(v)} `).join("");
  return envPrefix + [cli.command, ...cli.args].map((a) => shQuote(fwd(a))).join(" ") + " " + sub;
}

function claudeSettings(ctx: WorkspaceContext): object {
  const { cli, mainPath, gitDir } = ctx;
  // STET_PROJECT/STET_AGENT let the guard explain an archived workspace even after its folder is gone.
  const hookCmd = cliShellCommand(cli, "guard", { STET_PROJECT: fwd(mainPath), STET_AGENT: ctx.agent.id });
  const main = claudeAbsPath(mainPath);
  const settings: Record<string, unknown> = {
    permissions: {
      deny: [
        `Edit(${main}/**)`,
        "Edit(/.claude/**)",
        "Edit(/.mcp.json)",
        "Edit(/.codex/**)",
        "Edit(/CLAUDE.local.md)",
        "Edit(/AGENTS.override.md)",
        "Bash(git push *)",
        "Bash(git merge *)",
        "Bash(git rebase *)",
        "Bash(git switch *)",
        "Bash(git worktree *)",
        "Bash(git update-ref *)",
        "Bash(git branch -f *)",
        "Bash(git branch -D *)",
        "Bash(git branch -m *)",
        "Bash(git branch -M *)",
      ],
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell",
          hooks: [{ type: "command", command: hookCmd }],
        },
      ],
    },
    enabledMcpjsonServers: ["stet"],
  };
  // The Bash sandbox exists on macOS, Linux and WSL2 only. By default it lets commands write
  // to this workspace. Of the shared git dir, only the worktree's private part (index, HEAD) is
  // writable: the repository config, hooks, objects, refs and Stet's store stay read-only, so
  // the agent cannot plant commands that run outside the sandbox. Stet itself commits for the
  // agent (stet_submit), from outside the sandbox.
  if ((ctx.platform ?? process.platform) !== "win32") {
    settings.sandbox = { enabled: true, filesystem: { allowWrite: [fwd(gitDir)] } };
  }
  return settings;
}

function mcpServer(ctx: WorkspaceContext) {
  return {
    command: fwd(ctx.cli.command),
    args: [...ctx.cli.args.map(fwd), "mcp"],
    env: { ...ctx.cli.env, STET_WORKSPACE: fwd(ctx.agent.worktree), STET_PROJECT: fwd(ctx.mainPath), STET_AGENT: ctx.agent.id } as Record<string, string>,
  };
}

function codexConfig(ctx: WorkspaceContext): string {
  const s = mcpServer(ctx);
  const str = (v: string) => JSON.stringify(v);
  return [
    `# Written by Stet for agent ${ctx.agent.id}. Regenerate with: stet agent refresh ${ctx.agent.id}`,
    `sandbox_mode = "workspace-write"`,
    ``,
    `[mcp_servers.stet]`,
    `command = ${str(s.command)}`,
    `args = [${s.args.map(str).join(", ")}]`,
    `env = { ${Object.entries(s.env).map(([k, v]) => `${k} = ${str(v)}`).join(", ")} }`,
    ``,
  ].join("\n");
}

/** Write (or refresh) the workspace files. Files tracked by the project are never touched. */
export async function writeWorkspaceFiles(ctx: WorkspaceContext): Promise<WorkspaceResult> {
  // Tracked = in the agent branch, read from the project's repository (not the worktree's own index).
  const listed = await new Repo(ctx.mainPath).tryRun(["ls-tree", "-r", "-z", "--name-only", `refs/heads/${ctx.agent.branch}`, "--", ...WORKSPACE_FILES]);
  const tracked = new Set((listed ?? "").split("\0").filter(Boolean));
  const result: WorkspaceResult = { written: [], skipped: [] };
  const put = async (file: string, content: string) => {
    if (tracked.has(file)) {
      result.skipped.push({ file, reason: "tracked by the project" });
      return false;
    }
    // The agent controls this folder: never follow links it may have planted.
    await writeInside(ctx.agent.worktree, file, content);
    result.written.push(file);
    return true;
  };

  const instructions = agentInstructions(ctx.agent.id, cliShellCommand(ctx.cli, "watch"));
  await put("CLAUDE.local.md", instructions);

  // Codex reads AGENTS.override.md *instead of* AGENTS.md: carry the project's own instructions over.
  const projectAgents = (await readInside(ctx.agent.worktree, "AGENTS.md"))?.toString("utf8") ?? "";
  await put("AGENTS.override.md", (projectAgents && !projectAgents.includes(STET_MARKER) ? projectAgents.trimEnd() + "\n\n" : "") + instructions);

  await put(".mcp.json", JSON.stringify({ mcpServers: { stet: mcpServer(ctx) } }, null, 2) + "\n");

  const settings = JSON.stringify(claudeSettings(ctx), null, 2) + "\n";
  if (!(await put(".claude/settings.json", settings))) await put(".claude/settings.local.json", settings);

  await put(".codex/config.toml", codexConfig(ctx));

  // The inbox is appended to, never replaced: a running `stet watch` or `tail -f` keeps following it.
  if (!tracked.has(".stet/inbox")) await appendInside(ctx.agent.worktree, ".stet/inbox", "");
  return result;
}
