/** What agents are told: repeats of rejected changes, and the wording of feedback. */
import { describe, expect, it } from "vitest";
import { describeFeedback } from "../src/mcp.js";
import { edit, PAPER, setup } from "./helpers.js";

describe("repeats of rejected changes (agent report 2026-11-18)", () => {
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
});

describe("feedback sentences end in one full stop (test report v0.16, B13)", () => {
  it("a reason with its own full stop, question mark or none", async () => {
    const { describeFeedback } = await import("../src/mcp.js");
    const ev = (reason: string) => ({ seq: 1, at: "", type: "rejected", agent: "a", items: ["1.1"], data: { reason } }) as any;
    expect(describeFeedback(ev("we measured speed."))).toBe("REJECTED 1.1; reason: we measured speed. Do not propose this change again.");
    expect(describeFeedback(ev("why?"))).toBe("REJECTED 1.1; reason: why? Do not propose this change again.");
    expect(describeFeedback(ev("keep it"))).toBe("REJECTED 1.1; reason: keep it. Do not propose this change again.");
    const reopened = { seq: 2, at: "", type: "reopened", agent: "a", items: ["1.1"], data: { was: "needs_revision" } } as any;
    expect(describeFeedback(reopened)).toMatch(/took back the request to revise it/);
  });
});
