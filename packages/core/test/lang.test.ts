/**
 * Language profiles: which file gets which, and that splitting, grouping, parts and the inline
 * diff take their rules from the profile, not from LaTeX. A made-up language ("toy": `#name`
 * headings, `<key>` defines a key, `@key` uses it, `[ ]` nest) shows the seams work.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { autoGroups } from "../src/grouping.js";
import { inlineDiff } from "../src/inline.js";
import { agentInstructions } from "../src/instructions.js";
import { BIBTEX, documentProfile, hasPreview, LATEX, PLAIN, profileByName, profileFor } from "../src/lang/index.js";
import type { LanguageProfile, SyntaxRules } from "../src/lang/profile.js";
import type { Item } from "../src/model.js";
import { settleParts } from "../src/parts.js";
import { splitText } from "../src/split.js";
import { tokenizeWords } from "../src/tokenizer.js";

const cfg = defaultConfig("main");

let n = 0;
function item(file: string, oldText: string, newText: string, extra: Partial<Item> = {}): Item {
  n++;
  return {
    id: `1.${n}`,
    agent: "a",
    changeset: "C1",
    file,
    kind: "modify",
    baseCommit: "x",
    range: { start: 0, end: oldText.length },
    oldText,
    newText,
    context: { before: "", after: "" },
    fingerprint: String(n),
    note: null,
    groups: [],
    status: "pending",
    resolution: null,
    supersedes: null,
    conflictsWith: [],
    history: [],
    thread: [],
    ...extra,
  };
}

/** A language that is not LaTeX: its rules are all Stet knows of it. */
const TOY_SYNTAX: SyntaxRules = {
  tokenize: tokenizeWords,
  isBoundary: (t) => t.text === "#",
  mathSpans: () => [],
  keySpans: () => [],
  isKeyEdit: () => false,
  verbatim: () => () => false,
  endsUnit: () => false,
  sentenceEnd: /[.?!]$/,
  structureLine: /^#/,
  sectionLine: /^#/,
  isStructureOnly: (t) => /^#[^\n]*$/.test(t.trim()),
  environmentOf: () => null,
  isEnvironmentBound: () => false,
  lineNesting: () => [],
  isCommand: () => false,
  inMath: () => false,
};
const counts = (re: RegExp) => (t: string) => {
  const out = new Map<string, number>();
  for (const m of t.matchAll(re)) out.set(m[1]!, (out.get(m[1]!) ?? 0) + 1);
  return out;
};
const change = (o: Map<string, number>, nw: Map<string, number>) => ({
  removed: [...o].filter(([k, c]) => c > (nw.get(k) ?? 0)).map(([k]) => k),
  added: [...nw].filter(([k, c]) => c > (o.get(k) ?? 0)).map(([k]) => k),
});
const TOY: LanguageProfile = {
  id: "toy",
  name: "Toy",
  extensions: /\.toy$/,
  fence: "",
  document: true,
  syntax: TOY_SYNTAX,
  references: {
    definitions: (it) => [{ kind: { id: "label", noun: "anchor" }, ...change(counts(/<(\w+)>/g)(it.oldText), counts(/<(\w+)>/g)(it.newText)), fresh: false }],
    uses: (_kind, o, nw) => change(counts(/@(\w+)/g)(o), counts(/@(\w+)/g)(nw)),
  },
  parts: { global: (t) => t.includes("#import"), balance: (t) => [(t.match(/\[/g) ?? []).length - (t.match(/\]/g) ?? []).length], parity: [] },
};
const toyOf = (f: string) => (f.endsWith(".toy") ? TOY : profileByName(f));

