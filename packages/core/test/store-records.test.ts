/** Records written by older versions of Stet are read in today's shape. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type Item, upgradeItem } from "../src/model.js";
import { edit, PAPER, setup } from "./helpers.js";

describe("items stored by an older Stet (code quality report 6a517ae)", () => {
  it("a commit made by hand, kept as external:<commit>, is the commit with committedWithEdits", () => {
    const it = upgradeItem({ resolution: { appliedText: "x", edited: false, committed: "external:abc123" }, history: [] } as unknown as Item);
    expect(it.resolution).toMatchObject({ committed: "abc123", committedWithEdits: true });
    const own = upgradeItem({ resolution: { appliedText: "x", edited: false, committed: "abc123" }, history: [] } as unknown as Item);
    expect(own.resolution!.committedWithEdits).toBeUndefined();
  });

  it("a move whose ends were single ids (Stet 0.7.0) has lists", () => {
    const it = upgradeItem({ resolution: null, history: [], move: { from: "1.2", to: "1.5", changed: 0 } } as unknown as Item);
    expect(it.move).toEqual({ from: ["1.2"], to: ["1.5"], changed: 0 });
  });

  it("a change made stale by an accept, said so only in its note, names that accept", () => {
    const it = upgradeItem({ resolution: null, history: [{ at: "", status: "stale", by: "stet", note: "overlaps accepted 1.2" }] } as unknown as Item);
    expect(it.history[0]!.staleBy).toBe("1.2");
  });

  it("undoing an accept brings back a change it made stale, recorded the old way", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const b = await stet.newAgent("b");
    edit(a.worktree, "main.tex", "$a+b=c$", "$a+b=d$");
    edit(b.worktree, "main.tex", "$a+b=c$", "$a+b=e$");
    const [ia] = (await stet.submit("a", { title: "a" })).items;
    const [ib] = (await stet.submit("b", { title: "b" })).items;
    await stet.accept([ia!.id], { commit: false });
    // Rewrite b's record as an older Stet stored it: no staleBy, only the note.
    const file = join(repo, ".git", "stet", "items", `${ib!.id}.json`);
    const rec = JSON.parse(readFileSync(file, "utf8"));
    expect(rec.status).toBe("stale");
    for (const h of rec.history) delete h.staleBy;
    writeFileSync(file, JSON.stringify(rec));
    const undone = await stet.undo(ia!.id);
    expect(undone.restored.map((i) => i.id)).toEqual([ib!.id]);
    expect((await stet.getItem(ib!.id))!.status).toBe("pending");
  });
});

describe("a submit is written in one step (code quality report 6a517ae, refactoring 5)", () => {
  it("a submit that fails halfway leaves the store as it was", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    const { items } = await stet.submit("a", { title: "t" });
    const before = await stet.listItems();

    // The revision supersedes 1.1, then the submit fails before it is done.
    edit(wt, "main.tex", "the task of reviewing", "the challenge of reviewing");
    const fail = vi.spyOn(stet.decisionOps, "dissolveMoves").mockRejectedValueOnce(new Error("interrupted"));
    await expect(stet.submit("a", { title: "revised" })).rejects.toThrow("interrupted");
    fail.mockRestore();
    expect(await stet.listItems()).toEqual(before);
    expect((await stet.getItem(items[0]!.id))?.status).toBe("pending");

    // Submitted again, it goes through as it would have.
    const r = await stet.submit("a", { title: "revised" });
    expect(r.superseded).toEqual([items[0]!.id]);
  });
});
