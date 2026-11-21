import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { inlineDiff } from "../src/inline.js";
import { BIBTEX, LATEX, TYPST } from "../src/lang/index.js";
import { type Edit, splitText } from "../src/split.js";
import { changeSummary, paragraphChange } from "../src/text.js";
import { edit, read, setup, write } from "./helpers.js";

const cfg = defaultConfig("main").split;
const strict = { ...cfg, ignoreReflow: false };

function apply(old: string, edits: Edit[]): string {
  let out = old;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

const pairs = (edits: Edit[]) => edits.map((e) => [e.oldText, e.newText]);

const applyInOrder = (old: string, edits: { start: number; end: number; newText: string }[]) => {
  let out = old;
  // From the end; insertions at one place in reverse order, so they come out in order.
  const order = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.i - a.i);
  for (const { e } of order) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
};

describe("splitText (LaTeX)", () => {
  it("produces a word-level edit inside a sentence", () => {
    const old = "We study the problem of reviewing changes.\n";
    const neu = "We study the task of reviewing changes.\n";
    expect(pairs(splitText(LATEX, old, neu, cfg))).toEqual([["problem", "task"]]);
  });

  it("keeps edits in different sentences separate", () => {
    const old = "The cat sat on the mat. The dog ran in the park.\n";
    const neu = "The cat lay on the mat. The dog ran in the garden.\n";
    expect(pairs(splitText(LATEX, old, neu, cfg))).toEqual([
      ["sat", "lay"],
      ["park", "garden"],
    ]);
  });

  it("merges nearby edits in the same sentence", () => {
    const old = "This is a very good and quite useful result.\n";
    const neu = "This is an extremely good and quite helpful result.\n";
    expect(pairs(splitText(LATEX, old, neu, { ...cfg, mergeGap: 2 }))).toEqual([
      ["a very", "an extremely"],
      ["useful", "helpful"],
    ]);
    expect(pairs(splitText(LATEX, old, neu, { ...cfg, mergeGap: 3 }))).toEqual([["a very good and quite useful", "an extremely good and quite helpful"]]);
  });

  it("does not treat abbreviations as sentence ends", () => {
    const old = "Some tools, e.g. latexdiff work.\n";
    const neu = "Many tools, e.g. latexdiff help.\n";
    expect(splitText(LATEX, old, neu, { ...cfg, mergeGap: 8 })).toHaveLength(1);
    const withEnd = "Some tools. Latexdiff work.\n";
    expect(splitText(LATEX, withEnd, "Many tools. Latexdiff help.\n", { ...cfg, mergeGap: 8 })).toHaveLength(2);
  });

  it("takes inline math as a whole", () => {
    const old = "The formula $a + b = c$ holds.\n";
    const neu = "The formula $a + b = d$ holds.\n";
    expect(pairs(splitText(LATEX, old, neu, cfg))).toEqual([["$a + b = c$", "$a + b = d$"]]);
  });

  it("takes display math environments as a whole", () => {
    const old = "Text.\n\\begin{equation}\n  x = 1\n\\end{equation}\nMore.\n";
    const neu = "Text.\n\\begin{equation}\n  x = 2\n\\end{equation}\nMore.\n";
    const [e] = splitText(LATEX, old, neu, cfg);
    expect(e!.oldText).toBe("\\begin{equation}\n  x = 1\n\\end{equation}");
  });

  it("grows edits until braces are balanced", () => {
    const old = "Use {bold} text here.\n";
    const neu = "Use {bold text} here.\n";
    const bal = (s: string) => [...s].reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);
    const edits = splitText(LATEX, old, neu, cfg);
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) {
      expect(bal(e.oldText)).toBe(0);
      expect(bal(e.newText)).toBe(0);
    }
  });

  it("takes key arguments like \\ref{...} as a whole", () => {
    const old = "See Section~\\ref{sec:intro} for details.\n";
    const neu = "See Section~\\ref{sec:introduction} for details.\n";
    expect(pairs(splitText(LATEX, old, neu, cfg))).toEqual([["\\ref{sec:intro}", "\\ref{sec:introduction}"]]);
  });

  it("keeps a label rename separate from a rewrite of the same paragraph", () => {
    const old = "\\section{Introduction}\\label{sec:intro}\nIn this work we study the problem of reviewing changes that are proposed by an AI system.\n";
    const neu = "\\section{Introduction}\\label{sec:introduction}\nWe study how to review changes proposed by an AI system.\n";
    const edits = splitText(LATEX, old, neu, { ...cfg, rewriteRatio: 0.1, mergeGap: 10 });
    expect(edits[0]!.oldText).toBe("\\label{sec:intro}");
    expect(edits[0]!.newText).toBe("\\label{sec:introduction}");
    expect(edits.slice(1).every((e) => !e.oldText.includes("\\label"))).toBe(true);
  });

  it("ignores pure reflow by default", () => {
    const old = "A sentence that is\nwrapped here and there.\n";
    const neu = "A sentence that is wrapped\nhere and there.\n";
    expect(splitText(LATEX, old, neu, cfg)).toEqual([]);
    expect(splitText(LATEX, old, neu, strict).length).toBeGreaterThan(0);
  });

  it("coarsens heavily rewritten paragraphs into one edit", () => {
    const old = "One two three four five six seven eight nine ten.\n";
    const neu = "Uno dos tres four cinco seis siete eight nueve ten.\n";
    expect(splitText(LATEX, old, neu, { ...cfg, mergeGap: 0 })).toHaveLength(1);
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
    for (const [o, n] of cases) expect(apply(o, splitText(LATEX, o, n, strict))).toBe(n);
  });

  it("reports ranges in both texts", () => {
    const old = "x hello y\n";
    const neu = "x world y\n";
    const [e] = splitText(LATEX, old, neu, cfg);
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
    const edits = splitText(BIBTEX, old, neu, cfg);
    expect(edits).toHaveLength(2);
    expect(edits[0]!.oldText).toBe(a.trimEnd());
    expect(apply(old, edits)).toBe(neu);
  });

  it("handles added and deleted entries", () => {
    const edits = splitText(BIBTEX, a, a + "\n" + b, cfg);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.oldText).toBe("");
    expect(apply(a, edits).replace(/\s+/g, " ")).toBe((a + "\n" + b).replace(/\s+/g, " "));
    const del = splitText(BIBTEX, a + "\n" + b, b, cfg);
    expect(del).toHaveLength(1);
    expect(apply(a + "\n" + b, del)).toBe(b);
  });
});

