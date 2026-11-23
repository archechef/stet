import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeFeedback } from "../src/mcp.js";
import { edit, LABELLED, PAPER, read, renamed, setup, write } from "./helpers.js";

const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} computes omega${i + 1} in every round.`).join("\n") + "\n";

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

  it("reopens a rejection only while it can still be applied", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    const [task, sum] = [items.find((i) => i.newText.includes("task"))!, items.find((i) => i.newText.includes("d$"))!];
    await stet.reject([task.id, sum.id]);
    // You rewrote the sentence meanwhile: the change has nothing to apply to any more.
    edit(repo, "main.tex", "the problem of reviewing", "the difficulty of reviewing");
    await expect(stet.undo(task.id)).rejects.toThrow(/can no longer be applied \(1\.\d: .*Nothing was undone/);
    // Undone together with one that still applies: neither is.
    await expect(stet.undoMany([sum.id, task.id])).rejects.toThrow(/Nothing was undone/);
    expect((await stet.getItem(sum.id))!.status).toBe("rejected");
    await stet.undo(sum.id);
    expect((await stet.getItem(sum.id))!.status).toBe("pending");
    await stet.accept([sum.id], { commit: false });
    expect(read(repo, "main.tex")).toContain("$a+b=d$");
  });

  it("doesn't reopen a rejection the agent has revised since", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const [old] = (await stet.submit("a", { title: "t" })).items;
    await stet.reject([old!.id], { reason: "say question" });
    await stet.sync("a");
    edit(wt, "main.tex", "the problem", "the question");
    const [revision] = (await stet.submit("a", { title: "t2" })).items;
    await expect(stet.undo(old!.id)).rejects.toThrow(new RegExp(`a proposes ${revision!.id.replace(".", "\\.")} for the same text`));
    // With the revision rejected too, the first one can come back.
    await stet.reject([revision!.id]);
    await stet.undo(old!.id);
    expect((await stet.getItem(old!.id))!.status).toBe("pending");
    expect((await stet.sync("a")).stale).toEqual([]);
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
    await stet.store.withLock(() =>
      stet.store.putItem({ ...lost, oldText: "text that is nowhere", context: { before: "nowhere before", after: "nowhere after" } }),
    );
    const m = await stet.missingFromBase();
    expect(m.map((x) => x.item.id)).toEqual([lost.id]);
    expect(m[0]!.reason).toMatch(/can't be located/);
    expect((await stet.agentStatus("a")).missingAccepted).toEqual([lost.id]);

    await stet.commitAcceptedItems();
    expect(await stet.missingFromBase()).toEqual([]);
  });
});

describe("undo after deciding a linked group (test report v0.14, D2)", () => {
  it("undoes everything the group's accept took along, not just one part", async () => {
    const { stet, repo, g, label } = await renamed();
    await stet.acceptGroup(g.id);
    expect(read(repo, "main.tex")).not.toContain("{sec:intro}");
    const r = await stet.undo(label.id);
    expect(r.reopened.length).toBe(g.items.length);
    expect(read(repo, "main.tex")).toBe(LABELLED);
  });

  it("still undoes parts accepted one at a time on their own", async () => {
    const { stet, repo, label, refs } = await renamed();
    await stet.accept(refs.map((i) => i.id)); // the same \ref change twice: one part
    await stet.accept([label.id]);
    const r = await stet.undo(label.id);
    expect(r.reopened.map((i) => i.id)).toEqual([label.id]);
    expect(read(repo, "main.tex")).toContain("\\ref{sec:introduction}");
  });

  it("takes back the revision requests of a rejection undone (reject --revise-rest)", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", {
      title: "together",
      groups: [{ kind: "linked", reason: "test of linked groups", title: "both", where: ["main.tex:4", "main.tex:8"] }],
    });
    await stet.reject([items[0]!.id], { mode: "revise-rest", reason: "no" });
    expect((await stet.getItem(items[1]!.id))!.status).toBe("needs_revision");
    const r = await stet.undo(items[0]!.id);
    expect(r.reopened.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
    expect((await stet.getItem(items[1]!.id))!.status).toBe("pending");
  });
});

describe("undo after editing an accepted change (test report v0.16, D1)", () => {
  it("refuses instead of reverting another accepted change with the same words", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(
      wt,
      "main.tex",
      read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds").replace("omega10 in every round", "omega10 in all rounds"),
    );
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(2);
    await stet.accept(items.map((i) => i.id));
    // The user rewords the second accepted change, then undoes it.
    const edited = read(repo, "main.tex").replace("omega10 in all rounds", "omega10 in all the rounds");
    write(repo, "main.tex", edited);
    const id = items.find((i) => i.range.start > LINES.indexOf("omega10"))!.id;
    await expect(stet.undo(id)).rejects.toThrow(/no longer as accepted/);
    // Nothing changed: line 3 keeps the other accepted change, line 10 the user's wording.
    expect(read(repo, "main.tex")).toBe(edited);
    expect((await stet.store.getItem(items.find((i) => i.id !== id)!.id))!.status).toBe("accepted");
  });

  it("still undoes an accepted change the user didn't touch, next to one they did", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(
      wt,
      "main.tex",
      read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds").replace("omega10 in every round", "omega10 in all rounds"),
    );
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept(items.map((i) => i.id));
    write(repo, "main.tex", read(repo, "main.tex").replace("Line 10 computes", "Line ten computes"));
    const first = items.find((i) => i.range.start < LINES.indexOf("omega10"))!;
    await stet.undo(first.id);
    expect(read(repo, "main.tex")).toContain("omega3 in every round");
    expect(read(repo, "main.tex")).toContain("Line ten computes omega10 in all rounds");
  });
});

describe("undoing a revision request (test report v0.16, B5)", () => {
  it("makes the change pending again and tells the agent", async () => {
    const { stet } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds"));
    const { items } = await stet.submit("a", { title: "t" });
    const id = items[0]!.id;
    await stet.requestRevision(id, "shorter");
    expect((await stet.getItem(id))!.status).toBe("needs_revision");
    const r = await stet.undo(id);
    expect(r.reopened.map((i) => i.id)).toEqual([id]);
    expect((await stet.getItem(id))!.status).toBe("pending");
    const fb = await stet.feedback("a");
    expect(JSON.stringify(fb)).toMatch(/revision request taken back|reopened/);
    // A pending change has nothing to undo.
    await expect(stet.undo(id)).rejects.toThrow(/only accepted and rejected changes, and revision requests/);
  });
});

describe("many changes at once", () => {
  it("undoing many accepted changes at once restores the file (test report 5e4c6af, B5)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    edit(wt, "main.tex", "reviewing changes", "reviewing edits");
    const r = await stet.submit("a", { title: "t" });
    expect(r.items.length).toBeGreaterThan(1);
    await stet.accept(r.items.map((i) => i.id));
    const res = await stet.undoMany(r.items.map((i) => i.id));
    expect(res.reopened.map((i) => i.id).sort()).toEqual(r.items.map((i) => i.id).sort());
    expect(read(repo, "main.tex")).toBe(PAPER);
  });
});
