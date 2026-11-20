import { describe, expect, it } from "vitest";
import { inlineDiff } from "../src/inline.js";
import { tokenize } from "../src/lang/latex.js";

/** Apply an inline diff to the old text: must give the new text (up to whitespace, which display ignores). */
function apply(oldText: string, d: ReturnType<typeof inlineDiff>): string {
  let out = "";
  let pos = 0;
  const cuts = [...d.removed.map(([s, e]) => ({ s, e, ins: "" })), ...d.inserted.map((i) => ({ s: i.at, e: i.at, ins: i.text }))].sort((a, b) => a.e - b.e || a.s - b.s);
  for (const c of cuts) {
    out += oldText.slice(pos, c.s) + c.ins;
    pos = Math.max(pos, c.e);
  }
  return squash(out + oldText.slice(pos));
}
const squash = (s: string) => s.replace(/\s+/g, "");

const ALIGN = String.raw`\begin{align}
  f(x) &= \sum_{i=1}^{n} a_i x^i + b \\
  g(x) &= \int_0^1 f(t)\,dt
\end{align}`;

describe("inlineDiff: what changes inside an item", () => {
  it("shows a small change in a long formula as just that change", () => {
    const next = ALIGN.replace("a_i x^i + b", "a_i x^{i+1} + b");
    const d = inlineDiff(ALIGN, next, tokenize);
    // Only a few small parts are marked, never the formula around them.
    const parts = [...d.removed.map(([s, e]) => ALIGN.slice(s, e)), ...d.inserted.map((i) => i.text)];
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.every((p) => p.length <= 4)).toBe(true);
    expect(apply(ALIGN, d)).toBe(squash(next));
    const swap = ALIGN.replace("+ b", "- b");
    expect(inlineDiff(ALIGN, swap, tokenize).removed.map(([s, e]) => ALIGN.slice(s, e))).toEqual(["+"]);
  });

  it("finds several changes, each in place", () => {
    const next = ALIGN.replace("\\sum_{i=1}", "\\sum_{i=0}").replace("\\int_0^1", "\\int_0^\\infty");
    const d = inlineDiff(ALIGN, next, tokenize);
    expect(d.removed.map(([s, e]) => ALIGN.slice(s, e))).toEqual(["1", "1"]);
    expect(d.inserted.map((i) => i.text)).toEqual(["0", "\\infty"]);
    expect(apply(ALIGN, d)).toBe(squash(next));
  });

  it("shows pure insertions without striking anything", () => {
    const d = inlineDiff("a + b", "a + b + c", tokenize);
    expect(d.removed).toEqual([]);
    expect(d.inserted).toEqual([{ at: 5, text: " + c" }]);
  });

  it("merges changes separated only by whitespace", () => {
    const d = inlineDiff("we study the problem of reviewing changes", "we study the task of checking changes", tokenize);
    expect(d.removed.length).toBe(2); // "problem" and "reviewing" are separated by "of"
    const d2 = inlineDiff("the big red house", "the small blue house", tokenize);
    expect(d2.removed.map(([s, e]) => "the big red house".slice(s, e))).toEqual(["big red"]);
    expect(d2.inserted.map((i) => i.text)).toEqual(["small blue"]);
  });

  it("ignores re-wrapped lines", () => {
    const d = inlineDiff("one two\nthree four", "one two three\nfour five", tokenize);
    expect(d.removed).toEqual([]);
    expect(d.inserted.map((i) => i.text)).toEqual([" five"]);
  });

  it("shows a mostly rewritten text as one replacement", () => {
    const d = inlineDiff("The results are good.", "Our findings look very promising indeed!", tokenize);
    expect(d.removed).toEqual([[0, 21]]);
    expect(d.inserted).toEqual([{ at: 21, text: "Our findings look very promising indeed!" }]);
    expect(inlineDiff("problem", "task", tokenize)).toEqual({ removed: [[0, 7]], inserted: [{ at: 7, text: "task" }] });
    expect(inlineDiff("", "new", tokenize)).toEqual({ removed: [], inserted: [{ at: 0, text: "new" }] });
    expect(inlineDiff("old", "", tokenize)).toEqual({ removed: [[0, 3]], inserted: [] });
  });
});
