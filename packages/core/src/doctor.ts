/** `stet doctor`: environment and repository health checks. */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { compareVersions, gitVersion, Repo } from "./git.js";
import { isLive } from "./model.js";
import { BASE_REF, Stet } from "./service.js";

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

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
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
      : { name: "git", status: "error", message: `${gv} is too old (need ≥ ${MIN_GIT})`, fix: "Update git (Windows: `git update-git-for-windows`; macOS: `brew upgrade git`; Linux: your package manager)." },
  );

  const probe = new Repo(cwd);
  const name = await probe.tryRun(["config", "user.name"]);
  const email = await probe.tryRun(["config", "user.email"]);
  add(
    name && email
      ? { name: "git identity", status: "ok", message: `${name} <${email}>` }
      : { name: "git identity", status: "warn", message: "user.name / user.email not set; Stet can't commit accepted changes for you", fix: 'git config --global user.name "Your Name" && git config --global user.email you@example.com' },
  );

  const autocrlf = await probe.tryRun(["config", "core.autocrlf"]);
  add({
    name: "line endings",
    status: "info",
    message: `core.autocrlf=${autocrlf ?? "unset"}. Stet keeps each file's existing line endings (LF or CRLF).`,
  });

  const latexmk = await which("latexmk", ["-v"]);
  add(
    latexmk
      ? { name: "latexmk", status: "ok", message: latexmk.split("\n").find((l) => /latexmk/i.test(l))?.trim() ?? "found" }
      : { name: "latexmk", status: "info", message: "not found (only needed for PDF previews, a later feature)" },
  );

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
    stet = await Stet.open(cwd);
  } catch {
    add({ name: "stet setup", status: "warn", message: "Stet is not set up in this repository", fix: "stet init" });
    return checks;
  }
  const cfg = await stet.config();
  add({ name: "stet setup", status: "ok", message: `store at ${stet.store.root}` });

  const head = await stet.repo.revParse(`refs/heads/${cfg.mainBranch}`);
  if (!head) add({ name: "main branch", status: "error", message: `branch '${cfg.mainBranch}' not found`, fix: `Edit mainBranch in ${join(stet.store.root, "config.json")}` });
  else {
    const current = await stet.repo.tryRun(["symbolic-ref", "--short", "HEAD"]);
    add(
      current === cfg.mainBranch
        ? { name: "main branch", status: "ok", message: `'${cfg.mainBranch}' is checked out in ${located.mainPath}` }
        : { name: "main branch", status: "warn", message: `project folder is on '${current ?? "detached HEAD"}', not '${cfg.mainBranch}'; accepting is disabled`, fix: `git switch ${cfg.mainBranch}` },
    );
  }

  const base = await stet.repo.revParse(BASE_REF);
  add(base ? { name: "review base", status: "ok", message: base.slice(0, 10) } : { name: "review base", status: "warn", message: `${BASE_REF} missing`, fix: "It is recreated automatically by the next Stet command (e.g. `stet review`)." });

  if (await exists(stet.store.lockPath)) {
    const age = Date.now() - (await stat(stet.store.lockPath)).mtimeMs;
    add({
      name: "lock",
      status: age > 30_000 ? "warn" : "info",
      message: age > 30_000 ? `stale lock file (${Math.round(age / 1000)} s old)` : "an operation is in progress",
      ...(age > 30_000 ? { fix: `Delete ${stet.store.lockPath} if no Stet process is running.` } : {}),
    });
  }

  // Agents ---------------------------------------------------------------------
  const worktrees = await stet.repo.worktrees();
  const items = await stet.store.items();
  const agents = (await stet.listAgents()).filter((a) => a.state === "active");
  if (!agents.length) add({ name: "agents", status: "info", message: "no agents yet", fix: "stet agent new <name>" });
  for (const a of agents) {
    const wt = worktrees.find((w) => w.path.replace(/\\/g, "/").toLowerCase() === a.worktree.toLowerCase());
    const n = `agent ${a.id}`;
    if (!wt || !(await exists(a.worktree))) {
      add({ name: n, status: "error", message: `workspace missing (${a.worktree})`, fix: `stet agent archive ${a.id}  (then create a new one)` });
      continue;
    }
    if (wt.branch !== a.branch) {
      add({ name: n, status: "error", message: `workspace is on '${wt.branch}', expected '${a.branch}'`, fix: `git -C "${a.worktree}" switch ${a.branch}` });
      continue;
    }
    const dirty = (await new Repo(a.worktree).status()).length;
    const live = items.filter((i) => i.agent === a.id && isLive(i.status)).length;
    const parts = [`${live} pending`];
    if (dirty) parts.push(`${dirty} unsubmitted file change(s)`);
    if (base && a.baseCommit !== base) parts.push("needs sync");
    add({ name: n, status: "ok", message: parts.join(", ") });
  }
  const orphans = worktrees.filter((w) => w.branch?.startsWith(cfg.agentBranchPrefix) && !agents.some((a) => a.branch === w.branch));
  for (const o of orphans) add({ name: "worktree", status: "info", message: `${o.path} (${o.branch}) is not registered yet; it is adopted when used as an agent workspace` });

  // Store consistency -----------------------------------------------------------
  const groups = await stet.store.groups();
  const ids = new Set(items.map((i) => i.id));
  const dangling = groups.filter((g) => g.items.some((i) => !ids.has(i)));
  if (dangling.length) add({ name: "store", status: "warn", message: `groups referencing missing items: ${dangling.map((g) => g.id).join(", ")}` });
  else add({ name: "store", status: "ok", message: `${items.length} items, ${groups.length} groups` });

  return checks;
}