describe("whitespace in verbatim text (test report v0.14, D7)", () => {
  const DOC = "\\begin{document}\nText.\n\\begin{lstlisting}\nx  =  1\n\\end{lstlisting}\n\\begin{verbatim}\na    b\n\\end{verbatim}\n\\end{document}\n";
  it("proposes a change of spaces in a listing or verbatim block", async () => {
    const { stet, repo } = await setup({ "main.tex": DOC });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "x  =  1", "x = 1");
    edit(wt, "main.tex", "a    b", "a b");
    const { items } = await stet.submit("a", { title: "ws" });
    expect(items.length).toBeGreaterThan(0);
    await stet.accept(items.map((i) => i.id));
    expect(read(repo, "main.tex")).toBe(read(wt, "main.tex"));
  });
});

describe("verbatim text (test report v0.14, D7)", () => {
  it("still ignores reflowed text outside verbatim blocks", async () => {
    const DOC = "\\begin{document}\nSome text that is\nwrapped here.\n\\begin{verbatim}\na  b\n\\end{verbatim}\n\\end{document}\n";
    const { stet } = await setup({ "main.tex": DOC });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "Some text that is\nwrapped here.", "Some text that is wrapped\nhere.");
    const { items } = await stet.submit("a", { title: "reflow" });
    expect(items).toHaveLength(0);
  });
});

