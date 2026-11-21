/** Moving between changes, and which change a command acts on. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { changesAt, documentOrder, fromPanel, nextItemIndex } from "../src/model.js";

const src = (f: string) => readFileSync(join(__dirname, "../src", f), "utf8");

describe("j/k from a round or group row (test report v0.16, B4)", () => {
  // agent, round, change, change, group, change, change
  const rows = [false, false, true, true, false, true, true];
  it("goes to the change after or before the row, not to the panel's ends", () => {
    expect(nextItemIndex(rows, 4, 1)).toBe(5);
    expect(nextItemIndex(rows, 4, -1)).toBe(3);
    expect(nextItemIndex(rows, 1, 1)).toBe(2);
    expect(nextItemIndex(rows, 1, -1)).toBe(-1); // nothing before the first round's changes
  });
  it("steps between changes, stays at the ends, and starts at an end without a selection", () => {
    expect(nextItemIndex(rows, 2, 1)).toBe(3);
    expect(nextItemIndex(rows, 3, 1)).toBe(5);
    expect(nextItemIndex(rows, 6, 1)).toBe(6);
    expect(nextItemIndex(rows, 2, -1)).toBe(2);
    expect(nextItemIndex(rows, -1, 1)).toBe(2);
    expect(nextItemIndex(rows, -1, -1)).toBe(6);
    expect(nextItemIndex([false, false], -1, 1)).toBe(-1);
  });
});

describe("palette commands keep the focus where it is (test report v0.16, B6)", () => {
  it("only a key in the panel or a row's button counts as the panel", () => {
    expect(fromPanel("panel")).toBe(true);
    expect(fromPanel({ project: {}, node: { type: "item" } })).toBe(true);
    expect(fromPanel(undefined)).toBe(false); // the palette, a user's key binding
    expect(fromPanel({ path: "/p", id: "1.1" })).toBe(false); // CodeLens, hover
    expect(fromPanel("1.1")).toBe(false);
  });
});

describe("stet.navigationOrder: document (test report v0.16)", () => {
  it("orders changes by project, file and line, then id", () => {
    const xs = [
      { project: "/a", file: "b.tex", line: 3, id: "1.1" },
      { project: "/a", file: "a.tex", line: 9, id: "2.4" },
      { project: "/a", file: "a.tex", line: 2, id: "1.10" },
      { project: "/a", file: "a.tex", line: 2, id: "1.2" },
    ];
    expect(documentOrder(xs).map((x) => x.id)).toEqual(["1.2", "1.10", "2.4", "1.1"]);
  });
});

describe("overlapping changes at the cursor (test report v0.16)", () => {
  const r = (l0: number, c0: number, l1: number, c1: number, id: string) => ({
    id,
    range: { start: { line: l0, character: c0 }, end: { line: l1, character: c1 } },
  });
  it("are all named, so the command can ask which", () => {
    const a = r(2, 0, 2, 20, "1.1");
    const b = r(2, 5, 2, 30, "2.1");
    expect(changesAt([a, b], { line: 2, character: 10 }).map((x) => x.id)).toEqual(["1.1", "2.1"]);
    expect(changesAt([a, b], { line: 2, character: 25 })).toEqual([]); // only in one
    expect(changesAt([a], { line: 2, character: 10 })).toEqual([]);
  });
});

describe("which one?", () => {
  it('Escape in "which one?" decides nothing (test report 5e4c6af, D3)', () => {
    const e = src("extension.ts");
    expect(e).toContain("if (here === CANCELLED) return undefined;");
    expect(e).not.toContain("return (await this.atCursor()) ?? sel;");
  });
});
