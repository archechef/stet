/** On-disk store in `<git-common-dir>/stet/` (spec §4, §15). */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, link, mkdir, open, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { configDelta, defaultConfig, mergeConfig, type StetConfig, validateConfig } from "./config.js";
import { StetError } from "./errors.js";
import {
  type Agent,
  type Changeset,
  compareItemIds,
  type Group,
  type Item,
  type NewEvent,
  type Note,
  type StetEvent,
  type StoreState,
  upgradeItem,
} from "./model.js";
import { pathExists } from "./paths.js";

/**
 * A held lock is refreshed every `heartbeat` ms. It counts as abandoned when its owner process is
 * gone (same machine), or when it was not refreshed for `stale` ms (owner on another machine) or
 * `liveOwner` ms (owner still running here, but hung). Adjustable for tests.
 */
export const LOCK_TIMING = { heartbeat: 5_000, stale: 30_000, liveOwner: 10 * 60_000, timeout: 60_000 };

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

/** The file in the store's folder rewritten after records change (see `Store.signalChange`). */
export const CHANGED_FILE = "changed";

type Kind = "agents" | "changesets" | "groups" | "items" | "notes";

/** A record as read from disk, in today's shape (see `upgradeItem`). */
function upgrade<T>(kind: Kind, v: T): T {
  return kind === "items" && v ? (upgradeItem(v as unknown as Item) as T) : v;
}

