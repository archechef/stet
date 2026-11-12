import { describe, expect, it } from "vitest";
import { edit, git, PAPER, read, setup, write } from "./helpers.js";

/**
 * Accepted changes the user edits afterwards (bug report 2026-11-12): agents' copies had an
 * accepted remark twice, because the review base applied it again on top of the user's edited
 * version. A pure insertion's empty old text is found anywhere, so it always looked "still open".
 */
const REMARK = "\\begin{remark}\nThe review is incremental.\n\\end{remark}\n\n";
const AT = "We show that";

async function acceptedInsertion(mode: "manual" | "saved" | "committed") {
  const s = await setup({ "main.tex": PAPER });
  await s.stet.setShareEdits(mode);
  const { worktree: wt } = await s.stet.newAgent("a");
  edit(wt, "main.tex", AT, REMARK + AT);
  const { items } = await s.stet.submit("a", { title: "remark" });
  expect(items.map((i) => i.oldText)).toEqual([""]);
  await s.stet.accept([items[0]!.id]);
  return { ...s, wt, item: items[0]! };
}

const count = (text: string, s: string) => text.split(s).length - 1;

describe("accepted changes the user edits afterwards", () => {
  it("saved: the edited insertion reaches agents once", async () => {
    const { stet, repo, wt } = await acceptedInsertion("saved");
    edit(repo, "main.tex", "The review is incremental.", "The review is incremental and fast.");
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(read(repo, "main.tex"));
    expect(count(read(wt, "main.tex"), "\\begin{remark}")).toBe(1);
  });

  it("saved: an accepted change the user removed again stays removed", async () => {
    const { stet, repo, wt } = await acceptedInsertion("saved");
    write(repo, "main.tex", PAPER);
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(PAPER);
  });

  it("committed: once the user commits the edited insertion, agents see the commit", async () => {
    const { stet, repo, wt } = await acceptedInsertion("committed");
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(read(repo, "main.tex")); // accepted, not yet committed
    edit(repo, "main.tex", "The review is incremental.", "Reviews are incremental.");
    git(repo, "commit", "-qam", "edit the remark");
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(read(repo, "main.tex"));
    expect(count(read(wt, "main.tex"), "\\begin{remark}")).toBe(1);
    expect((await stet.uncommittedAccepted()).length).toBe(0);
  });

  it("committed: an accepted change stays visible to agents until the user commits its file", async () => {
    const { stet, repo, wt } = await acceptedInsertion("committed");
    write(repo, "notes.tex", "x\n");
    git(repo, "add", "notes.tex");
    git(repo, "commit", "-qm", "another file");
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(read(repo, "main.tex"));
    expect(read(wt, "notes.tex")).toBe("x\n");
    expect((await stet.uncommittedAccepted()).length).toBe(1);
  });

  it("manual: changes accepted after a share are added to it, earlier ones are not repeated", async () => {
    const { stet, repo, wt } = await acceptedInsertion("manual");
    edit(repo, "main.tex", "The review is incremental.", "The review is incremental and fast.");
    await stet.shareEdits();
    await stet.sync("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "wording" });
    expect(items.map((i) => i.newText)).toEqual(["real use"]);
    await stet.accept([items[0]!.id]);
    await stet.sync("a");
    const text = read(wt, "main.tex");
    expect(count(text, "\\begin{remark}")).toBe(1);
    expect(text).toContain("incremental and fast");
    expect(text).toContain("effective in real use"); // accepted after the share
  });

  it("items accepted before the fix: a later commit of their file counts as committing them", async () => {
    const { stet, repo, wt, item } = await acceptedInsertion("committed");
    const store = (stet as any).store;
    const it = await store.getItem(item.id);
    delete it.resolution.headBlob; // as recorded by Stet 0.6.0 and older
    it.history.at(-1).at = new Date(Date.now() - 3_600_000).toISOString();
    await store.putItem(it);
    edit(repo, "main.tex", "The review is incremental.", "Reviews are incremental.");
    git(repo, "commit", "-qam", "edit the remark");
    await stet.sync("a");
    expect(count(read(wt, "main.tex"), "\\begin{remark}")).toBe(1);

    // Without a commit since, the item stays open and HEAD's file is recorded for next time.
    const b = await acceptedInsertion("committed");
    const store2 = (b.stet as any).store;
    const it2 = await store2.getItem(b.item.id);
    delete it2.resolution.headBlob;
    await store2.putItem(it2);
    await b.stet.sync("a");
    expect(read(b.wt, "main.tex")).toBe(read(b.repo, "main.tex"));
    expect((await store2.getItem(b.item.id)).resolution.headBlob).toMatch(/^[0-9a-f]{40}$/);
  });
});
