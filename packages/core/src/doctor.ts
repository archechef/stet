/** `stet doctor`: environment and repository health checks. */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { compareVersions, gitVersion, Repo } from "./git.js";
import { hookStatus } from "./hooks.js";
import { PROFILES } from "./lang/index.js";
import { isLive } from "./model.js";
import { pathExists } from "./paths.js";
import { BASE_REF, Stet } from "./service.js";
import { verifyAgentWorktree } from "./worktree.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "error" | "info";
  message: string;
  fix?: string;
}

/** Oldest git with every feature Stet uses (reference-transaction hook: 2.28). */
export const MIN_GIT = "2.28.0";
export const MIN_NODE = "20.0.0";

function which(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });
}

export async function doctor(cwd: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck) => checks.push(c);

  // Environment ----------------------------------------------------------------
  const node = process.versions.node;
  add(
    compareVersions(node, MIN_NODE) >= 0
      ? { name: "Node.js", status: "ok", message: `v${node}` }
      : { name: "Node.js", status: "error", message: `v${node} is too old (need ≥ ${MIN_NODE})`, fix: "Install Node.js 20 or newer from https://nodejs.org" },
  );

  const gv = await gitVersion();
  if (!gv) {
    add({ name: "git", status: "error", message: "git not found on PATH", fix: "Install git from https://git-scm.com and restart your terminal/editor." });
    return checks;
  }
  add(
    compareVersions(gv, MIN_GIT) >= 0
      ? { name: "git", status: "ok", message: gv }
      : {
          name: "git",
          status: "error",
          message: `${gv} is too old (need ≥ ${MIN_GIT})`,
          fix: "Update git (Windows: `git update-git-for-windows`; macOS: `brew upgrade git`; Linux: your package manager).",
        },
  );

  const probe = new Repo(cwd);
  const name = await probe.tryRun(["config", "user.name"]);
  const email = await probe.tryRun(["config", "user.email"]);
  // What git commits with, also when set by GIT_AUTHOR_* / GIT_COMMITTER_*.
  const ident = name && email ? null : await probe.tryRun(["var", "GIT_AUTHOR_IDENT"]);
  const fromEnv = ident && (await probe.tryRun(["var", "GIT_COMMITTER_IDENT"])) ? ident.replace(/\s+\d+\s+[+-]\d{4}$/, "") : null;
  add(
    fromEnv
      ? { name: "git identity", status: "ok", message: `${fromEnv} (from the environment)` }
      : name && email
        ? { name: "git identity", status: "ok", message: `${name} <${email}>` }
        : {
            name: "git identity",
            status: "warn",
            message: "user.name / user.email not set; Stet can't commit accepted changes for you",
            fix: 'git config --global user.name "Your Name" && git config --global user.email you@example.com',
          },
  );

  const autocrlf = await probe.tryRun(["config", "core.autocrlf"]);
  add({
    name: "line endings",
    status: "info",
    message: `core.autocrlf=${autocrlf ?? "unset"}. Stet keeps each file's existing line endings (LF or CRLF).`,
  });

  // The tools each language's previews need (LaTeX: latexmk).
  for (const p of PROFILES) for (const c of (await p.typesetter?.doctor(which)) ?? []) add(c);

  // Repository -----------------------------------------------------------------
  let located: Awaited<ReturnType<typeof Stet.locate>>;
  try {
    located = await Stet.locate(cwd);
  } catch {
    add({ name: "repository", status: "info", message: "not inside a git repository; repository checks skipped" });
    return checks;
  }
  add({ name: "repository", status: "ok", message: located.mainPath });

  let stet: Stet;
  try {
    stet = await Stet.open(cwd, located);
  } catch {
    add({ name: "stet setup", status: "warn", message: "Stet is not set up in this repository", fix: "stet init" });
    return checks;
  }
  const cfg = await stet.config();
  add({ name: "stet setup", status: "ok", message: `store at ${stet.store.root}` });

  const head = await stet.repo.revParse(`refs/heads/${cfg.mainBranch}`);
  if (!head)
    add({
      name: "main branch",
      status: "error",
      message: `branch '${cfg.mainBranch}' not found`,
      fix: `Edit mainBranch in ${join(stet.store.root, "config.json")}`,
    });
  else {
    const current = await stet.repo.tryRun(["symbolic-ref", "--short", "HEAD"]);
    add(
      current === cfg.mainBranch
        ? { name: "main branch", status: "ok", message: `'${cfg.mainBranch}' is checked out in ${located.mainPath}` }
        : {
            name: "main branch",
            status: "warn",
            message: `project folder is on '${current ?? "detached HEAD"}', not '${cfg.mainBranch}'; accepting is disabled`,
            fix: `git switch ${cfg.mainBranch}`,
          },
    );
  }

  const base = await stet.repo.revParse(BASE_REF);
  add(
    base
      ? { name: "review base", status: "ok", message: base.slice(0, 10) }
      : {
          name: "review base",
          status: "warn",
          message: `${BASE_REF} missing`,
          fix: "It is recreated automatically by the next Stet command (e.g. `stet review`).",
        },
  );

  if (await pathExists(stet.store.lockPath)) {
    const age = Date.now() - (await stat(stet.store.lockPath)).mtimeMs;
    add({
      name: "lock",
      status: age > 30_000 ? "warn" : "info",
      message: age > 30_000 ? `stale lock file (${Math.round(age / 1000)} s old)` : "an operation is in progress",
      ...(age > 30_000 ? { fix: `Delete ${stet.store.lockPath} if no Stet process is running.` } : {}),
    });
  }

  // Guardrails and agent integration (M2) ----------------------------------------
  const hooks = await hookStatus(stet.repo, stet.commonDir);
  if (!cfg.guardHooks) add({ name: "git hooks", status: "info", message: "disabled in config (guardHooks: false)" });
  else if (!hooks.missing.length) add({ name: "git hooks", status: "ok", message: `installed in ${hooks.dir}` });
  else
    add({
      name: "git hooks",
      status: "warn",
      message: `missing: ${hooks.missing.join(", ")}${hooks.customHooksPath ? ` (core.hooksPath is ${hooks.dir})` : ""}`,
      fix: hooks.customHooksPath ? "stet hooks install --force  (or add Stet's hooks to your hook manager)" : "stet hooks install",
    });

  if (!cfg.cli) add({ name: "stet command", status: "warn", message: "not recorded; agent workspaces get no MCP/guard config", fix: "stet init" });
  else if (!(await pathExists(cfg.cli.args[0] ?? cfg.cli.command)))
    add({
      name: "stet command",
      status: "error",
      message: `${cfg.cli.args[0] ?? cfg.cli.command} no longer exists (Stet moved?)`,
      fix: "stet init, then stet agent refresh <name> for each agent",
    });
  else add({ name: "stet command", status: "ok", message: [cfg.cli.command, ...cfg.cli.args].join(" ") });

  const home = homedir();
  const claudeJson = await readFile(join(home, ".claude.json"), "utf8").catch(() => "");
  let claudeHasStet = false;
  try {
    claudeHasStet = !!JSON.parse(claudeJson || "{}")?.mcpServers?.stet;
  } catch {
    /* unreadable: treat as not registered */
  }
  add(
    claudeHasStet
      ? { name: "Claude Code MCP", status: "ok", message: "stet registered at user scope" }
      : {
          name: "Claude Code MCP",
          status: "info",
          message: "stet not registered at user scope; each workspace's .mcp.json is used instead (pre-approved, no prompt)",
          fix: "optional: stet setup claude",
        },
  );
  const codexToml = await readFile(join(home, ".codex", "config.toml"), "utf8").catch(() => "");
  add(
    /^\[mcp_servers\.stet\]/m.test(codexToml)
      ? { name: "Codex MCP", status: "ok", message: "stet registered in ~/.codex/config.toml" }
      : { name: "Codex MCP", status: "info", message: "stet not registered globally (workspaces carry a project .codex/config.toml)", fix: "stet setup codex" },
  );
  if (process.platform === "win32")
    add({
      name: "sandbox",
      status: "info",
      message: "Claude Code's Bash sandbox is not available on native Windows; Stet relies on the workspace, guard hook and git hooks",
    });

  // Agents ---------------------------------------------------------------------
  const worktrees = await stet.repo.worktrees();
  const items = await stet.store.items();
  const agents = (await stet.listAgents()).filter((a) => a.state === "active");
  if (!agents.length) add({ name: "agents", status: "info", message: "no agents yet", fix: "stet agent new <name>" });
  for (const a of agents) {
    const wt = worktrees.find((w) => w.path.replace(/\\/g, "/").toLowerCase() === a.worktree.toLowerCase());
    const n = `agent ${a.id}`;
    if (!wt || !(await pathExists(a.worktree))) {
      add({ name: n, status: "error", message: `workspace missing (${a.worktree})`, fix: `stet agent archive ${a.id}  (then create a new one)` });
      continue;
    }
    if (wt.branch !== a.branch) {
      add({ name: n, status: "error", message: `workspace is on '${wt.branch}', expected '${a.branch}'`, fix: `git -C "${a.worktree}" switch ${a.branch}` });
      continue;
    }
    try {
      await verifyAgentWorktree(a.worktree, stet.commonDir);
    } catch (e: any) {
      add({ name: n, status: "error", message: e.message, fix: `stet agent archive ${a.id} --remove  (then create a new one)` });
      continue;
    }
    const dirty = (await stet.unsubmittedFiles(a)).length;
    const live = items.filter((i) => i.agent === a.id && isLive(i.status)).length;
    const parts = [`${live} pending`];
    if (dirty) parts.push(`${dirty} unsubmitted file change(s)`);
    if (base && a.baseCommit !== base) parts.push("needs sync");
    const missingFiles: string[] = [];
    for (const f of ["CLAUDE.local.md", ".mcp.json"]) if (!(await pathExists(join(a.worktree, f)))) missingFiles.push(f);
    const settings = (await pathExists(join(a.worktree, ".claude/settings.json"))) || (await pathExists(join(a.worktree, ".claude/settings.local.json")));
    if (!settings) missingFiles.push(".claude/settings.json");
    if (cfg.cli && missingFiles.length)
      add({ name: n, status: "warn", message: `${parts.join(", ")}; missing workspace files: ${missingFiles.join(", ")}`, fix: `stet agent refresh ${a.id}` });
    else add({ name: n, status: "ok", message: parts.join(", ") });
  }
  const pv = await stet.previewStatus(true).catch(() => null);
  if (pv) {
    add({
      name: "PDF previews",
      status: pv.status === "ready" ? (pv.isolation === "process" ? "warn" : "ok") : "info",
      message: pv.message,
      ...(pv.fix ? { fix: pv.fix } : pv.isolation === "process" ? { fix: "install Podman for builds in an isolated container" } : {}),
    });
  }

  // Only when something is wrong: accepted changes agents don't get.
  const missing = await stet.missingFromBase().catch(() => []);
  if (missing.length)
    add({
      name: "review base",
      status: "warn",
      message: `agents don't get accepted ${missing.map((m) => `${m.item.id} (${m.reason})`).join(", ")}`,
      fix: "stet commit  (or share your edits again: stet share)",
    });
  const orphans = worktrees.filter((w) => w.branch?.startsWith(cfg.agentBranchPrefix) && !agents.some((a) => a.branch === w.branch));
  for (const o of orphans)
    add({ name: "worktree", status: "info", message: `${o.path} (${o.branch}) is not registered yet; it is adopted when used as an agent workspace` });

  // Store consistency -----------------------------------------------------------
  const groups = await stet.store.groups();
  const ids = new Set(items.map((i) => i.id));
  const dangling = groups.filter((g) => g.items.some((i) => !ids.has(i)));
  await Promise.all([stet.store.agents(), stet.store.changesets()]); // so damaged files of every kind are noticed
  if (stet.store.unreadable.size)
    add({
      name: "store",
      status: "error",
      message: `damaged record files (skipped): ${[...stet.store.unreadable].join(", ")}`,
      fix: "restore them from a backup or delete them",
    });
  if (dangling.length) add({ name: "store", status: "warn", message: `groups referencing missing items: ${dangling.map((g) => g.id).join(", ")}` });
  else add({ name: "store", status: "ok", message: `${items.length} items, ${groups.length} groups` });

  return checks;
}
