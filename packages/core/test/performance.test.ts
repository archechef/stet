/** Checks for the optimization pass: relocation through cached line diffs, and the store's operation cache. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchor, captureContext } from "../src/anchor.js";
import type { Item } from "../src/model.js";
import { LARGE_SUBMIT } from "../src/service.js";
import { Store } from "../src/store.js";
import { edit, PAPER, read, setup, write } from "./helpers.js";

/** Deterministic pseudo-random numbers (so a failure can be reproduced). */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} computes omega${i + 1} in every round.`).join("\n") + "\n";

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

describe("many changes in one long file (test report v0.14, B3)", () => {
  /** `n` lines of words from a 16-word vocabulary (every paragraph shares its words with every other), a blank every tenth. */
  function lines(n: number) {
    const vocab = "alpha beta gamma delta method result theorem proof lemma paper study analysis data model system approach".split(" ");
    let seed = 3;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: n }, (_, i) => (i % 10 === 9 ? "" : Array.from({ length: 12 }, () => vocab[Math.floor(r() * vocab.length)]).join(" ") + ` line${i}.`));
  }

  it("submits an edit in each of 150 paragraphs quickly, each paragraph its own change", async () => {
    const before = lines(1500);
    const after = before.map((l, i) => (i % 10 === 3 ? l.replace(" ", " very ") : l));
    const { stet, repo } = await setup({ "big.tex": before.join("\n") + "\n" });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "big.tex", after.join("\n") + "\n");
    const t0 = performance.now();
    const { items } = await stet.submit("a", { title: "t" });
    // Before: about 40 s (every pair of the 150 paragraphs diffed word by word).
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(items).toHaveLength(150);
    expect(items.every((i) => i.oldText === "" && i.newText.trim() === "very")).toBe(true);
    // Each change is where it belongs, and accepting them all gives the agent's file.
    await stet.accept(items.map((i) => i.id));
    expect(read(repo, "big.tex")).toBe(after.join("\n") + "\n");
  }, 60_000);

  it("pairs a long region the same way, with paragraphs added, removed and rewritten among the edits", async () => {
    const before = lines(800).filter((l) => l);
    const after = before.flatMap((l, i) =>
      i % 9 === 0 ? [] : i % 13 === 0 ? [l, "A new paragraph about something else entirely."] : i % 5 === 0 ? [l.replace(/\w+/, "changed")] : [l],
    );
    const doc = (ls: string[]) => ls.join("\n\n") + "\n";
    const { stet, repo } = await setup({ "big.tex": doc(before) });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "big.tex", doc(after));
    const { items } = await stet.submit("a", { title: "t" });
    expect(items.length).toBeGreaterThan(100);
    // No change swallows a neighbouring paragraph: none crosses a paragraph break both ways.
    expect(items.filter((i) => i.oldText.includes("\n\n") && i.newText.includes("\n\n") && i.oldText !== i.newText).length).toBe(0);
    await stet.accept(items.map((i) => i.id), { overrideLinked: true });
    expect(read(repo, "big.tex")).toBe(doc(after));
  }, 60_000);

  it("locateMany finds what locateInWorkingCopy finds, item by item", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    edit(wt, "main.tex", "It scales", "It also scales");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    edit(repo, "main.tex", "\\section{Introduction}", "\\section{Introduction}\nA line of mine.");
    const pending = items.slice(1);
    const many = await stet.locateMany(pending);
    for (const it of pending) expect(many.get(it.id)).toEqual(await stet.locateInWorkingCopy(it));
    const inText = await stet.locateMany(pending, read(repo, "main.tex"));
    for (const it of pending) expect(inText.get(it.id)!.span).toEqual(await stet.locateInText(it, read(repo, "main.tex")));
  });

  it("the read-only items within a locked operation follow its writes", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    const store: InstanceType<typeof Store> = (stet as any).store;
    await store.withLock(async () => {
      const a = await store.itemsReadOnly();
      expect(await store.itemsReadOnly()).toBe(a); // shared, not read again
      const it = (await store.getItem(items[0]!.id))!;
      it.note = "changed";
      await store.putItem(it);
      const b = await store.itemsReadOnly();
      expect(b).not.toBe(a);
      expect(b.find((i) => i.id === it.id)!.note).toBe("changed");
    });
    // Outside the lock: a fresh read each time.
    expect((await store.itemsReadOnly()).find((i) => i.id === items[0]!.id)!.note).toBe("changed");
  });
});

describe("locating while typing (test report v0.16, UX)", () => {
  it("locateMany uses the items the caller has, without reading the store", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds"));
    const { items } = await stet.submit("a", { title: "t" });
    const all = await stet.listItems();
    const reads = { n: 0 };
    const orig = stet.store.items;
    (stet.store as any).items = async () => {
      reads.n++;
      return orig();
    };
    const text = read(repo, "main.tex");
    const r = await stet.locateMany(items, text, all);
    expect(reads.n).toBe(0);
    expect(r.get(items[0]!.id)!.line).toBe(3);
    (stet.store as any).items = orig;
  });
});

describe("very large rounds", () => {
  it("a very large round is said to be, not refused (security report 5e4c6af, S15)", async () => {
    const was = { ...LARGE_SUBMIT };
    LARGE_SUBMIT.items = 1;
    try {
      const { stet } = await setup({ "main.tex": PAPER });
      const { worktree: wt } = await stet.newAgent("a");
      edit(wt, "main.tex", "effective in practice", "effective in real use");
      edit(wt, "main.tex", "reviewing changes", "reviewing edits");
      const r = await stet.submit("a", { title: "t" });
      expect(r.warnings.join(" ")).toMatch(/very large/);
      expect((await stet.store.getChangeset(r.changeset!.id))?.stetNote).toMatch(/very large round/);
    } finally {
      Object.assign(LARGE_SUBMIT, was);
    }
  });
});
