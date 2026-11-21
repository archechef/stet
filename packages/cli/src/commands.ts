/**
 * The commands of `stet`: each with its help lines, the options it takes, and what it does.
 * `main` parses the command line against this table and prints the help from it.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type AcceptResult,
  type Agent,
  type AgentKind,
  archivedMessage,
  type CliCommand,
  checkToolUse,
  DOCUMENT_LANGUAGES,
  describeItem,
  describeNote,
  doctor,
  documentProfile,
  findInbox,
  followInbox,
  type GroupHint,
  type GroupKind,
  hookStatus,
  type Item,
  type ItemStatus,
  installHooks,
  isLive,
  isNoteId,
  moveOthers,
  NOTIFY_TRIGGER_TEXT,
  NOTIFY_TRIGGERS,
  type NoteHint,
  type NotifyMode,
  type NotifyTrigger,
  notFound,
  notifyMode,
  notifyTriggers,
  oneLine,
  parseId,
  partId,
  pendingInRound,
  Repo,
  roundOf,
  SHARE_MODES,
  type ShareMode,
  Stet,
  StetError,
  StetMcpServer,
  serveStdio,
  uninstallHooks,
  usageError,
  verifyAgentWorktree,
} from "@stet/core";
import type { OptionName, Opts } from "./options.js";
import {
  bold,
  colored,
  describeEvent,
  dim,
  forTerminal,
  green,
  indented,
  itemDiff,
  itemSummary,
  localTime,
  missingText,
  NOTIFY_TEXT,
  noteReply,
  noteSummary,
  red,
  yellow,
} from "./output.js";

/** What a command runs with. */
export interface Ctx {
  /** The arguments after the command's name. */
  args: string[];
  opt: Opts;
  cwd: string;
  /** The project, opened (commands with `project`). */
  stet: Stet;
  /** Print `human` for people, or `data` as JSON with --json. */
  // biome-ignore lint/suspicious/noConfusingVoidType: `human` prints on its own when it returns nothing.
  out(human: () => string | void, data: unknown): void;
  print(s: string): void;
  printError(s: string): void;
  /** How other tools run this CLI (agents' workspaces, MCP registration). */
  self: CliCommand;
}

export interface Command {
  name: string;
  section: "project" | "review" | "agent" | "internal";
  /** Its lines in `stet --help`, without the indent. */
  usage: string[];
  /** The options it takes, besides --json, --help and --version. */
  options: OptionName[];
  /** It works on the project: opened from the current folder before it runs. */
  project?: true;
  /** The reviewer's: refused in an agent's workspace, where an agent without a sandbox could accept its own proposals (test report 2026-11-20). */
  reviewer?: boolean | ((args: string[]) => boolean);
  /** Its exit code, when not 0. */
  // biome-ignore lint/suspicious/noConfusingVoidType: most commands end with `return out(…)`.
  run(ctx: Ctx): Promise<number | void>;
}

async function readJsonArg<T>(arg: string | undefined): Promise<T | undefined> {
  if (!arg) return undefined;
  if (arg.trim().startsWith("[") || arg.trim().startsWith("{")) return JSON.parse(arg) as T;
  const raw = arg === "-" ? await readAll(process.stdin) : await readFile(arg, "utf8");
  return JSON.parse(raw) as T;
}

async function agentId(stet: Stet, opt: Opts, cwd: string): Promise<string> {
  if (opt.agent) return opt.agent;
  return (await stet.agentForCwd(cwd)).id;
}

const STATUSES: readonly ItemStatus[] = ["pending", "needs_revision", "accepted", "rejected", "withdrawn", "superseded", "stale"];

/** `--status a,b`, checked: a typo matched nothing and said "Nothing to review" (test report B5). */
function statusOption(v: string): ItemStatus[] {
  const out = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = out.filter((s) => !STATUSES.includes(s as ItemStatus));
  if (bad.length) throw usageError(`Unknown status ${bad.map((b) => `'${b}'`).join(", ")} (use ${STATUSES.join(", ")}).`);
  return out as ItemStatus[];
}

/** `--agent <name>`, checked against the agents there are (archived ones too). */
async function agentOption(stet: Stet, opt: Opts): Promise<string | undefined> {
  if (!opt.agent) return undefined;
  const all = await stet.listAgents();
  if (!all.some((a) => a.id === opt.agent))
    throw notFound(`Unknown agent '${opt.agent}'${all.length ? ` (there are: ${all.map((a) => a.id).join(", ")})` : " (there are no agents yet)"}.`);
  return opt.agent;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw usageError(`Missing ${what}.`);
  return v;
}

/** A group (G3) or a part of one (G3.2). */
const isGroupId = (s: string) => ["group", "part"].includes(parseId(s).kind);
const isRoundId = (s: string) => parseId(s).kind === "round";

/** A round's (C3) pending changes, for accepting or rejecting it whole (test report UX: "Unknown item 'C1'"). */
async function roundItems(stet: Stet, id: string): Promise<string[]> {
  const cs = (await stet.listChangesets()).find((c) => c.id === parseId(id).id);
  if (!cs) throw notFound(`Unknown changeset ${parseId(id).id}.`);
  const ids = pendingInRound(await stet.listItems({ changeset: cs.id }), cs.id).map((i) => i.id);
  if (!ids.length) throw new StetError(`${cs.id} has no pending changes.`);
  return ids;
}

export const VERSION = "0.16.0";

function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => (s += d));
    stream.on("end", () => resolve(s));
    stream.on("error", reject);
  });
}

