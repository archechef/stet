#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import {
  archivedMessage,
  checkToolUse,
  describeFeedback,
  oneLine,
  moveChanges,
  moveFrom,
  moveTexts,
  moveTo,
  movesOut,
  doctor,
  hookStatus,
  installHooks,
  Repo,
  serveStdio,
  StetMcpServer,
  uninstallHooks,
  type CliCommand,
  Stet,
  StetError,
  SHARE_MODES,
  roundOf,
  partId,
  type ShareMode,
  type AcceptResult,
  type Agent,
  type AgentKind,
  type GroupHint,
  type GroupKind,
  type Item,
  type ItemStatus,
  type NoteHint,
  type NotifyMode,
  type NotifyTrigger,
  notifyMode,
  notifyTriggers,
  NOTIFY_TRIGGERS,
  NOTIFY_TRIGGER_TEXT,
  type StetEvent,
  describeNote,
  printable,
  findInbox,
  followInbox,
  isNoteId,
  type Note,
} from "@stet/core";

const HELP = `stet — review AI-proposed changes to LaTeX projects

Project (run in your project folder):
  stet init [--main <branch>]           set up Stet in this repository
  stet doctor                           check your setup
  stet agent new <name> [--kind claude-code|codex|other]
                                        create an agent workspace
  stet agent list
  stet agent refresh <name>             rewrite the agent's instructions, MCP and guard files
  stet agent archive <name> [--remove]  retire an agent (withdraws its pending items)
  stet agent notify <name> [now|batched|off] [--on <kinds>|all]
                                        when a watching agent is woken, and by what: accepted,
                                        rejected, revision, comment, note, document, save
  stet agent ping <name> [-m <text>]    wake a watching agent now, whatever its settings
  stet setup claude|codex [--print]     register the Stet MCP server with Claude Code / Codex
  stet hooks install|uninstall|status   git hooks that block merges/pushes of agent branches

Review:
  stet review [--agent <a>] [--status <s>] [--all]
                                        list items (default: pending)
  stet show <12.3|G3|G3.2|C12|N3>       show a change (round 12, change 3), group, part of a group, round or note
  stet accept <12.3|G3|G3.2>... [--force] [--text <t> | --text-file <f>] [--commit | --no-commit]
  stet reject <12.3|G3|G3.2>... [-m <reason>] [--all | --revise-rest | --only]
  stet undo <12.3>                      undo an accept (until committed) or a rejection: pending again
  stet preview <12.3> [--page <n> [--before]]
                                        PDF preview: images of the page region before and after the change
                                        (--page: a whole page, with the change or --before it)
  stet preview status|setup [--extras]  what previews can use here | build their container image (downloads;
                                        --extras: add TeX's extra fonts to it, about 2 GB)
  stet revise <12.3> -m <what to change>
  stet comment <12.3|N3> -m <text>
  stet commit [-m <summary>]            commit all accepted changes in one commit (finish the review)
  stet share [manual|saved|committed]   share your saved edits with agents now, or set when agents see them
  stet group <12.1> <12.2>... --kind atomic|linked|related -t <title> [-m <rationale>] [--parts <file.json|->]
  stet ungroup <G3>
  stet note <agent> <file[:line[-line]]> -m <text>
                                        leave a note for one agent on a passage; it arrives at the agent's next sync
  stet note resolve <N3>                close a note
  stet notes [--agent <a>] [--all]      list open notes (--all: resolved ones too)

Agent side (run inside an agent workspace, or pass --agent <name>):
  stet status
  stet submit -t <title> [-m <rationale>] [--groups <file.json|->] [--notes <file.json>]
  stet sync
  stet feedback [--peek]
  stet list [--status <s>]
  stet reply <12.3|N3> -m <text>
  stet withdraw <12.3>... [-m <reason>]
  stet watch [--once]                   wait for the reviewer: print a line whenever something arrives
                                        (feedback, a note, a sync needed); --once exits after the first

Internal (called by agents' tools):
  stet mcp                              MCP server over stdio
  stet guard                            Claude Code PreToolUse hook

Global: --json for machine-readable output, --help.`;