describe("edits that rebuild one sentence (test report v0.14, D6)", () => {
  const S = "Plants are sessile organisms and therefore cannot escape stress.";
  const doc = (s: string) => `\\begin{document}\nIntroduction. ${s} More text follows here.\n\\end{document}\n`;
  async function submitted(after: string) {
    const { stet, repo } = await setup({ "main.tex": doc(S) });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", doc(after));
    return { ...(await stet.submit("a", { title: "t" })), stet, repo };
  }

  it("are one change (the tester's sentence)", async () => {
    const after = "Because plants are sessile organisms, they cannot escape stress.";
    const { items, stet, repo } = await submitted(after);
    expect(items).toHaveLength(1);
    await stet.accept([items[0]!.id]);
    expect(read(repo, "main.tex")).toBe(doc(after));
  });

  it("but word swaps a few words apart stay apart", async () => {
    const { items } = await submitted("Plants are immobile organisms and therefore cannot avoid stress.");
    expect(items.map((i) => [i.oldText, i.newText])).toEqual([
      ["sessile", "immobile"],
      ["escape", "avoid"],
    ]);
  });

  it("and so do edits in different sentences, or far apart", async () => {
    const far = await submitted("Plants are sessile organisms and therefore, sadly, cannot escape any stress.");
    expect(far.items.length).toBeGreaterThanOrEqual(1);
    const two = await submitted(S.replace("Plants", "Trees"));
    expect(two.items).toHaveLength(1);
    const { stet, repo } = await setup({ "main.tex": doc(S) });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", doc(S).replace("Introduction.", "Introduction, briefly.").replace("Plants are", "Trees are"));
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(2); // one sentence ends between them
    void repo;
  });
});

describe("split and joined paragraphs (a paragraph break moved past a sentence)", () => {
  const PARAS = `\\documentclass{article}
\\begin{document}
\\section{Intro}
Alpha one is the first sentence of the first paragraph here and it
goes on for a while. Beta two is the second sentence of that same
first paragraph, also somewhat long to fill a line.

Gamma three opens the second paragraph with some words that wrap
onto another line. Delta four closes the second paragraph with more
words that also wrap.

Epsilon five is a third paragraph standing on its own with words
that wrap around as well, like the others do here.

Zeta six is the last paragraph, kept so the document has a tail
that does not change at all in any of the cases.
\\end{document}
`;
  async function submitted(change: (s: string) => string) {
    const { stet, repo } = await setup({ "main.tex": PARAS });
    const { worktree: wt } = await stet.newAgent("a");
    const after = change(PARAS);
    write(wt, "main.tex", after);
    return { ...(await stet.submit("a", { title: "t" })), stet, repo, after };
  }
  // "Beta two …" ends paragraph one: it starts paragraph two instead (the tester's split + merge).
  const down = (s: string) => s.replace("while. Beta", "while.\n\nBeta").replace("line.\n\nGamma", "line. Gamma");
  // "Gamma three …" starts paragraph two: it ends paragraph one instead.
  const up = (s: string) => s.replace("line.\n\nGamma", "line. Gamma").replace("another line. Delta", "another line.\n\nDelta");

  it("is one change, not a move 'word for word', and accepts and undoes as one", async () => {
    for (const change of [down, up]) {
      const { items, stet, repo, after } = await submitted(change);
      expect(items).toHaveLength(1);
      expect(items[0]!.move).toBeUndefined();
      expect(paragraphChange(items[0]!.oldText, items[0]!.newText)).toBe("paragraph break moved");
      await stet.accept([items[0]!.id]);
      expect(read(repo, "main.tex")).toBe(after);
      await stet.undo(items[0]!.id);
      expect(read(repo, "main.tex")).toBe(PARAS);
    }
  });

  it("is one change too with a word of the sentence changed", async () => {
    const { items } = await submitted((s) => down(s).replace("the second sentence of", "the 2nd sentence of"));
    expect(items).toHaveLength(1);
    expect(items[0]!.move).toBeUndefined();
    expect(items[0]!.newText).toContain("2nd");
  });

  it("but a paragraph moved past another stays a move", async () => {
    const third = "Epsilon five is a third paragraph standing on its own with words\nthat wrap around as well, like the others do here.";
    const { items } = await submitted((s) => s.replace(`\n\n${third}`, "").replace("Alpha one", `${third}\n\nAlpha one`));
    expect(items.some((i) => i.move)).toBe(true);
  });

  it("names a split, a join and a moved break, and summarises each side at its break", () => {
    expect(paragraphChange(" ", "\n\n")).toBe("paragraph split");
    expect(paragraphChange("\n\n", " ")).toBe("paragraphs joined");
    expect(paragraphChange("a. b.\n\n", "a.\n\nb. ")).toBe("paragraph break moved");
    expect(paragraphChange("a b", "a c")).toBeNull();
    expect(paragraphChange("a b", "a\nb")).toBeNull(); // a line break: no paragraph
    const o = " Beta two is the second sentence of that same\nfirst paragraph, also long to fill a line.\n\n";
    const n = "\n\nBeta two is the second sentence of that same\nfirst paragraph, also long to fill a line. ";
    const [a, b] = changeSummary(o, n, 28);
    expect(a).toMatch(/^….*line\.¶$/);
    expect(b).toMatch(/^¶Beta two .*…$/);
    expect(a.length).toBeLessThanOrEqual(28);
    expect(b.length).toBeLessThanOrEqual(28);
  });

  it("shows only the breaks in the editor, not the whole text struck through", () => {
    const o = " Beta two is long.\n\n";
    const n = "\n\nBeta two is long. ";
    const d = inlineDiff(o, n);
    expect(d.removed).toEqual([
      [0, 1],
      [o.length - 2, o.length],
    ]);
    expect(d.inserted).toEqual([
      { at: 1, text: "\n\n" },
      { at: o.length, text: " " },
    ]);
  });
});

