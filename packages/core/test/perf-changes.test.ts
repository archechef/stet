/** Checks for the optimization pass: relocation through cached line diffs, and the store's operation cache. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchor, captureContext } from "../src/anchor.js";
import { Store } from "../src/store.js";
import type { Item } from "../src/model.js";

/** Deterministic pseudo-random numbers (so a failure can be reproduced). */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

describe("relocation after random line edits", () => {
  it("finds every change in an unchanged line at its exact new position", () => {
    const rand = rng(42);
    for (let round = 0; round < 40; round++) {
      const lines = Array.from({ length: 30 + Math.floor(rand() * 40) }, (_, i) => `line ${i} alpha beta gamma ${Math.floor(rand() * 1e6)}`);
      const ref = lines.join("\n") + "\n";
      // Random edits: delete, insert or change lines; remember which original lines survive and where.
      const target: string[] = [];
      const newIndex = new Map<number, number>();
      for (let i = 0; i < lines.length; i++) {
        const r = rand();
        if (r < 0.1) continue; // deleted
        if (r < 0.2) target.push(`inserted ${round}-${i}`);
        if (r < 0.28) {
          target.push(lines[i]! + " changed");
          continue;
        }
        newIndex.set(i, target.length);
        target.push(lines[i]!);
      }
      const tgt = target.join("\n") + "\n";
      const startOf = (arr: string[], idx: number) => arr.slice(0, idx).reduce((n, l) => n + l.length + 1, 0);
      // Many items against the same two texts: the mapper is built once and reused.
      for (const [i, j] of newIndex) {
        const s = startOf(lines, i) + 5;
        const e = s + 5 + (i % 7);
        const item = { oldText: ref.slice(s, e), range: { start: s, end: e }, context: captureContext(ref, s, e) };
        const span = anchor(item, tgt, ref);
        const expected = startOf(target, j) + 5;
        expect(span, `round ${round}, line ${i}`).toEqual({ start: expected, end: expected + (e - s) });
      }
    }
  });

  it("maps a change at the very end of the text", () => {
    const ref = "a\nb\nc";
    const item = { oldText: "", range: { start: ref.length, end: ref.length }, context: captureContext(ref, ref.length, ref.length) };
    expect(anchor(item, "x\n" + ref, ref)).toEqual({ start: ref.length + 2, end: ref.length + 2 });
  });
});

describe("store cache during an operation", () => {
  it("hands out copies, sees its own writes, and is dropped when the lock is released", async () => {
    const root = mkdtempSync(join(tmpdir(), "stet-cache-"));
    try {
      const store = new Store(root);
      await store.init("master");
      const item = { id: "S1", status: "pending", groups: [] } as unknown as Item;
      await store.withLock(async () => {
        await store.putItem(item);
        const [a] = await store.items();
        a!.status = "accepted"; // mutating a copy must not change the cache
        expect((await store.getItem("S1"))!.status).toBe("pending");
        await store.putItem({ ...item, status: "rejected" });
        expect((await store.items())[0]!.status).toBe("rejected");
      });
      // Another writer (another process) changes the item after we released the lock.
      const other = new Store(root);
      await other.withLock(() => other.putItem({ ...item, status: "withdrawn" }));
      await store.withLock(async () => expect((await store.getItem("S1"))!.status).toBe("withdrawn"));
      expect((await store.getItem("S1"))!.status).toBe("withdrawn");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
