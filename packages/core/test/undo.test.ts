import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeFeedback } from "../src/mcp.js";
import { edit, PAPER, read, setup, write } from "./helpers.js";

describe("undo", () => {
  it("takes an accepted change out of the working copy again; the agent's copy keeps it as a proposal", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    await stet.sync("a");
    await stet.feedback("a");
    expect(read(repo, "main.tex")).toContain("$a+b=d$");

    const r = await stet.undo(items[0]!.id);
    expect(r.reopened.map((i) => i.id)).toEqual([items[0]!.id]);
    expect(read(repo, "main.tex")).toBe(PAPER);
    const it2 = (await stet.getItem(items[0]!.id))!;
    expect(it2.status).toBe("pending");
    expect(it2.resolution).toBeNull();
    const [fb] = await stet.feedback("a");
    expect(describeFeedback(fb!)).toMatch(/^REOPENED .*undid accepting it; it is pending again/);

    expect((await stet.sync("a")).stale).toEqual([]);
    expect(read(wt, "main.tex")).toContain("$a+b=d$"); // still proposed
    await stet.accept([items[0]!.id]); // and can be accepted again
    expect(read(repo, "main.tex")).toContain("$a+b=d$");
  });

  it("brings back changes the accept made stale", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const b = await stet.newAgent("b");
    edit(a.worktree, "main.tex", "$a+b=c$", "$a+b=d$");
    edit(b.worktree, "main.tex", "$a+b=c$", "$a+b=e$");
    const ra = await stet.submit("a", { title: "a" });
    const rb = await stet.submit("b", { title: "b" });
    const acc = await stet.accept([ra.items[0]!.id]);
    expect(acc.stale.map((i) => i.id)).toEqual([rb.items[0]!.id]);
    const r = await stet.undo(ra.items[0]!.id);
    expect(r.restored.map((i) => i.id)).toEqual([rb.items[0]!.id]);
    expect((await stet.getItem(rb.items[0]!.id))!.status).toBe("pending");
    await stet.accept([rb.items[0]!.id]);
  });

  it("reopens a rejection, and the agent is told", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.reject([items[0]!.id], { reason: "no" });
    await stet.feedback("a");
    await stet.undo(items[0]!.id);
    expect((await stet.getItem(items[0]!.id))!.status).toBe("pending");
    expect(describeFeedback((await stet.feedback("a"))[0]!)).toMatch(/undid rejecting it/);
    // A reopened rejection no longer blocks the same change as a repeat.
    await stet.withdraw("a", [items[0]!.id]);
    await stet.sync("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    expect((await stet.submit("a", { title: "again" })).repeats).toEqual([]);
  });

  it("undoes a linked group as a whole (a part of one on its own)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items, groups } = await stet.submit("a", {
      title: "together",
      groups: [{ kind: "linked", reason: "test of linked groups", title: "both", where: ["main.tex:4", "main.tex:8"] }],
    });
    expect(items).toHaveLength(2);
    await stet.acceptGroup(groups.find((g) => g.kind === "linked")!.id);
    const r = await stet.undo(items[0]!.id);
    expect(r.reopened.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
    expect(read(repo, "main.tex")).toBe(PAPER);
  });

  it("removes an accepted new file again", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "sections/new.tex", "New section.\n");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    expect(existsSync(join(repo, "sections/new.tex"))).toBe(true);
    await stet.undo(items[0]!.id);
    expect(existsSync(join(repo, "sections/new.tex"))).toBe(false);
  });

  it("refuses committed accepts and changes edited since, and leaves everything as it was", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    const [task, formula] = [...items].sort((x, y) => x.range.start - y.range.start);
    await stet.accept([task!.id, formula!.id]);
    edit(repo, "main.tex", "$a+b=d$", "$x$"); // the user rewrote the accepted formula
    await expect(stet.undo(formula!.id)).rejects.toThrow(/Nothing was undone/);
    expect((await stet.getItem(formula!.id))!.status).toBe("accepted");
    expect(read(repo, "main.tex")).toContain("$x$");

    await stet.commitAcceptedItems();
    await expect(stet.undo(task!.id)).rejects.toThrow(/committed already .*Revert it with git/);
    await expect(stet.undo("9.9")).rejects.toThrow(/Unknown item/);
  });

  it("only undoes decisions", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    await expect(stet.undo(items[0]!.id)).rejects.toThrow(/is pending: only accepted and rejected/);
  });
});

describe("accepted changes missing from the base", () => {
  it("are reported (to the reviewer and the agent) until they are committed, and nothing is reported otherwise", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[1]!.id]);
    expect(await stet.missingFromBase()).toEqual([]);
    expect((await stet.agentStatus("a")).missingAccepted).toEqual([]);

    // An accepted change the base can't locate (as with the bug in 0.8.0).
    await stet.accept([items[0]!.id]);
    const lost = (await stet.getItem(items[0]!.id))!;
    await stet.store.putItem({ ...lost, oldText: "text that is nowhere", context: { before: "nowhere before", after: "nowhere after" } });
    const m = await stet.missingFromBase();
    expect(m.map((x) => x.item.id)).toEqual([lost.id]);
    expect(m[0]!.reason).toMatch(/can't be located/);
    expect((await stet.agentStatus("a")).missingAccepted).toEqual([lost.id]);

    await stet.commitAcceptedItems();
    expect(await stet.missingFromBase()).toEqual([]);
  });
});
