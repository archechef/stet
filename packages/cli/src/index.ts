#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import {
  changeSummary,
  DOCUMENT_LANGUAGES,
  documentProfile,
  languageCounts,
  inlineDiff,
  paragraphChange,
  profileByName,
  foldPath,
  isLive,
  summaryTexts,
  itemEffect,
  lineDiff,
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
  verifyAgentWorktree,
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

const HELP = `stet — review AI-proposed changes to ${DOCUMENT_LANGUAGES.map((p) => p.name).join(" and ")} projects

Project (run in your project folder):
  stet init [--main <branch>] [--language <latex|typst>]           set up Stet in this repository
  stet doctor                           check your setup
  stet agent new <name> [--kind claude-code|codex|other]
                                        create an agent workspace
  stet agent list
  stet agent refresh <name>             rewrite the agent's instructions, MCP and guard files
  stet agent archive <name> [--remove [--force]]
                                        retire an agent (withdraws its pending items); --remove deletes
                                        its folder and branch (--force: even with unsubmitted changes)
  stet agent notify <name> [now|batched|off] [--on <kinds>|all]
                                        when a watching agent is woken, and by what: accepted,
                                        rejected, revision, comment, note, document, save
  stet agent ping <name> [-m <text>]    wake a watching agent now, whatever its settings
  stet setup claude|codex [--print]     register the Stet MCP server with Claude Code / Codex
  stet hooks install|uninstall|status   git hooks that block merges/pushes of agent branches

Review:
  stet review [--agent <a>] [--status <s>] [--all]
                                        list items (default: pending)
  stet show <12.3|G3|G3.2|C12|N3> [--full]   show a change (round 12, change 3), group, part of a group, round or note; --full: whole added or deleted files
  stet accept <12.3|G3|G3.2|C12>... [--force] [--confirm] [--text <t> | --text-file <f>] [--commit | --no-commit]
  stet reject <12.3|G3|G3.2|C12>... [-m <reason>] [--all | --revise-rest | --only]
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
  stet group <12.1> <12.2>... --kind atomic|linked|related -t <title> [-m <rationale>] [--parts <file.json|->] [--reason <why linked>]
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

const OPTIONS = {
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
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
    reason: { type: "string" },
    notes: { type: "string" },
    peek: { type: "boolean" },
    once: { type: "boolean" },
    on: { type: "string" },
    extras: { type: "boolean" },
    page: { type: "string" },
    before: { type: "boolean" },
    print: { type: "boolean" },
    full: { type: "boolean" },
    confirm: { type: "boolean" },
    language: { type: "string" },
} as const;

/** Exit codes, for scripts: 1 any other error, 2 a wrong command line, 3 an unknown id or name. */
const EXIT = { error: 1, usage: 2, unknown: 3 } as const;

/** The command line; a wrong option is a usage error, not a stack trace (test report B1). */
function parseCommandLine() {
  try {
    return parseArgs({ allowPositionals: true, strict: true, options: OPTIONS });
  } catch (e: any) {
    if (!String(e?.code).startsWith("ERR_PARSE_ARGS")) throw e;
    const msg = String(e.message).split("\n")[0]!.replace(/\. To specify a positional argument.*$/, "");
    console.error(`error: ${msg}. Run \`stet --help\`.`);
    process.exit(EXIT.usage);
  }
}
const { values: opt, positionals: pos } = parseCommandLine();

// ---------------------------------------------------------------------------
// Output helpers

const color = process.stdout.isTTY && !process.env.NO_COLOR;
/**
 * Stet's own colour codes are written as markers with a random tag and become escape sequences
 * only in `forTerminal`, after every control character from agent text is gone: agent text could
 * otherwise carry Stet's own colours (security report 5e4c6af, S10).
 */
const TAG = randomBytes(8).toString("hex");
const sgr = (code: string) => `\uE000${TAG}${code}\uE001`;
const OWN_SGR = new RegExp(`\uE000${TAG}([0-9;]+)\uE001`, "g");
const c = (code: string) => (s: string) => (color ? `${sgr(code)}${s}${sgr("0")}` : s);
const red = c("31"), green = c("32"), yellow = c("33"), dim = c("2"), bold = c("1"), cyan = c("36");

