/** On-disk store in `<git-common-dir>/stet/` (spec §4, §15). */
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { defaultConfig, mergeConfig, type StetConfig } from "./config.js";
import type { Agent, Changeset, Group, Item, StetEvent, StoreState } from "./model.js";

/** A held lock is refreshed every `heartbeat` ms; one not refreshed for `stale` ms is abandoned. Adjustable for tests. */
export const LOCK_TIMING = { heartbeat: 5_000, stale: 30_000, timeout: 60_000 };

/** Whether a process with this pid exists on this machine. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path);
      return;
    } catch (e: any) {
      // Windows: the target may be briefly open by a reader.
      if (attempt < 20 && (e.code === "EPERM" || e.code === "EBUSY" || e.code === "EACCES")) await sleep(25);
      else {
        await rm(tmp, { force: true });
        throw e;
      }
    }
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

const lockContext = new AsyncLocalStorage<Store>();

/** Item, group, changeset and agent ids: a name, never a path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class Store {

  constructor(readonly root: string) {}

  get lockPath() {
    return join(this.root, "lock");
  }
  private dir(kind: "agents" | "changesets" | "groups" | "items") {
    return join(this.root, kind);
  }

  exists() {
    return exists(join(this.root, "state.json"));
  }

  async init(mainBranch: string): Promise<void> {
    for (const d of ["agents", "changesets", "groups", "items"] as const) await mkdir(this.dir(d), { recursive: true });
    if (!(await exists(join(this.root, "config.json")))) await writeJsonAtomic(join(this.root, "config.json"), defaultConfig(mainBranch));
    if (!(await exists(join(this.root, "state.json")))) {
      const state: StoreState = { schema: 1, nextItem: 1, nextChangeset: 1, nextGroup: 1, nextEvent: 1, base: null };
      await writeJsonAtomic(join(this.root, "state.json"), state);
    }
    if (!(await exists(join(this.root, "events.jsonl")))) await writeFile(join(this.root, "events.jsonl"), "");
  }

  async config(): Promise<StetConfig> {
    const raw = await readJson<Partial<StetConfig>>(join(this.root, "config.json"));
    return mergeConfig(defaultConfig(raw?.mainBranch ?? "main"), raw ?? {});
  }

  async saveConfig(cfg: StetConfig): Promise<void> {
    await writeJsonAtomic(join(this.root, "config.json"), cfg);
  }

  async state(): Promise<StoreState> {
    const s = await readJson<StoreState>(join(this.root, "state.json"));
    if (!s) throw new Error("Stet is not initialized in this repository (run `stet init`).");
    return s;
  }
  saveState(s: StoreState) {
    return writeJsonAtomic(join(this.root, "state.json"), s);
  }

  /**
   * Run `fn` holding the store lock. Re-entrant within the same async call chain.
   *
   * The lock file names its owner (host, pid, random token). While held, the owner refreshes the
   * file's time every few seconds, so a long operation is never mistaken for an abandoned one.
   * A lock is taken over only if its owner process is gone (same host) or its heartbeat stopped;
   * the takeover renames that exact file away first, so two waiters cannot both take it.
   * The owner removes the lock only if it still holds its token.
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (lockContext.getStore() === this) return fn();
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
      try {
        const fh = await open(this.lockPath, "wx");
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() }));
        await fh.close();
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST" && e.code !== "EPERM") throw e;
        if (await this.takeOverIfAbandoned()) continue;
        if (Date.now() - started > LOCK_TIMING.timeout) throw new Error(`Timed out waiting for the Stet lock (${this.lockPath}).`);
        await sleep(30 + Math.random() * 70);
      }
    }
    const beat = setInterval(() => {
      const t = new Date();
      utimes(this.lockPath, t, t).catch(() => undefined);
    }, LOCK_TIMING.heartbeat);
    beat.unref();
    try {
      return await lockContext.run(this, fn);
    } finally {
      clearInterval(beat);
      const cur = await readJson<{ token?: string }>(this.lockPath).catch(() => null);
      if (cur?.token === token) await rm(this.lockPath, { force: true });
    }
  }

  /** Remove the lock if its owner is gone. Returns true if it was removed. */
  private async takeOverIfAbandoned(): Promise<boolean> {
    let info: { pid?: number; host?: string; token?: string } | null;
    let mtime: number;
    try {
      info = await readJson(this.lockPath);
      mtime = (await stat(this.lockPath)).mtimeMs;
    } catch {
      return false; // released meanwhile, or unreadable for a moment: just retry
    }
    const heartbeatStopped = Date.now() - mtime > LOCK_TIMING.stale;
    const ownerGone = !!info?.pid && info.host === hostname() && !processAlive(info.pid);
    if (!heartbeatStopped && !ownerGone) return false;
    // Move exactly this lock file away; if someone else was faster, the rename fails or moves a
    // newer lock, which we then put back.
    const aside = `${this.lockPath}.${randomUUID()}.stale`;
    try {
      await rename(this.lockPath, aside);
    } catch {
      return false;
    }
    const moved = await readJson<{ token?: string }>(aside).catch(() => null);
    if (info?.token && moved?.token !== info.token) {
      await rename(aside, this.lockPath).catch(() => undefined);
      return false;
    }
    await rm(aside, { force: true });
    return true;
  }

  /** Allocate sequential ids. Call while holding the lock. */
  async allocate(kind: "item" | "changeset" | "group", n = 1): Promise<string[]> {
    const s = await this.state();
    const key = kind === "item" ? "nextItem" : kind === "changeset" ? "nextChangeset" : "nextGroup";
    const prefix = kind === "item" ? "S" : kind === "changeset" ? "C" : "G";
    const ids = Array.from({ length: n }, (_, i) => `${prefix}${s[key] + i}`);
    s[key] += n;
    await this.saveState(s);
    return ids;
  }

  private async getOne<T>(kind: "agents" | "changesets" | "groups" | "items", id: string): Promise<T | null> {
    // Ids come from agents (MCP arguments): never let one name a path.
    if (!SAFE_ID.test(id)) return null;
    return readJson<T>(join(this.dir(kind), `${id}.json`));
  }
  private async list<T>(kind: "agents" | "changesets" | "groups" | "items"): Promise<T[]> {
    let names: string[];
    try {
      names = await readdir(this.dir(kind));
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const n of names.filter((n) => n.endsWith(".json"))) {
      const v = await readJson<T>(join(this.dir(kind), n));
      if (v) out.push(v);
    }
    const num = (x: any) => Number(String(x.id).replace(/^\D+/, "")) || 0;
    return out.sort((a, b) => num(a) - num(b) || String((a as any).id).localeCompare(String((b as any).id)));
  }
  private put(kind: "agents" | "changesets" | "groups" | "items", v: { id: string }) {
    if (!SAFE_ID.test(v.id)) throw new Error(`Invalid id '${v.id}'.`);
    return writeJsonAtomic(join(this.dir(kind), `${v.id}.json`), v);
  }

  getAgent = (id: string) => this.getOne<Agent>("agents", id);
  getItem = (id: string) => this.getOne<Item>("items", id);
  getChangeset = (id: string) => this.getOne<Changeset>("changesets", id);
  getGroup = (id: string) => this.getOne<Group>("groups", id);
  agents = () => this.list<Agent>("agents");
  items = () => this.list<Item>("items");
  changesets = () => this.list<Changeset>("changesets");
  groups = () => this.list<Group>("groups");
  putAgent = (v: Agent) => this.put("agents", v);
  putItem = (v: Item) => this.put("items", v);
  putChangeset = (v: Changeset) => this.put("changesets", v);
  putGroup = (v: Group) => this.put("groups", v);
  deleteGroup = (id: string) => rm(join(this.dir("groups"), `${id}.json`), { force: true });

  /** Append an event. Call while holding the lock. */
  async appendEvent(e: Omit<StetEvent, "seq" | "at">): Promise<StetEvent> {
    const s = await this.state();
    const ev: StetEvent = { seq: s.nextEvent, at: new Date().toISOString(), ...e };
    s.nextEvent++;
    await this.saveState(s);
    await appendFile(join(this.root, "events.jsonl"), JSON.stringify(ev) + "\n", "utf8");
    return ev;
  }

  async events(since = 0): Promise<StetEvent[]> {
    let raw = "";
    try {
      raw = await readFile(join(this.root, "events.jsonl"), "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StetEvent)
      .filter((e) => e.seq > since);
  }
}