describe("language profiles", () => {
  it("a file gets its profile from the config's patterns, else plain text", () => {
    expect(profileFor("main.tex", cfg.files)).toBe(LATEX);
    expect(profileFor("chapters/intro.tex", cfg.files)).toBe(LATEX);
    expect(profileFor("refs.bib", cfg.files)).toBe(BIBTEX);
    expect(profileFor("notes.md", cfg.files)).toBe(PLAIN);
    // The patterns are the user's: another extension can be LaTeX.
    expect(profileFor("paper.ltx2", { ...cfg.files, tex: ["*.ltx2"] })).toBe(LATEX);
    expect(profileFor("main.tex", { ...cfg.files, tex: ["*.ltx2"] })).toBe(PLAIN);
  });

  it("front ends know previews and code blocks by file name", () => {
    expect(hasPreview("main.tex")).toBe(true);
    expect(hasPreview("macros.sty")).toBe(false); // LaTeX, but not compiled on its own
    expect(hasPreview("refs.bib")).toBe(false);
    expect(profileByName("macros.sty").fence).toBe("latex");
    expect(profileByName("notes.md").fence).toBe("");
    expect(documentProfile()).toBe(LATEX);
  });

  it("splits by the profile's syntax, by its units, or by lines", () => {
    const old = "One sentence here. Another one there.\n";
    const neu = "One sentence here. Another one elsewhere.\n";
    // Plain text: the changed line. A language with syntax rules: the changed word.
    expect(splitText(PLAIN, old, neu, cfg.split).map((e) => e.oldText)).toEqual([old]);
    expect(splitText(TOY, old, neu, cfg.split).map((e) => [e.oldText, e.newText])).toEqual([["there", "elsewhere"]]);
    // A heading of the language is a block of its own: a change next to it doesn't take it along.
    const doc = "# Intro\nSome text that stays the same here.\n";
    const edits = splitText(TOY, doc, doc.replace("# Intro", "# Overview"), cfg.split);
    expect(edits.map((e) => e.newText)).toEqual(["Overview"]);
  });

  it("groups renames by the profile's keys, with its own words", () => {
    const def = item("a.toy", "see <intro> here", "see <overview> here");
    const use = item("b.toy", "as in @intro", "as in @overview");
    const cite = item("c.tex", "\\cite{intro}", "\\cite{overview}");
    const ref = item("d.tex", "\\ref{intro}", "\\ref{overview}");
    const groups = autoGroups([def, use, cite, ref], cfg.grouping, toyOf);
    const g = groups.find((x) => x.kind === "linked")!;
    expect(g.title).toBe("Rename anchor intro → overview");
    // Keys are matched by kind, across languages: a LaTeX \ref uses labels too, a \cite doesn't.
    expect(g.items).toEqual([def.id, use.id, ref.id]);
    // Plain text has no keys at all.
    expect(
      autoGroups([item("a.md", "<intro>", "<overview>"), item("b.md", "@intro", "@overview")], cfg.grouping, () => PLAIN).filter((x) => x.kind === "linked"),
    ).toEqual([]);
  });

  it("parts follow the profile's balance and global changes", async () => {
    const open = item("a.toy", "x", "[x");
    const close = item("a.toy", "y", "y]");
    const other = item("a.toy", "z", "w");
    const one = (...xs: Item[]) => xs.map((i) => ({ title: i.id, items: [i.id] }));
    const r = await settleParts(one(open, close, other), [open, close, other], undefined, { profileOf: toyOf });
    expect(r.parts?.map((p) => p.items)).toEqual([[open.id, close.id], [other.id]]);
    // LaTeX braces in a toy file mean nothing: no join.
    const a = item("a.toy", "x", "{x");
    const b = item("a.toy", "y", "y}");
    expect((await settleParts(one(a, b), [a, b], undefined, { profileOf: toyOf })).parts?.length).toBe(2);
    // The profile's global change (an import) is kept with every other part.
    const imp = item("a.toy", "", "#import lib");
    expect((await settleParts(one(imp, other), [imp, other], undefined, { profileOf: toyOf })).parts).toBeUndefined();
  });

  it("the inline diff uses the language's tokens", () => {
    // LaTeX: `\alpha` is one token, replaced whole; any text: a backslash and a word.
    expect(inlineDiff("x \\alpha y", "x \\beta y", LATEX.syntax!.tokenize).inserted.map((i) => i.text)).toEqual(["\\beta"]);
    expect(inlineDiff("x \\alpha y", "x \\beta y").inserted.map((i) => i.text)).toEqual(["beta"]);
  });

  it("agents are told about the document's language, with its examples", () => {
    const t = agentInstructions("a");
    expect(t).toContain("for a LaTeX project");
    expect(t).toContain(LATEX.agentTerms!.reference);
    expect(t).toContain(LATEX.agentTerms!.location);
  });
});

describe("build files at setup (test report v0.16.0)", () => {
  it("ignores LaTeX's build files and the PDF of each source, not every PDF", async () => {
    const { buildIgnores } = await import("../src/lang/index.js");
    const files = ["main.tex", "main.aux", "main.log", "main.pdf", "main.synctex.gz", "figs/plot.pdf", "refs.bib", "ch/one.tex"];
    expect(buildIgnores(files)).toEqual(["*.aux", "*.log", "*.synctex.gz", "/main.pdf"]);
    expect(buildIgnores(["main.tex", "refs.bib"])).toEqual([]);
  });
});
