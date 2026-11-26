/**
 * Typst support, specified before it is built: what a Typst profile must do, mirroring what the
 * LaTeX tests check (tokenizer, split, grouping, parts, moves, realworld). The whole file is
 * skipped until a profile with id "typst" is registered in PROFILES; from then on, what fails is
 * what is left to build.
 *
 * Decisions this specifies (docs/spec.md §6.0, "Typst"):
 * - Files `*.typ` (the config's `files.typ`), code blocks fenced as `typst`.
 * - `@key` is a reference or a citation by what the project defines: a `<key>` label in a .typ
 *   file makes it a reference, an entry in the bibliography a citation. Bibliographies are
 *   BibTeX (.bib) for now. Hayagriva (.yml) is to come later as a profile of its own, whose
 *   entries define citation keys like BibTeX's do: nothing here may assume that citation keys
 *   come from .bib files only.
 * - A project's language is detected at setup from its files and kept in the config
 *   (`language`), LaTeX when in doubt; documentProfile(cfg) follows it.
 * - No PDF previews for Typst yet (no SyncTeX to find a change on the page): said, not attempted.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { autoGroups } from "../src/grouping.js";
import { inlineDiff } from "../src/inline.js";
import { documentProfile, hasPreview, LATEX, PROFILES, profileByName, profileFor } from "../src/lang/index.js";
import type { LanguageProfile } from "../src/lang/profile.js";
import type { Item, MoveInfo } from "../src/model.js";
import { settleParts } from "../src/parts.js";
import { type Edit, splitText } from "../src/split.js";
import { normalizeWs, paragraphChange } from "../src/text.js";
import { edit, git, makeItem, read, setup, write } from "./helpers.js";

const TYPST = PROFILES.find((p) => p.id === "typst") as LanguageProfile | undefined;
const T = () => TYPST!;
const spec = describe.skipIf(!TYPST);

const cfg = defaultConfig("main");
const split = cfg.split;
const strict = { ...split, ignoreReflow: false };
const pairs = (edits: Edit[]) => edits.map((e) => [e.oldText, e.newText]);
function apply(old: string, edits: Edit[]): string {
  let out = old;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

/** The Typst counterpart of the LaTeX PAPER fixture. */
export const TYPST_PAPER = [
  '#set document(title: "Reviewing changes")',
  "#let est = $hat(theta)$",
  "",
  "= Introduction <sec:intro>",
  "In this work we study the problem of reviewing changes. The changes are proposed by an AI.",
  "",
  "We show that this approach is effective in practice. It scales to large documents.",
  "",
  "As shown in @sec:intro, the approach works. The formula $a+b=c$ holds.",
  "",
].join("\n");

const BIB = "@article{lamport94,\n  title = {LaTeX},\n  author = {Lamport, Leslie},\n  year = {1994}\n}\n";
const BIB2 = BIB + "\n@book{knuth84,\n  title = {The TeXbook},\n  author = {Knuth, Donald},\n  year = {1984}\n}\n";

const item = (oldText: string, newText: string, extra: Partial<Item> = {}) => makeItem(oldText, newText, { file: "main.typ", ...extra });
const one = (...items: Item[]) => items.map((i) => ({ title: i.id, items: [i.id] }));
const ids = (parts: { items: string[] }[] | undefined) => parts?.map((p) => p.items);

// ---------------------------------------------------------------------------

spec("Typst: files and projects", () => {
  it("a .typ file gets the Typst profile, by the config's patterns and by its name", () => {
    expect((cfg.files as Record<string, string[]>).typ).toEqual(["*.typ"]);
    expect(profileFor("main.typ", cfg.files)).toBe(T());
    expect(profileFor("chapters/intro.typ", cfg.files)).toBe(T());
    expect(profileFor("main.tex", cfg.files)).toBe(LATEX);
    expect(profileByName("chapters/intro.typ")).toBe(T());
    expect(T().fence).toBe("typst");
    expect(T().document).toBe(true);
  });

  it("a project of .typ files is a Typst project; one with .tex files, or neither, LaTeX", async () => {
    const typst = await setup({ "main.typ": TYPST_PAPER, "refs.bib": BIB });
    expect((await typst.stet.config()).language).toBe("typst");
    expect(documentProfile(await typst.stet.config())).toBe(T());
    const latex = await setup({ "main.tex": "\\documentclass{article}\n", "notes.typ": "= Notes\n" });
    expect((await latex.stet.config()).language).toBe("latex");
    const none = await setup({ "notes.txt": "Hello.\n" });
    expect((await none.stet.config()).language).toBe("latex");
    expect(documentProfile(await none.stet.config())).toBe(LATEX);
  });

  it("agents of a Typst project are told so, with Typst examples", async () => {
    const { stet } = await setup({ "main.typ": TYPST_PAPER }, { cli: { command: process.execPath, args: ["/opt/stet/cli.js"] } });
    const { worktree: wt } = await stet.newAgent("a");
    const t = read(wt, "CLAUDE.local.md");
    expect(t).toContain("for a Typst project");
    expect(t).not.toContain("\\label");
    expect(t).toContain(T().agentTerms!.reference);
    expect(T().agentTerms!.reference).toMatch(/<.+>.*@/);
  });

  it("has no PDF previews yet, and says so", async () => {
    expect(hasPreview("main.typ")).toBe(false);
    const { stet } = await setup({ "main.typ": TYPST_PAPER });
    const env = await stet.previewStatus();
    expect(env.status).toBe("unavailable");
    expect(env.message).toMatch(/Typst/);
  });
});

// ---------------------------------------------------------------------------

spec("Typst: tokens", () => {
  const types = (s: string) =>
    T()
      .syntax!.tokenize(s)
      .map((t) => `${t.type}:${t.text}`);

  it("splits words, markup, brackets and punctuation", () => {
    expect(types("Hello #emph[world].")).toEqual(["word:Hello", "ws: ", "cmd:#emph", "lbrace:[", "word:world", "rbrace:]", "punct:."]);
    expect(types("#set text(size: 11pt)")).toContain("cmd:#set");
  });

  it("keeps hyphenated words and apostrophes together", () => {
    expect(types("state-of-the-art isn't")).toEqual(["word:state-of-the-art", "ws: ", "word:isn't"]);
  });

  it("recognizes maths, comments and paragraph breaks", () => {
    expect(types("$x$ // note\n\nNext")).toEqual(["math:$", "word:x", "math:$", "ws: ", "comment:// note", "parbreak:\n\n", "word:Next"]);
    expect(types("a /* block\ncomment */ b")).toContain("comment:/* block\ncomment */");
  });

  it("doesn't take escaped characters for markup", () => {
    const t = types("costs \\#5 or \\$3 at \\@home");
    expect(t.some((x) => x.startsWith("cmd:#"))).toBe(false);
    expect(t.some((x) => x === "math:$")).toBe(false);
  });

  it("records offsets", () => {
    expect(
      T()
        .syntax!.tokenize("ab  cd")
        .map((x) => x.start),
    ).toEqual([0, 2, 4]);
  });
});

// ---------------------------------------------------------------------------

