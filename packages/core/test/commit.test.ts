/** Committing accepted changes: what a commit takes along, and accepted changes dropped from main. */
import { describe, expect, it } from "vitest";
import { edit, git, PAPER, read, setup, write } from "./helpers.js";

const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} computes omega${i + 1} in every round.`).join("\n") + "\n";

describe("committing whole files (test report v0.14, D8)", () => {
  it("names the files where the commit takes the reviewer's own edits along", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER, "other.tex": "Other.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "other.tex", "Other.", "Another.");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept(items.map((i) => i.id));
    edit(repo, "main.tex", "It scales", "It also scales");
    const r = await stet.commitAcceptedItems();
    expect(r.yourEdits).toEqual(["main.tex"]);
    expect(git(repo, "log", "-1", "--format=%B")).toMatch(/Also the reviewer's own edits in main\.tex\./);
  });

  it("names none when the files hold only the accepted changes", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept(items.map((i) => i.id), { edited: { [items[0]!.id]: "the job" } });
    expect((await stet.commitAcceptedItems()).yourEdits).toEqual([]);
  });
});

describe("a commit with accepted changes dropped from main (test report v0.14, D9)", () => {
  it("makes the change pending again when git reset --hard took it out", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    await stet.commitAcceptedItems();
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    await stet.missingFromBase(); // any locked operation notices
    const it = (await stet.getItem(items[0]!.id))!;
    expect(it.status).toBe("pending");
    expect(it.history.at(-1)!.note).toMatch(/no longer on master \(git reset\?\)/);
    await stet.accept([it.id]);
    expect(read(repo, "main.tex")).toContain("the task");
  });

  it("makes it uncommitted again when the working copy still has it (git reset --mixed)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    await stet.commitAcceptedItems();
    git(repo, "reset", "-q", "HEAD~1");
    await stet.missingFromBase();
    const it = (await stet.getItem(items[0]!.id))!;
    expect(it.status).toBe("accepted");
    expect(it.resolution!.committed).toBeNull();
    await stet.undo(it.id);
    expect(read(repo, "main.tex")).toBe(PAPER);
  });
});

describe("what Finish review would commit (test report v0.16, D6)", () => {
  it("commitPreview names the files with edits of the user's, and commits nothing", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES, "other.tex": "Other.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds"));
    write(wt, "other.tex", "Other text.\n");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept(items.map((i) => i.id));
    write(repo, "main.tex", read(repo, "main.tex").replace("Line 1 ", "Line one "));
    const p = await stet.commitPreview();
    expect(p.items.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
    expect(p.yourEdits).toEqual(["main.tex"]);
    expect((await stet.uncommittedAccepted()).length).toBe(items.length);
  });
});
