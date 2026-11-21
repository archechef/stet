/** Hovers, the More… menu and diffs. */

import { describe, expect, it } from "vitest";
import { diffBlock, draftMarkdown } from "../src/markdown.js";
import { actionsTitle } from "../src/rows.js";
import { makeItem as item } from "./fixtures.js";

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