spec("Typst: splitting a change into edits", () => {
  const s = (o: string, nw: string, c = split) => splitText(T(), o, nw, c);

  it("produces a word-level edit inside a sentence", () => {
    expect(pairs(s("We study the problem of reviewing changes.\n", "We study the task of reviewing changes.\n"))).toEqual([["problem", "task"]]);
  });

  it("keeps edits in different sentences separate", () => {
    expect(pairs(s("The cat sat on the mat. The dog ran in the park.\n", "The cat lay on the mat. The dog ran in the garden.\n"))).toEqual([
      ["sat", "lay"],
      ["park", "garden"],
    ]);
  });

  it("merges nearby edits in the same sentence", () => {
    const old = "This is a very good and quite useful result.\n";
    const neu = "This is an extremely good and quite helpful result.\n";
    expect(s(old, neu, { ...split, mergeGap: 2 })).toHaveLength(2);
    expect(s(old, neu, { ...split, mergeGap: 3 })).toHaveLength(1);
  });

  it("does not treat abbreviations as sentence ends", () => {
    expect(s("Some tools, e.g. typst work.\n", "Many tools, e.g. typst help.\n", { ...split, mergeGap: 8 })).toHaveLength(1);
    expect(s("Some tools. Typst work.\n", "Many tools. Typst help.\n", { ...split, mergeGap: 8 })).toHaveLength(2);
  });

  it("takes inline maths as a whole", () => {
    expect(pairs(s("The formula $a + b = c$ holds.\n", "The formula $a + b = d$ holds.\n"))).toEqual([["$a + b = c$", "$a + b = d$"]]);
  });

  it("takes display maths as a whole", () => {
    const [e] = s("Text.\n\n$\n  x = 1\n$\n\nMore.\n", "Text.\n\n$\n  x = 2\n$\n\nMore.\n");
    expect(e!.oldText).toBe("$\n  x = 1\n$");
    const [f] = s("We have $ x = 1 $ here.\n", "We have $ x = 2 $ here.\n");
    expect(f!.oldText).toBe("$ x = 1 $");
  });

  it("grows edits until brackets are balanced", () => {
    const bal = (t: string) => [...t].reduce((d, ch) => d + ("[{(".includes(ch) ? 1 : "]})".includes(ch) ? -1 : 0), 0);
    const edits = s("Use #emph[bold] text here.\n", "Use #emph[bold text] here.\n");
    expect(edits.length).toBeGreaterThan(0);
    for (const e of edits) {
      expect(bal(e.oldText)).toBe(0);
      expect(bal(e.newText)).toBe(0);
    }
  });

  it("takes labels and references as a whole", () => {
    expect(pairs(s("See @sec:intro for details.\n", "See @sec:introduction for details.\n"))).toEqual([["@sec:intro", "@sec:introduction"]]);
    expect(pairs(s("= Introduction <sec:intro>\nText.\n", "= Introduction <sec:introduction>\nText.\n"))).toEqual([["<sec:intro>", "<sec:introduction>"]]);
    // A label passed to `ref` alone is taken with the call, as `\ref{…}` is in LaTeX.
    expect(pairs(s("As in #ref(<sec:intro>).\n", "As in #ref(<sec:introduction>).\n"))).toEqual([["#ref(<sec:intro>)", "#ref(<sec:introduction>)"]]);
  });

  it("keeps a label rename separate from a rewrite of the same paragraph", () => {
    const old = "= Introduction <sec:intro>\nIn this work we study the problem of reviewing changes that are proposed by an AI system.\n";
    const neu = "= Introduction <sec:introduction>\nWe study how to review changes proposed by an AI system.\n";
    const edits = s(old, neu, { ...split, rewriteRatio: 0.1, mergeGap: 10 });
    expect(pairs(edits)[0]).toEqual(["<sec:intro>", "<sec:introduction>"]);
    expect(edits.slice(1).every((e) => !e.oldText.includes("<sec:"))).toBe(true);
  });

  it("a heading is a structure of its own: a change next to it doesn't take it along", () => {
    expect(pairs(s("= Introduction\nSome text that stays the same here.\n", "= Overview\nSome text that stays the same here.\n"))).toEqual([
      ["Introduction", "Overview"],
    ]);
    const edits = s("== Method\nWe measure speed.\n", "== Method\nWe measure the speed.\n");
    expect(edits.every((e) => !e.oldText.includes("=="))).toBe(true);
  });

  it("list items are units of their own", () => {
    const edits = s("- first point here\n- second point here\n", "- first point there\n- second point there\n");
    expect(edits).toHaveLength(2);
  });

  it("changes a setting in code mode word for word, not with the prose around it", () => {
    expect(pairs(s("#set text(size: 11pt)\nBody text.\n", "#set text(size: 12pt)\nBody text.\n"))).toEqual([["11pt", "12pt"]]);
  });

  it("spaces in raw text are content; elsewhere reflow is ignored", () => {
    const raw = "Code:\n```\nx  =  1\n```\n";
    expect(s(raw, raw.replace("x  =  1", "x = 1")).length).toBeGreaterThan(0);
    expect(s("Inline `a  b` here.\n", "Inline `a b` here.\n").length).toBeGreaterThan(0);
    const old = "A sentence that is\nwrapped here and there.\n";
    const neu = "A sentence that is wrapped\nhere and there.\n";
    expect(s(old, neu)).toEqual([]);
    expect(s(old, neu, strict).length).toBeGreaterThan(0);
  });

  it("coarsens heavily rewritten paragraphs into one edit", () => {
    expect(
      s("One two three four five six seven eight nine ten.\n", "Uno dos tres four cinco seis siete eight nueve ten.\n", { ...split, mergeGap: 0 }),
    ).toHaveLength(1);
  });

  it("reconstructs the new text exactly when edits are applied (strict mode)", () => {
    const cases: [string, string][] = [
      ["Alpha beta gamma.\n\nDelta epsilon.\n", "Alpha BETA gamma.\n\nDelta epsilon zeta.\n"],
      ["= Intro\nText $x$ here.\n", "= Introduction\nText $y$ here, now.\n"],
      ["#let f(x) = x + 1\nUse #f(2).\n", "#let f(x) = x + 2\nUse #f(3) twice.\n"],
      ["```py\nprint(1)\n```\n", "```py\nprint(2)\n```\n"],
      ["", "New file content.\n"],
      ["Old content.\n", ""],
      ["No newline at end", "No newline at the end"],
    ];
    for (const [o, nw] of cases) expect(apply(o, splitText(T(), o, nw, strict))).toBe(nw);
  });

  it("the inline diff uses Typst's tokens: a function name is one token", () => {
    expect(inlineDiff("x #alpha y", "x #beta y", T().syntax!.tokenize).inserted.map((i) => i.text)).toEqual(["#beta"]);
  });
});

// ---------------------------------------------------------------------------

