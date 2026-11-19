/**
 * The agent's inbox: `.stet/inbox` in its workspace, one line per thing that arrived for it
 * (feedback, a note waiting, a sync needed, the workspace archived).
 *
 * The Stet MCP server writes it while the agent's session runs: it runs outside the agent's
 * sandbox, so it can work out the review base. `stet watch`, and any `tail -f`, only read it,
 * which works inside the sandbox too. The agent then waits for a line instead of polling.
 */
import { open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FEEDBACK_TYPES, notifyMode, notifyTriggers, triggerOf, type StetEvent } from "./model.js";
import { describeFeedback } from "./mcp.js";
import { pathExists } from "./paths.js";
import { appendInside, readInside } from "./safefs.js";
import type { Stet } from "./service.js";
import { oneLine } from "./text.js";

export const INBOX_FILE = ".stet/inbox";

/**
 * How often the writer looks for changes; how often it checks fully anyway (the user's saved
 * edits change no store file); and, for agents notified `batched`, how long the reviewer must
 * have paused before news is written.
 */
export const INBOX_TIMING = { poll: 3_000, full: 30_000, quiet: 30_000 };

export interface InboxLine {
  at: string;
  /** What the line is about, unique per line: `feedback#12`, `note:N3`, `sync:<agent base>`, `archived`. */
  key: string;
  text: string;
}

const LINE = /^(\S+) (\S+) (.*)$/;

export function parseInboxLine(line: string): InboxLine | null {
  const m = LINE.exec(line);
  return m ? { at: m[1]!, key: m[2]!, text: m[3]! } : null;
}

/** Writes the inbox of one agent. `tick` checks once; `start` keeps checking until `stop`. */
export class InboxWriter {
  private keys: Set<string> | null = null;
  private signature: string | null = null;
  private lastFull = 0;
  /** When the store last changed (the reviewer, or the agent, did something). */
  private lastActivity = 0;
  /** A `batched` agent has news waiting for the reviewer to pause. */
  private waiting = false;
  private running: Promise<InboxLine[]> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private done = false;

  constructor(
    private readonly stet: Stet,
    private readonly agentId: string,
  ) {}

  start(): void {
    if (this.timer || this.done) return;
    const run = () => void this.tick().catch(() => undefined);
    run();
    this.timer = setInterval(run, INBOX_TIMING.poll);
    this.timer.unref();
  }

