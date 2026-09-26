import { describe, expect, it } from "vitest";
import { anchor, captureContext } from "../src/anchor.js";

function itemFor(text: string, needle: string, occurrence = 0) {
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = text.indexOf(needle, start + 1);
  const end = start + needle.length;
  return { oldText: needle, range: { start, end }, context: captureContext(text, start, end) };
}

const base = "First paragraph with some text.\n\nThe quick brown fox jumps over the lazy dog.\n\nLast paragraph.\n";

describe("anchor", () => {
  it("uses the range directly when nothing changed", () => {
    const it0 = itemFor(base, "brown");
    expect(anchor(it0, base, base)).toEqual(it0.range);
  });

  it("maps through edits elsewhere in the file", () => {
    const it0 = itemFor(base, "brown");
    const target = "A new first line.\n" + base;
    const span = anchor(it0, target, base)!;
    expect(target.slice(span.start, span.end)).toBe("brown");
    expect(span.start).toBe(it0.range.start + 18);
  });

  it("finds the text by context when the line itself changed", () => {
    const it0 = itemFor(base, "brown");
    const target = base.replace("quick brown", "very quick brown");
    const span = anchor(it0, target, base)!;
    expect(target.slice(span.start, span.end)).toBe("brown");
  });

  it("works without the reference text (context search)", () => {
    const it0 = itemFor(base, "lazy");
    const target = base.replace("Last paragraph.", "Final paragraph.");
    const span = anchor(it0, target)!;
    expect(target.slice(span.start, span.end)).toBe("lazy");
  });

  it("returns null when the text is gone", () => {
    const it0 = itemFor(base, "brown");
    expect(anchor(it0, base.replace("brown", "red"), base)).toBeNull();
  });

  it("distinguishes repeated words by context", () => {
    const text = "alpha the one.\n\nbeta the two.\n";
    const second = itemFor(text, "the", 1);
    const target = "intro\n" + text.replace("alpha", "ALPHA");
    const span = anchor(second, target, text)!;
    expect(target.slice(span.start - 5, span.end)).toBe("beta the");
  });

  it("locates pure insertions", () => {
    const start = base.indexOf("fox");
    const ins = { oldText: "", range: { start, end: start }, context: captureContext(base, start, start) };
    const target = "Preface.\n" + base;
    const span = anchor(ins, target, base)!;
    expect(target.slice(span.start, span.start + 3)).toBe("fox");
  });
});