/** Claude Code PreToolUse hook: exit 2 blocks the tool call, stderr goes to the agent. */
async function guard(): Promise<number> {
  let input: any;
  try {
    input = JSON.parse(await readAll(process.stdin));
  } catch {
    return 0; // not a hook invocation we understand: allow
  }
  const cwd: string = input.cwd ?? process.cwd();
  const block = (reason: string) => {
    process.stderr.write(reason + "\n");
    return 2;
  };
  // The hook Stet installs names the project and the agent. The project is opened from there and
  // the workspace's git link checked, never followed (security report 5e4c6af, S1), and the guard
  // fails closed: an error used to let every tool call through (S6).
  const project = process.env.STET_PROJECT;
  const agentId = process.env.STET_AGENT;
  if (project && agentId) {
    try {
      const stet = await Stet.open(project);
      const agent = await stet.store.getAgent(agentId);
      if (agent?.state === "archived") return block(archivedMessage(agent));
      if (!existsSync(cwd))
        return block(`Stet: this workspace folder (${cwd}) no longer exists. Stop working here and ask the user for a new agent workspace.`);
      if (!agent) return block(`Stet: agent '${agentId}' is unknown to the project ${project}. Ask the user for a new agent workspace.`);
      await verifyAgentWorktree(agent.worktree, stet.commonDir);
      const cfg = await stet.config();
      const reason = checkToolUse(input, {
        worktree: agent.worktree,
        mainPath: stet.mainPath,
        commonDir: stet.commonDir,
        ...(cfg.cli ? { cli: cfg.cli } : {}),
      });
      return reason ? block(reason) : 0;
    } catch (e: any) {
      return block(`Stet's guard could not check this tool call, so it is blocked: ${e?.message ?? e}`);
    }
  }
  // A hook written by an older Stet: find the project from the folder.
  try {
    const located = await Stet.locate(cwd);
    const { toplevel, mainPath, commonDir } = located;
    const stet = await Stet.open(cwd, located);
    const cfg = await stet.config();
    const branch = await new Repo(toplevel, stet.untrustedConfig).tryRun(["symbolic-ref", "--short", "HEAD"]);
    if (!branch?.startsWith(cfg.agentBranchPrefix)) return 0; // not an agent workspace
    const reason = checkToolUse(input, { worktree: toplevel, mainPath, commonDir, ...(cfg.cli ? { cli: cfg.cli } : {}) });
    return reason ? block(reason) : 0;
  } catch (e: any) {
    // Never block on internal errors, but say so (non-blocking hook error).
    process.stderr.write(`stet guard: ${e?.message ?? e}\n`);
    return 1;
  }
}

/** `stet watch`: follow the workspace's inbox, which the Stet MCP server writes. */
async function watch(cwd: string, opt: Opts, print: (s: string) => void): Promise<void> {
  const inbox = await findInbox(cwd);
  if (!inbox) throw new StetError("Run `stet watch` inside an agent workspace.");
  if (!existsSync(inbox)) {
    process.stderr.write(`stet watch: ${inbox} does not exist yet. Lines are written while the agent's Stet tools (MCP server) are connected.\n`);
  }
  for await (const line of followInbox(inbox, { once: !!opt.once })) {
    print(opt.json ? JSON.stringify(line) : `${line.key}: ${line.text}`);
  }
}

