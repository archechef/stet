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
    // Accepted in the same second as the last commit (CI is that fast): that commit came before.
    const committedAt = Number(git(b.repo, "log", "-1", "--format=%ct").trim());
    it2.history.at(-1).at = new Date(committedAt * 1000 + 500).toISOString();
    await store2.putItem(it2);
    await b.stet.sync("a");
    expect(read(b.wt, "main.tex")).toBe(read(b.repo, "main.tex"));
    expect((await store2.getItem(b.item.id)).resolution.headBlob).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("insertions at one spot, and changes next to accepted ones (agent report 2026-11-18)", () => {
  it("keeps several insertions at one spot (entries appended to a .bib file) through syncs and accepts", async () => {
    const bib = "@article{knuth84,\n  title={Literate Programming},\n  year={1984}\n}\n";
    const entry = (k: string) => `\n@misc{${k},\n  title={${k}},\n  year={2020}\n}\n`;
    const { stet, repo } = await setup({ "main.tex": PAPER, "refs.bib": bib });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "refs.bib", bib + entry("one") + entry("two") + entry("three"));
    const { items } = await stet.submit("a", { title: "refs" });
    expect(items.map((i) => [i.range.start, i.oldText])).toEqual([
      [bib.length - 1, ""],
      [bib.length - 1, ""],
      [bib.length - 1, ""],
    ]);

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
      const g = await stet.group(
        "a",
        items.map((i) => i.id),
        "atomic",
        "one change",
      );
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