const { values: opt, positionals: pos } = parseArgs({
  allowPositionals: true,
  strict: true,
  options: {
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    main: { type: "string" },
    kind: { type: "string" },
    path: { type: "string" },
    remove: { type: "boolean" },
    agent: { type: "string" },
    status: { type: "string" },
    all: { type: "boolean" },
    force: { type: "boolean" },
    text: { type: "string" },
    "text-file": { type: "string" },
    "no-commit": { type: "boolean" },
    commit: { type: "boolean" },
    message: { type: "string", short: "m" },
    title: { type: "string", short: "t" },
    "revise-rest": { type: "boolean" },
    only: { type: "boolean" },
    groups: { type: "string" },
    parts: { type: "string" },
    notes: { type: "string" },
    peek: { type: "boolean" },
    once: { type: "boolean" },
    on: { type: "string" },
    extras: { type: "boolean" },
    page: { type: "string" },
    before: { type: "boolean" },
    print: { type: "boolean" },
  },
});

// ---------------------------------------------------------------------------
// Output helpers

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c("31"), green = c("32"), yellow = c("33"), dim = c("2"), bold = c("1"), cyan = c("36");

/**
 * Text for the terminal: Stet's own colour codes stay, every other control character goes (agent
 * text could otherwise carry escape sequences that rewrite or hide what the reviewer sees).
 */
