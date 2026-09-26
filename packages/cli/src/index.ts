#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  checkToolUse,
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
  type AcceptResult,
  type Agent,
  type AgentKind,
  type GroupHint,
  type GroupKind,
  type Item,
  type ItemStatus,
  type NoteHint,
  type StetEvent,
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
  stet setup claude|codex [--print]     register the Stet MCP server with Claude Code / Codex
  stet hooks install|uninstall|status   git hooks that block merges/pushes of agent branches

Review:
  stet review [--agent <a>] [--status <s>] [--all]
                                        list items (default: pending)
  stet show <S12|G3|C4>                 show an item, group or changeset
  stet accept <S12|G3>... [--force] [--text <t> | --text-file <f>] [--no-commit]
  stet reject <S12|G3>... [-m <reason>] [--all | --revise-rest | --only]
  stet revise <S12> -m <what to change>
  stet comment <S12> -m <text>
  stet commit                           commit accepted items that are not committed yet
  stet group <S1> <S2>... --kind atomic|linked|related -t <title> [-m <rationale>]
  stet ungroup <G3>

Agent side (run inside an agent workspace, or pass --agent <name>):
  stet status
  stet submit -t <title> [-m <rationale>] [--groups <file.json|->] [--notes <file.json>]
  stet sync
  stet feedback [--peek]
  stet list [--status <s>]
  stet reply <S12> -m <text>
  stet withdraw <S12>... [-m <reason>]

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
    message: { type: "string", short: "m" },
    title: { type: "string", short: "t" },
    "revise-rest": { type: "boolean" },
    only: { type: "boolean" },
    groups: { type: "string" },
    notes: { type: "string" },
    peek: { type: "boolean" },
    print: { type: "boolean" },
  },
});

// ---------------------------------------------------------------------------
// Output helpers

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = c("31"), green = c("32"), yellow = c("33"), dim = c("2"), bold = c("1"), cyan = c("36");

function out(human: () => string | void, data: unknown) {
  if (opt.json) console.log(JSON.stringify(data, null, 2));
  else {
    const s = human();
    if (s) console.log(s);
  }
}

const oneLine = (s: string, max = 70) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

const statusColor = (s: ItemStatus) =>
  s === "accepted" ? green(s) : s === "rejected" || s === "stale" ? red(s) : s === "needs_revision" ? yellow(s) : s === "pending" ? cyan(s) : dim(s);

function itemSummary(it: Item, line?: number): string {
  const where = `${it.file}${line ? `:${line}` : ""}`;
  if (it.kind !== "modify") return `${bold(it.id)} ${statusColor(it.status)} ${it.kind} ${where}${it.oldFile ? ` (from ${it.oldFile})` : ""}`;
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
  const raw = arg === "-" ? await readStdin() : await readFile(arg, "utf8");
  return JSON.parse(raw) as T;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", reject);
  });
}

async function agentId(stet: Stet): Promise<string> {
  if (opt.agent) return opt.agent;
  return (await stet.agentForCwd(process.cwd())).id;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new StetError(`Missing ${what}.`);
  return v;
}

const isGroupId = (s: string) => /^G\d+$/i.test(s);

/** How other tools should invoke this CLI: absolute node + script paths. */
const SELF: CliCommand = {
  command: process.execPath,
  args: [fileURLToPath(import.meta.url)],
  // Running on VS Code's own runtime (bundled with the extension): keep it in Node mode.
  ...(process.env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
};
const VERSION = "0.3.0";

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
  try {
    const { toplevel, mainPath, commonDir } = await Stet.locate(cwd);
    const stet = await Stet.open(cwd);
    const cfg = await stet.config();
    const branch = await new Repo(toplevel).tryRun(["symbolic-ref", "--short", "HEAD"]);
    if (!branch?.startsWith(cfg.agentBranchPrefix)) return; // not an agent workspace
    const reason = checkToolUse(input, { worktree: toplevel, mainPath, commonDir });
    if (reason) {
      process.stderr.write(reason + "\n");
      process.exitCode = 2;
    }
  } catch (e: any) {
    // Never block on internal errors, but say so (non-blocking hook error).
    process.stderr.write(`stet guard: ${e?.message ?? e}\n`);
    process.exitCode = 1;
  }
}

