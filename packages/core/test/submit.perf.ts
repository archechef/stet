/**
 * How long submit takes on larger revisions, and that it still splits them right. Run with
 * `npm run test:perf` (not part of `npm test` or CI). Each check prints its time; the limits are
 * generous, to catch a slowdown by an order of magnitude, not a slow machine.
 */
import { describe, expect, it } from "vitest";
import { setup, write } from "./helpers.js";

/** Deterministic pseudo-random numbers that don't repeat in the lengths used here (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` paragraphs of `words` made-up words each, all different. */
function paragraphs(n: number, words: number, seed = 1): string[] {
  const r = rng(seed);
  const word = () => Array.from({ length: 3 + Math.floor(r() * 6) }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(r() * 26)]).join("");
  return Array.from({ length: n }, (_, k) => `Paragraph ${k} ${Array.from({ length: words }, word).join(" ")}.`);
}

const doc = (ps: string[]) => `\\documentclass{article}\n\\begin{document}\n${ps.join("\n\n")}\n\\end{document}\n`;

async function timedSubmit(before: string[], after: string[], groups?: any[]) {
  const { stet } = await setup({ "main.tex": doc(before) });
  const { worktree: wt } = await stet.newAgent("a");
  write(wt, "main.tex", doc(after));
  const t0 = performance.now();
  const r = await stet.submit("a", { title: "t", ...(groups ? { groups } : {}) });
  return { r, ms: Math.round(performance.now() - t0) };
}

describe("submit on larger revisions", () => {
  it("one agent linked group of 150 changes (checked for dependencies change by change)", async () => {
    const ps = paragraphs(150, 20).map((p) => p.replace(/^Paragraph (\d+)/, "Paragraph $1 says that the method works well and"));
    const { r, ms } = await timedSubmit(ps, ps.map((p) => p.replace("works well", "performs well")), [{ kind: "linked", title: "Wording", where: ["main.tex"] }]);
    console.log(`linked group of 150 changes: ${ms} ms`);
    expect(r.items).toHaveLength(150);
    // The same change everywhere: one linked group (identical changes count as the same thing).
    expect(r.groups.filter((g) => g.kind === "linked").map((g) => g.items.length)).toEqual([150]);
    expect(ms).toBeLessThan(10_000);
  });

  it("150 changes in one agent linked group that Stet makes related", async () => {
    const ps = paragraphs(150, 20, 2);
    // A different word changed in every paragraph: no dependency between them.
    const after = ps.map((p) => p.replace(/^(Paragraph \d+ )(\S+)/, "$1changed"));
    const { r, ms } = await timedSubmit(ps, after, [{ kind: "linked", title: "Wording", where: ["main.tex"] }]);
    console.log(`linked group of 150 independent changes: ${ms} ms`);
    expect(r.items).toHaveLength(150);
    expect(r.groups.find((g) => g.title === "Wording")!.kind).toBe("related");
    expect(ms).toBeLessThan(10_000);
  });

  it("a section of 60 paragraphs in reverse order, a third of them replaced", async () => {
    const ps = paragraphs(60, 40, 3);
    const after = [...ps].reverse().map((p, k) => (k % 3 ? p : `Completely new paragraph number ${k} with other words entirely, sharing nothing at all.`));
    const { r, ms } = await timedSubmit(ps, after);
    console.log(`60 paragraphs reversed, 20 replaced: ${ms} ms, ${r.items.length} changes, ${r.moves.length} moves`);
    // 40 paragraphs kept: all but one or two move, a paragraph each; the 20 replaced ones are a
    // deletion and an insertion each, linked to nothing.
    expect(r.moves.length).toBeGreaterThanOrEqual(38);
    for (const m of r.moves) expect([m.from.length, m.to.length, m.changed]).toEqual([1, 1, 0]);
    const loose = r.items.filter((i) => !i.move);
    expect(loose.filter((i) => i.newText.includes("Completely new"))).toHaveLength(20);
    expect(loose.filter((i) => !i.oldText.trim() || !i.newText.trim())).toHaveLength(40);
    expect(ms).toBeLessThan(20_000);
  });

  it("a long paper with a small edit in every paragraph", async () => {
    const ps = paragraphs(400, 60, 4);
    const after = ps.map((p) => p.replace(/^(Paragraph \d+ \S+ \S+ )(\S+)/, "$1edited"));
    const { r, ms } = await timedSubmit(ps, after);
    console.log(`400 paragraphs, one word changed in each: ${ms} ms`);
    expect(r.items).toHaveLength(400);
    expect(r.items.every((i) => i.newText.trim() === "edited")).toBe(true);
    expect(ms).toBeLessThan(20_000);
  });
});