  /**
   * Stop checking; resolves once a check still running has finished, so nothing touches the
   * workspace afterwards (on Windows, a file or process still using it stops it being removed).
   */
  async stop(): Promise<void> {
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** Check for news and append it; returns the lines written. */
  async tick(force = false): Promise<InboxLine[]> {
    if (this.running || this.done) return [];
    this.running = this.check(force);
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private async check(force: boolean): Promise<InboxLine[]> {
    const { store, repo } = this.stet;
    const agent = await store.getAgent(this.agentId);
    if (!agent) return this.halt();
    const worktree = agent.worktree;
    if (!(await pathExists(worktree))) return this.halt();
    if (agent.state === "archived") {
      const lines = await this.append(worktree, [{ key: "archived", text: "the reviewer archived this workspace: stop working here (any Stet tool explains)" }]);
      this.halt();
      return lines;
    }

    // Cheap check first: the event log, the store's counters (new notes, items), the config, the main branch.
    const cfg = await this.stet.config();
    const sizeOf = async (f: string) => {
      const s = await stat(join(store.root, f)).catch(() => null);
      return s ? `${s.size}:${s.mtimeMs}` : "-";
    };
    const mode = notifyMode(agent);
    const signature = [
      await sizeOf("events.jsonl"),
      await sizeOf("state.json"),
      await sizeOf("config.json"),
      await repo.tryRun(["rev-parse", "-q", "--verify", `refs/heads/${cfg.mainBranch}`]),
      agent.baseCommit,
      agent.feedbackCursor,
      mode,
      notifyTriggers(agent).join(","),
    ].join("|");
    const now = Date.now();
    const changed = signature !== this.signature;
    if (changed && this.signature !== null) this.lastActivity = now; // the first look is no activity
    this.signature = signature;
    // Off: nothing is written, so all of it arrives once notifications are on again.
    if (mode === "off") return [];
    if (!force && !changed && !this.waiting && now - this.lastFull < INBOX_TIMING.full) return [];
    // Batched: wait until the reviewer has paused, then write everything at once.
    if (!force && mode === "batched" && now - this.lastActivity < INBOX_TIMING.quiet) {
      this.waiting = true;
      return [];
    }
    this.waiting = false;
    this.lastFull = now;

    // Only the kinds of news the reviewer chose for this agent. The others aren't written (nor
    // remembered), so they still arrive if the reviewer switches them on later.
    const wanted = new Set(notifyTriggers(agent));
    const status = await this.stet.agentStatus(this.agentId);
    const news: Omit<InboxLine, "at">[] = [];
    const events = (await store.events(agent.feedbackCursor)).filter((e: StetEvent) => e.agent === agent.id && FEEDBACK_TYPES.includes(e.type));
    for (const e of events) {
      if (!wanted.has(triggerOf(e))) continue;
      news.push({ key: `feedback#${e.seq}`, text: `${oneLine(describeFeedback(e), 300)} (read it with stet_get_feedback)` });
    }
    if (wanted.has("note")) {
      for (const n of await store.notes()) {
        if (n.agent !== agent.id || n.state !== "open" || n.deliveredAt) continue;
        news.push({ key: `note:${n.id}`, text: `note ${n.id} from the reviewer on ${n.file}: "${oneLine(n.body, 160)}" (receive it with stet_sync)` });
      }
    }
    // Once per base the agent is on: the user's saved edits may change the review base often.
    if (status.syncNeeded) {
      // A save, unless main moved on (a commit or pull) since the agent's base: its parent is
      // the main commit it was built on, or it is that commit itself.
      const head = await repo.tryRun(["rev-parse", "-q", "--verify", `refs/heads/${cfg.mainBranch}`]);
      const parent = await repo.tryRun(["rev-parse", "-q", "--verify", `${status.agent.baseCommit}^1`]);
      const mainMoved = head !== status.agent.baseCommit && head !== parent;
      const kind = !mainMoved && cfg.shareEdits === "saved" ? "save" : "document";
      if (wanted.has(kind)) news.push({ key: `sync:${status.agent.baseCommit}`, text: "the document changed since your last sync (call stet_sync before new work)" });
    }
    return this.append(worktree, news);
  }

  /** Stop from inside a check (which `stop` would wait for). */
  private halt(): InboxLine[] {
    this.done = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return [];
  }

  private async append(worktree: string, news: Omit<InboxLine, "at">[]): Promise<InboxLine[]> {
    if (this.done) return []; // stopped meanwhile: leave the workspace alone
    if (!this.keys) {
      // Keys already in the file (an earlier session, or another server for the same workspace).
      const old = (await readInside(worktree, INBOX_FILE))?.toString("utf8") ?? "";
      this.keys = new Set(old.split("\n").map((l) => parseInboxLine(l)?.key).filter((k): k is string => !!k));
    }
    const at = new Date().toISOString();
    const lines = news.filter((n) => !this.keys!.has(n.key)).map((n) => ({ at, ...n }));
    if (!lines.length) return [];
    await appendInside(worktree, INBOX_FILE, lines.map((l) => `${l.at} ${l.key} ${l.text}\n`).join(""));
    for (const l of lines) this.keys.add(l.key);
    return lines;
  }
}

/**
 * Wake an agent now, whatever its notification settings: the reviewer's *Notify now*. Written by
 * the reviewer's process (not the agent's MCP server), so it works even while that one waits.
 */
export async function pingInbox(worktree: string, message?: string): Promise<InboxLine> {
  const line: InboxLine = {
    at: new Date().toISOString(),
    key: `ping:${Date.now()}`,
    text: `the reviewer asks you to check in now${message?.trim() ? `: "${oneLine(message, 300)}"` : ""} (call stet_status, then stet_get_feedback / stet_sync)`,
  };
  await appendInside(worktree, INBOX_FILE, `${line.at} ${line.key} ${line.text}\n`);
  return line;
}

/** The inbox of the workspace containing `cwd` (the nearest folder with a `.git` entry), or null. */
export async function findInbox(cwd: string): Promise<string | null> {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (await pathExists(join(dir, ".git"))) return join(dir, INBOX_FILE);
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Lines appended to `path` from now on, as they arrive (the file may not exist yet).
 * With `once`, ends after the first batch: lines written within `settle` ms of each other.
 */
export async function* followInbox(
  path: string,
  opts: { once?: boolean; poll?: number; settle?: number; signal?: AbortSignal } = {},
): AsyncGenerator<InboxLine> {
  const poll = opts.poll ?? 500;
  const settle = opts.settle ?? 300;
  const sizeNow = async () => (await stat(path).catch(() => null))?.size ?? 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let offset = await sizeNow();
  let got = 0;
  let lastAt = 0;
  while (!opts.signal?.aborted) {
    const size = await sizeNow();
    if (size < offset) offset = 0; // replaced or emptied: read it from the start
    if (size > offset) {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(size - offset);
        await fh.read(buf, 0, buf.length, offset);
        const complete = buf.lastIndexOf(10) + 1; // a line still being written is read next time
        for (const raw of buf.subarray(0, complete).toString("utf8").split("\n")) {
          const line = parseInboxLine(raw.trim());
          if (!line) continue;
          got++;
          lastAt = Date.now();
          yield line;
        }
        offset += complete;
      } finally {
        await fh.close();
      }
    }
    if (opts.once && got && Date.now() - lastAt >= settle) return;
    await sleep(got && opts.once ? Math.min(poll, settle) : poll);
  }
}
