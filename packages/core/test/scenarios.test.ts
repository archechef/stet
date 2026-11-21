/**
 * How agents' edits become reviewable changes: one scenario per kind of edit, each with the
 * outcome a reviewer would find most natural. The rules behind them:
 * - every change can be accepted on its own without dropping or duplicating text, unless it is
 *   linked with exactly the changes it needs;
 * - a paragraph edited in place is shown as small edits in place, also when a new paragraph is
 *   inserted next to it (it is paired with its old version by similarity, not position);
 * - an unrelated paragraph replacing another is one replacement;
 * - a moved passage is one move (shown as moved), also for a single sentence of 7 words or more,
 *   with up to one changed word per 10 words (at least one);
 * - a passage moved and rewritten beyond that is a deletion and an insertion, linked;
 * - a heavily rewritten sentence is one change, not word-sized fragments;
 * - "linked" means accepting only some would break the document or lose text: an agent's linked
 *   group without such a dependency becomes a related group (the agent is told, and can insist
 *   with a reason).
 */
import { describe, expect, it } from "vitest";
import type { Item, MoveInfo } from "../src/model.js";
import { normalizeWs } from "../src/text.js";
import { DOC_LANGS, type DocLang, git, read, setup, write } from "./helpers.js";

// Paragraphs (one source line each, as in most LaTeX and Typst).
const A = "First, we bound the error of the estimator by the sum of two terms, one for the bias and one for the variance.";
const A2 = "First, we bound the error of the new estimator by the sum of two terms, one for its bias and one for the variance.";
const A3 = "First, we bound the total error of this estimator by a sum of two terms: one term for its bias, and one for the variance.";
const B = "By the dimension argument of Section 2, the space of solutions is finite, so the bound holds uniformly.";
const C = "We prove the claim by induction on the number of rounds, starting from the trivial case of one round.";
const D = "For $M=N_0$, the claim gives the base case directly, since every round then has a single participant.";
const D2 = "For $M=N_0$, the lemma gives the base case directly, since every round then has a single participant.";
const E = "The rest of the proof follows the same pattern, and we only sketch it here for completeness of exposition.";
const LONG = "The method is fast on every input that we tried."; // one sentence, 10 words
const SHORT = "The method is fast."; // one sentence, 4 words

interface Run {
  items: Item[];
  groups: { id: string; kind: string; items: string[]; title: string; rationale: string | null }[];
  warnings: string[];
  moves: MoveInfo[];
  stet: Awaited<ReturnType<typeof setup>>["stet"];
  repo: string;
}