const OWN_SGR = /\x1b\[(?:0|1|2|31|32|33|36)m/g;
export function forTerminal(s: string): string {
  const keep: string[] = [];
  const marked = s.replace(OWN_SGR, (m) => `\u0000${keep.push(m) - 1}\u0000`);
  return printable(marked.replace(/\u0000(\d+)\u0000/g, "\uE000$1\uE001")).replace(/\uE000(\d+)\uE001/g, (_, k) => keep[Number(k)]!);
}

function out(human: () => string | void, data: unknown) {
  if (opt.json) console.log(JSON.stringify(data, null, 2));
  else {
    const s = human();
    if (s) console.log(forTerminal(s));
  }
}

const statusColor = (s: ItemStatus) =>
  s === "accepted" ? green(s) : s === "rejected" || s === "stale" ? red(s) : s === "needs_revision" ? yellow(s) : s === "pending" ? cyan(s) : dim(s);

function itemSummary(it: Item, line?: number): string {
  const where = `${it.file}${line ? `:${line}` : ""}`;
  if (it.kind !== "modify") return `${bold(it.id)} ${statusColor(it.status)} ${it.kind} ${where}${it.oldFile ? ` (from ${it.oldFile})` : ""}`;
  if (it.move) {
    // Half of a move (spec §6.4.7): decided with its other half.
    const how = it.move.changed ? yellow(`${it.move.changed} word(s) changed on the way`) : "word for word";
    const move = movesOut(it)
      ? `${red(`moved out: "${oneLine(it.oldText, 40)}"`)} ${dim(`→ ${moveTo(it.move).join(", ")}`)}`
      : `${green(`moved in: "${oneLine(it.newText, 40)}"`)} ${dim(`← ${moveFrom(it.move).join(", ")},`)} ${how}`;
    return `${bold(it.id)} ${statusColor(it.status)} ${dim(where)}  ${move}`;
  }
  const change = !it.oldText ? green(`+ "${oneLine(it.newText, 50)}"`) : !it.newText ? red(`- "${oneLine(it.oldText, 50)}"`) : `${red(`"${oneLine(it.oldText, 30)}"`)} → ${green(`"${oneLine(it.newText, 30)}"`)}`;
  return `${bold(it.id)} ${statusColor(it.status)} ${dim(where)}  ${change}`;
}

function itemDiff(it: Item): string {
  if (it.kind === "binary") return dim("(binary file)");
  if (it.kind !== "modify") {
    const lines: string[] = [];
    if (it.oldText) lines.push(...it.oldText.split("\n").slice(0, 40).map((l) => red("- " + l)));
    if (it.newText) lines.push(...it.newText.split("\n").slice(0, 40).map((l) => green("+ " + l)));
    return lines.join("\n");
  }
  // Context up to the line boundary, without a cut-off partial word.
  const before = (it.context.before.split("\n").pop() ?? "").replace(/^\S*\s/, "…");
  const after = (it.context.after.split("\n")[0] ?? "").replace(/\s\S*$/, "…");
  const del = it.oldText ? (color ? `\x1b[31;9m${it.oldText}\x1b[0m` : `[-${it.oldText}-]`) : "";
  const ins = it.newText ? (color ? `\x1b[32;4m${it.newText}\x1b[0m` : `{+${it.newText}+}`) : "";
  return dim(before) + del + ins + dim(after);
}

// ---------------------------------------------------------------------------

async function readJsonArg<T>(arg: string | undefined): Promise<T | undefined> {
  if (!arg) return undefined;
  if (arg.trim().startsWith("[") || arg.trim().startsWith("{")) return JSON.parse(arg) as T;
  const raw = arg === "-" ? await readAll(process.stdin) : await readFile(arg, "utf8");
  return JSON.parse(raw) as T;
}

async function agentId(stet: Stet): Promise<string> {
  if (opt.agent) return opt.agent;
  return (await stet.agentForCwd(process.cwd())).id;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new StetError(`Missing ${what}.`);
  return v;
}

/** A group (G3) or a part of one (G3.2). */
const isGroupId = (s: string) => /^G\d+(\.\d+)?$/i.test(s);

/** How other tools should invoke this CLI: absolute node + script paths. */
const SELF: CliCommand = {
  command: process.execPath,
  args: [fileURLToPath(import.meta.url)],
  // Running on VS Code's own runtime (bundled with the extension): keep it in Node mode.
  ...(process.env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
};
const VERSION = "0.11.1";

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
async function guard(): Promise<void> {
  let input: any;
  try {
    input = JSON.parse(await readAll(process.stdin));
  } catch {
    return; // not a hook invocation we understand: allow
  }
  const cwd: string = input.cwd ?? process.cwd();
  const block = (reason: string) => {
    process.stderr.write(reason + "\n");
    process.exitCode = 2;
  };
  // An archived workspace: say so clearly (also when its folder is gone), and stop further work.
  const project = process.env.STET_PROJECT;
  const agentId = process.env.STET_AGENT;
  if (project && agentId) {
    try {
      const agent = await (await Stet.open(project)).store.getAgent(agentId);
      if (agent?.state === "archived") return block(archivedMessage(agent));
    } catch {
      /* fall through to the normal checks */
    }
    if (!existsSync(cwd)) return block(`Stet: this workspace folder (${cwd}) no longer exists. Stop working here and ask the user for a new agent workspace.`);
  }
  try {
    const { toplevel, mainPath, commonDir } = await Stet.locate(cwd);
    const stet = await Stet.open(cwd);
    const cfg = await stet.config();
    const branch = await new Repo(toplevel).tryRun(["symbolic-ref", "--short", "HEAD"]);
    if (!branch?.startsWith(cfg.agentBranchPrefix)) return; // not an agent workspace
    const reason = checkToolUse(input, { worktree: toplevel, mainPath, commonDir, ...(cfg.cli ? { cli: cfg.cli } : {}) });
    if (reason) block(reason);
  } catch (e: any) {
    // Never block on internal errors, but say so (non-blocking hook error).
    process.stderr.write(`stet guard: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  }
}

/** `stet watch`: follow the workspace's inbox, which the Stet MCP server writes. */
async function watch(cwd: string): Promise<void> {
  const inbox = await findInbox(cwd);
  if (!inbox) throw new StetError("Run `stet watch` inside an agent workspace.");
  if (!existsSync(inbox)) {
    process.stderr.write(`stet watch: ${inbox} does not exist yet. Lines are written while the agent's Stet tools (MCP server) are connected.\n`);
  }
  for await (const line of followInbox(inbox, { once: !!opt.once })) {
    console.log(opt.json ? JSON.stringify(line) : `${line.key}: ${line.text}`);
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

/** Feedback as the agents see it, with colored labels and the CLI's reply command. */
const describeEvent = (e: StetEvent) =>
  describeFeedback(e, {
    label: (t, tone) => ({ good: green, bad: red, warn: yellow, info: cyan })[tone](t.toLowerCase()),
    reply: (id) => `stet reply ${id} -m "..."`,
  });

const noteReply = (id: string) => `stet reply ${id} -m "..."`;

const NOTIFY_TEXT: Record<NotifyMode, string> = {
  now: "notified right away (a watching agent wakes at each decision)",
  batched: "notified when you pause (a watching agent wakes once you have stopped for a while)",
  off: "not notified (it hears about your decisions when it next checks)",
};

const missingText = (missing: { item: Item; reason: string }[]) =>
  `! Agents don't get ${missing.length === 1 ? "this accepted change" : "these accepted changes"}: ` +
  missing.map((m) => `${m.item.id} (${m.reason})`).join(", ") +
  ". Finish the review (`stet commit`) or share your edits (`stet share`) to pass them on.";

function noteSummary(n: Note): string {
  const tag = n.state === "resolved" ? dim(" [resolved]") : n.deliveredAt ? "" : dim(" [not delivered yet]");
  return `${bold(n.id)} for ${n.agent} on ${n.file}${tag}: ${oneLine(n.body, 80)}${n.thread.length ? dim(` (${n.thread.length} repl${n.thread.length === 1 ? "y" : "ies"})`) : ""}`;
}

// ---------------------------------------------------------------------------
// Commands

async function main() {
  const [cmd, ...args] = pos;
  if (!cmd || opt.help || cmd === "help") return console.log(HELP);
  const cwd = process.cwd();

  if (cmd === "doctor") {
    const checks = await doctor(cwd);
    const icon = { ok: green("✓"), warn: yellow("!"), error: red("✗"), info: dim("·") };
    out(
      () =>
        checks
          .map((ch) => `${icon[ch.status]} ${bold(ch.name)}: ${ch.message}${ch.fix ? `\n    ${dim("fix:")} ${ch.fix}` : ""}`)
          .join("\n"),
      checks,
    );
    if (checks.some((ch) => ch.status === "error")) process.exitCode = 1;
    return;
  }

  if (cmd === "guard") return guard();

  // Agent side, and read-only: it runs inside the agent's sandbox, where Stet's store is read-only.
  if (cmd === "watch") return watch(cwd);

  if (cmd === "mcp") {
    const server = new StetMcpServer({
      cwd,
      version: VERSION,
      ...(process.env.STET_WORKSPACE ? { workspace: process.env.STET_WORKSPACE } : {}),
      ...(process.env.STET_AGENT ? { agentId: process.env.STET_AGENT } : {}),
      ...(process.env.STET_PROJECT ? { project: process.env.STET_PROJECT } : {}),
    });
    return serveStdio(server, process.stdin, process.stdout);
  }

  if (cmd === "setup") {
    const target = args[0];
    const server = [SELF.command, ...SELF.args, "mcp"];
    const envFlags = (flag: string) => Object.entries(SELF.env ?? {}).flatMap(([k, v]) => [flag, `${k}=${v}`]);
    let tool: string;
    let steps: string[][];
    if (target === "claude") {
      tool = "claude";
      steps = [["mcp", "remove", "--scope", "user", "stet"], ["mcp", "add", "--scope", "user", ...envFlags("-e"), "stet", "--", ...server]];
    } else if (target === "codex") {
      tool = "codex";
      steps = [["mcp", "remove", "stet"], ["mcp", "add", "stet", ...envFlags("--env"), "--", ...server]];
    } else throw new StetError("Usage: stet setup claude|codex [--print]");
    const add = steps[1]!;
    const shown = [tool, ...add].map(winQuote).join(" ");
    if (opt.print) return console.log(shown);
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
  }

  if (cmd === "init") {
    const stet = await Stet.init(cwd, { ...(opt.main ? { mainBranch: opt.main } : {}), cli: SELF });
    const cfg = await stet.config();
    const hooks = await hookStatus(stet.repo, stet.commonDir);
    return out(
      () =>
        `Stet is set up for ${stet.mainPath} (main branch '${cfg.mainBranch}').\n` +
        (hooks.missing.length
          ? yellow(`! Git guard hooks not installed (${hooks.customHooksPath ? `core.hooksPath is ${hooks.dir}` : "disabled"}). See \`stet hooks install\`.`) + "\n"
          : `Git guard hooks installed in ${hooks.dir}.\n`) +
        `Next: stet agent new <name>, and once per machine: stet setup claude (and/or stet setup codex)`,
      { mainPath: stet.mainPath, mainBranch: cfg.mainBranch, hooks },
    );
  }

  const stet = await Stet.open(cwd);

  switch (cmd) {
    case "agent": {
      const [sub, name] = args;
      if (sub === "new") {
        const kind = (opt.kind ?? "other") as AgentKind;
        if (!["claude-code", "codex", "other"].includes(kind)) throw new StetError(`Unknown kind '${kind}'.`);
        if (!(await stet.config()).cli) await Stet.init(cwd, { cli: SELF });
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
            `It gets its instructions and the Stet tools automatically (run \`stet setup ${kind === "codex" ? "codex" : "claude"}\` once per machine).\n` +
            `Review with \`stet review\`.`,
          a,
        );
      }
      if (sub === "refresh") {
        if (!(await stet.config()).cli) await Stet.init(cwd, { cli: SELF });
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
        return out(() => (agents.length ? agents.map((a: Agent) => `${bold(a.id)} ${dim(a.state)} ${a.kind}  ${a.worktree}`).join("\n") : "No agents."), agents);
      }
      if (sub === "archive") {
        const r = await stet.archiveAgent(need(name, "agent name"), { removeWorktree: !!opt.remove });
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
        if (opt.on !== undefined) await stet.setNotifyOn(id, opt.on === "all" ? [...NOTIFY_TRIGGERS] : (opt.on.split(",").map((s) => s.trim()).filter(Boolean) as NotifyTrigger[]));
        const a = (await stet.listAgents()).find((x) => x.id === id);
        if (!a) throw new StetError(`Unknown agent '${id}'.`);
        const on = notifyTriggers(a);
        return out(
          () => `${bold(id)}: ${NOTIFY_TEXT[notifyMode(a)]}\n  woken by: ${on.length === NOTIFY_TRIGGERS.length ? "everything" : on.length ? on.map((t) => NOTIFY_TRIGGER_TEXT[t].toLowerCase()).join(", ") : dim("nothing")}`,
          { agent: id, notify: notifyMode(a), notifyOn: on },
        );
      }
      if (sub === "ping") {
        await stet.pingAgent(need(name, "agent name"), opt.message);
        return out(() => `Asked ${bold(name!)} to check in now (if it is watching).`, { ok: true });
      }
      throw new StetError("Usage: stet agent new|list|refresh|archive|notify|ping <name>");
    }

    case "hooks": {
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
      return out(() => `Hooks in ${st.dir}: installed ${st.installed.join(", ") || "none"}${st.missing.length ? `; missing ${st.missing.join(", ")}` : ""}.`, st);
    }

    case "review": {
      const status: ItemStatus[] | undefined = opt.all ? undefined : opt.status ? (opt.status.split(",") as ItemStatus[]) : ["pending", "needs_revision"];
      const items = await stet.listItems({ ...(opt.agent ? { agent: opt.agent } : {}), ...(status ? { status } : {}) });
      const groups = await stet.listGroups();
      const changesets = await stet.listChangesets();
      if (opt.json) return out(() => {}, { items, groups: groups.filter((g) => g.items.some((i) => items.some((x) => x.id === i))) });
      const share = await stet.shareStatus().catch(() => null);
      const shareHint = share?.unshared && share.mode === "manual" ? [dim("Agents don't see your latest saved edits yet: `stet share` shares them.")] : [];
      const missing = await stet.missingFromBase().catch(() => []);
      if (missing.length) shareHint.push(yellow(missingText(missing)));
      if (!items.length) return console.log(forTerminal(["Nothing to review.", ...shareHint].join("\n")));
      const lines: string[] = [];
      for (const cs of changesets) {
        const csItems = items.filter((i) => i.changeset === cs.id);
        if (!csItems.length) continue;
        lines.push(`${bold(cs.agent)} › ${bold(`Round ${roundOf(cs.id)}`)} (${cs.id}) ${cs.title}${cs.rationale ? dim(" — " + oneLine(cs.rationale, 60)) : ""}`);
        const shown = new Set<string>();
        for (const g of groups.filter((g) => g.items.some((i) => csItems.some((x) => x.id === i)))) {
          const icon = g.kind === "linked" ? "⛓" : g.kind === "related" ? "≡" : "◆";
          lines.push(`  ${icon} ${bold(g.id)} ${g.kind} ${g.title}${g.source === "auto" ? dim(" [auto]") : ""}${g.state === "broken" ? red(" [broken]") : ""}`);
          // Parts of a linked group are accepted one at a time: list them with their own ids.
          const units = g.parts ? g.parts.map((p, k) => ({ head: `${bold(partId(g.id, k))} ${p.title}`, items: p.items })) : [{ head: "", items: g.items }];
          for (const u of units) {
            const its = csItems.filter((x) => u.items.includes(x.id));
            if (!its.length) continue;
            if (u.head) lines.push(`      ${u.head}`);
            for (const i of its) {
              const { line } = await stet.locateInWorkingCopy(i);
              lines.push(`${u.head ? "        " : "      "}${itemSummary(i, line)}`);
              shown.add(i.id);
            }
          }
        }
        for (const i of csItems.filter((x) => !shown.has(x.id))) {
          const { line } = await stet.locateInWorkingCopy(i);
          lines.push(`    ${itemSummary(i, line)}`);
        }
      }
      return console.log(forTerminal([...lines, ...shareHint].join("\n")));
    }

    case "show": {
      const id = need(args[0], "id").toUpperCase();
      if (isNoteId(id)) {
        const n = await stet.getNote(id);
        return out(
          () =>
            [
              noteSummary(n),
              dim(`passage: ${oneLine(n.text, 200)}`),
              ...n.thread.map((t) => `${t.author === "user" ? "you" : n.agent}: ${t.text}`),
            ].join("\n"),
          n,
        );
      }
      if (id.startsWith("G")) {
        const { group: g, part } = await stet.groupTarget(id);
        const items = (await Promise.all((part ?? g).items.map((i) => stet.getItem(i)))).filter((x): x is Item => !!x);
        if (part) return out(() => [`${bold(id)} part of ${g.id} (${g.title}): ${part.title}`, ...items.map((i) => itemSummary(i))].join("\n"), { group: g, part, items });
        const lines = [`${bold(g.id)} ${g.kind} ${g.title} (${g.state})`, g.rationale ?? ""];
        if (g.parts) {
          for (const [k, p] of g.parts.entries()) lines.push(`${bold(partId(g.id, k))} ${p.title}`, ...items.filter((i) => p.items.includes(i.id)).map((i) => "  " + itemSummary(i)));
        } else lines.push(...items.map((i) => itemSummary(i)));
        return out(() => lines.filter(Boolean).join("\n"), { group: g, items });
      }
      if (id.startsWith("C")) {
        const cs = (await stet.listChangesets()).find((x) => x.id === id);
        if (!cs) throw new StetError(`Unknown changeset ${id}.`);
        const items = await stet.listItems({ changeset: id });
        return out(() => [`${bold(cs.id)} ${cs.title} (${cs.agent}, ${cs.submittedAt})`, cs.rationale, ...items.map((i) => itemSummary(i))].filter(Boolean).join("\n"), { changeset: cs, items });
      }
      const it = await stet.getItem(id);
      if (!it) throw new StetError(`Unknown item ${id}.`);
      const { line } = await stet.locateInWorkingCopy(it);
      const moveItems = it.move ? await Promise.all([...moveFrom(it.move), ...moveTo(it.move)].map((id) => stet.getItem(id))) : [];
      const moved = it.move ? moveTexts(it.move, (id) => moveItems.find((m) => m?.id === id) ?? undefined) : null;
      return out(() => {
        const lines = [itemSummary(it, line)];
        if (it.note) lines.push(`${dim("note:")} ${it.note}`);
        if (it.move) {
          lines.push(`${dim("move:")} ${moveFrom(it.move).join(", ")} remove the text, ${moveTo(it.move).join(", ")} insert it; accepting or rejecting one decides the whole move.`);
          if (it.move.changed && moved) {
            lines.push(yellow(`Changed on the way (${it.move.changed} word(s)):`));
            for (const c of moveChanges(moved.from, moved.to)) lines.push(`  ${red(`"${c.was}"`)} → ${green(`"${c.now}"`)}`);
          }
        }
        if (it.groups.length) lines.push(`${dim("groups:")} ${it.groups.join(", ")}`);
        if (it.conflictsWith.length) lines.push(`${yellow("conflicts with:")} ${it.conflictsWith.join(", ")}`);
        lines.push("", itemDiff(it));
        if (it.thread.length) lines.push("", ...it.thread.map((t) => `${dim(t.at.slice(0, 16).replace("T", " "))} ${bold(t.author)}: ${t.text}`));
        return lines.join("\n");
      }, { ...it, line });
    }

    case "accept": {
      if (!args.length) throw new StetError("Usage: stet accept <12.3|G3>...");
      const commit = opt["no-commit"] ? false : opt.commit ? true : undefined;
      const edited: Record<string, string> = {};
      const text = opt["text-file"] ? await readFile(opt["text-file"], "utf8") : opt.text;
      if (text !== undefined) {
        if (args.length !== 1 || isGroupId(args[0]!)) throw new StetError("--text/--text-file needs exactly one item id.");
        edited[args[0]!] = text;
      }
      let ids = args.filter((a) => !isGroupId(a));
      const results: AcceptResult[] = [];
      for (const g of args.filter(isGroupId)) results.push(await stet.acceptGroup(g, commit === undefined ? {} : { commit }));
      if (ids.length) results.push(await stet.accept(ids, { edited, overrideLinked: !!opt.force, ...(commit === undefined ? {} : { commit }) }));
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
    }

    case "reject": {
      if (!args.length) throw new StetError("Usage: stet reject <12.3|G3>... [-m reason]");
      const mode = opt.all ? "all" : opt["revise-rest"] ? "revise-rest" : opt.only ? "only" : undefined;
      let ids: string[] = [];
      for (const a of args) {
        if (!isGroupId(a)) ids.push(a);
        else ids.push(...(await stet.groupTarget(a)).pending);
      }
      ids = [...new Set(ids.map((i) => i.toUpperCase()))];
      try {
        const rejected = await stet.reject(ids, { ...(opt.message ? { reason: opt.message } : {}), ...(mode ? { mode } : args.some(isGroupId) ? { mode: "all" as const } : {}) });
        return out(() => `${red("Rejected")} ${rejected.map((i) => i.id).join(", ")}`, rejected);
      } catch (e) {
        if (e instanceof StetError && /is linked with/.test(e.message)) {
          throw new StetError(e.message + "\n  Use --all, --revise-rest or --only.");
        }
        throw e;
      }
    }

    case "preview": {
      const what = need(args[0], "item id, `status` or `setup`");
      if (what === "status") {
        const s = await stet.previewStatus(true);
        return out(() => [`${s.status === "ready" ? green("ready") : yellow(s.status)}: ${s.message}`, ...(s.fix ? [`  ${s.fix}`] : [])].join("\n"), s);
      }
      if (what === "setup") {
        // Downloads packages into a container image: only ever on this explicit command.
        const before = await stet.previewStatus(true);
        console.error(
          dim(
            opt.extras
              ? "Adding the extra fonts to the preview image (downloads about 2 GB; this takes a while)…"
              : before.texSource === "image"
                ? "Building the preview image with its own TeX Live (downloads about 1 GB; this takes a while)…"
                : "Building the preview image (downloads Debian, Perl and Poppler; TeX comes from your own installation)…",
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
            return [`${bold(what.toUpperCase())} page ${r.after.page}`, `  before: ${r.before ? r.before.file : dim("(not found in the old version)")}`, `  after:  ${r.after.file}`].join("\n");
          case "failed":
            return `${red(r.message)}${r.missing?.extras ? `\n  ${yellow("Add the extra fonts with `stet preview setup --extras` (downloads about 2 GB).")}` : ""}\n${r.log}`;
          case "unavailable":
            return `${yellow(r.message)}${r.fix ? `\n  ${r.fix}` : ""}`;
          default:
            return dim(r.message);
        }
      }, r);
    }

    case "undo": {
      if (!args.length) throw new StetError("Usage: stet undo <12.3>");
      const r = await stet.undo(args[0]!);
      return out(
        () =>
          `Undone: ${r.reopened.map((i) => i.id).join(", ")} ${r.reopened.length === 1 ? "is" : "are"} pending again.` +
          (r.restored.length ? ` No longer stale: ${r.restored.map((i) => i.id).join(", ")}.` : ""),
        r,
      );
    }

    case "revise": {
      const it = await stet.requestRevision(need(args[0], "item id"), need(opt.message, "-m <what to change>"));
      return out(() => `${yellow("Revision requested")} for ${it.id}.`, it);
    }

    case "commit": {
      const r = await stet.commitAcceptedItems(opt.message ? { subject: opt.message } : {});
      return out(
        () => (r.commit ? `Committed ${r.items.map((i) => i.id).join(", ")} as ${r.commit.slice(0, 7)}.` : "Nothing to commit: all accepted items are committed."),
        r,
      );
    }

    case "share": {
      if (args[0]) {
        const mode = args[0] as ShareMode;
        if (!SHARE_MODES.includes(mode)) throw new StetError(`Unknown mode '${args[0]}' (use ${SHARE_MODES.join(", ")}).`);
        await stet.setShareEdits(mode);
        const what = { manual: "your saved edits when you run `stet share`", saved: "your saved edits", committed: "only committed text" }[mode];
        return out(() => `Agents now see ${what}, plus the changes you accepted.`, { shareEdits: mode });
      }
      const changed = await stet.shareEdits();
      return out(() => (changed ? "Shared your saved edits; agents pick them up at their next sync." : "Nothing new to share."), { changed });
    }

    case "comment": {
      if (isNoteId(need(args[0], "item or note id"))) {
        const n = await stet.replyNote(args[0]!, need(opt.message, "-m <text>"), "user");
        return out(() => `Replied on ${n.id}${n.deliveredAt ? "" : " (the agent gets it with the note at its next sync)"}.`, n);
      }
      const it = await stet.comment(need(args[0], "item id"), need(opt.message, "-m <text>"), "user");
      return out(() => `Commented on ${it.id}.`, it);
    }

    case "note": {
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
    }

    case "notes": {
      const notes = await stet.listNotes({ ...(opt.agent ? { agent: opt.agent } : {}), ...(opt.all ? {} : { state: "open" as const }) });
      return out(() => (notes.length ? notes.map(noteSummary).join("\n") : "No open notes."), notes);
    }

    case "group": {
      const kind = need(opt.kind, "--kind") as GroupKind;
      if (!["atomic", "linked", "related"].includes(kind)) throw new StetError(`Unknown group kind '${kind}'.`);
      const onlyAgent = opt.agent ?? (await stet.agentForCwd(cwd).then((a) => a.id).catch(() => null));
      const parts = await readJsonArg<{ title: string; items: string[] }[]>(opt.parts);
      const r = await stet.group(onlyAgent, args, kind, need(opt.title, "-t <title>"), opt.message, parts ?? undefined);
      return out(() => {
        if (r.merged) return `Merged into ${bold(r.merged.id)}.`;
        const g = r.group!;
        return [
          `Created ${bold(g.id)} (${kind}).`,
          ...(g.parts ?? []).map((p, k) => `  part ${bold(partId(g.id, k))} "${p.title}": ${p.items.join(", ")}`),
          ...r.warnings.map((w) => yellow("! ") + w),
        ].join("\n");
      }, r);
    }

    case "ungroup": {
      const onlyAgent = await stet.agentForCwd(cwd).then((a) => a.id).catch(() => undefined);
      await stet.ungroup(need(args[0], "group id"), onlyAgent);
      return out(() => `Removed ${args[0]}.`, { removed: args[0] });
    }

    // Agent side ---------------------------------------------------------------
    case "status": {
      const s = await stet.agentStatus(await agentId(stet));
      return out(
        () =>
          [
            `Agent ${bold(s.agent.id)} (branch ${s.agent.branch})`,
            `Items: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`,
            s.unreadFeedback ? yellow(`${s.unreadFeedback} unread feedback event(s): run \`stet feedback\``) : "No unread feedback.",
            s.syncNeeded ? yellow("The document changed: run `stet sync` before starting new work.") : "Up to date with the document.",
            ...(s.notesWaiting ? [yellow(`${s.notesWaiting} note(s) from the reviewer waiting: run \`stet sync\` to receive them.`)] : []),
            ...(s.missingAccepted.length ? [yellow(`Accepted but not in your copy yet: ${s.missingAccepted.join(", ")} (the reviewer is told). Don't propose them again.`)] : []),
          ].join("\n"),
        s,
      );
    }

    case "submit": {
      const id = await agentId(stet);
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
    }

    case "sync": {
      const r = await stet.sync(await agentId(stet));
      return out(
        () =>
          [
            `Synced onto ${r.base.slice(0, 8)}: ${r.kept} pending item(s) kept${r.stale.length ? `, stale: ${r.stale.map((s) => s.id).join(", ")}` : ""}.`,
            ...r.notes.map((d) => describeNote(d, noteReply)),
          ].join("\n"),
        r,
      );
    }

    case "feedback": {
      const ev = await stet.feedback(await agentId(stet), { ack: !opt.peek });
      return out(() => (ev.length ? ev.map(describeEvent).join("\n") : "No new feedback."), ev);
    }

    case "list": {
      const id = await agentId(stet);
      const items = await stet.listItems({ agent: id, ...(opt.status ? { status: opt.status.split(",") as ItemStatus[] } : {}) });
      return out(() => (items.length ? items.map((i) => itemSummary(i)).join("\n") : "No items."), items);
    }

    case "reply": {
      const id = await agentId(stet);
      if (isNoteId(need(args[0], "item or note id"))) {
        const n = await stet.getNote(args[0]!);
        if (n.agent !== id || !n.deliveredAt) throw new StetError(`Unknown note ${args[0]}.`);
        await stet.replyNote(n.id, need(opt.message, "-m <text>"), "agent");
        return out(() => `Replied on ${n.id}.`, { ok: true });
      }
      const it = await stet.getItem(need(args[0], "item id").toUpperCase());
      if (it && it.agent !== id) throw new StetError(`${it.id} belongs to ${it.agent}.`);
      await stet.comment(args[0]!, need(opt.message, "-m <text>"), "agent");
      return out(() => `Replied on ${args[0]}.`, { ok: true });
    }

    case "withdraw": {
      const w = await stet.withdraw(await agentId(stet), args, opt.message);
      return out(() => `Withdrawn: ${w.map((i) => i.id).join(", ")}`, w);
    }

    default:
      throw new StetError(`Unknown command '${cmd}'. Run \`stet --help\`.`);
  }
}

main().catch((e) => {
  if (e instanceof StetError) {
    if (opt.json) console.log(JSON.stringify({ error: e.message }));
    else console.error(red("error: ") + forTerminal(e.message));
  } else console.error(e);
  process.exitCode = 1;
});