/**
 * Text for the terminal: Stet's own colour codes stay, every other control character goes (agent
 * text could otherwise carry escape sequences that rewrite or hide what the reviewer sees).
 */
export function forTerminal(s: string): string {
  return printable(s).replace(OWN_SGR, (_, code: string) => `\x1b[${code}m`);
}

// biome-ignore lint/suspicious/noConfusingVoidType: `human` prints on its own when it returns nothing.
function out(human: () => string | void, data: unknown) {
  if (opt.json) console.log(JSON.stringify(data, null, 2));
  else {
    const s = human();
    if (s) console.log(forTerminal(s));
  }
}

/** A status in words ("needs revision", not needs_revision), coloured. */
const statusColor = (st: ItemStatus) => {
  const s = st.replace(/_/g, " ");
  return st === "accepted" ? green(s) : st === "rejected" || st === "stale" ? red(s) : st === "needs_revision" ? yellow(s) : st === "pending" ? cyan(s) : dim(s);
};

/** A stored time (UTC) in the local time zone, to the minute. */
const localTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const sizeOf = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function itemSummary(it: Item, line?: number): string {
  // A file that takes effect (a latexmkrc, .gitattributes, AGENTS.md…): flagged (security report 5e4c6af, S12).
  const effect = itemEffect(it);
  return itemLine(it, line) + (effect ? yellow(` ⚠ takes effect: ${effect}`) : "");
}

function itemLine(it: Item, line?: number): string {
  const where = `${it.file}${line ? `:${line}` : ""}`;
  if (it.kind !== "modify") {
    const text = it.kind === "delete-file" ? it.oldText : it.newText;
    const size = it.kind === "binary" ? "" : dim(` (${sizeOf(Buffer.byteLength(text, "utf8"))})`);
    // A rename that also changes the text says so (it showed as a plain rename).
    const edited = it.kind === "rename-file" && it.oldText !== it.newText ? " and edited" : "";
    return `${bold(it.id)} ${statusColor(it.status)} ${it.kind}${edited} ${where}${it.oldFile ? ` (from ${it.oldFile})` : ""}${size}`;
  }
  if (it.move) {
    // Half of a move (spec §6.4.7): decided with its other half.
    const how = it.move.changed ? yellow(`${it.move.changed} word(s) changed on the way`) : "word for word";
    const move = movesOut(it)
      ? `${red(`moved out: "${oneLine(it.oldText, 40)}"`)} ${dim(`→ ${moveTo(it.move).join(", ")}`)}`
      : `${green(`moved in: "${oneLine(it.newText, 40)}"`)} ${dim(`← ${moveFrom(it.move).join(", ")},`)} ${how}`;
    return `${bold(it.id)} ${statusColor(it.status)} ${dim(where)}  ${move}`;
  }
  const [o, n] = changeSummary(...summaryTexts(it), it.oldText && it.newText ? 30 : 50);
  const change = !it.oldText ? green(`+ "${n}"`) : !it.newText ? red(`- "${o}"`) : `${red(`"${o}"`)} → ${green(`"${n}"`)}`;
  // A revision says what it revises (the reviewer's request is in `stet show`).
  const revises = it.supersedes ? dim(` (revises ${it.supersedes})`) : "";
  // A paragraph split, joined, or its break moved past a sentence: said in words.
  const breaks = paragraphChange(it.oldText, it.newText);
  return `${bold(it.id)} ${statusColor(it.status)} ${dim(where)}  ${breaks ? `${breaks}: ` : ""}${change}${revises}`;
}

/** A reply or note on several lines, indented, so it can't pass for thread lines of its own (security report 5e4c6af, S10). */
const indented = (t: string) => printable(t).replace(/\n/g, "\n    ");

