/**
 * Real-world revisions: one submission with many changes of different kinds at once, as agents
 * produce them. Besides what each change should look like, every scenario checks what must hold
 * for any review:
 * - accepting everything gives the agent's text;
 * - accepting any one decision unit alone (a linked group, or a change in none) gives a
 *   well-formed document: no paragraph twice, no text lost outside the unit, environments and
 *   braces balanced, and no macro used that isn't defined.
 */
import { describe, expect, it } from "vitest";
import type { Item } from "../src/model.js";
import { normalizeWs } from "../src/text.js";
import { read, setup, write } from "./helpers.js";

type Files = Record<string, string>;

interface Run {
  items: Item[];
  groups: { id: string; kind: string; items: string[]; title: string; rationale: string | null }[];
  moves: { from: string[]; to: string[]; changed: number }[];
  warnings: string[];
  stet: Awaited<ReturnType<typeof setup>>["stet"];
  repo: string;
}

async function submit(before: Files, after: Files, groups?: any[]): Promise<Run> {
  const { stet, repo } = await setup(before);
  const { worktree: wt } = await stet.newAgent("a");
  for (const [f, t] of Object.entries(after)) write(wt, f, t);
  const r = await stet.submit("a", { title: "Revision", ...(groups ? { groups } : {}) });
  const all = await stet.listGroups();
  const groupsOut = r.groups.map((g) => {
    const full = all.find((x) => x.id === g.id)!;
    return { id: g.id, kind: full.kind, items: [...full.items], title: full.title, rationale: full.rationale };
  });
  const items = [...r.items].sort((x, y) => x.file.localeCompare(y.file) || x.range.start - y.range.start);
  if (process.env.DUMP) {
    const sh = (t: string) => JSON.stringify(t.length > 60 ? t.slice(0, 30) + "…" + t.slice(-25) : t);
    console.log(["", ...items.map((i) => `${i.id} ${i.file}@${i.range.start}: ${sh(i.oldText)} → ${sh(i.newText)}${i.move ? " [move]" : ""}`), ...groupsOut.map((g) => `${g.kind} [${g.items.join(",")}] ${g.title}`), ...r.warnings.map((w) => "! " + w.slice(0, 120))].join("\n"));
  }
  return { items, groups: groupsOut, moves: r.moves, warnings: r.warnings, stet, repo };
}

const n = normalizeWs;
const isIns = (i: Item) => !n(i.oldText) && !!n(i.newText);
const isDel = (i: Item) => !!n(i.oldText) && !n(i.newText);
const has = (s: string, part: string) => n(s).includes(n(part));
const find = (r: Run, pred: (i: Item) => boolean, what: string): Item => {
  const hits = r.items.filter(pred);
  if (hits.length !== 1) throw new Error(`${what}: ${hits.length} items match: ${r.items.map((i) => `${i.id} ${JSON.stringify(n(i.oldText).slice(0, 40))} → ${JSON.stringify(n(i.newText).slice(0, 40))}`).join(" | ")}`);
  return hits[0]!;
};
const linkedOf = (r: Run, id: string) => r.groups.filter((g) => g.kind === "linked" && g.items.includes(id));

/** Decision units: each linked group (with everything linked to it), and each change in none. */
function units(r: Run): string[][] {
  const parent = new Map(r.items.map((i) => [i.id, i.id]));
  const root = (x: string): string => (parent.get(x) === x ? x : root(parent.get(x)!));
  for (const g of r.groups.filter((g) => g.kind === "linked")) for (const i of g.items.slice(1)) parent.set(root(i), root(g.items[0]!));
  const by = new Map<string, string[]>();
  for (const i of r.items) by.set(root(i.id), [...(by.get(root(i.id)) ?? []), i.id]);
  return [...by.values()];
}

