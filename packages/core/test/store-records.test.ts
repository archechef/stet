/** Records written by older versions of Stet are read in today's shape. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Item, upgradeItem } from "../src/model.js";
import { edit, PAPER, setup } from "./helpers.js";

describe("items stored by an older Stet (code quality report 6a517ae)", () => {
  it("a commit made by hand, kept as external:<commit>, is the commit with committedWithEdits", () => {
    const it = upgradeItem({ resolution: { appliedText: "x", edited: false, committed: "external:abc123" }, history: [] } as unknown as Item);
    expect(it.resolution).toMatchObject({ committed: "abc123", committedWithEdits: true });
    const own = upgradeItem({ resolution: { appliedText: "x", edited: false, committed: "abc123" }, history: [] } as unknown as Item);
    expect(own.resolution!.committedWithEdits).toBeUndefined();
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
