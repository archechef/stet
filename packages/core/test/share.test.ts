import { describe, expect, it } from "vitest";
import { edit, git, PAPER, read, setup, write } from "./helpers.js";

type Stet = Awaited<ReturnType<typeof setup>>["stet"];
const setMode = (stet: Stet, mode: "manual" | "saved" | "committed") => stet.setShareEdits(mode);

describe("sharing the user's own edits (shareEdits)", () => {
  it("manual (default): agents see saved edits only after Share my edits", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    expect((await stet.config()).shareEdits).toBe("manual");
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    await stet.submit("a", { title: "t" });

    edit(repo, "main.tex", "It scales to", "It even scales to");
    write(repo, "appendix.tex", "\\section{Appendix}\n");
    write(repo, "main.aux", "\\relax\n");
    write(repo, "main.pdf", "%PDF-1.5\n");
    const status = git(repo, "status", "--porcelain");
    expect(await stet.shareStatus()).toEqual({ mode: "manual", unshared: true });
    expect((await stet.agentStatus("a")).syncNeeded).toBe(false);

    expect(await stet.shareEdits()).toBe(true);
    expect(await stet.shareEdits()).toBe(false); // nothing new
    expect(git(repo, "status", "--porcelain")).toBe(status); // the user's index is untouched
    expect((await stet.shareStatus()).unshared).toBe(false);
    expect((await stet.agentStatus("a")).syncNeeded).toBe(true);
    await stet.sync("a");
    const text = read(wt, "main.tex");
    expect(text).toContain("It even scales to");
    expect(text).toContain("effective in real use"); // the agent's pending change stays on top
    expect(read(wt, "appendix.tex")).toBe("\\section{Appendix}\n");
    expect(() => read(wt, "main.aux")).toThrow(); // new non-TeX files stay out
    expect(() => read(wt, "main.pdf")).toThrow();

    // Editing again makes the share outdated until the next one.
    edit(repo, "main.tex", "the approach works", "the method works");
    expect((await stet.shareStatus()).unshared).toBe(true);
  });

  it("accepted changes are in the shared edits once, and proposals on shared text can be accepted", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    edit(repo, "main.tex", "It scales to", "Our draft sentence. It scales to");
    await stet.shareEdits();
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(read(repo, "main.tex"));

    edit(wt, "main.tex", "Our draft sentence.", "Our polished sentence.");
    const r = await stet.submit("a", { title: "polish" });
    expect(r.items.map((i) => [i.oldText, i.newText])).toEqual([["draft", "polished"]]);
    await stet.accept([r.items[0]!.id]);
    expect(read(repo, "main.tex")).toContain("Our polished sentence. It scales to");
    expect(read(repo, "main.tex")).toContain("the task of reviewing");
  });

  it("manual: a new commit on main replaces an older share", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(repo, "main.tex", "It scales to", "It even scales to");
    await stet.shareEdits();
    write(repo, "notes.tex", "x\n");
    git(repo, "add", "notes.tex");
    git(repo, "commit", "-qm", "notes only");
    await stet.sync("a");
    expect(read(wt, "notes.tex")).toBe("x\n");
    expect(read(wt, "main.tex")).toBe(PAPER); // shared before the commit; share again to include it
    expect((await stet.shareStatus()).unshared).toBe(true);
  });

  it("saved: agents see saved edits without sharing", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    await setMode(stet, "saved");
    const { worktree: wt } = await stet.newAgent("a");
    edit(repo, "main.tex", "It scales to", "It even scales to");
    expect((await stet.agentStatus("a")).syncNeeded).toBe(true);
    expect((await stet.shareStatus()).unshared).toBe(false);
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(read(repo, "main.tex"));
  });

  it("committed: only commits reach agents, and sharing has no effect", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    await setMode(stet, "committed");
    const { worktree: wt } = await stet.newAgent("a");
    edit(repo, "main.tex", "It scales to", "It even scales to");
    await stet.shareEdits();
    expect((await stet.agentStatus("a")).syncNeeded).toBe(false);
    expect(await stet.shareStatus()).toEqual({ mode: "committed", unshared: true });
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(PAPER);
  });

  it("refuses to share while the project folder is on another branch", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    git(repo, "switch", "-q", "-c", "draft");
    await expect(stet.shareEdits()).rejects.toThrow(/isn't on 'master'/);
    await expect(stet.setShareEdits("bogus" as any)).rejects.toThrow(/shareEdits/);
  });
});