/** Paragraphs of a LaTeX text, whitespace-normalized. */
const paragraphs = (t: string) => t.split(/\n[ \t]*\n/).map(n).filter(Boolean);
const macrosDefined = (t: string) => new Set([...t.matchAll(/\\newcommand\{?\\([A-Za-z]+)/g)].map((m) => m[1]!));

/** What must hold for any document a review can produce from `before` and `after`. */
function wellFormed(result: Files, before: Files, after: Files, what: string) {
  const all = (fs: Files) => Object.values(fs).join("\n\n");
  const [res, old, neu] = [all(result), all(before), all(after)];
  // No paragraph twice (unless it was there twice).
  const count = (t: string) => {
    const m = new Map<string, number>();
    for (const p of paragraphs(t)) if (p.length > 40) m.set(p, (m.get(p) ?? 0) + 1);
    return m;
  };
  const [cr, co, cn] = [count(res), count(old), count(neu)];
  for (const [p, k] of cr) expect(k, `${what}: paragraph twice: ${p.slice(0, 60)}`).toBeLessThanOrEqual(Math.max(co.get(p) ?? 1, cn.get(p) ?? 1));
  // Environments and braces balanced.
  const envs = (t: string) => [...t.matchAll(/\\(begin|end)\{([^}]*)\}/g)].map((m) => `${m[1]}:${m[2]}`);
  for (const e of new Set(envs(res).map((x) => x.split(":")[1]!))) {
    const c = (k: string) => envs(res).filter((x) => x === `${k}:${e}`).length;
    expect(c("begin"), `${what}: \\begin{${e}} and \\end{${e}} don't match`).toBe(c("end"));
  }
  const depth = [...res.replace(/\\[{}]/g, "")].reduce((d, ch) => d + (ch === "{" ? 1 : ch === "}" ? -1 : 0), 0);
  expect(depth, `${what}: braces don't balance`).toBe(0);
  expect((res.replace(/\\\$/g, "").match(/\$/g) ?? []).length % 2, `${what}: a $ without its partner`).toBe(0);
  const count2 = (k: string) => (res.match(new RegExp(`\\\\${k}(?![A-Za-z])`, "g")) ?? []).length;
  expect(count2("left"), `${what}: \\left without \\right`).toBe(count2("right"));
  // Every macro used that either version defines is defined (an undefined macro is an error).
  const known = new Set([...macrosDefined(old), ...macrosDefined(neu)]);
  const defined = macrosDefined(res);
  for (const m of res.matchAll(/\\([A-Za-z]+)(?![A-Za-z])/g)) {
    if (known.has(m[1]!)) expect(defined.has(m[1]!), `${what}: \\${m[1]} is used but not defined`).toBe(true);
  }
}