/** Quote an argument for cmd.exe when we have to go through a shell (npm .cmd shims). */
const winQuote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function runTool(cmd: string, args: string[]): { ok: boolean; out: string } {
  const win = process.platform === "win32";
  // cmd.exe would look for `claude`/`codex` in the current folder first; this variable stops that.
  const r = win
    ? spawnSync([cmd, ...args].map(winQuote).join(" "), { shell: true, encoding: "utf8", env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" } })
    : spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim() };
}

// ---------------------------------------------------------------------------
// Commands

export const SECTIONS: Record<Command["section"], string> = {
  project: "Project (run in your project folder):",
  review: "Review:",
  agent: "Agent side (run inside an agent workspace, or pass --agent <name>):",
  internal: "Internal (called by agents' tools):",
};

export const COMMANDS: Command[] = [
  {
    name: "init",
    section: "project",
    usage: ["stet init [--main <branch>] [--language <latex|typst>]           set up Stet in this repository"],
    options: ["main", "language"],
    async run({ opt, cwd, self, out }) {
      // A second run only refreshes the setup: say so, instead of the first-time message (test report UX).
      const { setUp: already, languages } = await Stet.inspectSetup(cwd);
      const stet = await Stet.init(cwd, { ...(opt.main ? { mainBranch: opt.main } : {}), ...(opt.language ? { language: opt.language } : {}), cli: self });
      const cfg = await stet.config();
      // Files of both languages: which has more, and how to choose the other (test report 5e4c6af).
      const mixed = !opt.language && !already && languages.length > 1;
      const hooks = await hookStatus(stet.repo, stet.commonDir);
      // Agents start from the last commit: edits not committed yet are not theirs to see.
      const dirty = await stet.uncommittedEdits();
      return out(
        () =>
          (already
            ? `Stet was already set up for ${stet.mainPath} (main branch '${cfg.mainBranch}'); its setup is refreshed.\n`
            : `Stet is set up for ${stet.mainPath} (main branch '${cfg.mainBranch}').\n`) +
          // Which language agents are told about, and how to change it (test report 5e4c6af, UX).
          `Language: ${documentProfile(cfg).name} (agents' instructions follow it; set "language" in .git/stet/config.json to change it).\n` +
          (mixed
            ? yellow(
                `! The project has files of both languages (${languages
                  .map(([id, n]) => `${n} ${DOCUMENT_LANGUAGES.find((p) => p.id === id)?.name ?? id}`)
                  .join(", ")}); Stet took the one with more. \`stet init --language <${DOCUMENT_LANGUAGES.map((p) => p.id).join("|")}>\` chooses.`,
              ) + "\n"
            : "") +
          (hooks.missing.length
            ? yellow(
                `! Git guard hooks not installed (${hooks.customHooksPath ? `core.hooksPath is ${hooks.dir}` : "disabled"}). See \`stet hooks install\`.`,
              ) + "\n"
            : already
              ? ""
              : `Git guard hooks installed in ${hooks.dir}.\n`) +
          (dirty
            ? yellow("! You have uncommitted edits. Agents start from your last commit: commit them first, or share them with `stet share`.") + "\n"
            : "") +
          (already
            ? ""
            : `Next: stet agent new <name>. Optional, once per machine: stet setup claude (or codex) registers Stet with the agent tool for every folder; each workspace already has its own config.`),
        { mainPath: stet.mainPath, mainBranch: cfg.mainBranch, hooks, alreadySetUp: already, uncommittedEdits: dirty },
      );
    },
  },
  {
    name: "doctor",
    section: "project",
    usage: ["stet doctor                           check your setup"],
    options: [],
    async run({ cwd, out }) {
      const checks = await doctor(cwd);
      const icon = { ok: green("✓"), warn: yellow("!"), error: red("✗"), info: dim("·") };
      out(() => checks.map((ch) => `${icon[ch.status]} ${bold(ch.name)}: ${ch.message}${ch.fix ? `\n    ${dim("fix:")} ${ch.fix}` : ""}`).join("\n"), checks);
      return checks.some((ch) => ch.status === "error") ? 1 : 0;
    },
  },
  {
    name: "agent",
    section: "project",
    usage: [
      "stet agent new <name> [--kind claude-code|codex|other]",
      "                                      create an agent workspace",
      "stet agent list",
      "stet agent refresh <name>             rewrite the agent's instructions, MCP and guard files",
      "stet agent archive <name> [--remove [--force]]",
      "                                      retire an agent (withdraws its pending items); --remove deletes",
      "                                      its folder and branch (--force: even with unsubmitted changes)",
      "stet agent notify <name> [now|batched|off] [--on <kinds>|all]",
      "                                      when a watching agent is woken, and by what: accepted,",
      "                                      rejected, revision, comment, note, document, save",
      "stet agent ping <name> [-m <text>]    wake a watching agent now, whatever its settings",
    ],
    options: ["kind", "path", "remove", "force", "on", "message"],
    project: true,
    reviewer: (args) => args[0] !== "list",
    async run({ args, opt, cwd, stet, self, out }) {
      const [sub, name] = args;
      if (sub === "new") {
        const kind = (opt.kind ?? "other") as AgentKind;
        if (!["claude-code", "codex", "other"].includes(kind)) throw new StetError(`Unknown kind '${kind}'.`);
        if (!(await stet.config()).cli) await Stet.init(cwd, { cli: self });
        const a = await stet.newAgent(need(name, "agent name"), { kind, ...(opt.path ? { path: opt.path } : {}) });
        const launch =
          kind === "codex"
            ? `  cd "${a.worktree}" && codex\n  (or open the folder in the Codex app/IDE; its .codex/config.toml needs the folder to be trusted)`
            : `  Claude desktop app: open the folder "${a.worktree}" in the Code tab\n  Claude Code CLI:    cd "${a.worktree}" && claude`;
        return out(
          () =>
            `Created agent ${bold(a.id)} on branch ${a.branch}.\n` +
            `Workspace: ${bold(a.worktree)}\n\n` +
            `Start the agent in that folder:\n${launch}\n\n` +
            `It gets its instructions and the Stet tools automatically, from files in that folder.\n` +
            `Review with \`stet review\`.`,
          a,
        );
      }
      if (sub === "refresh") {
        if (!(await stet.config()).cli) await Stet.init(cwd, { cli: self });
        const r = await stet.refreshWorkspace(need(name, "agent name"));
        return out(
          () =>
            `Refreshed ${name}: ${r?.written.join(", ")}` +
            (r?.skipped.length ? `\n${yellow("skipped")} (tracked by the project): ${r.skipped.map((s) => s.file).join(", ")}` : ""),
          r,
        );
      }
      if (sub === "list") {
        const agents = await stet.listAgents();
        return out(
          () => (agents.length ? agents.map((a: Agent) => `${bold(a.id)} ${dim(a.state)} ${a.kind}  ${a.worktree}`).join("\n") : "No agents."),
          agents,
        );
      }
      if (sub === "archive") {
        const r = await stet.archiveAgent(need(name, "agent name"), { removeWorktree: !!opt.remove, discardUnsubmitted: !!opt.force });
        return out(
          () =>
            `Archived ${name}.` +
            (r.withdrawn.length ? ` Withdrew ${r.withdrawn.length} pending change(s): ${r.withdrawn.join(", ")}.` : " It had no pending changes.") +
            (r.worktreeRemoved ? " Deleted its folder and branch." : ` Its folder is kept: ${r.agent.worktree}`) +
            "\nIf the agent's session is still open, it is told the workspace was archived on its next action.",
          { archived: name, withdrawn: r.withdrawn, worktreeRemoved: r.worktreeRemoved },
        );
      }
      if (sub === "notify") {
        const id = need(name, "agent name");
        const mode = args[2] as NotifyMode | undefined;
        if (mode) await stet.setNotify(id, mode);
        if (opt.on !== undefined)
          await stet.setNotifyOn(
            id,
            opt.on === "all"
              ? [...NOTIFY_TRIGGERS]
              : (opt.on
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean) as NotifyTrigger[]),
          );
        const a = (await stet.listAgents()).find((x) => x.id === id);
        if (!a) throw notFound(`Unknown agent '${id}'.`);
        const on = notifyTriggers(a);
        return out(
          () =>
            `${bold(id)}: ${NOTIFY_TEXT[notifyMode(a)]}\n  woken by: ${on.length === NOTIFY_TRIGGERS.length ? "everything" : on.length ? on.map((t) => NOTIFY_TRIGGER_TEXT[t].toLowerCase()).join(", ") : dim("nothing")}`,
          { agent: id, notify: notifyMode(a), notifyOn: on },
        );
      }
      if (sub === "ping") {
        await stet.pingAgent(need(name, "agent name"), opt.message);
        return out(() => `Asked ${bold(name!)} to check in now (if it is watching).`, { ok: true });
      }
      throw usageError("Usage: stet agent new|list|refresh|archive|notify|ping <name>");
    },
  },
  {
    name: "setup",
    section: "project",
    usage: ["stet setup claude|codex [--print]     register the Stet MCP server with Claude Code / Codex"],
    options: ["print"],
    async run({ args, opt, self, out, print }) {
      const target = args[0];
      const server = [self.command, ...self.args, "mcp"];
      const envFlags = (flag: string) => Object.entries(self.env ?? {}).flatMap(([k, v]) => [flag, `${k}=${v}`]);
      let tool: string;
      let steps: string[][];
      if (target === "claude") {
        tool = "claude";
        steps = [
          ["mcp", "remove", "--scope", "user", "stet"],
          ["mcp", "add", "--scope", "user", ...envFlags("-e"), "stet", "--", ...server],
        ];
      } else if (target === "codex") {
        tool = "codex";
        steps = [
          ["mcp", "remove", "stet"],
          ["mcp", "add", "stet", ...envFlags("--env"), "--", ...server],
        ];
      } else throw usageError("Usage: stet setup claude|codex [--print]");
      const add = steps[1]!;
      const shown = [tool, ...add].map(winQuote).join(" ");
      if (opt.print) return print(shown);
      runTool(tool, steps[0]!); // fails harmlessly when it wasn't registered yet
      const r = runTool(tool, add);
      if (!r.ok) {
        throw new StetError(
          `Could not run \`${tool}\` (${r.out.split("\n")[0] || "not found"}).\n` +
            `This registration is optional: every agent workspace already contains its MCP config (.mcp.json, .codex/config.toml).\n` +
            `To register globally, run this where the ${tool} CLI is available:\n  ${shown}`,
        );
      }
      return out(
        () =>
          `Registered the Stet MCP server with ${target === "claude" ? "Claude Code (user scope; also used by the desktop app)" : "Codex"}.\n` +
          `It works in every Stet agent workspace and explains itself elsewhere.`,
        { ok: true, output: r.out },
      );
    },
  },
  {
    name: "hooks",
    section: "project",
    usage: ["stet hooks install|uninstall|status   git hooks that block merges/pushes of agent branches"],
    options: ["force"],
    project: true,
    reviewer: true,
    async run({ args, opt, stet, out }) {
      const sub = args[0] ?? "status";
      if (sub === "install") {
        const st = await installHooks(stet.repo, stet.commonDir, await stet.config(), { force: !!opt.force });
        if (st.customHooksPath && !opt.force) throw new StetError(`core.hooksPath is set to ${st.dir} (e.g. husky). Use --force to install there anyway.`);
        return out(() => `Installed ${st.installed.join(", ")} in ${st.dir}.`, st);
      }
      if (sub === "uninstall") {
        await uninstallHooks(stet.repo, stet.commonDir);
        return out(() => "Removed Stet's git hooks (previous hooks restored).", { ok: true });
      }
      const st = await hookStatus(stet.repo, stet.commonDir);
      return out(
        () => `Hooks in ${st.dir}: installed ${st.installed.join(", ") || "none"}${st.missing.length ? `; missing ${st.missing.join(", ")}` : ""}.`,
        st,
      );
    },
  },
  {
    name: "review",
    section: "review",
    usage: ["stet review [--agent <a>] [--status <s>] [--all]", "                                      list items (default: pending)"],
    options: ["agent", "status", "all"],
    project: true,
    async run({ opt, stet, out, print }) {
      const status: ItemStatus[] | undefined = opt.all ? undefined : opt.status ? statusOption(opt.status) : ["pending", "needs_revision"];
      const agent = await agentOption(stet, opt);
      const items = await stet.listItems({ ...(agent ? { agent } : {}), ...(status ? { status } : {}) });
      const groups = await stet.listGroups();
      const changesets = await stet.listChangesets();
      if (opt.json) return out(() => {}, { items, groups: groups.filter((g) => g.items.some((i) => items.some((x) => x.id === i))) });
      const share = await stet.shareStatus().catch(() => null);
      // Only when there are agents to share with (test report UX: it showed before any agent existed).
      const agents = (await stet.listAgents()).filter((a) => a.state === "active");
      const shareHint =
        agents.length && share?.unshared && share.mode === "manual" ? [dim("Agents don't see your latest saved edits yet: `stet share` shares them.")] : [];
      const missing = await stet.missingFromBase().catch(() => []);
      if (missing.length) shareHint.push(yellow(missingText(missing)));
      // Accepted but not committed: easy to forget without a word here (test report UX).
      const uncommitted = await stet.uncommittedAccepted();
      if (uncommitted.length)
        shareHint.push(
          `${uncommitted.length} accepted change${uncommitted.length === 1 ? "" : "s"} not committed yet (${uncommitted.map((i) => i.id).join(", ")}): \`stet commit\` finishes the review.`,
        );
      if (!items.length) {
        const next = !agents.length
          ? "Create a workspace for an agent: `stet agent new <name>`."
          : uncommitted.length
            ? ""
            : "When an agent submits changes, they show here.";
        return print(forTerminal(["Nothing to review.", ...shareHint, ...(next ? [dim(next)] : [])].join("\n")));
      }
      const lines: string[] = [];
      const where = await stet.locateMany(items);
      // Changes no longer found in your file (you edited around them): accepting them fails.
      const lost = items.filter((i) => i.kind === "modify" && isLive(i.status) && !where.get(i.id)?.span);
      for (const cs of changesets) {
        const csItems = items.filter((i) => i.changeset === cs.id);
        if (!csItems.length) continue;
        lines.push(
          `${bold(cs.agent)} › ${bold(`Round ${roundOf(cs.id)}`)} (${cs.id}) ${oneLine(cs.title, 200)}${cs.rationale ? dim(" — " + oneLine(cs.rationale, 60)) : ""}${cs.stetNote ? yellow(` ! ${cs.stetNote}`) : ""}`,
        );
        const shown = new Set<string>();
        for (const g of groups.filter((g) => g.items.some((i) => csItems.some((x) => x.id === i)))) {
          const icon = g.kind === "linked" ? "⛓" : g.kind === "related" ? "≡" : "◆";
          lines.push(
            `  ${icon} ${bold(g.id)} ${g.kind} ${oneLine(g.title, 200)}${g.source === "auto" ? dim(" [auto]") : ""}${g.state === "broken" ? red(" [broken]") : ""}`,
          );
          // Parts of a linked group are accepted one at a time: list them with their own ids.
          const units = g.parts
            ? g.parts.map((p, k) => ({ head: `${bold(partId(g.id, k))} ${oneLine(p.title, 200)}`, items: p.items }))
            : [{ head: "", items: g.items }];
          for (const u of units) {
            const its = csItems.filter((x) => u.items.includes(x.id));
            if (!its.length) continue;
            if (u.head) lines.push(`      ${u.head}`);
            for (const i of its) {
              const line = where.get(i.id)?.line;
              lines.push(`${u.head ? "        " : "      "}${itemSummary(i, line)}`);
              shown.add(i.id);
            }
          }
        }
        for (const i of csItems.filter((x) => !shown.has(x.id))) {
          const line = where.get(i.id)?.line;
          lines.push(`    ${itemSummary(i, line)}`);
        }
      }
      if (lost.length)
        shareHint.push(
          yellow(
            `! Not found in your file any more (you edited there): ${lost.map((i) => i.id).join(", ")}. Accept with your own text (\`stet accept <id> --text …\`), reject, or ask for a revision.`,
          ),
        );
      lines.push(dim("Next: stet show <id> · stet accept <id> · stet reject <id> -m <why>"));
      return print(forTerminal([...lines, ...shareHint].join("\n")));
    },
  },
  {
    name: "show",
    section: "review",
    usage: [
      "stet show <12.3|G3|G3.2|C12|N3> [--full]   show a change (round 12, change 3), group, part of a group, round or note; --full: whole added or deleted files",
    ],
    options: ["full"],
    project: true,
    async run({ args, opt, stet, out }) {
      const ref = parseId(need(args[0], "id"));
      const id = ref.id.toUpperCase();
      if (ref.kind === "note") {
        const n = await stet.getNote(id);
        return out(
          () =>
            [
              noteSummary(n),
              dim(`passage: ${oneLine(n.text, 200)}`),
              ...n.thread.map((t) => `${t.author === "user" ? "you" : n.agent}: ${indented(t.text)}`),
            ].join("\n"),
          n,
        );
      }
      if (ref.kind === "group" || ref.kind === "part") {
        const { group: g, part } = await stet.groupTarget(id);
        const items = (await Promise.all((part ?? g).items.map((i) => stet.getItem(i)))).filter((x): x is Item => !!x);
        if (part)
          return out(
            () => [`${bold(id)} part of ${g.id} (${oneLine(g.title, 200)}): ${oneLine(part.title, 200)}`, ...items.map((i) => itemSummary(i))].join("\n"),
            { group: g, part, items },
          );
        const lines = [
          `${bold(g.id)} ${g.kind} ${oneLine(g.title, 200)} (${g.state})`,
          g.rationale ?? "",
          ...(await stet.partlyDecided(items)).map((w) => yellow("! ") + w),
        ];
        if (g.parts) {
          for (const [k, p] of g.parts.entries())
            lines.push(`${bold(partId(g.id, k))} ${oneLine(p.title, 200)}`, ...items.filter((i) => p.items.includes(i.id)).map((i) => "  " + itemSummary(i)));
        } else lines.push(...items.map((i) => itemSummary(i)));
        return out(() => lines.filter(Boolean).join("\n"), { group: g, items });
      }
      if (ref.kind === "round") {
        const cs = (await stet.listChangesets()).find((x) => x.id === id);
        if (!cs) throw notFound(`Unknown changeset ${id}.`);
        const items = await stet.listItems({ changeset: id });
        return out(
          () =>
            [`${bold(cs.id)} ${oneLine(cs.title, 200)} (${cs.agent}, ${localTime(cs.submittedAt)})`, cs.rationale, ...items.map((i) => itemSummary(i))]
              .filter(Boolean)
              .join("\n"),
          { changeset: cs, items },
        );
      }
      const it = await stet.getItem(id);
      if (!it) throw notFound(`Unknown item ${id}.`);
      const { line } = await stet.locateInWorkingCopy(it);
      // What it revises and the rest of its move, for the description.
      const related = await Promise.all([...(it.supersedes ? [it.supersedes] : []), ...moveOthers(it)].map((r) => stet.getItem(r)));
      const d = describeItem(it, (r) => related.find((x) => x?.id === r) ?? undefined);
      return out(
        () => {
          const lines = [itemSummary(it, line)];
          if (it.note) lines.push(`${dim("note:")} ${it.note}`);
          // A revision: what it revises, and what the reviewer asked for there (test report B4).
          if (d.revises) {
            const prev = d.revises.item;
            lines.push(`${dim("revises:")} ${d.revises.id}${prev ? ` (${prev.status})` : ""}${d.revises.asked ? `, where you asked: ${d.revises.asked}` : ""}`);
            if (prev?.kind === "modify") lines.push(`  ${dim("it proposed:")} ${itemDiff(prev, !!opt.full)}`);
          }
          // The text that went in (accepted with your wording) or would (your wording): test report B11.
          if (d.yours) {
            lines.push(
              `${dim(d.yours.accepted ? "accepted with your wording:" : "your wording (not accepted yet):")} ${itemDiff({ ...it, newText: d.yours.text }, !!opt.full)}`,
            );
            lines.push(`${dim("the agent proposed:")} ${itemDiff(it, !!opt.full)}`);
          }
          if (d.move) {
            lines.push(
              `${dim("move:")} ${d.move.from.join(", ")} remove the text, ${d.move.to.join(", ")} insert it; accepting or rejecting one decides the whole move.`,
            );
            if (d.move.changed && d.move.changes.length) {
              lines.push(yellow(`Changed on the way (${d.move.changed} word(s)):`));
              for (const c of d.move.changes) lines.push(`  ${red(`"${c.was}"`)} → ${green(`"${c.now}"`)}`);
            }
          }
          if (it.groups.length) lines.push(`${dim("groups:")} ${it.groups.join(", ")}`);
          if (it.conflictsWith.length) lines.push(`${yellow("conflicts with:")} ${it.conflictsWith.join(", ")}`);
          if (!d.yours) lines.push("", itemDiff(it, !!opt.full));
          // Without colours, the markers need a word (test report UX).
          if (!colored() && it.kind === "modify") lines.push(dim("([-…-] is removed, {+…+} is added)"));
          if (it.thread.length) lines.push("", ...it.thread.map((t) => `${dim(localTime(t.at))} ${bold(t.author)}: ${indented(t.text)}`));
          return lines.join("\n");
        },
        { ...it, line },
      );
    },
  },
  {
    name: "accept",
    section: "review",
    usage: ["stet accept <12.3|G3|G3.2|C12>... [--force] [--confirm] [--text <t> | --text-file <f>] [--commit | --no-commit]"],
    options: ["force", "confirm", "text", "text-file", "commit", "no-commit"],
    project: true,
    reviewer: true,
    async run({ args, opt, stet, out }) {
      if (!args.length) throw usageError("Usage: stet accept <12.3|G3|C12>...");
      const commit = opt["no-commit"] ? false : opt.commit ? true : undefined;
      const edited: Record<string, string> = {};
      const text = opt["text-file"] ? await readFile(opt["text-file"], "utf8") : opt.text;
      if (text !== undefined) {
        if (args.length !== 1 || isGroupId(args[0]!)) throw new StetError("--text/--text-file needs exactly one item id.");
        edited[args[0]!] = text;
      }
      const ids = args.filter((a) => !isGroupId(a) && !isRoundId(a));
      for (const r of args.filter(isRoundId)) ids.push(...(await roundItems(stet, r)));
      const results: AcceptResult[] = [];
      const confirmEffects = !!opt.confirm;
      for (const g of args.filter(isGroupId)) results.push(await stet.acceptGroup(g, { confirmEffects, ...(commit === undefined ? {} : { commit }) }));
      if (ids.length)
        results.push(await stet.accept(ids, { edited, overrideLinked: !!opt.force, confirmEffects, ...(commit === undefined ? {} : { commit }) }));
      return out(
        () =>
          results
            .map((r) =>
              [
                `${green("Accepted")} ${r.accepted.map((i) => i.id).join(", ")}${r.committed ? dim(` (committed ${r.committed.slice(0, 8)})`) : ""}`,
                ...(r.stale.length ? [`${yellow("Now stale")} (overlapped): ${r.stale.map((i) => i.id).join(", ")}`] : []),
                ...r.warnings.map((w) => yellow("! ") + w),
              ].join("\n"),
            )
            .join("\n"),
        results,
      );
    },
  },
  {
    name: "reject",
    section: "review",
    usage: ["stet reject <12.3|G3|G3.2|C12>... [-m <reason>] [--all | --revise-rest | --only]"],
    options: ["message", "all", "revise-rest", "only"],
    project: true,
    reviewer: true,
    async run({ args, opt, stet, out }) {
      if (!args.length) throw usageError("Usage: stet reject <12.3|G3|C12>... [-m reason]");
      const mode = opt.all ? "all" : opt["revise-rest"] ? "revise-rest" : opt.only ? "only" : undefined;
      let ids: string[] = [];
      for (const a of args) {
        if (isRoundId(a)) ids.push(...(await roundItems(stet, a)));
        else if (!isGroupId(a)) ids.push(a);
        else ids.push(...(await stet.groupTarget(a)).pending);
      }
      ids = [...new Set(ids.map((i) => i.toUpperCase()))];
      try {
        const rejected = await stet.reject(ids, {
          ...(opt.message ? { reason: opt.message } : {}),
          ...(mode ? { mode } : args.some((a) => isGroupId(a) || isRoundId(a)) ? { mode: "all" as const } : {}),
        });
        const warnings = await stet.partlyDecided(rejected);
        return out(() => [`${red("Rejected")} ${rejected.map((i) => i.id).join(", ")}`, ...warnings.map((w) => yellow("! ") + w)].join("\n"), rejected);
      } catch (e) {
        if (e instanceof StetError && e.code === "linked") {
          throw new StetError(e.message + "\n  Use --all, --revise-rest or --only.", { code: "linked" });
        }
        throw e;
      }
    },
  },
  {
    name: "undo",
    section: "review",
    usage: ["stet undo <12.3>                      undo an accept (until committed) or a rejection: pending again"],
    options: [],
    project: true,
    reviewer: true,
    async run({ args, stet, out }) {
      if (!args.length) throw usageError("Usage: stet undo <12.3>");
      const r = await stet.undo(args[0]!);
      return out(
        () =>
          `Undone: ${r.reopened.map((i) => i.id).join(", ")} ${r.reopened.length === 1 ? "is" : "are"} pending again.` +
          (r.restored.length ? ` No longer stale: ${r.restored.map((i) => i.id).join(", ")}.` : ""),
        r,
      );
    },
  },
  {
    name: "preview",
    section: "review",
    usage: [
      "stet preview <12.3> [--page <n> [--before]]",
      "                                      PDF preview: images of the page region before and after the change",
      "                                      (--page: a whole page, with the change or --before it)",
      "stet preview status|setup [--extras]  what previews can use here | build their container image (downloads;",
      "                                      --extras: add TeX's extra fonts to it, about 2 GB)",
    ],
    options: ["page", "before", "extras"],
    project: true,
    async run({ args, opt, stet, out, printError }) {
      const what = need(args[0], "item id, `status` or `setup`");
      if (what === "status") {
        const s = await stet.previewStatus(true);
        return out(() => [`${s.status === "ready" ? green("ready") : yellow(s.status)}: ${s.message}`, ...(s.fix ? [`  ${s.fix}`] : [])].join("\n"), s);
      }
      if (what === "setup") {
        // Downloads packages into a container image: only ever on this explicit command.
        const before = await stet.previewStatus(true);
        printError(
          forTerminal(
            dim(
              opt.extras
                ? "Adding the extra fonts to the preview image (downloads about 2 GB; this takes a while)…"
                : before.toolSource === "image"
                  ? "Building the preview image with its own TeX Live (downloads about 1 GB; this takes a while)…"
                  : "Building the preview image (downloads Debian, Perl and Poppler; TeX comes from your own installation)…",
            ),
          ),
        );
        const r = await stet.setupPreview({ extras: !!opt.extras });
        if (!r.ok) throw new StetError(`Building the preview image failed:\n${r.log.split("\n").slice(-15).join("\n")}`);
        return out(() => `${green("Done.")} ${r.status.message}${r.status.fix ? `\n  ${r.status.fix}` : ""}`, r.status);
      }
      const r = await stet.preview(what);
      // A whole page of the preview (the page viewer's): --page <n>, of the version --before or after.
      if (opt.page !== undefined) {
        if (r.status !== "ready" || !r.pages) throw new StetError(`No page view for ${what.toUpperCase()}: ${"message" in r ? r.message : "it has no pages"}`);
        const n = Number(opt.page);
        const pg = await stet.previewPage(r.pages.base, r.pages.key, opt.before ? "before" : "after", n);
        if (!pg) throw new StetError(`Page ${opt.page} doesn't exist in the ${opt.before ? "version without" : "version with"} the change.`);
        return out(() => `${what.toUpperCase()} ${opt.before ? "before" : "after"}, page ${n}: ${pg.file}`, pg);
      }
      return out(() => {
        switch (r.status) {
          case "ready":
            return [
              `${bold(what.toUpperCase())} page ${r.after.page}`,
              `  before: ${r.before ? r.before.file : dim("(not found in the old version)")}`,
              `  after:  ${r.after.file}`,
            ].join("\n");
          case "failed":
            return `${red(r.message)}${r.missing?.extras ? `\n  ${yellow("Add the extra fonts with `stet preview setup --extras` (downloads about 2 GB).")}` : ""}\n${r.log}`;
          case "unavailable":
            return `${yellow(r.message)}${r.fix ? `\n  ${r.fix}` : ""}`;
          default:
            return dim(r.message);
        }
      }, r);
    },
  },
  {
    name: "revise",
    section: "review",
    usage: ["stet revise <12.3> -m <what to change>"],
    options: ["message"],
    project: true,
    reviewer: true,
    async run({ args, opt, stet, out }) {
      const it = await stet.requestRevision(need(args[0], "item id"), need(opt.message, "-m <what to change>"));
      return out(() => `${yellow("Revision requested")} for ${it.id}.`, it);
    },
  },
  {
    name: "comment",
    section: "review",
    usage: ["stet comment <12.3|N3> -m <text>"],
    options: ["message"],
    project: true,
    reviewer: true,
    async run({ args, opt, stet, out }) {
      if (isNoteId(need(args[0], "item or note id"))) {
        const n = await stet.replyNote(args[0]!, need(opt.message, "-m <text>"), "user");
        return out(() => `Replied on ${n.id}${n.deliveredAt ? "" : " (the agent gets it with the note at its next sync)"}.`, n);
      }
      const it = await stet.comment(need(args[0], "item id"), need(opt.message, "-m <text>"), "user");
      return out(() => `Commented on ${it.id}.`, it);
    },
  },
  {
    name: "commit",
    section: "review",
    usage: ["stet commit [-m <summary>]            commit all accepted changes in one commit (finish the review)"],
    options: ["message"],
    project: true,
    reviewer: true,
    async run({ opt, stet, out }) {
      const r = await stet.commitAcceptedItems(opt.message ? { subject: opt.message } : {});
      return out(
        () =>
          r.commit
            ? `Committed ${r.items.map((i) => i.id).join(", ")} as ${r.commit.slice(0, 7)}.` +
              (r.yourEdits.length ? `\n${yellow("!")} Stet commits whole files: this includes your own edits in ${r.yourEdits.join(", ")}.` : "")
            : "Nothing to commit: all accepted items are committed.",
        r,
      );
    },
  },
  {
    name: "share",
    section: "review",
    usage: ["stet share [manual|saved|committed]   share your saved edits with agents now, or set when agents see them"],
    options: [],
    project: true,
    reviewer: true,
    async run({ args, stet, out }) {
      if (args[0]) {
        const mode = args[0] as ShareMode;
        if (!SHARE_MODES.includes(mode)) throw new StetError(`Unknown mode '${args[0]}' (use ${SHARE_MODES.join(", ")}).`);
        await stet.setShareEdits(mode);
        const what = { manual: "your saved edits when you run `stet share`", saved: "your saved edits", committed: "only committed text" }[mode];
        return out(() => `Agents now see ${what}, plus the changes you accepted.`, { shareEdits: mode });
      }
      const changed = await stet.shareEdits();
      return out(() => (changed ? "Shared your saved edits; agents pick them up at their next sync." : "Nothing new to share."), { changed });
    },
  },
  {
    name: "group",
    section: "review",
    usage: ["stet group <12.1> <12.2>... --kind atomic|linked|related -t <title> [-m <rationale>] [--parts <file.json|->] [--reason <why linked>]"],
    options: ["agent", "kind", "title", "message", "parts", "reason"],
    project: true,
    reviewer: true,
    async run({ args, opt, cwd, stet, out }) {
      const kind = need(opt.kind, "--kind") as GroupKind;
      if (!["atomic", "linked", "related"].includes(kind)) throw new StetError(`Unknown group kind '${kind}'.`);
      const onlyAgent =
        opt.agent ??
        (await stet
          .agentForCwd(cwd)
          .then((a) => a.id)
          .catch(() => null));
      const parts = await readJsonArg<{ title: string; items: string[] }[]>(opt.parts);
      const r = await stet.group(onlyAgent, args, kind, need(opt.title, "-t <title>"), opt.message, parts ?? undefined, opt.reason);
      return out(() => {
        if (r.merged) return `Merged into ${bold(r.merged.id)}.`;
        const g = r.group!;
        return [
          `Created ${bold(g.id)} (${kind}).`,
          ...(g.parts ?? []).map((p, k) => `  part ${bold(partId(g.id, k))} "${p.title}": ${p.items.join(", ")}`),
          ...r.warnings.map((w) => yellow("! ") + w),
        ].join("\n");
      }, r);
    },
  },
  {
    name: "ungroup",
    section: "review",
    usage: ["stet ungroup <G3>"],
    options: [],
    project: true,
    reviewer: true,
    async run({ args, cwd, stet, out }) {
      const onlyAgent = await stet
        .agentForCwd(cwd)
        .then((a) => a.id)
        .catch(() => undefined);
      await stet.ungroup(need(args[0], "group id"), onlyAgent);
      return out(() => `Removed ${args[0]}.`, { removed: args[0] });
    },
  },
  {
    name: "note",
    section: "review",
    usage: [
      "stet note <agent> <file[:line[-line]]> -m <text>",
      "                                      leave a note for one agent on a passage; it arrives at the agent's next sync",
      "stet note resolve <N3>                close a note",
    ],
    options: ["message"],
    project: true,
    reviewer: true,
    async run({ args, opt, stet, out }) {
      if (args[0] === "resolve") {
        const n = await stet.resolveNote(need(args[1], "note id"));
        return out(() => `Resolved ${n.id}.`, n);
      }
      const agent = need(args[0], "agent");
      const where = need(args[1], "file[:line[-line]]");
      const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(where);
      const n = await stet.addNote(
        agent,
        m ? { file: m[1]!, fromLine: Number(m[2]), toLine: Number(m[3] ?? m[2]) } : { file: where, fromLine: 1, toLine: Number.MAX_SAFE_INTEGER },
        need(opt.message, "-m <text>"),
      );
      return out(() => `Left ${bold(n.id)} for ${n.agent}; it arrives at the agent's next sync.`, n);
    },
  },
  {
    name: "notes",
    section: "review",
    usage: ["stet notes [--agent <a>] [--all]      list open notes (--all: resolved ones too)"],
    options: ["agent", "all"],
    project: true,
    async run({ opt, stet, out }) {
      const noteAgent = await agentOption(stet, opt);
      const notes = await stet.listNotes({ ...(noteAgent ? { agent: noteAgent } : {}), ...(opt.all ? {} : { state: "open" as const }) });
      return out(() => (notes.length ? notes.map(noteSummary).join("\n") : "No open notes."), notes);
    },
  },
  {
    name: "status",
    section: "agent",
    usage: ["stet status"],
    options: ["agent"],
    project: true,
    async run({ opt, cwd, stet, out }) {
      const s = await stet.agentStatus(await agentId(stet, opt, cwd));
      return out(
        () =>
          [
            `Agent ${bold(s.agent.id)} (branch ${s.agent.branch})`,
            `Items: ${
              Object.entries(s.counts)
                .map(([k, v]) => `${v} ${k}`)
                .join(", ") || "none"
            }`,
            s.unreadFeedback ? yellow(`${s.unreadFeedback} unread feedback event(s): run \`stet feedback\``) : "No unread feedback.",
            s.syncNeeded ? yellow("The document changed: run `stet sync` before starting new work.") : "Up to date with the document.",
            ...(s.notesWaiting ? [yellow(`${s.notesWaiting} note(s) from the reviewer waiting: run \`stet sync\` to receive them.`)] : []),
            ...(s.missingAccepted.length
              ? [yellow(`Accepted but not in your copy yet: ${s.missingAccepted.join(", ")} (the reviewer is told). Don't propose them again.`)]
              : []),
          ].join("\n"),
        s,
      );
    },
  },
  {
    name: "submit",
    section: "agent",
    usage: ["stet submit -t <title> [-m <rationale>] [--groups <file.json|->] [--notes <file.json>]"],
    options: ["agent", "title", "message", "groups", "notes"],
    project: true,
    async run({ opt, cwd, stet, out }) {
      const id = await agentId(stet, opt, cwd);
      const groups = await readJsonArg<GroupHint[]>(opt.groups);
      const notes = await readJsonArg<NoteHint[]>(opt.notes);
      const r = await stet.submit(id, {
        title: need(opt.title, "-t <title>"),
        ...(opt.message ? { rationale: opt.message } : {}),
        ...(groups ? { groups } : {}),
        ...(notes ? { notes } : {}),
      });
      return out(() => {
        const lines: string[] = [];
        if (r.changeset) lines.push(`Submitted ${bold(r.changeset.id)} "${r.changeset.title}" with ${r.items.length} item(s):`);
        for (const i of r.items) lines.push(`  ${itemSummary(i)}${i.groups.length ? dim(` [${i.groups.join(",")}]`) : ""}`);
        for (const g of r.groups) {
          lines.push(`  group ${bold(g.id)} ${g.kind} "${g.title}"${g.source === "auto" ? dim(" (auto-detected)") : ""}: ${g.items.join(", ")}`);
          for (const [k, p] of (g.parts ?? []).entries()) lines.push(`    part ${bold(partId(g.id, k))} "${p.title}": ${p.items.join(", ")}`);
        }
        if (r.ungrouped.length && r.items.length > 1) lines.push(dim(`  ungrouped: ${r.ungrouped.join(", ")} (use \`stet group\` if some belong together)`));
        if (r.superseded.length) lines.push(`  superseded: ${r.superseded.join(", ")}`);
        if (r.withdrawn.length) lines.push(`  withdrawn (change removed): ${r.withdrawn.join(", ")}`);
        if (r.repeats.length) lines.push(red(`  auto-rejected as repeats of earlier rejections: ${r.repeats.join(", ")}`));
        for (const w of r.warnings) lines.push(yellow("! ") + w);
        if (r.sync) lines.push(`Synced onto the latest document${r.sync.stale.length ? `; stale: ${r.sync.stale.map((s) => s.id).join(", ")}` : ""}.`);
        return lines.join("\n");
      }, r);
    },
  },
  {
    name: "sync",
    section: "agent",
    usage: ["stet sync"],
    options: ["agent"],
    project: true,
    async run({ opt, cwd, stet, out }) {
      const r = await stet.sync(await agentId(stet, opt, cwd));
      return out(
        () =>
          [
            `Synced onto ${r.base.slice(0, 8)}: ${r.kept} pending item(s) kept${r.stale.length ? `, stale: ${r.stale.map((s) => s.id).join(", ")}` : ""}.`,
            ...r.notes.map((d) => describeNote(d, noteReply)),
          ].join("\n"),
        r,
      );
    },
  },
  {
    name: "feedback",
    section: "agent",
    usage: ["stet feedback [--peek]"],
    options: ["agent", "peek"],
    project: true,
    async run({ opt, cwd, stet, out }) {
      const ev = await stet.feedback(await agentId(stet, opt, cwd), { ack: !opt.peek });
      return out(() => (ev.length ? ev.map(describeEvent).join("\n") : "No new feedback."), ev);
    },
  },
  {
    name: "list",
    section: "agent",
    usage: ["stet list [--status <s>]"],
    options: ["agent", "status"],
    project: true,
    async run({ opt, cwd, stet, out }) {
      const id = await agentId(stet, opt, cwd);
      const items = await stet.listItems({ agent: id, ...(opt.status ? { status: statusOption(opt.status) } : {}) });
      return out(() => (items.length ? items.map((i) => itemSummary(i)).join("\n") : "No items."), items);
    },
  },
  {
    name: "reply",
    section: "agent",
    usage: ["stet reply <12.3|N3> -m <text>"],
    options: ["agent", "message"],
    project: true,
    async run({ args, opt, cwd, stet, out }) {
      const id = await agentId(stet, opt, cwd);
      if (isNoteId(need(args[0], "item or note id"))) {
        const n = await stet.getNote(args[0]!);
        if (n.agent !== id || !n.deliveredAt) throw notFound(`Unknown note ${args[0]}.`);
        await stet.replyNote(n.id, need(opt.message, "-m <text>"), "agent");
        return out(() => `Replied on ${n.id}.`, { ok: true });
      }
      const it = await stet.getItem(need(args[0], "item id").toUpperCase());
      if (it && it.agent !== id) throw new StetError(`${it.id} belongs to ${it.agent}.`);
      await stet.comment(args[0]!, need(opt.message, "-m <text>"), "agent");
      return out(() => `Replied on ${args[0]}.`, { ok: true });
    },
  },
  {
    name: "withdraw",
    section: "agent",
    usage: ["stet withdraw <12.3>... [-m <reason>]"],
    options: ["agent", "message"],
    project: true,
    async run({ args, opt, cwd, stet, out }) {
      const w = await stet.withdraw(await agentId(stet, opt, cwd), args, opt.message);
      return out(() => `Withdrawn: ${w.map((i) => i.id).join(", ")}`, w);
    },
  },
  {
    name: "watch",
    section: "agent",
    usage: [
      "stet watch [--once]                   wait for the reviewer: print a line whenever something arrives",
      "                                      (feedback, a note, a sync needed); --once exits after the first",
    ],
    options: ["once"],
    // Agent side, and read-only: it runs inside the agent's sandbox, where Stet's store is read-only.
    async run({ opt, cwd, print }) {
      return watch(cwd, opt, print);
    },
  },
  {
    name: "mcp",
    section: "internal",
    usage: ["stet mcp                              MCP server over stdio"],
    options: [],
    async run({ cwd }) {
      const server = new StetMcpServer({
        cwd,
        version: VERSION,
        ...(process.env.STET_WORKSPACE ? { workspace: process.env.STET_WORKSPACE } : {}),
        ...(process.env.STET_AGENT ? { agentId: process.env.STET_AGENT } : {}),
        ...(process.env.STET_PROJECT ? { project: process.env.STET_PROJECT } : {}),
      });
      return serveStdio(server, process.stdin, process.stdout);
    },
  },
  {
    name: "guard",
    section: "internal",
    usage: ["stet guard                            Claude Code PreToolUse hook"],
    options: [],
    async run(_ctx) {
      return guard();
    },
  },
];