/** The scenarios in the document language `L` (Typst's are skipped until its profile exists). */
function scenarios(L: DocLang) {
  /** A document of one section with paragraphs `ps`. */
  const doc = (...ps: string[]) => `${L.begin}${L.heading("Intro")}\n${ps.join("\n\n")}\n${L.end}`;

  async function submit(before: string, after: string, opts: { groups?: any[]; files?: Record<string, [string, string]> } = {}): Promise<Run> {
    const { stet, repo } = await setup({ [L.file]: before, ...Object.fromEntries(Object.entries(opts.files ?? {}).map(([f, [b]]) => [f, b])) });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, L.file, after);
    for (const [f, [, a]] of Object.entries(opts.files ?? {})) write(wt, f, a);
    const r = await stet.submit("a", { title: "t", ...(opts.groups ? { groups: opts.groups } : {}) });
    const items = [...r.items].sort((x, y) => x.file.localeCompare(y.file) || x.range.start - y.range.start || x.range.end - y.range.end);
    const groups = [];
    for (const g of r.groups) {
      const full = (await stet.listGroups()).find((x) => x.id === g.id)!;
      groups.push({ id: g.id, kind: full.kind, items: [...full.items], title: full.title, rationale: full.rationale });
    }
    return { items, groups, warnings: r.warnings, moves: r.moves, stet, repo };
  }

  const n = normalizeWs;
  const isIns = (i: Item) => !n(i.oldText) && !!n(i.newText);
  const isDel = (i: Item) => !!n(i.oldText) && !n(i.newText);
  const isEdit = (i: Item) => !!n(i.oldText) && !!n(i.newText);
  /** The item that inserts exactly `p`, or deletes exactly `p`. */
  const inserting = (r: Run, p: string) => r.items.filter((i) => isIns(i) && n(i.newText) === n(p));
  const deleting = (r: Run, p: string) => r.items.filter((i) => isDel(i) && n(i.oldText) === n(p));
  const linkedWith = (r: Run, ids: string[]) => r.groups.filter((g) => g.kind === "linked" && ids.every((id) => g.items.includes(id)));
  const linkedOf = (r: Run, id: string) => r.groups.filter((g) => g.kind === "linked" && g.items.includes(id));

  /** Accept `ids` in a fresh copy of the scenario and return the reviewer's file. */
  async function acceptOnly(before: string, after: string, pick: (r: Run) => Item[]): Promise<string> {
    const r = await submit(before, after);
    const ids = pick(r).map((i) => i.id);
    await r.stet.accept(ids, { overrideLinked: true });
    return read(r.repo, L.file);
  }

  /** Accepting everything gives the agent's text. */
  async function acceptAll(before: string, after: string): Promise<void> {
    const r = await submit(before, after);
    await r.stet.accept(r.items.map((i) => i.id));
    expect(read(r.repo, L.file)).toBe(after);
  }

  describe("a paragraph inserted next to one edited in place", () => {
    it("before it: an insertion, and small edits in place (bug report C42)", async () => {
      const [before, after] = [doc(C, A, E), doc(C, B, A2, E)];
      const r = await submit(before, after);
      expect(inserting(r, B)).toHaveLength(1);
      const rest = r.items.filter((i) => !inserting(r, B).includes(i));
      expect(rest.length).toBeGreaterThan(0);
      // The edits are small and inside the old paragraph: no "A → B", no reinsertion of A.
      for (const i of rest) {
        expect(A).toContain(n(i.oldText));
        expect(n(i.newText).length).toBeLessThan(10);
      }
      expect(r.groups.filter((g) => g.kind === "linked")).toEqual([]);
      // Each can be accepted alone.
      expect(await acceptOnly(before, after, (r) => inserting(r, B))).toBe(doc(C, B, A, E));
      expect(await acceptOnly(before, after, (r) => r.items.filter((i) => !isIns(i) || n(i.newText) !== n(B)))).toBe(doc(C, A2, E));
      await acceptAll(before, after);
    });

    it("after it: small edits, and an insertion", async () => {
      const [before, after] = [doc(C, A, E), doc(C, A2, B, E)];
      const r = await submit(before, after);
      expect(inserting(r, B)).toHaveLength(1);
      expect(await acceptOnly(before, after, (r) => inserting(r, B))).toBe(doc(C, A, B, E));
      await acceptAll(before, after);
    });

    it("between two edited paragraphs", async () => {
      const C2 = C.replace("induction", "strong induction");
      const [before, after] = [doc(C, A, E), doc(C2, B, A2, E)];
      const r = await submit(before, after);
      expect(inserting(r, B)).toHaveLength(1);
      expect(r.items.every((i) => inserting(r, B).includes(i) || n(i.newText).length < 12)).toBe(true);
      expect(await acceptOnly(before, after, (r) => inserting(r, B))).toBe(doc(C, B, A, E));
      await acceptAll(before, after);
    });

    it("two new paragraphs around an edited one", async () => {
      const [before, after] = [doc(C, A, E), doc(C, B, A2, D, E)];
      const r = await submit(before, after);
      expect(inserting(r, B)).toHaveLength(1);
      expect(inserting(r, D)).toHaveLength(1);
      expect(await acceptOnly(before, after, (r) => inserting(r, D))).toBe(doc(C, A, D, E));
      await acceptAll(before, after);
    });
  });

  describe("replacements", () => {
    it("an unrelated paragraph in the place of another is one replacement", async () => {
      const r = await submit(doc(C, A, E), doc(C, B, E));
      expect(r.items).toHaveLength(1);
      expect([n(r.items[0]!.oldText), n(r.items[0]!.newText)]).toEqual([A, B]);
    });

    it("but not when the old paragraph moved elsewhere: an insertion, and a move", async () => {
      const [before, after] = [doc(C, A, E, D), doc(C, B, E, D, A)];
      const r = await submit(before, after);
      expect(inserting(r, B)).toHaveLength(1);
      const [del] = deleting(r, A);
      const [ins] = inserting(r, A);
      expect(del?.move && ins?.move).toBeTruthy();
      expect(linkedOf(r, inserting(r, B)[0]!.id)).toEqual([]);
      expect(await acceptOnly(before, after, (r) => inserting(r, B))).toBe(doc(C, B, A, E, D));
      await acceptAll(before, after);
    });

    it("a heavily rewritten sentence is one change (bug report C31)", async () => {
      const S = "Thus the estimator converges quickly to the true value under mild conditions.";
      const S2 = "Hence this estimator converges rapidly towards the correct value under weak assumptions.";
      const r = await submit(doc(`${C} ${S} ${E}`), doc(`${C} ${S2} ${E}`));
      expect(r.items).toHaveLength(1);
      expect(n(r.items[0]!.oldText)).toMatch(/^Thus .* conditions$/);
    });

    it("a sentence with many scattered word changes is one change", async () => {
      const S = "We now prove that the bound is tight for all graphs with large girth and small degree.";
      const S2 = "We next show that this bound is sharp for every graph with high girth and bounded degree.";
      const r = await submit(doc(`${C} ${S} ${E}`), doc(`${C} ${S2} ${E}`));
      expect(r.items).toHaveLength(1);
    });

    it("two independent word changes in a long sentence stay two changes", async () => {
      const r = await submit(doc(C), doc(C.replace("prove", "show").replace("trivial", "simple")));
      expect(r.items.map((i) => [n(i.oldText), n(i.newText)])).toEqual([
        ["prove", "show"],
        ["trivial", "simple"],
      ]);
    });

    it("splitting and merging paragraphs is one small change", async () => {
      const split = await submit(doc(`${C} ${A}`), doc(C, A));
      expect(split.items).toHaveLength(1);
      const merge = await submit(doc(C, A), doc(`${C} ${A}`));
      expect(merge.items).toHaveLength(1);
    });
  });

  describe("moves", () => {
    it("a paragraph moved next to one edited in place (bug report C38)", async () => {
      const [before, after] = [doc(C, D, A, E), doc(D2, C, A, E)];
      const r = await submit(before, after);
      // One move, with or without the small edit inside it; nothing pairs unrelated paragraphs.
      expect(r.moves).toHaveLength(1);
      for (const i of r.items) if (isEdit(i)) expect(n(i.oldText).length).toBeLessThan(15);
      await acceptAll(before, after);
    });

    it("a paragraph moved word for word, with its new neighbour edited", async () => {
      const r = await submit(doc(C, A, E, D), doc(A, E, C, D2));
      expect(r.moves).toHaveLength(1);
      expect(r.items.filter(isEdit).map((i) => [n(i.oldText), n(i.newText)])).toEqual([["claim", "lemma"]]);
    });

    it("two paragraphs swapped, one of them edited a little", async () => {
      const [before, after] = [doc(C, A, E), doc(A2, C, E)];
      const r = await submit(before, after);
      expect(r.moves).toHaveLength(1);
      expect(r.moves[0]!.changed).toBeGreaterThan(0);
      await acceptAll(before, after);
    });

    it("a short paragraph with one word changed is still a move (one per 10 words, at least one)", async () => {
      const r = await submit(doc(C, D, E), doc(C, E, D2));
      expect(r.moves).toEqual([expect.objectContaining({ changed: 1 })]);
    });

    it("a long paragraph may change one word in ten, without an upper limit", async () => {
      const P = Array.from({ length: 6 }, (_, k) => `Sentence ${k} of the long paragraph talks about item number ${k} in detail.`).join(" ");
      let P2 = P;
      for (const k of [0, 1, 2, 3, 4]) P2 = P2.replace(`item number ${k}`, `entry number ${k}`); // 5 of 66 words
      const r = await submit(doc(C, P, E), doc(C, E, P2));
      expect(r.moves).toEqual([expect.objectContaining({ changed: 5 })]);
    });

    it("a paragraph moved and rewritten beyond that is a linked deletion and insertion", async () => {
      const [before, after] = [doc(C, A, E, D), doc(C, E, D, A3)];
      const r = await submit(before, after);
      expect(r.moves).toEqual([]);
      const [del] = deleting(r, A);
      const [ins] = inserting(r, A3);
      expect(del && ins).toBeTruthy();
      expect(linkedWith(r, [del!.id, ins!.id])).toHaveLength(1);
      expect(linkedWith(r, [del!.id, ins!.id])[0]!.title).toMatch(/^Moved and rewritten/);
    });

    it("unrelated paragraphs deleted in one place and inserted in another are not linked", async () => {
      const r = await submit(doc(C, A, E), doc(C, E, B));
      expect(r.groups.filter((g) => g.kind === "linked")).toEqual([]);
    });

    it("a sentence of 7 words or more moved inside its paragraph is a move", async () => {
      const [before, after] = [doc(`${LONG} ${C} ${E}`), doc(`${C} ${LONG} ${E}`)];
      const r = await submit(before, after);
      expect(r.moves).toHaveLength(1);
      // Both halves are whole sentences: no stray full stops.
      expect(r.items.map((i) => n(i.oldText) || n(i.newText)).every((t) => t === LONG)).toBe(true);
      await acceptAll(before, after);
    });

    it("a sentence moved to another paragraph is a move", async () => {
      const [before, after] = [doc(`${LONG} ${C}`, E), doc(C, `${E} ${LONG}`)];
      const r = await submit(before, after);
      expect(r.moves).toHaveLength(1);
      await acceptAll(before, after);
    });

    it("a sentence of fewer than 7 words is not a move", async () => {
      const r = await submit(doc(`${SHORT} ${C}`, E), doc(C, `${E} ${SHORT}`));
      expect(r.moves).toEqual([]);
    });

    it("a paragraph moved to another file is a move", async () => {
      const r = await submit(doc(C, A, E), doc(C, E), { files: { [`intro.${L.ext}`]: [`${D}\n`, `${D}\n\n${A}\n`] } });
      expect(r.moves).toHaveLength(1);
    });

    it("a section's paragraphs put in reverse order: a move per paragraph, not one big change", async () => {
      const [before, after] = [doc(A, B, C, D, E), doc(E, D, C, B, A)];
      const r = await submit(before, after);
      // One paragraph stays where it is; the others are moves of one paragraph each.
      expect(r.moves.length).toBeGreaterThanOrEqual(3);
      for (const m of r.moves) expect([m.from.length, m.to.length, m.changed]).toEqual([1, 1, 0]);
      expect(r.items.every((i) => i.move)).toBe(true);
      await acceptAll(before, after);
    });

    it("two neighbouring paragraphs moved together are one move", async () => {
      const r = await submit(doc(C, A, B, E, D), doc(C, E, D, A, B));
      expect(r.moves).toHaveLength(1);
    });
  });

  describe("linked groups only for changes that need each other", () => {
    const four = (t: string) => t.replace("prove", "show").replace("trivial", "simple");
    const before = doc(C, A, E);
    const after = doc(four(C), A2, E.replace("sketch", "outline"));

    it("an agent's linked group without dependencies becomes related, and the agent is told", async () => {
      const r = await submit(before, after, { groups: [{ kind: "linked", title: "Polish the proof", where: [L.file] }] });
      const g = r.groups.find((g) => g.title.includes("Polish the proof"))!;
      expect(g.kind).toBe("related");
      expect(g.items).toHaveLength(r.items.length);
      expect(r.groups.filter((g) => g.kind === "linked")).toEqual([]);
      expect(r.warnings.join("\n")).toMatch(/Polish the proof.*related.*reason/s);
    });

    it("the agent can insist, with a reason the reviewer sees", async () => {
      const r = await submit(before, after, {
        groups: [{ kind: "linked", title: "Polish the proof", where: [L.file], reason: "the proof uses the new wording of the claim" }],
      });
      const g = r.groups.find((g) => g.title.includes("Polish the proof"))!;
      expect(g.kind).toBe("linked");
      expect(g.rationale).toMatch(/Linked because: the proof uses the new wording of the claim/);
    });

    it("only the changes that depend on each other stay linked, inside the related group", async () => {
      const b = doc(`${L.def("est")}\n${C}`, A, E);
      const a = doc(`${L.def("estim")}\n${four(C)}`, A.replace("the estimator", `the estimator ${L.use("estim")}`), E.replace("sketch", "outline"));
      const r = await submit(b, a, { groups: [{ kind: "linked", title: "Rename the estimator macro", where: [L.file] }] });
      expect(r.groups.find((g) => g.title === "Rename the estimator macro")!.kind).toBe("related");
      const use = r.items.find((i) => i.newText.includes(L.use("estim")))!;
      // The name in the definition (a line of its own, or just the name, by the language's tokens).
      const def = r.items.find((i) => i !== use && n(i.oldText).includes("est") && L.def("est").includes(n(i.oldText)))!;
      const linked = linkedWith(r, [def.id, use.id]);
      expect(linked).toHaveLength(1);
      expect(linked[0]!.items).toHaveLength(2);
    });

    it("a linked group whose changes all depend on each other stays linked", async () => {
      const b = doc(C, L.wrap[0], A, L.wrap[1], E);
      const a = doc(C, A, E);
      const r = await submit(b, a, { groups: [{ kind: "linked", title: "Drop the proof environment", where: [L.file] }] });
      expect(r.groups.find((g) => g.title.includes("Drop the proof environment"))!.kind).toBe("linked");
      expect(r.warnings.join("\n")).not.toMatch(/Drop the proof environment/);
    });

    it("the same symbol renamed in several formulas stays linked", async () => {
      const b = doc("Let $n$ be the number of rounds.", `Then $n ${L.geq} 1$ holds.`, "So $2n$ bounds the cost.");
      const a = doc("Let $m$ be the number of rounds.", `Then $m ${L.geq} 1$ holds.`, "So $2m$ bounds the cost.");
      const r = await submit(b, a, { groups: [{ kind: "linked", title: "Rename n to m", where: [L.file] }] });
      expect(r.groups.find((g) => g.title.includes("Rename n to m"))!.kind).toBe("linked");
    });
  });

  describe("large groups", () => {
    it("a notation change the agent splits by section: each section linked, the whole related", async () => {
      const ps = ["Let $n$ be the rounds and $n_0$ the first.", `Then $n ${L.geq} 1$ holds.`, "So $2n$ bounds the cost.", "Finally $n$ is even."];
      const b = doc(...ps);
      const a = doc(...ps.map((p) => p.replace(/\$n/g, "$m").replace(/2n/, "2m").replace(/\$n\b/g, "$m")));
      const r = await submit(b, a, {
        groups: [
          {
            kind: "linked",
            title: "Rename n to m",
            where: [L.file],
            parts: [
              { title: "First half", where: [`${L.file}:${L.beginLines + 2}-${L.beginLines + 4}`] },
              { title: "Second half", where: [`${L.file}:${L.beginLines + 6}-${L.beginLines + 8}`] },
            ],
          },
        ],
      });
      expect(r.groups.find((g) => g.title === "Rename n to m")!.kind).toBe("related");
      const linked = r.groups
        .filter((g) => g.kind === "linked")
        .map((g) => g.title)
        .sort();
      expect(linked).toEqual(["First half", "Second half"]);
      expect(r.warnings.join("\n")).toMatch(/'Rename n to m' is a related group now/);
    });

    it("a linked group Stet can't see a dependency in is refused by stet_group, with the way out", async () => {
      const r = await submit(doc(C, A), doc(C.replace("prove", "show"), A.replace("bound", "estimate")));
      const ids = r.items.map((i) => i.id);
      await expect(r.stet.group("a", ids, "linked", "Wording")).rejects.toThrow(/Not linked.*"related".*"reason"/s);
      const { group } = await r.stet.group("a", ids, "linked", "Wording", undefined, undefined, "the proof refers to the new verb");
      expect(group!.rationale).toBe("Linked because: the proof refers to the new verb");
    });
  });

  describe("a sync during submit (bug report C36)", () => {
    it("leaves the workspace consistent when the reviewer changed an edited paragraph meanwhile", async () => {
      const { stet, repo } = await setup({ [L.file]: doc(C, A, E) });
      const { worktree: wt } = await stet.newAgent("a");
      // The reviewer reflows the paragraph and changes a word in it; the agent, on the old text,
      // inserts a paragraph before it and edits it.
      const mine = A.replace("two terms, one", "two terms,\none").replace("estimator", "estimate").replace("for the bias", "for a systematic error");
      write(repo, L.file, doc(C, mine, E));
      git(repo, "commit", "-qam", "reviewer edits");
      write(wt, L.file, doc(C, B, A2, E));
      const r = await stet.submit("a", { title: "t" });
      const text = read(wt, L.file);
      // One copy of the paragraph (the reviewer's), the new paragraph, and no stray text.
      expect(text.split("First, we bound").length - 1).toBe(1);
      expect(text).toContain(B);
      expect(text).toContain("estimate by the sum");
      // The agent hears which changes went stale and that they are no longer in its workspace.
      expect(text).toContain("for a systematic error");
      expect(r.sync!.stale.map((i) => [n(i.oldText), n(i.newText)])).toEqual([["the", "its"]]);
      expect((await stet.getItem(inserting({ items: r.items } as Run, B)[0]!.id))!.status).toBe("pending");
      // The submit result says what that means for the workspace.
      const { describeSubmit } = await import("../src/mcp.js");
      expect(describeSubmit(r)).toMatch(/Stale.*the reviewer changed that text.*no longer in your workspace/s);
    });
  });
}

for (const L of DOC_LANGS) describe.skipIf(!L.available)(L.name, () => scenarios(L));