function itemDiff(it: Item): string {
  if (it.kind === "binary") {
    // Text with bytes that aren't UTF-8: shown, the bytes marked (security report 5e4c6af, S7).
    if (!it.shownText) return dim("(binary file)");
    const all = lineDiff(it.shownText.old ?? "", it.shownText.new ?? "");
    const shown = opt.full ? all : all.slice(0, 80);
    return [
      dim("(not UTF-8 text: bytes that aren't UTF-8 are shown as ⟨0x..⟩; accepting writes the file byte for byte)"),
      ...shown.map((l) => (l.startsWith("+ ") ? green(l) : l.startsWith("- ") ? red(l) : dim(l))),
      ...(shown.length < all.length ? [dim(`  … ${all.length - shown.length} more lines (stet show ${it.id} --full shows them all)`)] : []),
    ].join("\n");
  }
  if (it.kind !== "modify") {
    const lines: string[] = [];
    // Whole files with --full; else the first 40 lines of each side, and how many more there are
    // (security report 5e4c6af, S8: the rest was cut without a word).
    const side = (text: string, mark: (s: string) => string, sign: string) => {
      const all = text.split("\n");
      const shown = opt.full ? all : all.slice(0, 40);
      lines.push(...shown.map((l) => mark(sign + l)));
      if (shown.length < all.length) lines.push(dim(`  … ${all.length - shown.length} more lines (stet show ${it.id} --full shows them all)`));
    };
    if (it.oldText) side(it.oldText, red, "- ");
    if (it.newText) side(it.newText, green, "+ ");
    return lines.join("\n");
  }
  // Context up to the line boundary, without a cut-off partial word.
  const before = (it.context.before.split("\n").pop() ?? "").replace(/^\S*\s/, "…");
  const after = (it.context.after.split("\n")[0] ?? "").replace(/\s\S*$/, "…");
  const del = (t: string) => (t ? (color ? c("31;9")(t) : `[-${t}-]`) : "");
  const ins = (t: string) => (t ? (color ? c("32;4")(t) : `{+${t}+}`) : "");
  if (paragraphChange(it.oldText, it.newText)) {
    // Only the paragraph breaks changed: those, made visible, in the text (not all of it twice).
    const shown = (t: string) => t.replace(/\n[ \t]*\n\s*/g, "¶").replace(/\n/g, "↵").replace(/[ \t]/g, "␣");
    const d = inlineDiff(it.oldText, it.newText, profileByName(it.file).syntax?.tokenize);
    let out = "";
    let pos = 0;
    for (const { at, text } of d.inserted) {
      const [a] = d.removed.find(([, b]) => b === at) ?? [at];
      out += it.oldText.slice(pos, a) + del(shown(it.oldText.slice(a, at))) + ins(shown(text));
      pos = at;
    }
    return dim(before) + out + it.oldText.slice(pos) + dim(after);
  }
  return dim(before) + del(it.oldText) + ins(it.newText) + dim(after);
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

const STATUSES: readonly ItemStatus[] = ["pending", "needs_revision", "accepted", "rejected", "withdrawn", "superseded", "stale"];

/** `--status a,b`, checked: a typo matched nothing and said "Nothing to review" (test report B5). */
function statusOption(v: string): ItemStatus[] {
  const out = v.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = out.filter((s) => !STATUSES.includes(s as ItemStatus));
  if (bad.length) throw new StetError(`Unknown status ${bad.map((b) => `'${b}'`).join(", ")} (use ${STATUSES.join(", ")}).`);
  return out as ItemStatus[];
}

/** `--agent <name>`, checked against the agents there are (archived ones too). */
async function agentOption(stet: Stet): Promise<string | undefined> {
  if (!opt.agent) return undefined;
  const all = await stet.listAgents();
  if (!all.some((a) => a.id === opt.agent)) throw new StetError(`Unknown agent '${opt.agent}'${all.length ? ` (there are: ${all.map((a) => a.id).join(", ")})` : " (there are no agents yet)"}.`);
  return opt.agent;
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new StetError(`Missing ${what}.`);
  return v;
}

/** A group (G3) or a part of one (G3.2). */
const isGroupId = (s: string) => /^G\d+(\.\d+)?$/i.test(s);
const isRoundId = (s: string) => /^C\d+$/i.test(s);

/** A round's (C3) pending changes, for accepting or rejecting it whole (test report UX: "Unknown item 'C1'"). */
async function roundItems(stet: Stet, id: string): Promise<string[]> {
  const cs = (await stet.listChangesets()).find((c) => c.id === id.toUpperCase());
  if (!cs) throw new StetError(`Unknown changeset ${id.toUpperCase()}.`);
  const ids = (await stet.listItems({ changeset: cs.id })).filter((i) => isLive(i.status)).map((i) => i.id);
  if (!ids.length) throw new StetError(`${cs.id} has no pending changes.`);
  return ids;
}

/** How other tools should invoke this CLI: absolute node + script paths. */
const SELF: CliCommand = {
  command: process.execPath,
  args: [fileURLToPath(import.meta.url)],
  // Running on VS Code's own runtime (bundled with the extension): keep it in Node mode.
  ...(process.env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
};
const VERSION = "0.16.0";

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
      if (!existsSync(cwd)) return block(`Stet: this workspace folder (${cwd}) no longer exists. Stop working here and ask the user for a new agent workspace.`);
      if (!agent) return block(`Stet: agent '${agentId}' is unknown to the project ${project}. Ask the user for a new agent workspace.`);
      await verifyAgentWorktree(agent.worktree, stet.commonDir);
      const cfg = await stet.config();
      const reason = checkToolUse(input, { worktree: agent.worktree, mainPath: stet.mainPath, commonDir: stet.commonDir, ...(cfg.cli ? { cli: cfg.cli } : {}) });
      if (reason) block(reason);
    } catch (e: any) {
      block(`Stet's guard could not check this tool call, so it is blocked: ${e?.message ?? e}`);
    }
    return;
  }
  // A hook written by an older Stet: find the project from the folder.
  try {
    const located = await Stet.locate(cwd);
    const { toplevel, mainPath, commonDir } = located;
    const stet = await Stet.open(cwd, located);
    const cfg = await stet.config();
    const branch = await new Repo(toplevel, stet.untrustedConfig).tryRun(["symbolic-ref", "--short", "HEAD"]);
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
  if (opt.version || cmd === "version") return out(() => `stet ${VERSION}`, { version: VERSION });
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
    // A second run only refreshes the setup: say so, instead of the first-time message (test report UX).
    const already = await Stet.open(cwd).then(() => true, () => false);
    const stet = await Stet.init(cwd, { ...(opt.main ? { mainBranch: opt.main } : {}), ...(opt.language ? { language: opt.language } : {}), cli: SELF });
    const cfg = await stet.config();
    // Files of both languages: which has more, and how to choose the other (test report 5e4c6af).
    const counts = languageCounts(((await stet.repo.tryRun(["ls-files", "-z"])) ?? "").split("\0").filter(Boolean), cfg.files);
    const mixed = !opt.language && !already && Object.keys(counts).length > 1;
    const hooks = await hookStatus(stet.repo, stet.commonDir);
    // Agents start from the last commit: edits not committed yet are not theirs to see.
    const dirty = (await stet.repo.tryRun(["status", "--porcelain", "--untracked-files=no"])) ?? "";
    return out(
      () =>
        (already ? `Stet was already set up for ${stet.mainPath} (main branch '${cfg.mainBranch}'); its setup is refreshed.\n` : `Stet is set up for ${stet.mainPath} (main branch '${cfg.mainBranch}').\n`) +
        // Which language agents are told about, and how to change it (test report 5e4c6af, UX).
        `Language: ${documentProfile(cfg).name} (agents' instructions follow it; set "language" in .git/stet/config.json to change it).\n` +
        (mixed
          ? yellow(`! The project has files of both languages (${Object.entries(counts).map(([id, n]) => `${n} ${DOCUMENT_LANGUAGES.find((p) => p.id === id)?.name ?? id}`).join(", ")}); Stet took the one with more. \`stet init --language <${DOCUMENT_LANGUAGES.map((p) => p.id).join("|")}>\` chooses.`) + "\n"
          : "") +
        (hooks.missing.length
          ? yellow(`! Git guard hooks not installed (${hooks.customHooksPath ? `core.hooksPath is ${hooks.dir}` : "disabled"}). See \`stet hooks install\`.`) + "\n"
          : already ? "" : `Git guard hooks installed in ${hooks.dir}.\n`) +
        (dirty ? yellow("! You have uncommitted edits. Agents start from your last commit: commit them first, or share them with `stet share`.") + "\n" : "") +
        (already ? "" : `Next: stet agent new <name>. Optional, once per machine: stet setup claude (or codex) registers Stet with the agent tool for every folder; each workspace already has its own config.`),
      { mainPath: stet.mainPath, mainBranch: cfg.mainBranch, hooks, alreadySetUp: already, uncommittedEdits: !!dirty },
    );
  }

  // The reviewer's commands, refused in an agent's workspace: an agent without a sandbox could
  // otherwise accept its own proposals (test report 2026-11-20).
  const located = await Stet.locate(cwd);
  const reviewerOnly = ["accept", "reject", "undo", "commit", "revise", "comment", "share", "group", "ungroup", "note", "hooks"].includes(cmd) || (cmd === "agent" && args[0] !== "list");
  if (reviewerOnly && foldPath(located.toplevel) !== foldPath(located.mainPath)) {
    throw new StetError(`\`stet ${cmd}\` is for the reviewer, and this is an agent's workspace (${located.toplevel}). Run it in your project folder, ${located.mainPath}.`);
  }
  const stet = await Stet.open(cwd, located);

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
            `It gets its instructions and the Stet tools automatically, from files in that folder.\n` +
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
      const status: ItemStatus[] | undefined = opt.all ? undefined : opt.status ? statusOption(opt.status) : ["pending", "needs_revision"];
      const agent = await agentOption(stet);
      const items = await stet.listItems({ ...(agent ? { agent } : {}), ...(status ? { status } : {}) });
      const groups = await stet.listGroups();
      const changesets = await stet.listChangesets();
      if (opt.json) return out(() => {}, { items, groups: groups.filter((g) => g.items.some((i) => items.some((x) => x.id === i))) });
      const share = await stet.shareStatus().catch(() => null);
      // Only when there are agents to share with (test report UX: it showed before any agent existed).
      const agents = (await stet.listAgents()).filter((a) => a.state === "active");
      const shareHint = agents.length && share?.unshared && share.mode === "manual" ? [dim("Agents don't see your latest saved edits yet: `stet share` shares them.")] : [];
      const missing = await stet.missingFromBase().catch(() => []);
      if (missing.length) shareHint.push(yellow(missingText(missing)));
      // Accepted but not committed: easy to forget without a word here (test report UX).
      const uncommitted = await stet.uncommittedAccepted();
      if (uncommitted.length) shareHint.push(`${uncommitted.length} accepted change${uncommitted.length === 1 ? "" : "s"} not committed yet (${uncommitted.map((i) => i.id).join(", ")}): \`stet commit\` finishes the review.`);
      if (!items.length) {
        const next = !agents.length ? "Create a workspace for an agent: `stet agent new <name>`." : uncommitted.length ? "" : "When an agent submits changes, they show here.";
        return console.log(forTerminal(["Nothing to review.", ...shareHint, ...(next ? [dim(next)] : [])].join("\n")));
      }
      const lines: string[] = [];
      const where = await stet.locateMany(items);
      // Changes no longer found in your file (you edited around them): accepting them fails.
      const lost = items.filter((i) => i.kind === "modify" && isLive(i.status) && !where.get(i.id)?.span);
      for (const cs of changesets) {
        const csItems = items.filter((i) => i.changeset === cs.id);
        if (!csItems.length) continue;
        lines.push(`${bold(cs.agent)} › ${bold(`Round ${roundOf(cs.id)}`)} (${cs.id}) ${oneLine(cs.title, 200)}${cs.rationale ? dim(" — " + oneLine(cs.rationale, 60)) : ""}${cs.stetNote ? yellow(` ! ${cs.stetNote}`) : ""}`);
        const shown = new Set<string>();
        for (const g of groups.filter((g) => g.items.some((i) => csItems.some((x) => x.id === i)))) {
          const icon = g.kind === "linked" ? "⛓" : g.kind === "related" ? "≡" : "◆";
          lines.push(`  ${icon} ${bold(g.id)} ${g.kind} ${oneLine(g.title, 200)}${g.source === "auto" ? dim(" [auto]") : ""}${g.state === "broken" ? red(" [broken]") : ""}`);
          // Parts of a linked group are accepted one at a time: list them with their own ids.
          const units = g.parts ? g.parts.map((p, k) => ({ head: `${bold(partId(g.id, k))} ${oneLine(p.title, 200)}`, items: p.items })) : [{ head: "", items: g.items }];
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
      if (lost.length) shareHint.push(yellow(`! Not found in your file any more (you edited there): ${lost.map((i) => i.id).join(", ")}. Accept with your own text (\`stet accept <id> --text …\`), reject, or ask for a revision.`));
      lines.push(dim("Next: stet show <id> · stet accept <id> · stet reject <id> -m <why>"));
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
              ...n.thread.map((t) => `${t.author === "user" ? "you" : n.agent}: ${indented(t.text)}`),
            ].join("\n"),
          n,
        );
      }
      if (id.startsWith("G")) {
        const { group: g, part } = await stet.groupTarget(id);
        const items = (await Promise.all((part ?? g).items.map((i) => stet.getItem(i)))).filter((x): x is Item => !!x);
        if (part) return out(() => [`${bold(id)} part of ${g.id} (${oneLine(g.title, 200)}): ${oneLine(part.title, 200)}`, ...items.map((i) => itemSummary(i))].join("\n"), { group: g, part, items });
        const lines = [`${bold(g.id)} ${g.kind} ${oneLine(g.title, 200)} (${g.state})`, g.rationale ?? "", ...(await stet.partlyDecided(items)).map((w) => yellow("! ") + w)];
        if (g.parts) {
          for (const [k, p] of g.parts.entries()) lines.push(`${bold(partId(g.id, k))} ${oneLine(p.title, 200)}`, ...items.filter((i) => p.items.includes(i.id)).map((i) => "  " + itemSummary(i)));
        } else lines.push(...items.map((i) => itemSummary(i)));
        return out(() => lines.filter(Boolean).join("\n"), { group: g, items });
      }
      if (id.startsWith("C")) {
        const cs = (await stet.listChangesets()).find((x) => x.id === id);
        if (!cs) throw new StetError(`Unknown changeset ${id}.`);
        const items = await stet.listItems({ changeset: id });
        return out(() => [`${bold(cs.id)} ${oneLine(cs.title, 200)} (${cs.agent}, ${localTime(cs.submittedAt)})`, cs.rationale, ...items.map((i) => itemSummary(i))].filter(Boolean).join("\n"), { changeset: cs, items });
      }
      const it = await stet.getItem(id);
      if (!it) throw new StetError(`Unknown item ${id}.`);
      const { line } = await stet.locateInWorkingCopy(it);
      const moveItems = it.move ? await Promise.all([...moveFrom(it.move), ...moveTo(it.move)].map((id) => stet.getItem(id))) : [];
      const moved = it.move ? moveTexts(it.move, (id) => moveItems.find((m) => m?.id === id) ?? undefined) : null;
      // A revision: what it revises, and what the reviewer asked for there (test report B4).
      const prev = it.supersedes ? await stet.getItem(it.supersedes) : null;
      const asked = prev ? [...prev.thread].reverse().find((t) => t.author === "user") : undefined;
      // The text that went in (accepted with your wording) or would (your wording): test report B11.
      const yours = it.status === "accepted" && it.resolution?.edited ? it.resolution.appliedText : it.draft;
      return out(() => {
        const lines = [itemSummary(it, line)];
        if (it.note) lines.push(`${dim("note:")} ${it.note}`);
        if (prev) {
          lines.push(`${dim("revises:")} ${prev.id} (${prev.status})${asked ? `, where you asked: ${asked.text}` : ""}`);
          if (prev.kind === "modify") lines.push(`  ${dim("it proposed:")} ${itemDiff(prev)}`);
        }
        if (yours !== undefined && it.kind === "modify") {
          lines.push(`${dim(it.status === "accepted" ? "accepted with your wording:" : "your wording (not accepted yet):")} ${itemDiff({ ...it, newText: yours })}`);
          lines.push(`${dim("the agent proposed:")} ${itemDiff(it)}`);
        }
        if (it.move) {
          lines.push(`${dim("move:")} ${moveFrom(it.move).join(", ")} remove the text, ${moveTo(it.move).join(", ")} insert it; accepting or rejecting one decides the whole move.`);
          if (it.move.changed && moved) {
            lines.push(yellow(`Changed on the way (${it.move.changed} word(s)):`));
            for (const c of moveChanges(moved.from, moved.to)) lines.push(`  ${red(`"${c.was}"`)} → ${green(`"${c.now}"`)}`);
          }
        }
        if (it.groups.length) lines.push(`${dim("groups:")} ${it.groups.join(", ")}`);
        if (it.conflictsWith.length) lines.push(`${yellow("conflicts with:")} ${it.conflictsWith.join(", ")}`);
        if (yours === undefined || it.kind !== "modify") lines.push("", itemDiff(it));
        // Without colours, the markers need a word (test report UX).
        if (!color && it.kind === "modify") lines.push(dim("([-…-] is removed, {+…+} is added)"));
        if (it.thread.length) lines.push("", ...it.thread.map((t) => `${dim(localTime(t.at))} ${bold(t.author)}: ${indented(t.text)}`));
        return lines.join("\n");
      }, { ...it, line });
    }

    case "accept": {
      if (!args.length) throw new StetError("Usage: stet accept <12.3|G3|C12>...");
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
      if (ids.length) results.push(await stet.accept(ids, { edited, overrideLinked: !!opt.force, confirmEffects, ...(commit === undefined ? {} : { commit }) }));
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
      if (!args.length) throw new StetError("Usage: stet reject <12.3|G3|C12>... [-m reason]");
      const mode = opt.all ? "all" : opt["revise-rest"] ? "revise-rest" : opt.only ? "only" : undefined;
      let ids: string[] = [];
      for (const a of args) {
        if (isRoundId(a)) ids.push(...(await roundItems(stet, a)));
        else if (!isGroupId(a)) ids.push(a);
        else ids.push(...(await stet.groupTarget(a)).pending);
      }
      ids = [...new Set(ids.map((i) => i.toUpperCase()))];
      try {
        const rejected = await stet.reject(ids, { ...(opt.message ? { reason: opt.message } : {}), ...(mode ? { mode } : args.some((a) => isGroupId(a) || isRoundId(a)) ? { mode: "all" as const } : {}) });
        const warnings = await stet.partlyDecided(rejected);
        return out(() => [`${red("Rejected")} ${rejected.map((i) => i.id).join(", ")}`, ...warnings.map((w) => yellow("! ") + w)].join("\n"), rejected);
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
        console.error(forTerminal(
          dim(
            opt.extras
              ? "Adding the extra fonts to the preview image (downloads about 2 GB; this takes a while)…"
              : before.toolSource === "image"
                ? "Building the preview image with its own TeX Live (downloads about 1 GB; this takes a while)…"
                : "Building the preview image (downloads Debian, Perl and Poppler; TeX comes from your own installation)…",
          ),
        ));
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
        () =>
          r.commit
            ? `Committed ${r.items.map((i) => i.id).join(", ")} as ${r.commit.slice(0, 7)}.` +
              (r.yourEdits.length ? `\n${yellow("!")} Stet commits whole files: this includes your own edits in ${r.yourEdits.join(", ")}.` : "")
            : "Nothing to commit: all accepted items are committed.",
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
      const noteAgent = await agentOption(stet);
      const notes = await stet.listNotes({ ...(noteAgent ? { agent: noteAgent } : {}), ...(opt.all ? {} : { state: "open" as const }) });
      return out(() => (notes.length ? notes.map(noteSummary).join("\n") : "No open notes."), notes);
    }

    case "group": {
      const kind = need(opt.kind, "--kind") as GroupKind;
      if (!["atomic", "linked", "related"].includes(kind)) throw new StetError(`Unknown group kind '${kind}'.`);
      const onlyAgent = opt.agent ?? (await stet.agentForCwd(cwd).then((a) => a.id).catch(() => null));
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
      const items = await stet.listItems({ agent: id, ...(opt.status ? { status: statusOption(opt.status) } : {}) });
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
    else console.error(forTerminal(red("error: ") + e.message));
    process.exitCode = /^(Usage: |Missing |Unknown status )/.test(e.message) ? EXIT.usage : /^Unknown (item|group|changeset|agent|note|command)\b/.test(e.message) ? EXIT.unknown : EXIT.error;
  } else {
    // Not Stet's own error: the message, and the stack only when asked for.
    console.error(forTerminal(red("error: ")) + (e?.message ?? String(e)) + (process.env.STET_DEBUG ? `\n${e?.stack ?? ""}` : "\n(set STET_DEBUG=1 for details)"));
    process.exitCode = EXIT.error;
  }
});
