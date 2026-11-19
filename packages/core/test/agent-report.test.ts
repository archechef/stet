/** Bug report from an agent (2026-11-18): repeats after failed accepts, split sentences, insertions at one spot. */
import { describe, expect, it } from "vitest";
import { describeFeedback } from "../src/mcp.js";
import { edit, PAPER, read, setup, write } from "./helpers.js";

describe("agent report 2026-11-18", () => {
  it("does not count a rejection after a failed accept as a reason to auto-reject the change again", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    // The reviewer rewrote the formula meanwhile, so the change no longer applies.
    edit(repo, "main.tex", "$a+b=c$", "$a + b = c$");
    await expect(stet.accept([items[0]!.id])).rejects.toThrow(/could not be applied/);
    expect((await stet.getItem(items[0]!.id))!.acceptFailed?.reason).toMatch(/surrounding text changed/);
    await stet.reject([items[0]!.id], { reason: "does not apply cleanly, will re-review later" });
    const [fb] = await stet.feedback("a");
    expect(describeFeedback(fb!)).toMatch(/tried to accept it, but it could not be applied .*propose it again/);
    expect(describeFeedback(fb!)).not.toMatch(/Do not propose this change again/);

    await stet.sync("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const r2 = await stet.submit("a", { title: "again" });
    expect(r2.repeats).toEqual([]);
    expect(r2.items.map((i) => i.status)).toEqual(["pending"]);
  });

  it("still auto-rejects a plain repeat", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.reject([items[0]!.id], { reason: "no" });
    await stet.sync("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    expect((await stet.submit("a", { title: "again" })).repeats).toHaveLength(1);
  });

  it("keeps a reworded sentence together when a piece of it repeats a rejection", async () => {
    const sentence = "In this work we study the problem of reviewing many changes that are proposed by an assistant for a long paper.";
    const { stet } = await setup({ "main.tex": `\\section{A}\n${sentence}\n\nNext paragraph.\n` });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const first = await stet.submit("a", { title: "t" });
    await stet.reject([first.items[0]!.id], { reason: "keep 'problem'" });
    await stet.sync("a");

    // Reworded: the rejected piece again, plus a change further on in the same sentence.
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "for a long paper", "for a lengthy manuscript");
    const r = await stet.submit("a", { title: "reword" });
    expect(r.repeats).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.status).toBe("pending");
    expect(r.items[0]!.newText).toMatch(/^task[\s\S]*lengthy manuscript$/);
    expect(r.warnings.join("\n")).toMatch(/together as one item/);
  });

  it("does not merge across sentences: a repeat in another sentence is still auto-rejected", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const first = await stet.submit("a", { title: "t" });
    await stet.reject([first.items[0]!.id]);
    await stet.sync("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "proposed by an AI", "proposed by a model");
    const r = await stet.submit("a", { title: "two sentences" });
    expect(r.repeats).toHaveLength(1);
    expect(r.items.filter((i) => i.status === "pending")).toHaveLength(1);
  });

  it("keeps several insertions at one spot (entries appended to a .bib file) through syncs and accepts", async () => {
    const bib = "@article{knuth84,\n  title={Literate Programming},\n  year={1984}\n}\n";
    const entry = (k: string) => `\n@misc{${k},\n  title={${k}},\n  year={2020}\n}\n`;
    const { stet, repo } = await setup({ "main.tex": PAPER, "refs.bib": bib });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "refs.bib", bib + entry("one") + entry("two") + entry("three"));
    const { items } = await stet.submit("a", { title: "refs" });
    expect(items.map((i) => [i.range.start, i.oldText])).toEqual([[bib.length - 1, ""], [bib.length - 1, ""], [bib.length - 1, ""]]);

    for (let k = 0; k < 2; k++) {
      const s = await stet.sync("a");
      expect(s.stale).toEqual([]);
      expect(read(wt, "refs.bib")).toBe(bib + entry("one") + entry("two") + entry("three"));
    }

    // Accepting one leaves the others pending; accepting the rest adds them after it, in order.
    const [one, ...rest] = (await stet.listItems({ agent: "a", status: ["pending"] })).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const acc = await stet.accept([one!.id]);
    expect(acc.stale).toEqual([]);
    const all = bib + entry("one") + entry("two") + entry("three");
    expect(rest).toHaveLength(2);
    expect((await stet.sync("a")).stale).toEqual([]);
    expect(read(wt, "refs.bib")).toBe(all); // not reordered in the agent's copy
    await stet.accept(rest.map((i) => i.id));
    expect(read(repo, "refs.bib")).toBe(all);
  });

  describe("a change right next to an accepted one", () => {
    const P = "We now state the main technical result, which is used throughout the rest of this section and the next one.";
    const DOC = `\\section{Results}\n${P}\n\\begin{lemma}[Old title]\\label{lem:main}\nFor all $x$ we have $f(x) \\le g(x)$.\n\\end{lemma}\n`;
    const WANT = DOC.replace(`${P}\n\\begin{lemma}[Old title]`, "A shorter lead-in.\\begin{lemma}[Main bound]");

    for (const [name, order, sync] of [
      ["in order", [0, 1], false],
      ["in order, syncing in between", [0, 1], true],
      ["the other way round", [1, 0], false],
      ["the other way round, syncing in between", [1, 0], true],
    ] as const) {
      it(`can be accepted ${name}`, async () => {
        const { stet, repo } = await setup({ "main.tex": DOC });
        const { worktree: wt } = await stet.newAgent("a");
        // The paragraph rewritten and joined onto the lemma line: two changes that touch (the
        // rewrite takes the line break with it).
        edit(wt, "main.tex", `${P}\n\\begin{lemma}[Old title]`, "A shorter lead-in.\\begin{lemma}[Main bound]");
        const { items } = await stet.submit("a", { title: "t" });
        expect(items.map((i) => i.oldText)).toEqual([expect.stringMatching(/next one\.\n$/), "Old title"]);
        for (const k of order) {
          const r = await stet.accept([items[k]!.id]);
          expect(r.stale).toEqual([]);
          if (sync) expect((await stet.sync("a")).stale).toEqual([]);
        }
        expect(read(repo, "main.tex")).toBe(WANT);
      });
    }

    it("can be merged with it into an atomic group although one of them crosses a paragraph break", async () => {
      const { stet } = await setup({ "main.tex": `Intro.\n\nA paragraph that ends here.\n\n\\begin{lemma}[Old]\nBody.\n\\end{lemma}\n` });
      const { worktree: wt } = await stet.newAgent("a");
      edit(wt, "main.tex", "A paragraph that ends here.\n\n\\begin{lemma}[Old]", "\\begin{lemma}[New]");
      const { items } = await stet.submit("a", { title: "t" });
      expect(items.length).toBeGreaterThanOrEqual(2);
      const g = await stet.group("a", items.map((i) => i.id), "atomic", "one change");
      expect(g.merged?.status).toBe("pending");
      expect(g.merged?.oldText).toMatch(/^A paragraph[\s\S]*Old$/);
    });
  });

  for (const between of ["commit", "share"] as const) {
    it(`gives other agents an accepted change next to one accepted before a ${between}`, async () => {
      // Accepted edits not reaching agents: the review base dropped an accepted change it could not
      // locate on top of the user's commit or shared edits, which hold its accepted neighbour.
      const P = "We now state the main technical result, which is used throughout the rest of this section and the next one.";
      const DOC = `\\section{Results}\n${P}\n\\begin{lemma}[Old title]\\label{lem:main}\nFor all $x$.\n\\end{lemma}\n`;
      const WANT = DOC.replace(`${P}\n\\begin{lemma}[Old title]`, "A shorter lead-in.\\begin{lemma}[Main bound]");
      const { stet, repo } = await setup({ "main.tex": DOC });
      const { worktree: wt } = await stet.newAgent("a");
      const { worktree: other } = await stet.newAgent("b");
      edit(wt, "main.tex", `${P}\n\\begin{lemma}[Old title]`, "A shorter lead-in.\\begin{lemma}[Main bound]");
      const { items } = await stet.submit("a", { title: "t" });
      await stet.accept([items[0]!.id]);
      if (between === "commit") await stet.commitAcceptedItems();
      else await stet.shareEdits();
      await stet.accept([items[1]!.id]);
      expect(read(repo, "main.tex")).toBe(WANT);
      await stet.sync("b");
      expect(read(other, "main.tex")).toBe(WANT);
    });
  }
});
