/** Hovers, the More… menu and diffs. */
import { describe, expect, it } from "vitest";
import type { Item } from "@stet/core";
import { actionsTitle, diffBlock, draftMarkdown } from "../src/model.js";

const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id, agent: "a", changeset: "C1", file: "main.tex", kind: "modify", baseCommit: "b", range: { start: 0, end: 1 },
  oldText: "old", newText: "new", context: { before: "", after: "" }, fingerprint: "", note: null, groups: ["G1"],
  status: "pending", resolution: null, supersedes: null, conflictsWith: [], history: [], thread: [], ...extra,
});

describe("hovers with your wording (test report v0.16, B12)", () => {
  it("put the code block on lines of its own, so it is one", () => {
    const md = draftMarkdown({ draft: "a \\emph{hard} task", file: "main.tex" });
    expect(md).toMatch(/which Accept uses:\n\n```latex\na \\emph\{hard\} task\n```$/);
  });
});

describe("More… names a change once (test report v0.16, B13)", () => {
  it("gives the id, then the label without its number", () => {
    const it2 = item("4.12", { oldText: "fast", newText: "quick" });
    expect(actionsTitle(it2)).toMatch(/^4\.12: \S/);
    expect(actionsTitle(it2)).not.toMatch(/^4\.12: 12\b/);
  });
});

describe("diffs of .bib entries (test report 5e4c6af)", () => {
  it("a key-only change of a .bib entry shows the changed line, not the entry twice", () => {
    const entry = (k: string) => `@book{${k},\n  title = {The TeXbook},\n  author = {Knuth},\n  year = {1984}\n}`;
    const d = diffBlock(entry("knuth84"), entry("knuth1984"));
    expect(d).toContain("- @book{knuth84,");
    expect(d).toContain("+ @book{knuth1984,");
    expect(d).not.toContain("year");
  });
});
