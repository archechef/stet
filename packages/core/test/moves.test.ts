import { describe, expect, it } from "vitest";
import { moveChanges, moveChangesOf } from "../src/moves.js";
import { settleParts } from "../src/parts.js";
import type { Item } from "../src/model.js";
import { DOC_LANGS, edit, read, setup, write, type DocLang } from "./helpers.js";

const P1 = "We study the review of changes proposed by language models in scientific papers. Such changes are often long and touch many places at once.";
const P2 = "Our tool splits every proposal into small items that the author can accept or reject one at a time, in the editor where the paper is written.";
const P3 = "The approach scales to long documents. It was evaluated on three papers with several hundred proposals each.";

/** The moves in the document language `L` (Typst's are skipped until its profile exists). */
function moves(L: DocLang) {
  const DOC = `${L.begin}${L.heading("Introduction")}\n${P1}\n\n${P2}\n\n${P3}\n\n${L.heading("Evaluation")}\nWe report on the evaluation here.\n${L.end}`;
  /** Line `k` of the LaTeX version, in this language. */
  const line = (k: number) => k - 2 + L.beginLines;

  /** The agent moves P2 to the evaluation section (optionally with an edit), and nothing else. */
  async function submitMove(moved = P2, extra?: (t: string) => string) {
    const s = await setup({ [L.file]: DOC });
    const { worktree: wt } = await s.stet.newAgent("a");
    let t = DOC.replace(`${P2}\n\n`, "").replace("We report on the evaluation here.\n", `We report on the evaluation here.\n\n${moved}\n`);
    if (extra) t = extra(t);
    write(wt, L.file, t);
    const r = await s.stet.submit("a", { title: "move" });
    return { ...s, wt, r };
  }

  /** Submit `doc` as the agent's version of DOC. */
  async function submitDoc(doc: string) {
    const s = await setup({ [L.file]: DOC });
    const { worktree: wt } = await s.stet.newAgent("a");
    write(wt, L.file, doc);
    const r = await s.stet.submit("a", { title: "move" });
    return { ...s, wt, r };
  }

  const byId = (items: Item[]) => (id: string) => items.find((i) => i.id === id);

  describe("moves (§6.4.7)", () => {
    it("a paragraph moved word for word is one linked move, accepted as a unit", async () => {
      const { stet, repo, wt, r } = await submitMove();
      expect(r.items).toHaveLength(2);
      const [from, to] = [r.items.find((i) => !i.newText.trim())!, r.items.find((i) => !i.oldText.trim())!];
      expect(r.moves).toEqual([{ from: [from.id], to: [to.id], changed: 0 }]);
      expect(from.move).toEqual(to.move);
      const g = r.groups.find((g) => g.items.includes(from.id))!;
      expect(g.kind).toBe("linked");
      expect(g.items.sort()).toEqual([from.id, to.id].sort());
      expect(g.title).toMatch(/^Move “Our tool splits every [^”]*…” \(paragraph, unchanged\)$/);

      // Deciding one half decides the move (half of it would lose or duplicate the passage), even
      // if its group was dissolved.
      await stet.ungroup(g.id);
      const r2 = await stet.accept([to.id], { overrideLinked: true });
      expect(r2.accepted.map((i) => i.id).sort()).toEqual([from.id, to.id].sort());
      expect(read(repo, L.file)).toBe(read(wt, L.file));
    });

    it("rejecting one half rejects the move", async () => {
      const { stet, r } = await submitMove();
      const m = r.moves[0]!;
      const rejected = await stet.reject([m.from[0]!]);
      expect(rejected.map((i) => i.id).sort()).toEqual([...m.from, ...m.to].sort());
    });

    it("two sentences moved within the text count; a few words don't", async () => {
      const two = "Such changes are often long and touch many places at once. They are hard to review in a plain diff of the whole file.";
      const doc = DOC.replace(P1, `We study the review of changes proposed by language models. ${two}`);
      const s = await setup({ [L.file]: doc });
      const { worktree: wt } = await s.stet.newAgent("a");
      write(wt, L.file, doc.replace(` ${two}`, "").replace("We report on the evaluation here.", `We report on the evaluation here. ${two}`));
      const r = await s.stet.submit("a", { title: "move two sentences" });
      expect(r.moves).toHaveLength(1);
      expect(r.groups[0]!.title).toMatch(/\(2 sentences, unchanged\)/);

      const s2 = await setup({ [L.file]: DOC });
      const { worktree: wt2 } = await s2.stet.newAgent("a");
      write(wt2, L.file, DOC.replace(" in scientific papers", "").replace("We report on", "We report in scientific papers on"));
      expect((await s2.stet.submit("a", { title: "few words" })).moves).toEqual([]);
    });

    it("a small change along the way is shown; a larger one is not a move", async () => {
      const small = await submitMove(P2.replace("small items", "short items"));
      expect(small.r.moves).toEqual([expect.objectContaining({ changed: 1 })]);
      expect(small.r.groups[0]!.title).toMatch(/\(paragraph, 1 word changed\)$/);
      const to = small.r.items.find((i) => i.id === small.r.moves[0]!.to[0])!;
      const from = small.r.items.find((i) => i.id === small.r.moves[0]!.from[0])!;
      const changes = moveChanges(from.oldText, to.newText);
      expect(changes).toEqual([expect.objectContaining({ was: "small", now: "short" })]);
      expect(to.newText.slice(changes[0]!.start, changes[0]!.end)).toBe("short");
      expect(moveChangesOf(to, byId(small.r.items))).toEqual(changes);

      // A 27-word paragraph allows two changed words (one per 10); with three it is a deletion and
      // an insertion, linked: accepting one alone would lose or duplicate the paragraph.
      const two = await submitMove(P2.replace("small items", "short pieces"));
      expect(two.r.moves).toEqual([expect.objectContaining({ changed: 2 })]);
      const more = await submitMove(P2.replace("small items that the author", "short pieces that each author"));
      expect(more.r.moves).toEqual([]);
      expect(more.r.groups).toEqual([expect.objectContaining({ title: expect.stringMatching(/^Moved and rewritten “Our tool splits/) })]);
    });

    it("moves into another file count, and stay together in the parts of a larger linked group", async () => {
      const s = await setup({ [L.file]: DOC, [`appendix.${L.ext}`]: `${L.heading("Appendix")}\n` });
      const { worktree: wt } = await s.stet.newAgent("a");
      write(wt, L.file, DOC.replace(`${P2}\n\n`, ""));
      write(wt, `appendix.${L.ext}`, `${L.heading("Appendix")}\n\n${P2}\n`);
      edit(wt, L.file, "We report on", "We now report on");
      const r = await s.stet.submit("a", {
        title: "to the appendix",
        groups: [{ kind: "linked", title: "Restructure", where: [`${L.file}:1-20`, `appendix.${L.ext}:1-5`], parts: [{ title: "Out", where: [`${L.file}:${line(5)}`] }, { title: "In", where: [`appendix.${L.ext}:3`] }, { title: "Wording", where: [`${L.file}:${line(11)}`] }] }],
      });
      expect(r.moves).toHaveLength(1);
      const m = r.moves[0]!;
      const g = r.groups.find((g) => g.items.includes(m.from[0]!))!;
      const part = g.parts?.find((p) => p.items.includes(m.from[0]!));
      if (g.parts) expect(part!.items).toContain(m.to[0]);
      else expect(g.items).toContain(m.to[0]);
    });

    it("blocks from different places that land next to each other are a move each (bug report 2026-11-13)", async () => {
      // P1 and P3, apart in the introduction, end up together in the evaluation. Since 2026-11-19
      // each new paragraph is a change of its own, and paragraphs that only land together (or only
      // leave together) are separate moves: one block moved is next to each other on both sides.
      const doc = DOC.replace(`${P1}\n\n`, "").replace(`${P3}\n\n`, "").replace("We report on the evaluation here.\n", `We report on the evaluation here.\n\n${P1}\n\n${P3}\n`);
      const { stet, repo, wt, r } = await submitDoc(doc);
      expect(r.items).toHaveLength(4);
      const del1 = r.items.find((i) => i.oldText.startsWith("We study"))!;
      const del3 = r.items.find((i) => i.oldText.startsWith("The approach"))!;
      const ins1 = r.items.find((i) => !i.oldText.trim() && i.newText.includes("We study"))!;
      const ins3 = r.items.find((i) => !i.oldText.trim() && i.newText.includes("The approach"))!;
      expect(r.moves).toEqual(expect.arrayContaining([{ from: [del1.id], to: [ins1.id], changed: 0 }, { from: [del3.id], to: [ins3.id], changed: 0 }]));
      expect(r.moves).toHaveLength(2);
      // Rejecting one move leaves the other, and the paper stays well formed.
      const rejected = await stet.reject([del3.id]);
      expect(rejected).toHaveLength(2);
      await stet.accept([del1.id]);
      // (The paragraph break that came with P1 stays: one blank line more at the end.)
      expect(read(repo, L.file)).toBe(DOC.replace(`${P1}\n\n`, "").replace("We report on the evaluation here.\n", `We report on the evaluation here.\n\n${P1}\n\n`));
      void wt;
    });

    it("adjacent blocks that go to different places are a move each", async () => {
      // P2 and P3, next to each other, go to the top of the introduction and to the evaluation.
      const doc = DOC.replace(`${P2}\n\n${P3}\n\n`, "")
        .replace(`${L.heading("Introduction")}\n`, `${L.heading("Introduction")}\n${P3}\n\n`)
        .replace("We report on the evaluation here.\n", `We report on the evaluation here.\n\n${P2}\n`);
      const { stet, repo, wt, r } = await submitDoc(doc);
      const del = r.items.filter((i) => !i.newText.trim());
      const ins = r.items.filter((i) => !i.oldText.trim());
      expect(del).toHaveLength(2);
      expect(ins).toHaveLength(2);
      expect(r.moves).toHaveLength(2);
      for (const m of r.moves) expect([m.from.length, m.to.length]).toEqual([1, 1]);
      await stet.accept([...r.moves[0]!.to, ...r.moves[1]!.to]);
      expect(read(repo, L.file)).toBe(read(wt, L.file));
    });

    it("a changed word in one of several moved blocks is shown at that block", async () => {
      const doc = DOC.replace(`${P1}\n\n`, "").replace(`${P3}\n\n`, "")
        .replace("We report on the evaluation here.\n", `We report on the evaluation here.\n\n${P1}\n\n${P3.replace("three papers", "four papers")}\n`);
      const { r } = await submitDoc(doc);
      expect(r.moves.map((m) => m.changed).sort()).toEqual([0, 1]);
      const m = r.moves.find((m) => m.changed === 1)!;
      const ins = r.items.find((i) => m.to.includes(i.id) && i.newText.includes("four papers"))!;
      const c = moveChangesOf(ins, byId(r.items));
      expect(c).toEqual([expect.objectContaining({ was: "three", now: "four" })]);
      expect(ins.newText.slice(c[0]!.start, c[0]!.end)).toBe("four");
    });
  });

  describe("moves the agent's report found missing (2026-11-13)", () => {
    const THM = L.theorem;
    const Y = L.refersToTheorem;
    const PAPER = `${L.begin}${L.heading("Introduction")}\n${THM}\n\n${P1}\n\n${L.heading("Results")}\n${Y}\n\n${P2}\n${L.end}`;

    async function agentOn(doc: string) {
      const s = await setup({ [L.file]: doc });
      const { worktree: wt } = await s.stet.newAgent("a");
      return { ...s, wt };
    }

    it("a block inserted right before a paragraph starting with words from the block is a pure insertion (cause 1)", async () => {
      const { stet, wt } = await agentOn(PAPER);
      write(wt, L.file, PAPER.replace(`${THM}\n\n`, "").replace(`${L.heading("Results")}\n${Y}`, `${L.heading("Results")}\n${THM}\n${Y}`));
      const r = await stet.submit("a", { title: "move the theorem" });
      expect(r.items.map((i) => [!!i.oldText.trim(), !!i.newText.trim()])).toEqual([[true, false], [false, true]]);
      expect(r.moves).toEqual([expect.objectContaining({ changed: 0 })]);
      expect(r.groups[0]!.title).toContain(`(${L.theoremKind}, unchanged)`);
    });

    it("the two sides of a move submitted in different rounds are paired (cause 2)", async () => {
      const { stet, wt } = await agentOn(PAPER);
      write(wt, L.file, PAPER.replace(`${P1}\n\n`, ""));
      const r1 = await stet.submit("a", { title: "drop P1" });
      expect(r1.moves).toEqual([]);
      write(wt, L.file, read(wt, L.file).replace(`${P2}\n`, `${P2}\n\n${P1}\n`));
      const r2 = await stet.submit("a", { title: "P1 at the end" });
      expect(r2.moves).toEqual([{ from: [r1.items[0]!.id], to: [r2.items[0]!.id], changed: 0 }]);
      expect((await stet.getItem(r1.items[0]!.id))!.move).toEqual(r2.moves[0]);
    });

    it("a block moved next to a pending moved block: one move of both, and no group linking unrelated items (cause 3)", async () => {
      const { stet, repo, wt } = await agentOn(PAPER);
      // Round 1: the theorem moves to the end.
      write(wt, L.file, PAPER.replace(`${THM}\n\n`, "").replace(`${P2}\n`, `${P2}\n\n${THM}\n`));
      const r1 = await stet.submit("a", { title: "theorem to the end" });
      expect(r1.moves).toHaveLength(1);
      const oldGroup = r1.groups[0]!.id;
      // Round 2: P1 moves to the end too, right before the theorem's pending insertion.
      write(wt, L.file, read(wt, L.file).replace(`${P1}\n\n`, "").replace(`${P2}\n\n${THM}`, `${P2}\n\n${P1}\n\n${THM}`));
      const r2 = await stet.submit("a", { title: "P1 to the end" });
      // Re-splitting joins the two deletions (adjacent at the source) and the two insertions; the
      // blocks are in swapped order, and it is still one move.
      expect(r2.moves).toHaveLength(1);
      const m = r2.moves[0]!;
      // (Whether the title says "reordered" depends on the order of the two insertions, which
      // come from different rounds at the same place.)
      expect(r2.groups.find((g) => g.items.includes(m.to[0]!))!.title).toMatch(/^Move 2 passages .*unchanged\)/);
      expect((await stet.listGroups()).map((g) => g.id)).not.toContain(oldGroup);
      const get = byId(await stet.listItems({ agent: "a" }));
      expect(moveChangesOf(get(m.to[0]!)!, get)).toEqual([]);
      // Every pending item is part of this one move; accepting one accepts all and gives the agent's text.
      const pending = await stet.listItems({ agent: "a", status: ["pending"] });
      expect(pending.map((i) => i.id).sort()).toEqual([...m.from, ...m.to].sort());
      await stet.accept([m.to[0]!]);
      expect(read(repo, L.file)).toBe(read(wt, L.file));
    });

    it("withdrawing part of a move dissolves it", async () => {
      const { stet, wt } = await agentOn(PAPER);
      write(wt, L.file, PAPER.replace(`${P1}\n\n`, "").replace(`${P2}\n`, `${P2}\n\n${P1}\n`));
      const r = await stet.submit("a", { title: "move" });
      const [from, to] = [r.moves[0]!.from[0]!, r.moves[0]!.to[0]!];
      await stet.withdraw("a", [to]);
      const left = (await stet.getItem(from))!;
      expect(left.move).toBeUndefined();
      expect(left.groups).toEqual([]);
      expect((await stet.listGroups()).filter((g) => g.items.includes(from))).toEqual([]);
    });
  });
}

for (const L of DOC_LANGS) describe.skipIf(!L.available)(L.name, () => moves(L));

describe("parts and moves", () => {
  it("joins proposed parts that would split a move", async () => {
    const mk = (id: string, oldText: string, newText: string, move?: Item["move"]) =>
      ({ id, kind: "modify", status: "pending", oldText, newText, context: { before: "", after: "" }, ...(move ? { move } : {}) }) as Item;
    // As stored by 0.7.0 (single ids) and since (lists).
    for (const move of [{ from: "1.1", to: "1.2", changed: 0 }, { from: ["1.1"], to: ["1.2"], changed: 0 }]) {
      const members = [mk("1.1", "A passage.", "", move), mk("1.2", "", "A passage.", move), mk("1.3", "x", "y")];
      const r = await settleParts([{ title: "Out", items: ["1.1"] }, { title: "In", items: ["1.2"] }, { title: "Other", items: ["1.3"] }], members);
      expect(r.parts!.map((p) => p.items)).toEqual([["1.1", "1.2"], ["1.3"]]);
      expect(r.notes.join(" ")).toMatch(/move one passage/);
    }
  });
});