describe("headings and code blocks", () => {
  it("a sentence added before a new heading is an insertion, not the old sentence replaced (test report 5e4c6af, D4)", () => {
    const cases: [typeof TYPST, string, string][] = [
      [TYPST, "The bound is tight.\n$ x <= y $\n", "The bound is tight. We now state it.\n= Statement\nHere it is:\n$ x <= y $\n"],
      [
        TYPST,
        "Some text here. The bound is tight.\n$ x <= y $\nMore.\n",
        "Some text here. The bound is tight. We now state it.\n= Statement\nHere it is:\n$ x <= y $\nMore.\n",
      ],
      [TYPST, "The bound is tight.\n```py\nx=1\n```\n", "The bound is tight. We now state it.\n= Code\nHere it is:\n```py\nx=1\n```\n"],
      [LATEX, "The bound is tight.\n\\bibliography{refs}\n", "The bound is tight. We now state it.\n\\section{Statement}\nHere it is:\n\\bibliography{refs}\n"],
    ];
    for (const [p, o, nw] of cases) {
      const edits = splitText(p, o, nw, cfg);
      expect(applyInOrder(o, edits)).toBe(nw);
      // Nothing of the old text is taken out: each change only inserts.
      expect(
        edits.map((e) => e.oldText.trim()),
        JSON.stringify(edits),
      ).toEqual(edits.map(() => ""));
      // And each alone leaves the old text whole, with no words run together.
      for (const e of edits) expect(applyInOrder(o, [e]), JSON.stringify(e)).not.toMatch(/\.[A-Z=\\]/);
    }
  });

  it("a re-indented code block is one change, in Typst and LaTeX (test report 5e4c6af, D7)", () => {
    const o = "Text before.\n\n```python\ndef f(x):\n  if x:\n    return 1\n  return 2\n```\n\nAfter.\n";
    const nw = "Text before.\n\n```python\ndef f(x):\n    if x:\n        return 1\n    return 2\n```\n\nAfter.\n";
    expect(splitText(TYPST, o, nw, cfg)).toHaveLength(1);
    const v = (t: string) => t.replace("```python", "\\begin{verbatim}").replace("```\n\nAfter", "\\end{verbatim}\n\nAfter");
    expect(splitText(LATEX, v(o), v(nw), cfg)).toHaveLength(1);
  });
});