/** Accept everything, and each unit alone (each in a fresh copy), checking what must hold. */
async function checkReviews(before: Files, after: Files, groups?: any[]) {
  const r = await submit(before, after, groups);
  const readAll = (repo: string) => Object.fromEntries(Object.keys({ ...before, ...after }).map((f) => [f, read(repo, f)]));
  await r.stet.accept(r.items.map((i) => i.id), { overrideLinked: true });
  expect(readAll(r.repo)).toEqual({ ...before, ...after });
  for (const u of units(r)) {
    const fresh = await submit(before, after, groups);
    // Ids are the same in every copy: the same submission splits the same way.
    await fresh.stet.accept(u);
    const shown = u.map((id) => r.items.find((i) => i.id === id)!).map((i) => `${i.id} ${JSON.stringify(n(i.oldText).slice(0, 30))}→${JSON.stringify(n(i.newText).slice(0, 30))}`).join(", ");
    wellFormed(readAll(fresh.repo), before, after, `accepting only ${shown}`);
    // Rejecting it instead leaves the rest acceptable: accepting all others then works too.
    const other = await submit(before, after, groups);
    await other.stet.reject(u);
    const rest = other.items.filter((i) => !u.includes(i.id)).map((i) => i.id);
    if (rest.length) await other.stet.accept(rest, { overrideLinked: true });
    wellFormed(readAll(other.repo), before, after, `accepting all but ${shown}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Scenario 1: polishing a paper (one file plus the bibliography)

const P = {
  intro: "Peer review of scientific papers is slow, and authors increasingly use language models to revise their drafts before submission.",
  goal: "We study how such revisions can be reviewed change by change, so that the author keeps control over every word of the paper.",
  related: "Earlier tools show the whole rewritten text at once, which makes it hard to see what changed and why it was changed.",
  method: "Our method splits each revision into small changes and groups the ones that belong together, for example a label and its references.",
  methodEdited: "Our method splits each revision into small changes and links the ones that belong together, for example a label and all its references.",
  estimator: "The quality of a split is measured by the estimator $\\est$, which counts the changes a reviewer has to read.",
  estimatorEdited: "The quality of a split is measured by the estimator $\\estim$, which counts the changes a reviewer has to read.",
  bound: "First, we bound the error of the estimator by the sum of two terms, one for the bias and one for the variance.",
  boundEdited: "First, we bound the error of the new estimator by the sum of two terms, one for its bias and one for the variance.",
  inserted: "By the dimension argument of Section~\\ref{sec:intro}, the space of solutions is finite, so the bound holds uniformly.",
  insertedRenamed: "By the dimension argument of Section~\\ref{sec:introduction}, the space of solutions is finite, so the bound holds uniformly.",
  rewrite: "Thus the estimator converges quickly to the true value under mild conditions.",
  rewritten: "Hence this estimator converges rapidly towards the correct value under weak assumptions.",
  typos: "The rest of the proof follows teh same pattern, and we only sketch it here for completness of exposition.",
  fixed: "The rest of the proof follows the same pattern, and we only sketch it here for completeness of exposition.",
  dropped: "This paragraph repeats what the previous section already said and adds nothing new to the argument at all.",
  cite: "Reviewing changes one at a time is an old idea from version control.",
  cited: "Reviewing changes one at a time is an old idea from version control~\\cite{knuth84}.",
};
const BIB = "@article{lamport94,\n  title = {LaTeX},\n  author = {Lamport, Leslie},\n  year = {1994}\n}\n";
const BIB2 = BIB + "\n@book{knuth84,\n  title = {The TeXbook},\n  author = {Knuth, Donald},\n  year = {1984}\n}\n";

const paper1 = (v: "old" | "new") =>
  [
    "\\documentclass{article}",
    v === "old" ? "\\newcommand{\\est}{\\hat{\\theta}}" : "\\newcommand{\\estim}{\\hat{\\theta}}",
    "\\begin{document}",
    v === "old" ? "\\section{Introduction}\\label{sec:intro}" : "\\section{Introduction}\\label{sec:introduction}",
    P.intro,
    "",
    // The goal paragraph moves to the method section (word for word).
    ...(v === "old" ? [P.goal, ""] : []),
    v === "old" ? P.related : P.related,
    "",
    v === "old" ? P.cite : P.cited,
    "",
    "\\section{Method}",
    ...(v === "new" ? [P.goal, ""] : []),
    v === "old" ? P.method : P.methodEdited,
    "",
    v === "old" ? P.estimator : P.estimatorEdited,
    "",
    "\\begin{proof}",
    // A new paragraph before an edited one.
    ...(v === "new" ? [P.insertedRenamed, ""] : []),
    v === "old" ? P.bound : P.boundEdited,
    "",
    `We prove the claim by induction on the number of rounds. ${v === "old" ? P.rewrite : P.rewritten} The base case is immediate.`,
    "",
    v === "old" ? P.typos : P.fixed,
    "\\end{proof}",
    "",
    ...(v === "old" ? [P.dropped, ""] : []),
    `As shown in Section~\\ref{${v === "old" ? "sec:intro" : "sec:introduction"}}, the estimator $${v === "old" ? "\\est" : "\\estim"}$ is unbiased.`,
    "\\bibliography{refs}",
    "\\end{document}",
    "",
  ].join("\n");

describe("polishing a paper: many kinds of change in one submission", () => {
  const before = { "main.tex": paper1("old"), "refs.bib": BIB };
  const after = { "main.tex": paper1("new"), "refs.bib": BIB2 };

  it("splits and groups each change as a reviewer would expect", async () => {
    const r = await submit(before, after);
    // The moved paragraph: one move, word for word.
    expect(r.moves).toEqual([expect.objectContaining({ changed: 0 })]);
    const goalOut = find(r, (i) => isDel(i) && has(i.oldText, P.goal), "goal moved out");
    const goalIn = find(r, (i) => isIns(i) && has(i.newText, P.goal), "goal moved in");
    expect(goalOut.move && goalIn.move).toBeTruthy();
    // The label rename with its reference: linked, a part per change. (The new paragraph that
    // refers to the new label isn't part of it: alone, it's only an undefined reference.)
    const label = find(r, (i) => i.oldText.includes("\\label{sec:intro}"), "label");
    const renameGroup = linkedOf(r, label.id).find((g) => g.title.startsWith("Rename label"))!;
    expect(renameGroup.items).toHaveLength(2);
    // The macro renamed with its uses: linked, accepting a use without the definition is an error.
    const def = find(r, (i) => i.oldText.includes("\\est}") || n(i.oldText) === "\\est", "macro definition");
    const uses = r.items.filter((i) => i.newText.includes("\\estim") && i !== def);
    expect(uses).toHaveLength(2);
    for (const u of uses) expect(linkedOf(r, def.id).some((g) => g.items.includes(u.id))).toBe(true);
    // The new citation with its bibliography entry: linked.
    const cite = find(r, (i) => i.newText.includes("\\cite{knuth84}"), "citation");
    const bib = find(r, (i) => i.file === "refs.bib", "bib entry");
    expect(linkedOf(r, cite.id).some((g) => g.items.includes(bib.id))).toBe(true);
    // The paragraph inserted before an edited one: an insertion, and small edits in place.
    find(r, (i) => isIns(i) && has(i.newText, "By the dimension argument"), "inserted paragraph");
    for (const i of r.items.filter((i) => P.bound.includes(n(i.oldText)) && n(i.oldText) && !isDel(i))) expect(n(i.newText).length).toBeLessThan(12);
    // The rewritten sentence: one change.
    find(r, (i) => has(i.oldText, "converges quickly") && has(i.newText, "converges rapidly"), "rewritten sentence");
    // The typo fixes: two changes.
    find(r, (i) => n(i.oldText) === "teh", "typo 1");
    find(r, (i) => n(i.oldText) === "completness", "typo 2");
    // The dropped paragraph: one deletion, linked to nothing.
    const dropped = find(r, (i) => isDel(i) && has(i.oldText, P.dropped), "dropped paragraph");
    expect(linkedOf(r, dropped.id)).toEqual([]);
    // The small wording edits in the method paragraph: not linked to anything.
    for (const i of r.items.filter((i) => P.method.includes(n(i.oldText)) && n(i.oldText) && has(i.newText, "links"))) expect(linkedOf(r, i.id)).toEqual([]);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkReviews(before, after);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Scenario 2: restructuring a section, with the agent's own (too large) groups

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

const paper2 = (v: "old" | "new") =>
  [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{Model}",
    // a and b are swapped; b gets one word changed.
    ...(v === "old" ? [Q.a, "", Q.b] : [Q.b.replace("largest", "maximal"), "", Q.a]),
    "",
    "\\section{Simulation}",
    // c moves to the end of the section and is rewritten (more than a move allows); e is replaced
    // in its place by an unrelated new paragraph, and moves into the next section, word for word.
    ...(v === "old" ? [Q.c, ""] : []),
    v === "old" ? `${Q.d} ${Q.long}` : Q.d,
    "",
    v === "old" ? Q.e : Q.eNew,
    "",
    ...(v === "new" ? [Q.cRewritten, ""] : []),
    "\\section{Lower bound}",
    ...(v === "new" ? [Q.e, ""] : []),
    // A sentence moves from the simulation section to here.
    v === "old" ? Q.f : `${Q.fFixed} ${Q.long}`,
    "\\end{document}",
    "",
  ].join("\n");

describe("restructuring: moves of every kind next to edits", () => {
  const before = { "main.tex": paper2("old") };
  const after = { "main.tex": paper2("new") };
  const groups = [
    { kind: "linked", title: "Reorganise the model and simulation sections", where: ["main.tex"] },
    { kind: "related", title: "Wording", where: ['main.tex "maximal"', 'main.tex "fills"'] },
  ];

  it("finds the moves, the rewritten move, the replacement, and makes the agent's big group related", async () => {
    const r = await submit(before, after, groups);
    const titles = r.groups.map((g) => `${g.kind}: ${g.title}`);
    // Swapped paragraphs (one word changed), the paragraph moved to the next section, and the
    // sentence moved: three moves.
    expect(r.moves).toHaveLength(3);
    expect(r.moves.map((m) => m.changed).sort()).toEqual([0, 0, 1]);
    // The paragraph moved and rewritten: a linked deletion and insertion.
    const cOut = find(r, (i) => isDel(i) && has(i.oldText, Q.c), "c moved out");
    const cIn = find(r, (i) => isIns(i) && has(i.newText, Q.cRewritten), "c moved in");
    expect(linkedOf(r, cOut.id).some((g) => g.items.includes(cIn.id) && g.title.startsWith("Moved and rewritten"))).toBe(true);
    // The unrelated paragraph in e's old place: an insertion of its own.
    const eNew = find(r, (i) => isIns(i) && has(i.newText, Q.eNew), "new paragraph in e's place");
    expect(linkedOf(r, eNew.id)).toEqual([]);
    // The agent's group over everything is related now, and the agent is told.
    expect(titles).toContain("related: Reorganise the model and simulation sections");
    expect(r.warnings.join("\n")).toMatch(/'Reorganise the model and simulation sections' is a related group now/);
    expect(titles).toContain("related: Wording");
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkReviews(before, after, groups);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Scenario 3: moving material into an appendix (several files)

describe("moving material into an appendix", () => {
  const proof = "\\begin{proof}\nWe argue by contradiction and assume that the bound fails for some input of length $n$.\n\nThen the run visits more than $\\log n$ cells, which contradicts the choice of the input and ends the proof.\n\\end{proof}";
  const before = {
    "main.tex": `\\documentclass{article}\n\\begin{document}\n\\section{Results}\\label{sec:results}\n\\begin{theorem}\\label{thm:main}\nEvery run uses at most $\\log n$ cells.\n\\end{theorem}\n${proof}\n\nTheorem~\\ref{thm:main} is the main result of this paper, and the rest of it explains its consequences.\n\\input{appendix}\n\\end{document}\n`,
    "appendix.tex": "\\section{Appendix}\\label{sec:app}\nThis appendix collects the proofs that are too long for the main text of the paper.\n",
  };
  const after = {
    "main.tex": `\\documentclass{article}\n\\begin{document}\n\\section{Results}\\label{sec:results}\n\\begin{theorem}\\label{thm:main}\nEvery run uses at most $\\log n$ cells.\n\\end{theorem}\nThe proof is in Appendix~\\ref{sec:app}.\n\nTheorem~\\ref{thm:main} is the main result of this paper, and the rest of it explains its consequences.\n\\input{appendix}\n\\end{document}\n`,
    "appendix.tex": `\\section{Appendix}\\label{sec:app}\nThis appendix collects the proofs that are too long for the main text of the paper.\n\n\\subsection{Proof of Theorem~\\ref{thm:main}}\n${proof}\n`,
  };

  it("the proof moves to the other file as one move; the pointer to it is a change of its own", async () => {
    const r = await submit(before, after);
    expect(r.moves).toHaveLength(1);
    const m = r.moves[0]!;
    const out = r.items.find((i) => i.id === m.from[0])!;
    const into = r.items.find((i) => i.id === m.to[0])!;
    expect([out.file, into.file]).toEqual(["main.tex", "appendix.tex"]);
    expect(has(out.oldText, "We argue by contradiction")).toBe(true);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkReviews(before, after);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Scenario 4: a section full of math

const math = (v: "old" | "new") => {
  const o = v === "old";
  return [
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    ...(o ? [] : ["\\newcommand{\\R}{\\mathbb{R}}"]),
    "\\begin{document}",
    "\\section{Analysis}",
    // Inline formulas: one symbol renamed in three of them (the agent links them), one sign fixed.
    `Let $${o ? "n" : "m"}$ be the number of rounds and assume $${o ? "n" : "m"} \\geq 2$ throughout.`,
    "",
    `The total cost is $${o ? "a+b" : "a-b"}$, and each round costs at most $2${o ? "n" : "m"}$ steps.`,
    "",
    // A display formula with a label that is renamed, and referred to below.
    "\\begin{equation}",
    `  \\label{${o ? "eq:cost" : "eq:total-cost"}}`,
    `  C(x) = \\sum_{i=1}^{${o ? "n" : "m"}} \\frac{x_i}{i} + \\left( \\int_0^1 f(t) \\, dt \\right)^2`,
    "\\end{equation}",
    "",
    // An align with one line changed and one line added.
    "\\begin{align}",
    "  f(x) &= x^2 + 1 \\\\",
    o ? "  g(x) &= \\sqrt{x} \\\\" : "  g(x) &= \\sqrt{x + 1} \\\\",
    ...(o ? [] : ["  k(x) &= \\log x \\\\"]),
    "  h(x) &= f(g(x))",
    "\\end{align}",
    "",
    // Cases inside an equation, with one branch changed.
    "\\begin{equation*}",
    "  s(x) = \\begin{cases}",
    "    0 & \\text{if } x < 0, \\\\",
    o ? "    x & \\text{otherwise.}" : "    x^2 & \\text{otherwise.}",
    "  \\end{cases}",
    "\\end{equation*}",
    "",
    // Prose with a reference to the renamed label, and a new macro used.
    `By~\\eqref{${o ? "eq:cost" : "eq:total-cost"}}, the cost grows at most linearly in the number of rounds of the protocol.`,
    "",
    o
      ? "Every value of the cost function lies in the real numbers, which is all we need later."
      : "Every value of the cost function lies in $\\R$, which is all we need later.",
    "",
    // A whole align moved to the end of the section, word for word.
    ...(o ? ["\\begin{align*}", "  u &= v + w, \\\\", "  w &= 2u - v.", "\\end{align*}", ""] : []),
    "This closes the analysis of the protocol, and we turn to its implementation next.",
    ...(o ? [] : ["", "\\begin{align*}", "  u &= v + w, \\\\", "  w &= 2u - v.", "\\end{align*}"]),
    "\\end{document}",
    "",
  ].join("\n");
};

describe("a section full of math", () => {
  const before = { "main.tex": math("old") };
  const after = { "main.tex": math("new") };
  // (Snippets unescape backslashes: \\\\geq is \geq.)
  const groups = [{ kind: "linked", title: "Rename n to m", where: ['main.tex "$m$"', 'main.tex "m \\\\geq 2"', 'main.tex "$2m$"', 'main.tex "^{m}"'] }];

  it("keeps formulas whole, links what depends on each other, and moves the align", async () => {
    const r = await submit(before, after, groups);
    // Inline math is taken whole, each formula its own change.
    find(r, (i) => n(i.oldText) === "$a+b$" && n(i.newText) === "$a-b$", "sign fix");
    // Display math is one change per environment: the align with its changed and added lines,
    // the cases branch with its equation.
    find(r, (i) => i.oldText.includes("\\sqrt{x}") && i.newText.includes("\\log x"), "align");
    find(r, (i) => i.oldText.includes("x & \\text{otherwise") && i.newText.includes("x^2 &"), "cases");
    // The renamed equation label and its \eqref: linked by the rename.
    const eq = find(r, (i) => i.oldText.includes("eq:cost") && !i.oldText.includes("eqref"), "equation");
    const ref = find(r, (i) => i.oldText.includes("\\eqref{eq:cost}"), "eqref");
    expect(linkedOf(r, eq.id).some((g) => g.items.includes(ref.id))).toBe(true);
    // The new macro and its use: linked (the use alone is an undefined macro).
    const def = find(r, (i) => i.newText.includes("\\newcommand{\\R}"), "macro definition");
    const use = find(r, (i) => i.newText.includes("$\\R$"), "macro use");
    expect(linkedOf(r, def.id).some((g) => g.items.includes(use.id))).toBe(true);
    // The agent's rename of n: linked, Stet sees the same symbol replaced. (It merges with the
    // label rename: the equation does both.)
    const nm = r.groups.find((g) => g.title.startsWith("Rename n to m"))!;
    expect(nm.kind).toBe("linked");
    for (const s of ["$m$", "$m \\geq 2$", "$2m$"]) expect(nm.items).toContain(find(r, (i) => n(i.newText) === s, s).id);
    // The align moved word for word: one move, unchanged. (The diff may describe it as the
    // paragraph after it moving up instead: the same document.)
    expect(r.moves).toEqual([expect.objectContaining({ changed: 0 })]);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkReviews(before, after, groups);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Scenario 5: a TikZ figure

const tikz = (v: "old" | "new") => {
  const o = v === "old";
  const style = o ? "vertex" : "node";
  return [
    "\\documentclass{article}",
    "\\usepackage{tikz}",
    `\\tikzset{${style}/.style={draw, circle, minimum size=6mm}}`,
    "\\begin{document}",
    "\\section{The graph}",
    `Figure~\\ref{${o ? "fig:graph" : "fig:example-graph"}} shows the graph we use as a running example in this section.`,
    "",
    "\\begin{figure}[t]",
    "  \\centering",
    "  \\begin{tikzpicture}[scale=1.5]",
    `    \\node[${style}] (a) at (0,0) {$v_1$};`,
    `    \\node[${style}] (b) at (${o ? "2,0" : "3,0"}) {$v_2$};`,
    `    \\node[${style}] (c) at (1,1.5) {$${o ? "v_3" : "w"}$};`,
    "    \\draw[->] (a) -- (b);",
    "    \\draw[->] (b) -- (c);",
    ...(o ? [] : ["    \\draw[->, dashed] (c) -- (a);"]),
    "    \\foreach \\x in {0,...,3} {",
    `      \\fill (\\x,-1) circle (${o ? "1pt" : "2pt"});`,
    "    }",
    "  \\end{tikzpicture}",
    `  \\caption{${o ? "A small graph." : "A small directed graph with a back edge."}}`,
    `  \\label{${o ? "fig:graph" : "fig:example-graph"}}`,
    "\\end{figure}",
    "",
    "The graph has three vertices, and every vertex can reach every other one along the edges.",
    "\\end{document}",
    "",
  ].join("\n");
};

describe("a TikZ figure", () => {
  const before = { "main.tex": tikz("old") };
  const after = { "main.tex": tikz("new") };

  it("small changes inside the picture; the style rename and the label rename linked", async () => {
    const r = await submit(before, after);
    // A coordinate, a node label, the dot size: small changes of their own.
    find(r, (i) => n(i.oldText) === "2" && n(i.newText) === "3", "coordinate");
    find(r, (i) => n(i.oldText) === "$v_3$" && n(i.newText) === "$w$", "node label");
    find(r, (i) => i.oldText.includes("1pt") && i.newText.includes("2pt") && i.oldText.length < 12, "dot size");
    // The new edge: an insertion inside the picture.
    find(r, (i) => isIns(i) && i.newText.includes("dashed"), "new edge");
    // The caption: one change.
    find(r, (i) => i.newText.includes("directed"), "caption");
    // The figure label and its reference: linked by the rename.
    const label = find(r, (i) => i.oldText.includes("\\label{fig:graph}"), "figure label");
    const ref = find(r, (i) => i.oldText.includes("\\ref{fig:graph}"), "figure reference");
    expect(linkedOf(r, label.id).some((g) => g.items.includes(ref.id))).toBe(true);
    // The TikZ style renamed with its three uses: linked (a node with an unknown style is an error).
    const def = find(r, (i) => i.oldText.includes("vertex") && (i.oldText.includes("/.style") || i.context.after.startsWith("/.style")), "style definition");
    const uses = r.items.filter((i) => i !== def && i.oldText.includes("vertex"));
    expect(uses).toHaveLength(3);
    for (const u of uses) expect(linkedOf(r, def.id).some((g) => g.items.includes(u.id))).toBe(true);
    // Shown once: no related "Replace vertex → node (4×)" next to the linked rename.
    expect(r.groups.filter((g) => g.items.includes(def.id))).toHaveLength(1);
  });

  it("every review it allows gives a well-formed document", async () => {
    await checkReviews(before, after);
  }, 180_000);
});