spec("Typst: references and citations", () => {
  const LONG = TYPST_PAPER + "\nSee @sec:intro again, and #ref(<sec:intro>) once more.\n";

  it("links a label rename with its references as one unit: a reference to a missing label stops the build", async () => {
    // Unlike LaTeX's \label, whose parts can be accepted alone ("??"): test report 5e4c6af, D1.
    const { stet, repo } = await setup({ "main.typ": LONG });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", read(wt, "main.typ").replaceAll("sec:intro", "sec:introduction"));
    const r = await stet.submit("a", { title: "rename" });
    const g = r.groups.find((x) => x.kind === "linked")!;
    expect(g.title).toBe("Rename label sec:intro → sec:introduction");
    expect(g.items).toHaveLength(r.items.length);
    expect(g.parts, `${JSON.stringify(g.parts)}\n${shown(r.items)}`).toBeUndefined();
    const label = r.items.find((i) => i.oldText.includes("<sec:intro>") && i.context.before.includes("= Introduction"))!;
    await expect(stet.accept([label.id])).rejects.toThrow(/linked/);
    await stet.accept(g.items);
    expect(read(repo, "main.typ")).toBe(read(wt, "main.typ"));
  });

  it("@key is a citation when the bibliography has it: a new one is linked with its entry", async () => {
    const { stet } = await setup({ "main.typ": TYPST_PAPER + '#bibliography("refs.bib")\n', "refs.bib": BIB });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.typ", "effective in practice.", "effective in practice @knuth84.");
    write(wt, "refs.bib", BIB2);
    const r = await stet.submit("a", { title: "cite" });
    const cite = r.items.find((i) => i.newText.includes("@knuth84"))!;
    const entry = r.items.find((i) => i.file === "refs.bib")!;
    const g = r.groups.find((x) => x.kind === "linked" && x.items.includes(cite.id))!;
    expect(g.items).toContain(entry.id);
    expect(g.title).toBe("Add reference knuth84");
  });

  it("renaming a citation key links the entry with its @-uses and #cite(<…>)s", async () => {
    const doc = TYPST_PAPER + 'Old idea @knuth84 and #cite(<knuth84>).\n#bibliography("refs.bib")\n';
    const { stet } = await setup({ "main.typ": doc, "refs.bib": BIB2 });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", doc.replaceAll("knuth84", "knuth1984"));
    write(wt, "refs.bib", BIB2.replace("knuth84", "knuth1984"));
    const r = await stet.submit("a", { title: "rekey" });
    const g = r.groups.find((x) => x.kind === "linked")!;
    expect(g.title, shown(r.items)).toMatch(/^Rename citation key knuth84 → knuth1984/);
    expect(g.items).toHaveLength(3);
  });

  it("@key as a reference and as a citation are told apart by what the project defines", () => {
    // A label rename in a .typ file groups with an @-use; a citation key used the same way doesn't
    // become a label rename (the key is defined in the bibliography, not by a <label>).
    const def = item("<intro>", "<overview>");
    const use = item("@intro", "@overview");
    const groups = autoGroups([def, use], cfg.grouping);
    expect(groups.find((x) => x.kind === "linked")?.title).toMatch(/^Rename label intro → overview/);
    const bibDef = item("@book{knuth84,", "@book{knuth1984,", { file: "refs.bib" });
    const bibUse = item("@knuth84", "@knuth1984");
    const g2 = autoGroups([bibDef, bibUse], cfg.grouping).find((x) => x.kind === "linked");
    expect(g2?.title).toMatch(/^Rename citation key/);
  });

  it.todo("a Hayagriva .yml bibliography's entries are citation keys too (a profile of its own, later)");
});

// ---------------------------------------------------------------------------

