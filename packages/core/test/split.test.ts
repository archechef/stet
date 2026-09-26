import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { splitText, type Edit } from "../src/split.js";

const cfg = defaultConfig("main").split;
const strict = { ...cfg, ignoreReflow: false };

function apply(old: string, edits: Edit[]): string {
  let out = old;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

const pairs = (edits: Edit[]) => edits.map((e) => [e.oldText, e.newText]);

describe("splitText (LaTeX)", () => {
  it("produces a word-level edit inside a sentence", () => {
    const old = "We study the problem of reviewing changes.\n";
    const neu = "We study the task of reviewing changes.\n";
    expect(pairs(splitText("tex", old, neu, cfg))).toEqual([["problem", "task"]]);
  });

  it("keeps edits in different sentences separate", () => {
    const old = "The cat sat on the mat. The dog ran in the park.\n";
    const neu = "The cat lay on the mat. The dog ran in the garden.\n";
    expect(pairs(splitText("tex", old, neu, cfg))).toEqual([["sat", "lay"], ["park", "garden"]]);
  });

  it("merges nearby edits in the same sentence", () => {
    const old = "This is a very good and quite useful result.\n";
    const neu = "This is an extremely good and quite helpful result.\n";
    expect(pairs(splitText("tex", old, neu, { ...cfg, mergeGap: 2 }))).toEqual([["a very", "an extremely"], ["useful", "helpful"]]);
    expect(pairs(splitText("tex", old, neu, { ...cfg, mergeGap: 3 }))).toEqual([
      ["a very good and quite useful", "an extremely good and quite helpful"],
    ]);
  });

  it("does not treat abbreviations as sentence ends", () => {
    const old = "Some tools, e.g. latexdiff work.\n";
    const neu = "Many tools, e.g. latexdiff help.\n";
    expect(splitText("tex", old, neu, { ...cfg, mergeGap: 8 })).toHaveLength(1);
    const withEnd = "Some tools. Latexdiff work.\n";
    expect(splitText("tex", withEnd, "Many tools. Latexdiff help.\n", { ...cfg, mergeGap: 8 })).toHaveLength(2);
  });

  it("takes inline math as a whole", () => {
    const old = "The formula $a + b = c$ holds.\n";
    const neu = "The formula $a + b = d$ holds.\n";
    expect(pairs(splitText("tex", old, neu, cfg))).toEqual([["$a + b = c$", "$a + b = d$"]]);
  });

  it("takes display math environments as a whole", () => {
    const old = "Text.\n\\begin{equation}\n  x = 1\n\\end{equation}\nMore.\n";
    const neu = "Text.\n\\begin{equation}\n  x = 2\n\\end{equation}\nMore.\n";
    const [e] = splitText("tex", old, neu, cfg);
    expect(e!.oldText).toBe("\\begin{equation}\n  x = 1\n\\end{equation}");
  });

  it("grows edits until braces are balanced", () => {
    const old = "Use {bold} text here.\n";
    const neu = "Use {bold text} here.\n";
    const bal = (s: string) => [...s].reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);
    const edits = splitText("tex", old, neu, cfg);
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) {
      expect(bal(e.oldText)).toBe(0);
      expect(bal(e.newText)).toBe(0);
    }
  });

  it("takes key arguments like \\ref{...} as a whole", () => {
    const old = "See Section~\\ref{sec:intro} for details.\n";
    const neu = "See Section~\\ref{sec:introduction} for details.\n";
    expect(pairs(splitText("tex", old, neu, cfg))).toEqual([["\\ref{sec:intro}", "\\ref{sec:introduction}"]]);
  });

  it("keeps a label rename separate from a rewrite of the same paragraph", () => {
    const old = "\\section{Introduction}\\label{sec:intro}\nIn this work we study the problem of reviewing changes that are proposed by an AI system.\n";
    const neu = "\\section{Introduction}\\label{sec:introduction}\nWe study how to review changes proposed by an AI system.\n";
    const edits = splitText("tex", old, neu, { ...cfg, rewriteRatio: 0.1, mergeGap: 10 });
    expect(edits[0]!.oldText).toBe("\\label{sec:intro}");
    expect(edits[0]!.newText).toBe("\\label{sec:introduction}");
    expect(edits.slice(1).every((e) => !e.oldText.includes("\\label"))).toBe(true);
  });

  it("ignores pure reflow by default", () => {
    const old = "A sentence that is\nwrapped here and there.\n";
    const neu = "A sentence that is wrapped\nhere and there.\n";
    expect(splitText("tex", old, neu, cfg)).toEqual([]);
    expect(splitText("tex", old, neu, strict).length).toBeGreaterThan(0);
  });

  it("coarsens heavily rewritten paragraphs into one edit", () => {
    const old = "One two three four five six seven eight nine ten.\n";
    const neu = "Uno dos tres four cinco seis siete eight nueve ten.\n";
    expect(splitText("tex", old, neu, { ...cfg, mergeGap: 0 })).toHaveLength(1);
  });

  it("reconstructs the new text exactly when edits are applied (strict mode)", () => {
    const cases: [string, string][] = [
      ["Alpha beta gamma.\n\nDelta epsilon.\n", "Alpha BETA gamma.\n\nDelta epsilon zeta.\n"],
      ["\\section{Intro}\nText $x$ here.\n", "\\section{Introduction}\nText $y$ here, now.\n"],
      ["a\nb\nc\n", "a\nc\n"],
      ["", "New file content.\n"],
      ["Old content.\n", ""],
      ["Keep.\n\nRemove this paragraph.\n\nKeep too.\n", "Keep.\n\nKeep too.\n"],
      ["No newline at end", "No newline at the end"],
    ];
    for (const [o, n] of cases) expect(apply(o, splitText("tex", o, n, strict))).toBe(n);
  });

  it("reports ranges in both texts", () => {
    const old = "x hello y\n";
    const neu = "x world y\n";
    const [e] = splitText("tex", old, neu, cfg);
    expect(old.slice(e!.start, e!.end)).toBe("hello");
    expect(neu.slice(e!.newStart, e!.newEnd)).toBe("world");
  });
});

describe("splitText (bib)", () => {
  const a = "@article{knuth84,\n  title={Literate Programming},\n  year={1984}\n}\n";
  const b = "@book{lamport94,\n  title={LaTeX},\n  year={1994}\n}\n";

  it("makes one edit per changed entry", () => {
    const old = a + "\n" + b;
    const neu = a.replace("1984", "1983") + "\n" + b.replace("LaTeX", "LaTeX: A Document Preparation System");
    const edits = splitText("bib", old, neu, cfg);
    expect(edits).toHaveLength(2);
    expect(edits[0]!.oldText).toBe(a.trimEnd());
    expect(apply(old, edits)).toBe(neu);
  });

  it("handles added and deleted entries", () => {
    const edits = splitText("bib", a, a + "\n" + b, cfg);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.oldText).toBe("");
    expect(apply(a, edits).replace(/\s+/g, " ")).toBe((a + "\n" + b).replace(/\s+/g, " "));
    const del = splitText("bib", a + "\n" + b, b, cfg);
    expect(del).toHaveLength(1);
    expect(apply(a + "\n" + b, del)).toBe(b);
  });
});
