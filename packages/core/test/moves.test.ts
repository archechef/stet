import { describe, expect, it } from "vitest";
import { moveChanges } from "../src/moves.js";
import { settleParts } from "../src/parts.js";
import type { Item } from "../src/model.js";
import { edit, read, setup, write } from "./helpers.js";

const P1 = "We study the review of changes proposed by language models in scientific papers. Such changes are often long and touch many places at once.";
const P2 = "Our tool splits every proposal into small items that the author can accept or reject one at a time, in the editor where the paper is written.";
const P3 = "The approach scales to long documents. It was evaluated on three papers with several hundred proposals each.";
const DOC = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
${P1}

${P2}

${P3}

\\section{Evaluation}
We report on the evaluation here.
\\end{document}
`;

/** The agent moves P2 to the evaluation section (optionally with an edit), and nothing else. */
async function submitMove(moved = P2, extra?: (t: string) => string) {
  const s = await setup({ "main.tex": DOC });
  const { worktree: wt } = await s.stet.newAgent("a");
  let t = DOC.replace(`${P2}\n\n`, "").replace("We report on the evaluation here.\n", `We report on the evaluation here.\n\n${moved}\n`);
  if (extra) t = extra(t);
  write(wt, "main.tex", t);
  const r = await s.stet.submit("a", { title: "move" });
  return { ...s, wt, r };
}

describe("moves (§6.4.7)", () => {
  it("a paragraph moved word for word is one linked move, accepted as a unit", async () => {
    const { stet, repo, wt, r } = await submitMove();
    expect(r.items).toHaveLength(2);
    const [from, to] = [r.items.find((i) => !i.newText.trim())!, r.items.find((i) => !i.oldText.trim())!];
    expect(r.moves).toEqual([{ from: from.id, to: to.id, changed: 0 }]);
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
    expect(read(repo, "main.tex")).toBe(read(wt, "main.tex"));
  });

  it("rejecting one half rejects the move", async () => {
    const { stet, r } = await submitMove();
    const rejected = await stet.reject([r.moves[0]!.from]);
    expect(rejected.map((i) => i.id).sort()).toEqual([r.moves[0]!.from, r.moves[0]!.to].sort());
  });

  it("two sentences moved within the text count; a few words don't", async () => {
    const two = "Such changes are often long and touch many places at once. They are hard to review in a plain diff of the whole file.";
    const doc = DOC.replace(P1, `We study the review of changes proposed by language models. ${two}`);
    const s = await setup({ "main.tex": doc });
    const { worktree: wt } = await s.stet.newAgent("a");
    write(wt, "main.tex", doc.replace(` ${two}`, "").replace("We report on the evaluation here.", `We report on the evaluation here. ${two}`));
    const r = await s.stet.submit("a", { title: "move two sentences" });
    expect(r.moves).toHaveLength(1);
    expect(r.groups[0]!.title).toMatch(/\(2 sentences, unchanged\)/);

    const s2 = await setup({ "main.tex": DOC });
    const { worktree: wt2 } = await s2.stet.newAgent("a");
    write(wt2, "main.tex", DOC.replace(" in scientific papers", "").replace("We report on", "We report in scientific papers on"));
    expect((await s2.stet.submit("a", { title: "few words" })).moves).toEqual([]);
  });

  it("a small change along the way is shown; a larger one is not a move", async () => {
    const small = await submitMove(P2.replace("small items", "short items"));
    expect(small.r.moves).toEqual([expect.objectContaining({ changed: 1 })]);
    expect(small.r.groups[0]!.title).toMatch(/\(paragraph, 1 word changed\)$/);
    const to = small.r.items.find((i) => i.id === small.r.moves[0]!.to)!;
    const from = small.r.items.find((i) => i.id === small.r.moves[0]!.from)!;
    const changes = moveChanges(from.oldText, to.newText);
    expect(changes).toEqual([expect.objectContaining({ was: "small", now: "short" })]);
    expect(to.newText.slice(changes[0]!.start, changes[0]!.end)).toBe("short");

    // A 27-word paragraph allows one changed word; two are a deletion and an insertion.
    const more = await submitMove(P2.replace("small items", "short pieces"));
    expect(more.r.moves).toEqual([]);
  });

  it("moves into another file count, and stay together in the parts of a larger linked group", async () => {
    const s = await setup({ "main.tex": DOC, "appendix.tex": "\\section{Appendix}\n" });
    const { worktree: wt } = await s.stet.newAgent("a");
    write(wt, "main.tex", DOC.replace(`${P2}\n\n`, ""));
    write(wt, "appendix.tex", `\\section{Appendix}\n\n${P2}\n`);
    edit(wt, "main.tex", "We report on", "We now report on");
    const r = await s.stet.submit("a", {
      title: "to the appendix",
      groups: [{ kind: "linked", title: "Restructure", where: ["main.tex:1-20", "appendix.tex:1-5"], parts: [{ title: "Out", where: ["main.tex:5"] }, { title: "In", where: ["appendix.tex:3"] }, { title: "Wording", where: ["main.tex:11"] }] }],
    });
    expect(r.moves).toHaveLength(1);
    const g = r.groups.find((g) => g.items.includes(r.moves[0]!.from))!;
    const part = g.parts?.find((p) => p.items.includes(r.moves[0]!.from));
    if (g.parts) expect(part!.items).toContain(r.moves[0]!.to);
    else expect(g.items).toContain(r.moves[0]!.to);
  });
});

describe("parts and moves", () => {
  it("joins proposed parts that would split a move", async () => {
    const mk = (id: string, oldText: string, newText: string, move?: Item["move"]) =>
      ({ id, kind: "modify", status: "pending", oldText, newText, context: { before: "", after: "" }, ...(move ? { move } : {}) }) as Item;
    const move = { from: "1.1", to: "1.2", changed: 0 };
    const members = [mk("1.1", "A passage.", "", move), mk("1.2", "", "A passage.", move), mk("1.3", "x", "y")];
    const r = await settleParts([{ title: "Out", items: ["1.1"] }, { title: "In", items: ["1.2"] }, { title: "Other", items: ["1.3"] }], members);
    expect(r.parts!.map((p) => p.items)).toEqual([["1.1", "1.2"], ["1.3"]]);
    expect(r.notes.join(" ")).toMatch(/move one passage/);
  });
});