spec("Typst: what parts of a linked group must keep together", () => {
  const typ = (o: string, nw: string, extra: Partial<Item> = {}) => item(o, nw, { file: "main.typ", ...extra });

  it("joins a #let definition with its uses, and a label with its references", async () => {
    const def = typ("#let est = $hat(theta)$", "#let estim = $hat(theta)$");
    const use = typ("#est", "#estim");
    const inMath = typ("$est$", "$estim$");
    const other = typ("is", "was");
    const { parts, notes } = await settleParts(one(def, use, inMath, other), [def, use, inMath, other]);
    expect(ids(parts)).toEqual([[def.id, use.id, inMath.id], [other.id]]);
    expect(notes.join()).toMatch(/defines .*est/);
    const label = typ("<a>", "<b>");
    const ref = typ("@a", "@b");
    // A reference to a missing label is an error in Typst (test report 5e4c6af, D1).
    expect((await settleParts(one(label, ref), [label, ref])).parts).toBeUndefined();
    const bib = item("@book{knuth84,", "@book{knuth1984,", { file: "refs.bib" });
    const cite = typ("@knuth84", "@knuth1984");
    expect((await settleParts(one(bib, cite, other), [bib, cite, other])).parts?.map((p) => p.items)).toEqual([[bib.id, cite.id], [other.id]]);
  });

  it("joins a function with parameters and its calls", async () => {
    const def = typ("#let vec(x) = $bold(#x)$", "#let vect(x) = $bold(#x)$");
    const call = typ("#vec[a]", "#vect[a]");
    expect((await settleParts(one(def, call), [def, call])).parts).toBeUndefined();
  });

  it("keeps imports, set rules and show rules with everything", async () => {
    const other = typ("is", "was");
    for (const g of ['#import "@preview/cetz:0.2.2": canvas', '#set text(lang: "de")', "#show heading: set text(blue)"]) {
      const glob = typ("", g);
      expect((await settleParts(one(glob, other), [glob, other])).parts).toBeUndefined();
    }
  });

  it("joins parts whose brackets or maths only close together", async () => {
    const open = typ("x", "#emph[x");
    const close = typ("y", "y]");
    const other = typ("is", "was");
    expect(ids((await settleParts(one(open, close, other), [open, close, other])).parts)).toEqual([[open.id, close.id], [other.id]]);
    const m1 = typ("a", "$a");
    const m2 = typ("b", "b$");
    expect((await settleParts(one(m1, m2), [m1, m2])).parts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

spec("Typst: files read in", () => {
  it("links an added chapter with its #include, and a figure with its #image", async () => {
    const { stet } = await setup({ "main.typ": TYPST_PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "chapters/discussion.typ", "= Discussion\nIt works.\n");
    write(wt, "figs/plot.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    write(wt, "main.typ", read(wt, "main.typ") + '#include "chapters/discussion.typ"\n#image("figs/plot.svg", width: 50%)\n');
    const r = await stet.submit("a", { title: "t" });
    const linked = r.groups.filter((g) => g.kind === "linked");
    const of = (f: string) => r.items.find((i) => i.file === f)!.id;
    const main = r.items.filter((i) => i.file === "main.typ").map((i) => i.id);
    expect(linked.some((g) => g.items.includes(of("chapters/discussion.typ")) && g.items.some((i) => main.includes(i)))).toBe(true);
    expect(linked.some((g) => g.items.includes(of("figs/plot.svg")) && g.items.some((i) => main.includes(i)))).toBe(true);
  });

  it("links a deleted chapter with the #include taken out", async () => {
    const { stet } = await setup({ "main.typ": TYPST_PAPER + '#include "old.typ"\n', "old.typ": "Old.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    git(wt, "rm", "-q", "old.typ");
    edit(wt, "main.typ", '#include "old.typ"\n', "");
    const r = await stet.submit("a", { title: "t" });
    expect(r.groups.some((g) => g.kind === "linked" && g.items.length === 2 && /Delete old\.typ/.test(g.title))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

spec("Typst: moves", () => {
  const P1 = "The first paragraph explains the setting in enough words to count as a real paragraph of text.";
  const P2 = "The second paragraph gives the result, again long enough that moving it is worth noticing here.";

  it("a paragraph moved word for word under another heading is one move", async () => {
    const before = ["= One", P1, "", P2, "", "= Two", "Closing words of the paper.", ""].join("\n");
    const after = ["= One", P1, "", "= Two", P2, "", "Closing words of the paper.", ""].join("\n");
    const { stet } = await setup({ "main.typ": before });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", after);
    const r = await stet.submit("a", { title: "move" });
    // (Moving the heading over the paragraph is the same document: the diff may show either.)
    expect(r.moves).toEqual([expect.objectContaining({ changed: 0 })]);
    expect(
      r.items.every((i) => i.move),
      shown(r.items),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------

spec("Typst: labels across rounds, and in rewrites", () => {
  it("links a label and its references across submissions, and keeps the link through revisions", async () => {
    const { stet } = await setup({ "main.typ": TYPST_PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.typ", "@sec:intro,", "@sec:introduction,");
    const r1 = await stet.submit("a", { title: "ref first" });
    expect(r1.groups).toEqual([]);
    edit(wt, "main.typ", "<sec:intro>", "<sec:introduction>");
    const r2 = await stet.submit("a", { title: "then the label" });
    expect(r2.groups).toHaveLength(1);
    expect(r2.groups[0]!.items.sort()).toEqual([r1.items[0]!.id, r2.items[0]!.id].sort());
    expect(r2.groups[0]!.title).toBe("Rename label sec:intro → sec:introduction");

    // Revising the reference into #ref(<…>) keeps it in the linked group.
    await stet.requestRevision(r1.items[0]!.id, "use #ref");
    edit(wt, "main.typ", "@sec:introduction,", "#ref(<sec:introduction>),");
    const r3 = await stet.submit("a", { title: "revised" });
    expect(r3.superseded).toEqual([r1.items[0]!.id]);
    const g = (await stet.listGroups()).find((x) => x.kind === "linked")!;
    expect(g.items).toContain(r3.items[0]!.id);
    expect(g.items).not.toContain(r1.items[0]!.id);
    await stet.acceptGroup(g.id);
    expect((await stet.listGroups()).find((x) => x.id === g.id)!.state).toBe("resolved");
    expect((await stet.feedback("a")).map((e) => e.type)).not.toContain("group_broken");
  });

  it("never merges a label rename into an atomic rewrite", async () => {
    const { stet } = await setup({ "main.typ": TYPST_PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.typ", "<sec:intro>\nIn this work we study the problem of reviewing changes.", "<sec:introduction>\nWe study how to review changes.");
    const r = await stet.submit("a", { title: "t", groups: [{ kind: "atomic", title: "Rewrite opening", where: ["main.typ:4-5"] }] });
    expect(r.items.find((i) => i.newText === "<sec:introduction>")).toBeDefined();
    expect(r.items.some((i) => i.newText.startsWith("We study") && !i.newText.includes("<sec:"))).toBe(true);
  });

  it("sees a #let on the changed line even when the change itself is only part of it", async () => {
    const def = item("", ", y", { context: { before: "#let f(x", after: ") = x\n" } });
    const use = item("#f(1)", "#f(1, 2)");
    expect((await settleParts(one(def, use), [def, use])).parts).toBeUndefined();
  });

  it("shows a small change in a long formula as just that change", () => {
    const ALIGN = "$\n  f(x) &= sum_(i=1)^n a_i x^i + b \\\n  g(x) &= integral_0^1 f(t) dif t\n$";
    const squash = (s: string) => s.replace(/\s+/g, "");
    const next = ALIGN.replace("a_i x^i + b", "a_i x^(i+1) + b");
    const d = inlineDiff(ALIGN, next, T().syntax!.tokenize);
    const parts = [...d.removed.map(([s, e]) => ALIGN.slice(s, e)), ...d.inserted.map((i) => i.text)];
    expect(parts.length).toBeLessThanOrEqual(3);
    expect(parts.every((p) => p.length <= 6)).toBe(true);
    let out = "";
    let pos = 0;
    const cuts = [...d.removed.map(([s, e]) => ({ s, e, ins: "" })), ...d.inserted.map((i) => ({ s: i.at, e: i.at, ins: i.text }))].sort(
      (a, b) => a.e - b.e || a.s - b.s,
    );
    for (const c of cuts) {
      out += ALIGN.slice(pos, c.s) + c.ins;
      pos = Math.max(pos, c.e);
    }
    expect(squash(out + ALIGN.slice(pos))).toBe(squash(next));
    const swap = ALIGN.replace("+ b", "- b");
    expect(inlineDiff(ALIGN, swap, T().syntax!.tokenize).removed.map(([s, e]) => ALIGN.slice(s, e))).toEqual(["+"]);
  });
});

// ---------------------------------------------------------------------------
// Prose in a Typst file: what the test reports found for LaTeX (split.test.ts: test report v0.14,
// D6 and D7, and paragraphs split and joined) holds here too. (scenarios.test.ts and moves.test.ts run in both
// languages.)

spec("Typst: prose", () => {
  async function submitted(before: string, after: string) {
    const { stet, repo } = await setup({ "main.typ": before });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", after);
    return { ...(await stet.submit("a", { title: "t" })), stet, repo, wt };
  }

  it("proposes a change of spaces in raw text, and accepts it as it is", async () => {
    const doc = "= Code\nText.\n\n```\nx  =  1\n```\n\nInline `a    b` here.\n";
    const { items, stet, repo, wt } = await submitted(doc, doc.replace("x  =  1", "x = 1").replace("a    b", "a b"));
    expect(items.length).toBeGreaterThan(0);
    await stet.accept(items.map((i) => i.id));
    expect(read(repo, "main.typ")).toBe(read(wt, "main.typ"));
  });

  it("still ignores reflowed text outside raw blocks", async () => {
    const doc = "= Code\nSome text that is\nwrapped here.\n\n```\na  b\n```\n";
    const { items } = await submitted(doc, doc.replace("Some text that is\nwrapped here.", "Some text that is wrapped\nhere."));
    expect(items).toHaveLength(0);
  });

  describe("edits that rebuild one sentence", () => {
    const S = "Plants are sessile organisms and therefore cannot escape stress.";
    const doc = (s: string) => `= Intro\nIntroduction. ${s} More text follows here.\n`;

    it("are one change", async () => {
      const after = "Because plants are sessile organisms, they cannot escape stress.";
      const { items, stet, repo } = await submitted(doc(S), doc(after));
      expect(items).toHaveLength(1);
      await stet.accept([items[0]!.id]);
      expect(read(repo, "main.typ")).toBe(doc(after));
    });

    it("but word swaps a few words apart stay apart", async () => {
      const { items } = await submitted(doc(S), doc("Plants are immobile organisms and therefore cannot avoid stress."));
      expect(items.map((i) => [i.oldText, i.newText])).toEqual([
        ["sessile", "immobile"],
        ["escape", "avoid"],
      ]);
    });

    it("and so do edits in different sentences", async () => {
      const { items } = await submitted(doc(S), doc(S).replace("Introduction.", "Introduction, briefly.").replace("Plants are", "Trees are"));
      expect(items).toHaveLength(2);
    });
  });

  describe("a paragraph break moved past a sentence", () => {
    const PARAS = [
      "= Intro",
      "Alpha one is the first sentence of the first paragraph here and it",
      "goes on for a while. Beta two is the second sentence of that same",
      "first paragraph, also somewhat long to fill a line.",
      "",
      "Gamma three opens the second paragraph with some words that wrap",
      "onto another line. Delta four closes the second paragraph with more",
      "words that also wrap.",
      "",
      "Epsilon five is a third paragraph standing on its own with words",
      "that wrap around as well, like the others do here.",
      "",
      "Zeta six is the last paragraph, kept so the document has a tail",
      "that does not change at all in any of the cases.",
      "",
    ].join("\n");
    const down = (s: string) => s.replace("while. Beta", "while.\n\nBeta").replace("line.\n\nGamma", "line. Gamma");
    const up = (s: string) => s.replace("line.\n\nGamma", "line. Gamma").replace("another line. Delta", "another line.\n\nDelta");

    it("is one change, not a move, and accepts and undoes as one", async () => {
      for (const change of [down, up]) {
        const { items, stet, repo } = await submitted(PARAS, change(PARAS));
        expect(items).toHaveLength(1);
        expect(items[0]!.move).toBeUndefined();
        expect(paragraphChange(items[0]!.oldText, items[0]!.newText)).toBe("paragraph break moved");
        await stet.accept([items[0]!.id]);
        expect(read(repo, "main.typ")).toBe(change(PARAS));
        await stet.undo(items[0]!.id);
        expect(read(repo, "main.typ")).toBe(PARAS);
      }
    });

    it("is one change too with a word of the sentence changed", async () => {
      const { items } = await submitted(PARAS, down(PARAS).replace("the second sentence of", "the 2nd sentence of"));
      expect(items).toHaveLength(1);
      expect(items[0]!.newText).toContain("2nd");
    });

    it("but a paragraph moved past another stays a move", async () => {
      const third = "Epsilon five is a third paragraph standing on its own with words\nthat wrap around as well, like the others do here.";
      const { items } = await submitted(PARAS, PARAS.replace(`\n\n${third}`, "").replace("Alpha one", `${third}\n\nAlpha one`));
      expect(items.some((i) => i.move)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Realistic revisions of Typst papers: what each change looks like, and that every review they
// allow gives a well-formed document (as realworld.test.ts checks for LaTeX).

type Files = Record<string, string>;
interface Run {
  items: Item[];
  groups: { id: string; kind: string; items: string[]; title: string }[];
  warnings: string[];
  moves: MoveInfo[];
  stet: Awaited<ReturnType<typeof setup>>["stet"];
  repo: string;
}
const nw = normalizeWs;
const has = (s: string, part: string) => nw(s).includes(nw(part));
const isIns = (i: Item) => !nw(i.oldText) && !!nw(i.newText);
const isDel = (i: Item) => !!nw(i.oldText) && !nw(i.newText);
const find = (r: Run, pred: (i: Item) => boolean, what: string): Item => {
  const hits = r.items.filter(pred);
  if (hits.length !== 1) throw new Error(`${what}: ${hits.length} items match, of\n${shown(r.items)}`);
  return hits[0]!;
};
/** Items as `id "old" → "new"`, one per line, for failure messages. */
const shown = (items: Item[]) => items.map((i) => `${i.id} ${JSON.stringify(i.oldText)} → ${JSON.stringify(i.newText)}`).join("\n");
const linkedOf = (r: Run, id: string) => r.groups.filter((g) => g.kind === "linked" && g.items.includes(id));

async function submitTyp(before: Files, after: Files, groups?: any[]): Promise<Run> {
  const { stet, repo } = await setup(before);
  const { worktree: wt } = await stet.newAgent("a");
  for (const [f, t] of Object.entries(after)) write(wt, f, t);
  const r = await stet.submit("a", { title: "Revision", ...(groups ? { groups } : {}) });
  const all = await stet.listGroups();
  const gs = r.groups.map((g) => all.find((x) => x.id === g.id)!).map((g) => ({ id: g.id, kind: g.kind, items: [...g.items], title: g.title }));
  return { items: r.items, groups: gs, warnings: r.warnings, moves: r.moves, stet, repo };
}

/** Decision units: each linked group with everything linked to it, and each change in none. */
function units(r: Run): string[][] {
  const parent = new Map(r.items.map((i) => [i.id, i.id]));
  const root = (x: string): string => (parent.get(x) === x ? x : root(parent.get(x)!));
  for (const g of r.groups.filter((g) => g.kind === "linked")) for (const i of g.items.slice(1)) parent.set(root(i), root(g.items[0]!));
  const by = new Map<string, string[]>();
  for (const i of r.items) by.set(root(i.id), [...(by.get(root(i.id)) ?? []), i.id]);
  return [...by.values()];
}

/** What must hold for any Typst document a review can produce from `before` and `after`. */
function wellFormedTyp(result: Files, before: Files, after: Files, what: string) {
  const all = (fs: Files) =>
    Object.entries(fs)
      .filter(([f]) => f.endsWith(".typ"))
      .map(([, t]) => t)
      .join("\n\n");
  const [res, old, neu] = [all(result), all(before), all(after)];
  // No paragraph twice (unless it was there twice).
  const paras = (t: string) =>
    t
      .split(/\n[ \t]*\n/)
      .map(nw)
      .filter((p) => p.length > 40);
  const count = (t: string) => paras(t).reduce((m, p) => m.set(p, (m.get(p) ?? 0) + 1), new Map<string, number>());
  const [cr, co, cn] = [count(res), count(old), count(neu)];
  for (const [p, k] of cr) expect(k, `${what}: paragraph twice: ${p.slice(0, 60)}`).toBeLessThanOrEqual(Math.max(co.get(p) ?? 1, cn.get(p) ?? 1));
  // Brackets balanced, and every $ with its partner (outside raw text and strings, without escapes).
  const plain = res
    .replace(/\\./g, "")
    .replace(/```[\s\S]*?```|`[^`]*`/g, "")
    .replace(/"[^"\n]*"/g, '""');
  for (const [o, c] of [
    ["[", "]"],
    ["{", "}"],
    ["(", ")"],
  ] as const) {
    const depth = [...plain].reduce((d, ch) => d + (ch === o ? 1 : ch === c ? -1 : 0), 0);
    expect(depth, `${what}: ${o}${c} don't balance`).toBe(0);
  }
  expect((plain.match(/\$/g) ?? []).length % 2, `${what}: a $ without its partner`).toBe(0);
  // Every name either version defines with #let, used as #name, in maths, or in code, is defined.
  const lets = (t: string) => new Set([...t.matchAll(/#let\s+([A-Za-z][\w-]*)/g)].map((m) => m[1]!));
  const known = new Set([...lets(old), ...lets(neu)]);
  const defined = lets(res);
  const code = [...plain.matchAll(/#[^\n]*|\$[^$]*\$/g)].map((m) => m[0]).join("\n");
  for (const name of known) {
    if (defined.has(name)) continue;
    expect(new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(code), `${what}: ${name} is used but not defined`).toBe(false);
  }
}

/** Accept everything, and each unit alone (each in a fresh copy), checking what must hold. */
async function checkTyp(before: Files, after: Files, groups?: any[]) {
  const r = await submitTyp(before, after, groups);
  const readAll = (repo: string) => Object.fromEntries(Object.keys({ ...before, ...after }).map((f) => [f, read(repo, f)]));
  await r.stet.accept(
    r.items.map((i) => i.id),
    { overrideLinked: true },
  );
  expect(readAll(r.repo)).toEqual({ ...before, ...after });
  const check = async (u: string[]) => {
    const shown = u
      .map((id) => r.items.find((i) => i.id === id)!)
      .map((i) => `${i.id} ${JSON.stringify(nw(i.oldText).slice(0, 30))}→${JSON.stringify(nw(i.newText).slice(0, 30))}`)
      .join(", ");
    const [fresh, other] = await Promise.all([submitTyp(before, after, groups), submitTyp(before, after, groups)]);
    await fresh.stet.accept(u);
    wellFormedTyp(readAll(fresh.repo), before, after, `accepting only ${shown}`);
    await other.stet.reject(u);
    const rest = other.items.filter((i) => !u.includes(i.id)).map((i) => i.id);
    if (rest.length) await other.stet.accept(rest, { overrideLinked: true });
    wellFormedTyp(readAll(other.repo), before, after, `accepting all but ${shown}`);
  };
  const todo = units(r);
  const workers = Array.from({ length: Math.min(4, todo.length) }, async () => {
    for (let u = todo.shift(); u; u = todo.shift()) await check(u);
  });
  const failed = (await Promise.allSettled(workers)).find((x) => x.status === "rejected");
  if (failed) throw failed.reason;
  return r;
}

// Scenario 1: polishing a paper (one file plus the bibliography)

const R = {
  intro: "Reviewing machine-made changes is slow when every edit arrives as one large diff.",
  goal: "Our goal is a review in which every change can be accepted or rejected on its own, safely.",
  cite: "Reviewing changes one at a time is an old idea from version control.",
  cited: "Reviewing changes one at a time is an old idea from version control @knuth84.",
  method: "We split each revision into small changes and group those that depend on each other.",
  estimator: "The quality of a split is measured by the estimator #est, which counts what a reviewer reads.",
  estimatorEdited: "The quality of a split is measured by the estimator #estim, which counts what a reviewer reads.",
  rewrite: "Thus the estimator converges quickly to the true value under mild conditions.",
  rewritten: "Hence this estimator converges rapidly towards the correct value under weak assumptions.",
  typos: "The rest of the proof follows teh same pattern, and we only sketch it here for completness.",
  fixed: "The rest of the proof follows the same pattern, and we only sketch it here for completeness.",
  dropped: "This paragraph repeats what the previous section already said and adds nothing new at all.",
};
const paper = (v: "old" | "new") =>
  [
    '#set document(title: "Reviewing changes")',
    v === "old" ? "#let est = $hat(theta)$" : "#let estim = $hat(theta)$",
    "",
    v === "old" ? "= Introduction <sec:intro>" : "= Introduction <sec:introduction>",
    R.intro,
    "",
    ...(v === "old" ? [R.goal, ""] : []),
    v === "old" ? R.cite : R.cited,
    "",
    "= Method",
    ...(v === "new" ? [R.goal, ""] : []),
    R.method,
    "",
    v === "old" ? R.estimator : R.estimatorEdited,
    "",
    `We prove the claim by induction. ${v === "old" ? R.rewrite : R.rewritten} The base case is immediate.`,
    "",
    v === "old" ? R.typos : R.fixed,
    "",
    ...(v === "old" ? [R.dropped, ""] : []),
    `As shown in @${v === "old" ? "sec:intro" : "sec:introduction"}, the estimator $${v === "old" ? "est" : "estim"}$ is unbiased.`,
    '#bibliography("refs.bib")',
    "",
  ].join("\n");

spec("Typst: polishing a paper, many kinds of change in one submission", () => {
  const before = { "main.typ": paper("old"), "refs.bib": BIB };
  const after = { "main.typ": paper("new"), "refs.bib": BIB2 };

  it("splits and groups each change as a reviewer would expect", async () => {
    const r = await submitTyp(before, after);
    expect(r.moves).toEqual([expect.objectContaining({ changed: 0 })]);
    const label = find(r, (i) => i.oldText.includes("<sec:intro>"), "label");
    expect(linkedOf(r, label.id).find((g) => g.title.startsWith("Rename label"))!.items).toHaveLength(2);
    const def = find(r, (i) => i.oldText.includes("#let est ") || nw(i.oldText) === "est", "definition");
    const uses = r.items.filter((i) => i !== def && /\bestim\b/.test(i.newText));
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(linkedOf(r, def.id).some((g) => g.items.includes(u.id))).toBe(true);
    const cite = find(r, (i) => i.newText.includes("@knuth84"), "citation");
    const entry = find(r, (i) => i.file === "refs.bib", "bib entry");
    expect(linkedOf(r, cite.id).some((g) => g.items.includes(entry.id))).toBe(true);
    find(r, (i) => has(i.oldText, "converges quickly") && has(i.newText, "converges rapidly"), "rewritten sentence");
    find(r, (i) => nw(i.oldText) === "teh", "typo 1");
    find(r, (i) => nw(i.oldText) === "completness", "typo 2");
    const dropped = find(r, (i) => isDel(i) && has(i.oldText, R.dropped), "dropped paragraph");
    expect(linkedOf(r, dropped.id)).toEqual([]);
    expect(r.items.some((i) => isIns(i) && has(i.newText, R.goal))).toBe(true);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkTyp(before, after);
  }, 120_000);
});

// Scenario 2: restructuring under headings

const Q = {
  a: "We first recall the model of computation, in which every machine has a bounded number of registers and a single tape.",
  b: "The cost of a run is the number of steps it takes, and the space is the largest number of cells it ever visits at once.",
  c: "Lemma 1 shows that every run of polynomial cost can be simulated with logarithmic space, provided the input is sorted first.",
  cRewritten: "Lemma 1 shows that any run of polynomial cost can be simulated in logarithmic space, as long as the input is sorted beforehand.",
  d: "Sorting itself takes linear space in the worst case, which is why the lemma needs the extra condition on the input.",
  e: "In practice the inputs are almost always sorted already, because they come out of the previous stage of the pipeline.",
  eNew: "Our experiments use inputs from three different pipelines, each producing between ten thousand and a million records.",
  f: "We now turn to the lower bound, which is the main technical contribution of this paper and takes the rest of the section.",
  fFixed: "We now turn to the lower bound, which is the main technical contribution of this paper and fills the rest of the section.",
  long: "The method is fast on every input that we tried.",
};
const restructured = (v: "old" | "new") =>
  [
    "= Model",
    // a and b are swapped; b gets one word changed.
    ...(v === "old" ? [Q.a, "", Q.b] : [Q.b.replace("largest", "maximal"), "", Q.a]),
    "",
    "= Simulation",
    // c moves to the end of the section and is rewritten (more than a move allows); e is replaced
    // in its place by an unrelated new paragraph, and moves into the next section, word for word.
    ...(v === "old" ? [Q.c, ""] : []),
    v === "old" ? `${Q.d} ${Q.long}` : Q.d,
    "",
    v === "old" ? Q.e : Q.eNew,
    "",
    ...(v === "new" ? [Q.cRewritten, ""] : []),
    "= Lower bound",
    ...(v === "new" ? [Q.e, ""] : []),
    // A sentence moves from the simulation section to here.
    v === "old" ? Q.f : `${Q.fFixed} ${Q.long}`,
    "",
  ].join("\n");

spec("Typst: restructuring, moves of every kind next to edits", () => {
  const before = { "main.typ": restructured("old") };
  const after = { "main.typ": restructured("new") };
  const groups = [
    { kind: "linked", title: "Reorganise the model and simulation sections", where: ["main.typ"] },
    { kind: "related", title: "Wording", where: ['main.typ "maximal"', 'main.typ "fills"'] },
  ];

  it("finds the moves, the rewritten move, the replacement, and makes the agent's big group related", async () => {
    const r = await submitTyp(before, after, groups);
    const titles = r.groups.map((g) => `${g.kind}: ${g.title}`);
    expect(r.moves).toHaveLength(3);
    expect(r.moves.map((m) => m.changed).sort()).toEqual([0, 0, 1]);
    const cOut = find(r, (i) => isDel(i) && has(i.oldText, Q.c), "c moved out");
    const cIn = find(r, (i) => isIns(i) && has(i.newText, Q.cRewritten), "c moved in");
    expect(linkedOf(r, cOut.id).some((g) => g.items.includes(cIn.id) && g.title.startsWith("Moved and rewritten"))).toBe(true);
    const eNew = find(r, (i) => isIns(i) && has(i.newText, Q.eNew), "new paragraph in e's place");
    expect(linkedOf(r, eNew.id)).toEqual([]);
    expect(titles).toContain("related: Reorganise the model and simulation sections");
    expect(r.warnings.join("\n")).toMatch(/'Reorganise the model and simulation sections' is a related group now/);
    expect(titles).toContain("related: Wording");
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkTyp(before, after, groups);
  }, 120_000);
});

// Scenario 3: moving a proof into an appendix (another file)

spec("Typst: moving material into an appendix", () => {
  const proof =
    "#block[\n  _Proof._ We argue by contradiction and assume that the bound fails for some input of length $n$.\n\n  Then the run visits more than $log n$ cells, which contradicts the choice of the input and ends the proof.\n]";
  const main = (body: string) =>
    `= Results <sec:results>\n#figure(kind: "theorem", supplement: [Theorem])[\n  Every run uses at most $log n$ cells.\n] <thm:main>\n${body}\n\n@thm:main is the main result of this paper, and the rest of it explains its consequences.\n#include "appendix.typ"\n`;
  const appendix = "= Appendix <sec:app>\nThis appendix collects the proofs that are too long for the main text of the paper.\n";
  const before = { "main.typ": main(proof), "appendix.typ": appendix };
  const after = { "main.typ": main("The proof is in @sec:app."), "appendix.typ": `${appendix}\n== Proof of @thm:main\n${proof}\n` };

  it("the proof moves to the other file as one move; the pointer to it is a change of its own", async () => {
    const r = await submitTyp(before, after);
    expect(r.moves).toHaveLength(1);
    const m = r.moves[0]!;
    const out = r.items.find((i) => i.id === m.from[0])!;
    const into = r.items.find((i) => i.id === m.to[0])!;
    expect([out.file, into.file]).toEqual(["main.typ", "appendix.typ"]);
    expect(has(out.oldText, "We argue by contradiction")).toBe(true);
    const pointer = find(r, (i) => i.newText.includes("The proof is in"), "pointer");
    expect(m.to).not.toContain(pointer.id);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkTyp(before, after);
  }, 120_000);
});

// Scenario 4: a section full of maths

const typMath = (v: "old" | "new") => {
  const o = v === "old";
  const k = o ? "n" : "m";
  const eq = o ? "eq:cost" : "eq:total-cost";
  const moved = ["$", "  u &= v + w, \\", "  w &= 2u - v.", "$"];
  return [
    ...(o ? [] : ["#let reals = $bb(R)$", ""]),
    "= Analysis",
    // Inline formulas: one symbol renamed in three of them (the agent links them), one sign fixed.
    `Let $${k}$ be the number of rounds and assume $${k} >= 2$ throughout.`,
    "",
    `The total cost is $${o ? "a+b" : "a-b"}$, and each round costs at most $2${k}$ steps.`,
    "",
    // A display formula with a label that is renamed, and referred to below.
    `$ C(x) = sum_(i=1)^${k} x_i / i + (integral_0^1 f(t) dif t)^2 $ <${eq}>`,
    "",
    // An aligned formula with one line changed and one line added.
    "$",
    "  f(x) &= x^2 + 1 \\",
    o ? "  g(x) &= sqrt(x) \\" : "  g(x) &= sqrt(x + 1) \\",
    ...(o ? [] : ["  k(x) &= log x \\"]),
    "  h(x) &= f(g(x))",
    "$",
    "",
    // Cases, with one branch changed.
    "$ s(x) = cases(",
    '  0 & "if" x < 0,',
    o ? '  x & "otherwise."' : '  x^2 & "otherwise."',
    ") $",
    "",
    // Prose with a reference to the renamed label, and a new definition used.
    `By @${eq}, the cost grows at most linearly in the number of rounds of the protocol.`,
    "",
    o
      ? "Every value of the cost function lies in the real numbers, which is all we need later."
      : "Every value of the cost function lies in $reals$, which is all we need later.",
    "",
    // A whole display formula moved to the end of the section, word for word.
    ...(o ? [...moved, ""] : []),
    "This closes the analysis of the protocol, and we turn to its implementation next.",
    ...(o ? [] : ["", ...moved]),
    "",
  ].join("\n");
};

spec("Typst: a section full of maths", () => {
  const before = { "main.typ": typMath("old") };
  const after = { "main.typ": typMath("new") };
  const groups = [{ kind: "linked", title: "Rename n to m", where: ['main.typ "$m$"', 'main.typ "m >= 2"', 'main.typ "$2m$"', 'main.typ "^m"'] }];

  it("keeps formulas whole, links what depends on each other, and moves the formula", async () => {
    const r = await submitTyp(before, after, groups);
    find(r, (i) => nw(i.oldText) === "$a+b$" && nw(i.newText) === "$a-b$", "sign fix");
    // A display formula is one change: the aligned one with its changed and added lines, the
    // cases with their branch.
    find(r, (i) => i.oldText.includes("sqrt(x)") && i.newText.includes("log x"), "aligned");
    find(r, (i) => i.oldText.includes('x & "otherwise') && i.newText.includes("x^2 &"), "cases");
    const eq = find(r, (i) => i.oldText.includes("<eq:cost>"), "equation label");
    const ref = find(r, (i) => i.oldText.includes("@eq:cost"), "reference");
    expect(linkedOf(r, eq.id).some((g) => g.items.includes(ref.id))).toBe(true);
    const def = find(r, (i) => i.newText.includes("#let reals"), "definition");
    const use = find(r, (i) => i.newText.includes("$reals$"), "use");
    expect(linkedOf(r, def.id).some((g) => g.items.includes(use.id))).toBe(true);
    const nm = r.groups.find((g) => g.title.startsWith("Rename n to m"))!;
    expect(nm.kind).toBe("linked");
    for (const s of ["$m$", "$m >= 2$", "$2m$"]) expect(nm.items).toContain(find(r, (i) => nw(i.newText) === s, s).id);
    expect(r.moves).toEqual([expect.objectContaining({ changed: 0 })]);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkTyp(before, after, groups);
  }, 180_000);
});

// Scenario 5: a figure with a table

const results = (v: "old" | "new") => {
  const o = v === "old";
  const mark = o ? "best" : "top";
  const label = o ? "tab:results" : "tab:running-times";
  return [
    `#let ${mark}(body) = text(weight: "bold", body)`,
    "",
    "= Results",
    `@${label} shows the running times we measured on the inputs of this section, one row per input.`,
    "",
    "#figure(",
    "  table(",
    "    columns: 3,",
    "    [Input], [Time], [Space],",
    `    [small], [#${mark}[2 s]], [#${mark}[1 MB]],`,
    `    [large], [${o ? "40 s" : "45 s"}], [#${mark}[8 MB]],`,
    ...(o ? [] : ["    [huge], [300 s], [64 MB],"]),
    "  ),",
    `  caption: [${o ? "Running times." : "Running times and space of each input."}],`,
    `) <${label}>`,
    "",
    "The large input takes most of the time, and its space grows linearly with its length.",
    "",
  ].join("\n");
};

spec("Typst: a figure with a table", () => {
  const before = { "main.typ": results("old") };
  const after = { "main.typ": results("new") };

  it("small changes in the table; the function rename and the label rename linked", async () => {
    const r = await submitTyp(before, after);
    find(r, (i) => i.oldText.includes("40") && i.newText.includes("45") && i.oldText.length < 12, "a cell");
    find(r, (i) => isIns(i) && i.newText.includes("huge"), "new row");
    find(r, (i) => i.newText.includes("each input"), "caption");
    const label = find(r, (i) => i.oldText.includes("<tab:results>"), "figure label");
    const ref = find(r, (i) => i.oldText.includes("@tab:results"), "figure reference");
    expect(linkedOf(r, label.id).some((g) => g.items.includes(ref.id))).toBe(true);
    // The function renamed with its three uses: linked (a call of an unknown function is an error).
    const def = find(r, (i) => i.oldText.includes("best") && (i.oldText.includes("#let") || i.context.before.endsWith("#let ")), "definition");
    const uses = r.items.filter((i) => i !== def && i.oldText.includes("best"));
    expect(uses).toHaveLength(3);
    for (const u of uses) expect(linkedOf(r, def.id).some((g) => g.items.includes(u.id))).toBe(true);
    expect(r.groups.filter((g) => g.items.includes(def.id))).toHaveLength(1);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkTyp(before, after);
  }, 180_000);
});

// Scenario 6: scripting, which LaTeX papers rarely do: data, a loop, a condition

const script = (v: "old" | "new") => {
  const o = v === "old";
  const tot = o ? "tot" : "elapsed";
  return [
    `#let data = (("small", 2), ("large", 40)${o ? "" : ', ("huge", 300)'})`,
    `#let ${tot} = data.map(r => r.at(1)).sum()`,
    "",
    "= Measurements",
    "We ran the tool on each input once, on an otherwise idle machine, and list the times here.",
    "",
    "#for (name, t) in data [",
    `  - Input #name ${o ? "took" : "needed"} #t seconds.`,
    "]",
    "",
    `#if ${tot} > ${o ? "30" : "60"} {`,
    `  [The sum of #${tot} seconds is too slow for interactive use, so we run it overnight.]`,
    "} else {",
    `  [${o ? "The sum is fine." : "The sum is fine for interactive use."}]`,
    "}",
    "",
    "The next section explains where the time goes, input by input, and what we did about it.",
    "",
  ].join("\n");
};

spec("Typst: scripting", () => {
  const before = { "main.typ": script("old") };
  const after = { "main.typ": script("new") };

  it("changes inside code are small, and a renamed variable is linked with its uses in code and markup", async () => {
    const r = await submitTyp(before, after);
    find(r, (i) => isIns(i) && i.newText.includes('("huge", 300)') && !i.newText.includes("#let"), "new data");
    find(r, (i) => nw(i.oldText) === "took" && nw(i.newText) === "needed", "loop body");
    // (The threshold may come with the variable renamed next to it: one token apart.)
    find(r, (i) => i.oldText.includes("30") && i.newText.includes("60") && i.oldText.length < 12, "threshold");
    find(r, (i) => i.newText.includes("for interactive use") && !i.newText.includes("#if"), "else branch");
    const def = find(r, (i) => /\btot\b/.test(i.oldText) && (i.oldText.includes("#let") || i.context.before.endsWith("#let ")), "definition");
    const uses = r.items.filter((i) => i !== def && /\btot\b/.test(i.oldText));
    expect(uses.map((u) => u.newText).join(), shown(r.items)).toMatch(/elapsed.*#elapsed|#elapsed.*elapsed/);
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(linkedOf(r, def.id).some((g) => g.items.includes(u.id))).toBe(true);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkTyp(before, after);
  }, 120_000);
});

describe("labels, references and files read in (test report 5e4c6af)", () => {
  it("B2: Typst comments and strings in code are neither labels nor references", () => {
    const refs = T().references!;
    const win = (it: Item, t: string) => it.context.before + t + it.context.after;
    const comment = item("// a note about <intro> and @intro", "// a note about <start> and @start");
    expect(refs.definitions(comment)[0]!.added).toEqual([]);
    expect(refs.uses("label", win(comment, comment.oldText), win(comment, comment.newText), cfg.grouping).added).toEqual([]);
    const str = item('#"see @intro"', '#"see @start"');
    expect(refs.uses("label", str.oldText, str.newText, cfg.grouping).added).toEqual([]);
    // Quotes in markup are text: a reference in them counts.
    const quoted = item('He said "see @intro".', 'He said "see @start".');
    expect(refs.uses("label", quoted.oldText, quoted.newText, cfg.grouping).added).toEqual(["start"]);
  });

  it("D1: in Typst a label rename and its references are one unit; in LaTeX a part each", () => {
    const def = item("<intro>", "<start>");
    const use = item("@intro", "@start");
    const g = autoGroups([def, use], cfg.grouping).find((x) => x.kind === "linked")!;
    expect(g.parts).toBeUndefined();
    const ldef = item("\\label{intro}", "\\label{start}", { file: "main.tex" });
    const luse = item("\\ref{intro}", "\\ref{start}", { file: "main.tex" });
    expect(autoGroups([ldef, luse], cfg.grouping).find((x) => x.kind === "linked")!.parts).toHaveLength(2);
  });

  it("D1: Typst parts never put a label and its references apart", async () => {
    const label = item("= Intro <intro>", "= Intro <start>");
    const ref = item("See @intro.", "See @start.");
    const other = item("is", "was");
    const { parts, notes } = await settleParts(
      [
        { title: "label", items: [label.id] },
        { title: "ref", items: [ref.id] },
        { title: "o", items: [other.id] },
      ],
      [label, ref, other],
      undefined,
      { grouping: cfg.grouping },
    );
    expect(parts?.map((p) => p.items)).toEqual([[label.id, ref.id], [other.id]]);
    expect(notes.join()).toMatch(/stops the build/);
  });

  it("D1: a partial accept of a Typst linked group says the document may not compile", async () => {
    const doc = "= Intro <intro>\nText.\n\nSee @intro.\n\nMore text here.\n";
    const { stet } = await setup({ "main.typ": doc });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", doc.replaceAll("intro", "start"));
    const r = await stet.submit("a", { title: "rename" });
    const g = r.groups.find((x) => x.kind === "linked")!;
    const res = await stet.accept([g.items[0]!], { overrideLinked: true });
    expect(res.warnings.join(" ")).toMatch(/may not compile/);
  });

  it("D8: a citation key renamed next to a maths edit is a change of its own", () => {
    const o = "The damping is $alpha = 3 times 10^(-4)$ as measured in @chumak2015 for YIG films.\n";
    const nw = "The damping is $alpha = (3.1 plus.minus 0.2) times 10^(-4)$ as measured in @chumak2015magnon for YIG films.\n";
    expect(splitText(T(), o, nw, cfg.split).map((e) => e.newText)).toEqual(["$alpha = (3.1 plus.minus 0.2) times 10^(-4)$", "@chumak2015magnon"]);
  });

  it("D5: in Typst a new label and a new reference to it are linked", () => {
    const def = item("= Method", "= Method <sec:method>");
    const use = item("", "The method is in @sec:method.");
    const g = autoGroups([def, use], cfg.grouping).find((x) => x.kind === "linked");
    expect(g?.items.sort()).toEqual([def.id, use.id].sort());
    expect(g?.parts).toBeUndefined();
    // LaTeX: "??" until both are there, so nothing to link.
    const ldef = item("\\section{Method}", "\\section{Method}\\label{sec:method}", { file: "main.tex" });
    const luse = item("", "The method is in \\ref{sec:method}.", { file: "main.tex" });
    expect(autoGroups([ldef, luse], cfg.grouping).find((x) => x.kind === "linked")).toBeUndefined();
  });

  it("D5: a new reference is linked with a pending rename of its label from an earlier round", async () => {
    const doc = "= Intro <intro>\nText.\n\nSee @intro.\n\nMore text here.\n";
    const { stet } = await setup({ "main.typ": doc });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", doc.replaceAll("intro", "start"));
    const r1 = await stet.submit("a", { title: "rename" });
    edit(wt, "main.typ", "More text here.", "More text here, as in @start.");
    const r2 = await stet.submit("a", { title: "use it" });
    const g = (await stet.listGroups()).find((x) => x.kind === "linked" && x.items.includes(r2.items[0]!.id));
    expect(g?.items).toEqual(expect.arrayContaining([...r1.items.map((i) => i.id), r2.items[0]!.id]));
  });

  it("D6: a new image read in by a relative path from a subfolder is grouped with the #image", async () => {
    const doc = '#include "chapters/one.typ"\n';
    const { stet } = await setup({ "main.typ": doc, "chapters/one.typ": "= One\nText.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "chapters/one.typ", "Text.", 'Text.\n#image("../figures/x.png")');
    write(wt, "figures/x.png", "PNG");
    const r = await stet.submit("a", { title: "figure" });
    const fig = r.items.find((i) => i.file === "figures/x.png")!;
    const use = r.items.find((i) => i.newText.includes("#image"))!;
    expect(r.groups.find((g) => g.kind === "linked")?.items.sort()).toEqual([fig.id, use.id].sort());
    expect(read(wt, "chapters/one.typ")).toContain("../figures/x.png");
  });
});
