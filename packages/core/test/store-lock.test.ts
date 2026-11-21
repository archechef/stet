/** The store lock: owners, stale and empty locks, and fencing a process that lost it. */
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Item } from "../src/model.js";
import { LOCK_TIMING, Store } from "../src/store.js";
import { outsideDir, PAPER, setup } from "./helpers.js";

describe("store lock (Codex review 2026-09, F5)", () => {
  const saved = { ...LOCK_TIMING };
  afterEach(() => Object.assign(LOCK_TIMING, saved));

  it("keeps a live owner's lock beyond the stale threshold", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, timeout: 5000 });
    const root = outsideDir();
    const a = new Store(root);
    const b = new Store(root);
    const log: string[] = [];
    const first = a.withLock(async () => {
      log.push("A in");
      await new Promise((r) => setTimeout(r, 800)); // > stale threshold
      log.push("A out");
    });
    await new Promise((r) => setTimeout(r, 50));
    await b.withLock(async () => void log.push("B in"));
    await first;
    expect(log).toEqual(["A in", "A out", "B in"]);
    expect(existsSync(join(root, "lock"))).toBe(false);
  });

  it("takes over a lock whose owner is gone, and never removes someone else's lock", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, timeout: 5000 });
    const root = outsideDir();
    // A crashed owner on this machine (pid that does not exist), with a fresh timestamp.
    writeFileSync(join(root, "lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(), token: "dead", at: Date.now() }));
    const s = new Store(root);
    let entered = false;
    await s.withLock(async () => {
      entered = true;
      // Someone replaces our lock (e.g. after a takeover): our release must leave theirs alone.
      writeFileSync(join(root, "lock"), JSON.stringify({ pid: process.pid, host: "x", token: "other" }));
    });
    expect(entered).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "lock"), "utf8")).token).toBe("other");
  });

  it("keeps the lock of a live owner on this machine even when its heartbeat stalls", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, liveOwner: 60_000, timeout: 600 });
    const root = outsideDir();
    const { hostname } = await import("node:os");
    writeFileSync(join(root, "lock"), JSON.stringify({ pid: process.pid, host: hostname(), token: "busy" }));
    const old = new Date(Date.now() - 10_000); // silent far longer than `stale`
    utimesSync(join(root, "lock"), old, old);
    await expect(new Store(root).withLock(async () => undefined)).rejects.toThrow(/Timed out/);
    expect(JSON.parse(readFileSync(join(root, "lock"), "utf8")).token).toBe("busy");
  });

  it("stops a displaced owner from writing (fencing)", async () => {
    const root = outsideDir();
    const store = new Store(root);
    await store.init("master");
    const item = { id: "S1", status: "pending", groups: [] } as unknown as Item;
    await expect(
      store.withLock(async () => {
        await store.putItem(item);
        // Another process took the lock over meanwhile.
        writeFileSync(join(root, "lock"), JSON.stringify({ pid: 1, host: "x", token: "someone-else" }));
        await store.putItem({ ...item, status: "accepted" });
      }),
    ).rejects.toThrow(/lost its lock/);
    expect(JSON.parse(readFileSync(join(root, "items", "S1.json"), "utf8")).status).toBe("pending");
  });

  it("refuses writes, new ids and events outside the lock (code quality report 6a517ae, lock)", async () => {
    const root = outsideDir();
    const store = new Store(root);
    await store.init("master");
    const other = new Store(root);
    const item = { id: "S1", status: "pending", groups: [] } as unknown as Item;
    const outside = /outside the Stet lock/;
    await expect(store.putItem(item)).rejects.toThrow(outside);
    await expect(store.deleteGroup("G1")).rejects.toThrow(outside);
    await expect(store.saveState(await store.state())).rejects.toThrow(outside);
    await expect(store.saveConfig(await store.config())).rejects.toThrow(outside);
    await expect(store.allocate("group")).rejects.toThrow(outside);
    await expect(store.appendEvent({ type: "submitted", actor: "x" } as never)).rejects.toThrow(outside);
    // Another Store's lock on the same folder is not this one's.
    await expect(other.withLock(() => store.putItem(item))).rejects.toThrow(outside);
    expect(existsSync(join(root, "items", "S1.json"))).toBe(false);
    expect(store.locked).toBe(false);
    await store.withLock(async () => {
      expect(store.locked).toBe(true);
      await store.putItem(item);
    });
    expect(existsSync(join(root, "items", "S1.json"))).toBe(true);
  });

  it("refuses to update the base outside the lock (code quality report 6a517ae, lock)", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await expect(stet.ensureBase()).rejects.toThrow(/updating the base outside the Stet lock/);
    await expect(stet.recoverInterrupted()).rejects.toThrow(/outside the Stet lock/);
    await expect(stet.store.withLock(() => stet.ensureBase())).resolves.toMatch(/^[0-9a-f]{40}$/);
  });

  it("takes over an empty lock left by a process stopped while taking it (bug report 2026-11-20)", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, timeout: 5000 });
    const root = outsideDir();
    writeFileSync(join(root, "lock"), "");
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(root, "lock"), old, old);
    let entered = false;
    await new Store(root).withLock(async () => void (entered = true));
    expect(entered).toBe(true);
    expect(existsSync(join(root, "lock"))).toBe(false);
  });

  it("waits for an empty lock that is still fresh (its owner may be writing it)", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 60_000, timeout: 300 });
    const root = outsideDir();
    writeFileSync(join(root, "lock"), "");
    await expect(new Store(root).withLock(async () => undefined)).rejects.toThrow(/Timed out/);
    expect(readFileSync(join(root, "lock"), "utf8")).toBe("");
  });

  it("never shows the lock without its owner, and leaves no temporary files", async () => {
    const root = outsideDir();
    const s = new Store(root);
    await s.withLock(async () => {
      expect(JSON.parse(readFileSync(join(root, "lock"), "utf8"))).toMatchObject({ pid: process.pid, token: expect.any(String) });
    });
    expect(readdirSync(root).filter((f) => f.startsWith("lock"))).toEqual([]);
  });

  it("takes over a lock whose heartbeat stopped", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, timeout: 5000 });
    const root = outsideDir();
    writeFileSync(join(root, "lock"), JSON.stringify({ pid: process.pid, host: "another-machine", token: "old" }));
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(root, "lock"), old, old);
    let entered = false;
    await new Store(root).withLock(async () => void (entered = true));
    expect(entered).toBe(true);
  });
});