/** Item, group, changeset and agent ids: a name, never a path. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class Store {
  constructor(readonly root: string) {}

  /** Record files that could not be parsed (skipped by listings; reported by `stet doctor`). */
  readonly unreadable = new Set<string>();

  get lockPath() {
    return join(this.root, "lock");
  }
  private dir(kind: Kind) {
    return join(this.root, kind);
  }

  exists() {
    return pathExists(join(this.root, "state.json"));
  }

  async init(mainBranch: string): Promise<void> {
    for (const d of ["agents", "changesets", "groups", "items", "notes"] as const) await mkdir(this.dir(d), { recursive: true });
    if (!(await pathExists(join(this.root, "config.json")))) await writeJsonAtomic(join(this.root, "config.json"), configDelta(defaultConfig(mainBranch)));
    if (!(await pathExists(join(this.root, "state.json")))) {
      const state: StoreState = { schema: 1, nextChangeset: 1, nextGroup: 1, nextEvent: 1, base: null };
      await writeJsonAtomic(join(this.root, "state.json"), state);
    }
    if (!(await pathExists(join(this.root, "events.jsonl")))) await writeFile(join(this.root, "events.jsonl"), "");
  }

  async config(): Promise<StetConfig> {
    const raw = await readJson<Partial<StetConfig>>(join(this.root, "config.json"));
    return validateConfig(mergeConfig(defaultConfig(raw?.mainBranch ?? "main"), raw ?? {}));
  }

  async saveConfig(cfg: StetConfig): Promise<void> {
    await this.fence("saving the config");
    await writeJsonAtomic(join(this.root, "config.json"), configDelta(cfg));
  }

  async state(): Promise<StoreState> {
    const s = await readJson<StoreState>(join(this.root, "state.json"));
    if (!s) throw new Error("Stet is not initialized in this repository (run `stet init`).");
    return s;
  }
  async saveState(s: StoreState) {
    await this.fence("saving the state");
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
    const owner = JSON.stringify({ pid: process.pid, host: hostname(), token, at: Date.now() });
    for (;;) {
      try {
        await this.createLock(owner, token);
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
    this.session = new Map();
    this.token = token;
    this.wrote = false;
    try {
      return await lockContext.run(this, fn);
    } finally {
      // One signal per operation that changed records, while the lock is still held.
      if (this.wrote) await this.signalChange();
      this.session = null;
      this.token = null;
      clearInterval(beat);
      const cur = await readJson<{ token?: string }>(this.lockPath).catch(() => null);
      if (cur?.token === token) await rm(this.lockPath, { force: true });
    }
  }

  /**
   * Create the lock file with its owner in it, failing (EEXIST) if it exists. The owner is written
   * to a file of its own first, which is then linked as the lock: the lock appears whole or not at
   * all. Created empty and then written, a process stopped in between (a window reloaded, a
   * command killed) left an empty lock that named no owner, which nobody took over. Where links aren't possible, it is created and written as before.
   */
  private async createLock(owner: string, token: string): Promise<void> {
    const tmp = `${this.lockPath}.${token}.new`;
    await writeFile(tmp, owner);
    try {
      await link(tmp, this.lockPath);
    } catch (e: any) {
      if (e.code === "EEXIST") throw e;
      const fh = await open(this.lockPath, "wx");
      await fh.writeFile(owner);
      await fh.close();
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Remove the lock if its owner is gone. Returns true if it was removed. */
  private async takeOverIfAbandoned(): Promise<boolean> {
    let mtime: number;
    try {
      mtime = (await stat(this.lockPath)).mtimeMs;
    } catch {
      return false; // released meanwhile: just retry
    }
    // A lock that doesn't say whose it is (empty, or cut short) counts as another machine's: taken
    // over once it is older than `stale`. Its owner, if any, would have written it in milliseconds.
    const info = await readJson<{ pid?: number; host?: string; token?: string }>(this.lockPath).catch(() => null);
    const age = Date.now() - mtime;
    const here = !!info?.pid && info.host === hostname();
    const alive = here && processAlive(info!.pid!);
    // A live owner here keeps its lock unless it has been silent for very long (hung).
    const abandoned = here ? !alive || age > LOCK_TIMING.liveOwner : age > LOCK_TIMING.stale;
    if (!abandoned) return false;
    // Move exactly this lock file away; if someone else was faster, the rename fails or moves a
    // newer lock, which we then put back.
    const aside = `${this.lockPath}.${randomUUID()}.stale`;
    try {
      await rename(this.lockPath, aside);
    } catch {
      return false;
    }
    const moved = await readJson<{ token?: string }>(aside).catch(() => null);
    // Not the lock looked at (a new one appeared meanwhile): put it back.
    if ((moved?.token ?? null) !== (info?.token ?? null)) {
      await rename(aside, this.lockPath).catch(() => undefined);
      return false;
    }
    await rm(aside, { force: true });
    return true;
  }

  /** Token of the lock this process holds (null when not holding it). */
  private token: string | null = null;

  /** Whether the running operation holds this store's lock (is inside `withLock`). */
  get locked(): boolean {
    return lockContext.getStore() === this && !!this.token;
  }

  /**
   * Throw unless the running operation holds the lock: a write outside it could interleave with
   * another process's operation, and nothing else would notice. A mistake in Stet, not the user's.
   */
  assertLocked(what: string): void {
    if (!this.locked) throw new Error(`Internal error: ${what} outside the Stet lock (run it inside withLock).`);
  }

  /**
   * Fencing: before writing, make sure this process still holds the lock. A process whose lock was
   * taken over (after hanging for long) must not keep writing next to the new owner.
   */
  async fence(what = "a write"): Promise<void> {
    this.assertLocked(what);
    const cur = await readJson<{ token?: string }>(this.lockPath).catch(() => null);
    if (cur?.token !== this.token)
      throw new StetError("Stet lost its lock to another process (this one was unresponsive for too long); nothing more was written. Please try again.");
  }

  /** Allocate sequential ids. */
  async allocate(kind: "changeset" | "group" | "note", n = 1): Promise<string[]> {
    this.assertLocked("allocating ids");
    const s = await this.state();
    const key = kind === "changeset" ? "nextChangeset" : kind === "group" ? "nextGroup" : "nextNote";
    const prefix = kind === "changeset" ? "C" : kind === "group" ? "G" : "N";
    const next = s[key] ?? 1;
    const ids = Array.from({ length: n }, (_, i) => `${prefix}${next + i}`);
    s[key] = next + n;
    await this.saveState(s);
    return ids;
  }

  /**
   * Records cached for the operation that holds the lock: nobody else can write the store then,
   * so each kind is read from disk at most once per operation instead of on every lookup.
   * Callers get copies and may change them freely; writes go to disk and to the cache.
   */
  private session: Map<Kind, Map<string, unknown>> | null = null;

  private cached(kind: Kind): Map<string, unknown> | null {
    return lockContext.getStore() === this && this.session ? (this.session.get(kind) ?? null) : null;
  }

  private async getOne<T>(kind: Kind, id: string): Promise<T | null> {
    // Ids come from agents (MCP arguments): never let one name a path.
    if (!SAFE_ID.test(id)) return null;
    const c = this.cached(kind);
    if (c) return c.has(id) ? structuredClone(c.get(id) as T) : null;
    return upgrade(kind, await readJson<T>(join(this.dir(kind), `${id}.json`)));
  }

  private async list<T>(kind: Kind): Promise<T[]> {
    let records = this.cached(kind) as Map<string, T> | null;
    if (!records) {
      records = new Map();
      let names: string[] = [];
      try {
        names = await readdir(this.dir(kind));
      } catch {
        /* nothing yet */
      }
      // Read in parallel batches (bounded, so large stores don't run out of file handles).
      const files = names.filter((n) => n.endsWith(".json")).map((n) => join(this.dir(kind), n));
      for (let i = 0; i < files.length; i += 64) {
        const batch = await Promise.all(
          files.slice(i, i + 64).map((f) =>
            readJson<T>(f).catch(() => {
              this.unreadable.add(f); // e.g. a damaged file: skip it rather than failing every listing
              return null;
            }),
          ),
        );
        for (const v of batch) if (v && typeof (v as any).id === "string") records.set((v as any).id, upgrade(kind, v));
      }
      if (lockContext.getStore() === this && this.session) this.session.set(kind, records);
    }
    return [...records.values()].map((v) => structuredClone(v)).sort((a, b) => byId(String((a as any).id), String((b as any).id)));
  }

  private async put(kind: Kind, v: { id: string }) {
    if (!SAFE_ID.test(v.id)) throw new Error(`Invalid id '${v.id}'.`);
    await this.fence(`writing ${kind}`);
    // Stores made before a kind existed (notes) get its folder on first write.
    if (kind === "notes") await mkdir(this.dir(kind), { recursive: true });
    await writeJsonAtomic(join(this.dir(kind), `${v.id}.json`), v);
    this.cached(kind)?.set(v.id, structuredClone(v));
    if (kind === "items") this.itemsView = null;
    this.wrote = true;
  }

  private itemsView: { records: Map<string, unknown>; list: readonly Item[] } | null = null;

  /**
   * The items, shared and not copied: for lookups repeated many times in one locked operation,
   * which must not change them. `items()` copies every record on every call: locating the other
   * 750 changes of a file during an accept took 4 s. Outside the
   * lock, the same as `items()`.
   */
  async itemsReadOnly(): Promise<readonly Item[]> {
    if (!this.cached("items")) {
      const fresh = await this.items();
      if (!this.cached("items")) return fresh;
    }
    const records = this.cached("items")!;
    if (this.itemsView?.records !== records) this.itemsView = null;
    if (!this.itemsView) {
      const list = ([...records.values()] as Item[]).sort((a, b) => byId(a.id, b.id));
      this.itemsView = { records, list };
    }
    return this.itemsView.list;
  }

  /** Whether the operation holding the lock wrote a record: `withLock` then signals it once (see `signalChange`). */
  private wrote = false;

  /**
   * Rewrite `changed` in the store's folder: a record (item, group, changeset, agent, note) was
   * written or removed. Watchers of the folder (the VS Code panel) see the records' own files
   * only in subfolders, and not every operation appends an event (merging
   * changes into one, removing a group).
   */
  private async signalChange() {
    await writeFile(join(this.root, CHANGED_FILE), `${Date.now()}\n`).catch(() => undefined);
  }

  getAgent = (id: string) => this.getOne<Agent>("agents", id);
  getItem = (id: string) => this.getOne<Item>("items", id);
  getChangeset = (id: string) => this.getOne<Changeset>("changesets", id);
  getGroup = (id: string) => this.getOne<Group>("groups", id);
  agents = () => this.list<Agent>("agents");
  items = () => this.list<Item>("items");
  changesets = () => this.list<Changeset>("changesets");
  groups = () => this.list<Group>("groups");
  getNote = (id: string) => this.getOne<Note>("notes", id);
  notes = () => this.list<Note>("notes");
  putNote = (v: Note) => this.put("notes", v);
  putAgent = (v: Agent) => this.put("agents", v);
  putItem = (v: Item) => this.put("items", v);
  putChangeset = (v: Changeset) => this.put("changesets", v);
  putGroup = (v: Group) => this.put("groups", v);
  deleteGroup = async (id: string) => {
    await this.fence("removing a group");
    await rm(join(this.dir("groups"), `${id}.json`), { force: true });
    this.cached("groups")?.delete(id);
    this.wrote = true;
  };

  /** Append an event. */
  async appendEvent(e: NewEvent): Promise<StetEvent> {
    this.assertLocked("appending an event");
    const s = await this.state();
    const ev: StetEvent = { seq: s.nextEvent, at: new Date().toISOString(), ...e };
    s.nextEvent++;
    await this.saveState(s);
    await appendFile(join(this.root, "events.jsonl"), JSON.stringify(ev) + "\n", "utf8");
    return ev;
  }

  /** Parsed events so far; the log is append-only, so later calls only parse what was added. */
  private eventCache: { bytes: number; events: StetEvent[] } = { bytes: 0, events: [] };

  async events(since = 0): Promise<StetEvent[]> {
    let fh: Awaited<ReturnType<typeof open>>;
    try {
      fh = await open(join(this.root, "events.jsonl"), "r");
    } catch {
      return [];
    }
    try {
      const size = (await fh.stat()).size;
      if (size < this.eventCache.bytes) this.eventCache = { bytes: 0, events: [] }; // replaced: start over
      if (size > this.eventCache.bytes) {
        const buf = Buffer.alloc(size - this.eventCache.bytes);
        await fh.read(buf, 0, buf.length, this.eventCache.bytes);
        // Only complete lines; a line still being appended is read next time.
        const complete = buf.lastIndexOf(10) + 1;
        for (const line of buf.subarray(0, complete).toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            this.eventCache.events.push(JSON.parse(line) as StetEvent);
          } catch {
            /* a damaged line: skip it */
          }
        }
        this.eventCache.bytes += complete;
      }
    } finally {
      await fh.close();
    }
    return this.eventCache.events.filter((e) => e.seq > since);
  }
}

/**
 * Order of records by id: items by round and number (1.2 before 1.10: as decimals, 1.10 was 1.1), the others (C3, G12, N4) by their number.
 */
export function byId(a: string, b: string): number {
  if (/^\d+\.\d+$/.test(a) && /^\d+\.\d+$/.test(b)) return compareItemIds(a, b);
  const num = (x: string) => Number(x.replace(/^\D+/, "")) || 0;
  return num(a) - num(b) || a.localeCompare(b);
}