/** Quote an argument for cmd.exe when we have to go through a shell (npm .cmd shims). */
const winQuote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);

function runTool(cmd: string, args: string[]): { ok: boolean; out: string } {
  const win = process.platform === "win32";
  const r = win
    ? spawnSync([cmd, ...args].map(winQuote).join(" "), { shell: true, encoding: "utf8" })
    : spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}`.trim() };
}

function describeEvent(e: StetEvent): string {
  const d = (e.data ?? {}) as any;
  const it = d.item ? `${d.item.id} (${d.item.file}:${d.item.line})` : (e.items ?? []).join(", ");
  switch (e.type) {
    case "accepted":
      return `${green("accepted")} ${it}${d.finalText !== undefined ? ` — edited by the reviewer to: "${oneLine(d.finalText, 200)}"` : ""}`;
    case "rejected":
      return `${red("rejected")} ${it}${d.reason ? ` — reason: ${d.reason}` : ""}. Do not propose this change again.`;
    case "revision_requested":
      return `${yellow("revision requested")} ${it}: ${d.comment}`;
    case "comment":
      return `${cyan("comment")} on ${it}: ${d.text}  (answer with: stet reply ${d.item?.id ?? ""} -m "...")`;
    case "stale":
      return `${yellow("stale")} ${it}: ${d.reason}. Re-propose against the current text if still relevant.`;
    case "repeat_rejected":
      return `${red("repeat")} ${it} repeats an already rejected change (${d.previous}); it was rejected automatically.`;
    case "group_broken":
      return `${red("group broken")} ${e.group} "${d.title}": ${(d.members ?? []).map((m: any) => `${m.id}=${m.status}`).join(", ")}. Make the document consistent again.`;
    default:
      return `${e.type} ${it}`;
  }
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

  if (cmd === "mcp") {
    const server = new StetMcpServer({
      cwd,
      version: VERSION,
      ...(process.env.STET_WORKSPACE ? { workspace: process.env.STET_WORKSPACE } : {}),
      ...(process.env.STET_AGENT ? { agentId: process.env.STET_AGENT } : {}),
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
        await stet.archiveAgent(need(name, "agent name"), { removeWorktree: !!opt.remove });
        return out(() => `Archived ${name}.`, { archived: name });
      }
      throw new StetError("Usage: stet agent new|list|archive <name>");
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
      if (!items.length) return console.log("Nothing to review.");
      const lines: string[] = [];
      for (const cs of changesets) {
        const csItems = items.filter((i) => i.changeset === cs.id);
        if (!csItems.length) continue;
        lines.push(`${bold(cs.agent)} › ${bold(cs.id)} ${cs.title}${cs.rationale ? dim(" — " + oneLine(cs.rationale, 60)) : ""}`);
        const shown = new Set<string>();
        for (const g of groups.filter((g) => g.items.some((i) => csItems.some((x) => x.id === i)))) {
          const icon = g.kind === "linked" ? "⛓" : g.kind === "related" ? "≡" : "◆";
          lines.push(`  ${icon} ${bold(g.id)} ${g.kind} ${g.title}${g.source === "auto" ? dim(" [auto]") : ""}${g.state === "broken" ? red(" [broken]") : ""}`);
          for (const i of csItems.filter((x) => g.items.includes(x.id))) {
            const { line } = await stet.locateInWorkingCopy(i);
            lines.push(`      ${itemSummary(i, line)}`);
            shown.add(i.id);
          }
        }
        for (const i of csItems.filter((x) => !shown.has(x.id))) {
          const { line } = await stet.locateInWorkingCopy(i);
          lines.push(`    ${itemSummary(i, line)}`);
        }
      }
      return console.log(lines.join("\n"));
    }

    case "show": {
      const id = need(args[0], "id").toUpperCase();
      if (id.startsWith("G")) {
        const g = (await stet.listGroups()).find((x) => x.id === id);
        if (!g) throw new StetError(`Unknown group ${id}.`);
        const items = (await Promise.all(g.items.map((i) => stet.getItem(i)))).filter((x): x is Item => !!x);
        return out(() => [`${bold(g.id)} ${g.kind} ${g.title} (${g.state})`, g.rationale ?? "", ...items.map((i) => itemSummary(i))].filter(Boolean).join("\n"), { group: g, items });
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
      return out(() => {
        const lines = [itemSummary(it, line)];
        if (it.note) lines.push(`${dim("note:")} ${it.note}`);
        if (it.groups.length) lines.push(`${dim("groups:")} ${it.groups.join(", ")}`);
        if (it.conflictsWith.length) lines.push(`${yellow("conflicts with:")} ${it.conflictsWith.join(", ")}`);
        lines.push("", itemDiff(it));
        if (it.thread.length) lines.push("", ...it.thread.map((t) => `${dim(t.at.slice(0, 16).replace("T", " "))} ${bold(t.author)}: ${t.text}`));
        return lines.join("\n");
      }, { ...it, line });
    }

    case "accept": {
      if (!args.length) throw new StetError("Usage: stet accept <S12|G3>...");
      const commit = opt["no-commit"] ? false : undefined;
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
      if (!args.length) throw new StetError("Usage: stet reject <S12|G3>... [-m reason]");
      const mode = opt.all ? "all" : opt["revise-rest"] ? "revise-rest" : opt.only ? "only" : undefined;
      let ids: string[] = [];
      for (const a of args) {
        if (!isGroupId(a)) ids.push(a);
        else {
          const g = (await stet.listGroups()).find((x) => x.id === a.toUpperCase());
          if (!g) throw new StetError(`Unknown group ${a}.`);
          for (const i of g.items) {
            const it = await stet.getItem(i);
            if (it && (it.status === "pending" || it.status === "needs_revision")) ids.push(i);
          }
        }
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

    case "revise": {
      const it = await stet.requestRevision(need(args[0], "item id"), need(opt.message, "-m <what to change>"));
      return out(() => `${yellow("Revision requested")} for ${it.id}.`, it);
    }

    case "commit": {
      const r = await stet.commitAcceptedItems();
      return out(
        () => (r.commit ? `Committed ${r.items.map((i) => i.id).join(", ")} as ${r.commit.slice(0, 7)}.` : "Nothing to commit: all accepted items are committed."),
        r,
      );
    }

    case "comment": {
      const it = await stet.comment(need(args[0], "item id"), need(opt.message, "-m <text>"), "user");
      return out(() => `Commented on ${it.id}.`, it);
    }

    case "group": {
      const kind = need(opt.kind, "--kind") as GroupKind;
      if (!["atomic", "linked", "related"].includes(kind)) throw new StetError(`Unknown group kind '${kind}'.`);
      const onlyAgent = opt.agent ?? (await stet.agentForCwd(cwd).then((a) => a.id).catch(() => null));
      const r = await stet.group(onlyAgent, args, kind, need(opt.title, "-t <title>"), opt.message);
      return out(() => (r.merged ? `Merged into ${bold(r.merged.id)}.` : `Created ${bold(r.group!.id)} (${kind}).`), r);
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
        for (const g of r.groups) lines.push(`  group ${bold(g.id)} ${g.kind} "${g.title}"${g.source === "auto" ? dim(" (auto-detected)") : ""}: ${g.items.join(", ")}`);
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
      return out(() => `Synced onto ${r.base.slice(0, 8)}: ${r.kept} pending item(s) kept${r.stale.length ? `, stale: ${r.stale.map((s) => s.id).join(", ")}` : ""}.`, r);
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
    else console.error(red("error: ") + e.message);
  } else console.error(e);
  process.exitCode = 1;
});
