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

  // Decisions review db49f7d, 1 and 2. The sections share the sentence and the long line after
  // it: swapped, the line diff pairs A's sentence with B's.
  const SHARED = "This closing remark is the same in both sections, and it is long enough to fill the context.";
  const SEC_A = `Section A describes the method that we use for reviewing the documents carefully here.\nThe common wording stays here.\n${SHARED}\n`;
  const SEC_B = `Section B reports the results of the evaluation, in quite different words of its own.\nThe common wording stays here.\n${SHARED}\n`;

  it("follows a sentence's own section when sections are swapped, not the same sentence in the other", () => {
    const ref = SEC_A + SEC_B;
    const it0 = itemFor(ref, "common", 0); // in section A
    const target = SEC_B + SEC_A;
    expect(anchor(it0, target, ref)!.start).toBe(target.indexOf("common", SEC_B.length));
  });

  it("undoing after the sections are swapped finds the accepted wording in its own section", () => {
    // Accepted in A: "different" → "common" made both sentences the same.
    const ref = SEC_A + SEC_B; // as accepted
    const it0 = { ...itemFor(ref, "common", 0), newText: "different" };
    const target = SEC_B + SEC_A;
    expect(anchor(it0, target, ref)!.start).toBe(target.indexOf("common", SEC_B.length));
  });

  it("an insertion at the end of the file needs its preceding text to survive", () => {
    const ref = "Intro.\n\nAn old conclusion.\n";
    const ins = { oldText: "", range: { start: ref.length, end: ref.length }, context: captureContext(ref, ref.length, ref.length) };
    expect(anchor(ins, "A completely new document, every line replaced.\n", ref)).toBeNull();
    // Still found where the end of the file is as it was.
    const kept = "New first line.\n" + ref;
    expect(anchor(ins, kept, ref)).toEqual({ start: kept.length, end: kept.length });
    // A file that was empty: at the end of what it has now.
    const empty = { oldText: "", range: { start: 0, end: 0 }, context: { before: "", after: "" } };
    expect(anchor(empty, "Now some text.\n", "")).toEqual({ start: 15, end: 15 });
  });
});
