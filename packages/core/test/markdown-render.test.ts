/** The Markdown a rendered preview of a change shows: which block, and where the marks go (the profile's `renderSource`). */
import { describe, expect, it } from "vitest";
import { blockAround, MARK_CLOSE, MARK_OPEN, markdownSides, markRange } from "../src/lang/markdown-render.js";

/** The marks shown as ⟦ and ⟧. */
const shown = (s: string) => s.replaceAll(MARK_OPEN, "⟦").replaceAll(MARK_CLOSE, "⟧");
const mark = (source: string, text: string) => {
  const a = source.indexOf(text);
  return shown(markRange(source, a, a + text.length));
};
const block = (text: string, inner: string) => {
  const a = text.indexOf(inner);
  const [s, e] = blockAround(text, a, a + inner.length);
  return text.slice(s, e);
};

const DOC = [
  "# Title",
  "",
  "First paragraph, one line.",
  "",
  "Second paragraph",
  "on two lines.",
  "",
  "```python",
  "def f():",
  "",
  "    return 1",
  "```",
  "",
  "Last paragraph.",
].join("\n");

describe("the block around a change", () => {
  it("is the paragraph it is in", () => {
    expect(block(DOC, "two lines")).toBe("Second paragraph\non two lines.");
    expect(block(DOC, "one line")).toBe("First paragraph, one line.");
  });

  it("is a whole code block, blank lines and all", () => {
    expect(block(DOC, "return 1")).toBe("```python\ndef f():\n\n    return 1\n```");
  });

  it("is the paragraphs on both sides of a change in blank lines", () => {
    const a = DOC.indexOf("\n\nLast");
    const [s, e] = blockAround(DOC, a + 1, a + 1);
    expect(DOC.slice(s, e)).toBe("```python\ndef f():\n\n    return 1\n```\n\nLast paragraph.");
  });
});

describe("marks around a change", () => {
  it("go around words, and after a heading's, a list's or a quote's markup", () => {
    expect(mark("Some old words here.", "old words")).toBe("Some ⟦old words⟧ here.");
    expect(mark("## A heading", "## A heading")).toBe("## ⟦A heading⟧");
    expect(mark("- [ ] a task\n> quoted", "- [ ] a task\n> quoted")).toBe("- [ ] ⟦a task⟧\n> ⟦quoted⟧");
    expect(mark("| a | b |\n|---|---|\n| c | d |", "| a | b |\n|---|---|\n| c | d |")).toBe("| ⟦a | b |⟧\n|---|---|\n| ⟦c | d |⟧");
  });

  it("go around a whole link, not between its text and its target", () => {
    expect(mark("See [the guide](b.md) now.", "(b.md)")).toBe("See ⟦[the guide](b.md)⟧ now.");
    expect(mark("See ![a plot](p.png) now.", "(p.png)")).toBe("See ⟦![a plot](p.png)⟧ now.");
    expect(mark("See [the guide](b.md) now.", "[the guide]")).toBe("See ⟦[the guide](b.md)⟧ now.");
  });

  it("leave fences, breaks and `$$` maths alone; mark code inside fences", () => {
    expect(mark("```\ncode here\n```", "```\ncode here\n```")).toBe("```\n⟦code here⟧\n```");
    expect(mark("Text.\n\n---\n\nMore.", "Text.\n\n---\n\nMore.")).toBe("⟦Text.⟧\n\n---\n\n⟦More.⟧");
    expect(mark("$$\nx = 1\n$$", "$$\nx = 1\n$$")).toBe("$$\nx = 1\n$$");
    // `#` in code is code.
    expect(mark("```sh\n# install\n```", "# install")).toBe("```sh\n⟦# install⟧\n```");
  });
});

describe("the sides of a change", () => {
  it("before and after, marked, with the file's reference definitions", () => {
    const text = "Intro.\n\nRead [the docs][d] for the old way.\n\n[d]: https://x.org\n";
    const a = text.indexOf("old");
    const { before, after } = markdownSides(text, a, a + 3, "new");
    expect(shown(before)).toBe("Read [the docs][d] for the ⟦old⟧ way.\n\n[d]: https://x.org\n");
    expect(shown(after)).toBe("Read [the docs][d] for the ⟦new⟧ way.\n\n[d]: https://x.org\n");
  });

  it("a new paragraph: after shows it, before the text around where it goes", () => {
    const text = "One.\n\nTwo.\n";
    const a = text.indexOf("\n\nTwo") + 1;
    const { before, after } = markdownSides(text, a, a, "\nNew paragraph.\n");
    expect(shown(after)).toBe("⟦New paragraph.⟧\n");
    expect(shown(before)).toBe("One.\n\nTwo.\n");
  });
});
