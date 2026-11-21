/** Linked groups: what is linked, and deciding a group differently in its parts. */
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { joinTitles } from "../src/grouping.js";
import type { Item } from "../src/model.js";
import { settleParts } from "../src/parts.js";
import { CLI_DIST, edit, git, makeItem, PAPER, renamed, setup, write } from "./helpers.js";

const item = (oldText: string, newText: string, extra: Partial<Item> = {}) => makeItem(oldText, newText, { file: "main.typ", ...extra });

describe("a new file and what reads it in (test report v0.14, D6)", () => {
  it("links an added chapter with its \\input, and a figure with its \\includegraphics", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "chapters/discussion.tex", "\\section{Discussion}\nIt works.\n");
    write(wt, "figs/plot.pdf", "%PDF-1.4\n\u0000binary\n");
    edit(wt, "main.tex", "\\end{document}", "\\input{chapters/discussion}\n\\includegraphics[width=3cm]{figs/plot}\n\\end{document}");
    const r = await stet.submit("a", { title: "t" });
    const linked = r.groups.filter((g) => g.kind === "linked");
    const of = (f: string) => r.items.find((i) => i.file === f)!.id;
    const main = r.items.filter((i) => i.file === "main.tex").map((i) => i.id);
    expect(linked.some((g) => g.items.includes(of("chapters/discussion.tex")) && g.items.some((i) => main.includes(i)))).toBe(true);
    expect(linked.some((g) => g.items.includes(of("figs/plot.pdf")) && g.items.some((i) => main.includes(i)))).toBe(true);
  });

  it("links a deleted chapter with the \\input taken out", async () => {
    const { stet } = await setup({ "main.tex": PAPER.replace("\\end{document}", "\\input{old}\n\\end{document}"), "old.tex": "Old.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    git(wt, "rm", "-q", "old.tex");
    edit(wt, "main.tex", "\\input{old}\n", "");
    const r = await stet.submit("a", { title: "t" });
    expect(r.groups.some((g) => g.kind === "linked" && g.items.length === 2 && /Delete old\.tex/.test(g.title))).toBe(true);
  });
});

describe("a linked group decided differently in its parts (test report v0.14, D3)", () => {
  it("tells the reviewer, on the accept and on the reject", async () => {
    const { stet, label, refs } = await renamed();
    const acc = await stet.accept(refs.map((i) => i.id));
    // The label is still pending: that is said too (test report v0.16.0, D3).
    expect(acc.warnings.join(" ")).toMatch(/partly accepted: .* still to decide/);
    const rejected = await stet.reject([label.id]);
    const w = await stet.partlyDecided(rejected);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/partly accepted: .* accepted, .* rejected/);
    // And when the reject came first.
    await stet.undo(refs[0]!.id);
    const acc2 = await stet.accept(refs.map((i) => i.id));
    expect(acc2.warnings.join(" ")).toMatch(/partly accepted/);
  });
});

describe("accepting one part of a label rename (test report v0.16, D3)", () => {
  it("warns that the rest of the linked group is still to decide", async () => {
    const { stet, g, label, refs } = await renamed();
    const r = await stet.accept([label.id]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(g.id);
    expect(r.warnings[0]).toMatch(
      new RegExp(`partly accepted: ${label.id.replace(".", "\\.")} accepted, .*${refs[0]!.id.replace(".", "\\.")}.* still to decide`),
    );
    // Accepting the rest makes the group whole again: no warning.
    expect((await stet.accept(refs.map((i) => i.id))).warnings).toEqual([]);
  });

  it("rejecting a part while nothing is accepted says nothing", async () => {
    const { stet, label } = await renamed();
    expect(await stet.partlyDecided(await stet.reject([label.id]))).toEqual([]);
  });

  it("`stet accept` prints the warning", async () => {
    const { repo, label } = await renamed();
    const r = spawnSync(process.execPath, [CLI_DIST, "accept", label.id], { cwd: repo, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/! G\d+ \(Rename label .*\) is a linked group, now partly accepted: .* still to decide/);
  });
});

describe("merged linked groups don't confuse the agent (test report v0.16)", () => {
  it("parts sharing a change are joined, quietly when the groups were merged", async () => {
    const { settleParts } = await import("../src/parts.js");
    const mk = (id: string): any => ({
      id,
      file: "a.tex",
      kind: "modify",
      oldText: id,
      newText: id + "!",
      status: "pending",
      groups: [],
      range: { start: 0, end: 0 },
      context: { before: "", after: "" },
    });
    const [a, b, c] = [mk("1.1"), mk("1.2"), mk("1.3")];
    const drafts = [
      { title: "Old", items: ["1.1", "1.2"] },
      { title: "New", items: ["1.2", "1.3"] },
    ];
    const loud = await settleParts(drafts, [a, b, c]);
    expect(loud.notes.join(" ")).toMatch(/both contain 1\.2/);
    const quiet = await settleParts(drafts, [a, b, c], undefined, { quietOverlaps: true });
    expect(quiet.parts).toBeUndefined(); // one part: the whole group
    expect(quiet.notes).toEqual([]);
  });
});

describe("parts and titles", () => {
  it("parts that overlap list each change once (security report 5e4c6af, S17)", async () => {
    const a = item("is", "was");
    const b = item("an", "the");
    const { parts } = await settleParts(
      [
        { title: "x", items: [a.id, b.id] },
        { title: "y", items: [b.id] },
        { title: "z", items: [item("q", "r").id] },
      ],
      [a, b],
    );
    expect(parts).toBeUndefined();
    const c = item("q", "r");
    const r = await settleParts(
      [
        { title: "x", items: [a.id, b.id] },
        { title: "y", items: [b.id] },
        { title: "z", items: [c.id] },
      ],
      [a, b, c],
    );
    expect(r.parts?.map((p) => p.items)).toEqual([[a.id, b.id], [c.id]]);
  });

  it("joined titles keep each title once (test report 5e4c6af, B1)", () => {
    expect(joinTitles("@intro → @start + See @intro", "See @intro + @intro → @start")).toBe("@intro → @start + See @intro");
    expect(joinTitles("a", "b + a + c")).toBe("a + b + c");
  });
});
