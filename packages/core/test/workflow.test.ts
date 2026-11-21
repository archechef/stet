import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { foldPath, isInside } from "../src/paths.js";
import { Stet } from "../src/service.js";
import { edit, git, PAPER, read, setup, write } from "./helpers.js";

const statuses = async (stet: Awaited<ReturnType<typeof setup>>["stet"]) => Object.fromEntries((await stet.listItems()).map((i) => [i.id, i.status]));

describe("basic review loop", () => {
  it("submits, accepts, rejects and gives feedback", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const agent = await stet.newAgent("claude-1", { kind: "claude-code" });
    const wt = agent.worktree;

    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const r = await stet.submit("claude-1", { title: "Polish", rationale: "wording" });
    expect(r.items.map((i) => [i.oldText, i.newText])).toEqual([
      ["problem", "task"],
      ["$a+b=c$", "$a+b=d$"],
    ]);
    const [s1, s2] = r.items;

    // The real file is untouched until accepted.
    expect(read(repo, "main.tex")).toBe(PAPER);

    // By default accepting only writes the file; Finish review commits.
    const acc = await stet.accept([s1!.id]);
    expect(acc.committed).toBeNull();
    expect(read(repo, "main.tex")).toContain("the task of reviewing");
    expect(git(repo, "log", "--format=%s")).toBe("init");

    await stet.reject([s2!.id], { reason: "the formula is right" });
    expect(read(repo, "main.tex")).toContain("$a+b=c$");

    const fb = await stet.feedback("claude-1");
    expect(fb.map((e) => e.type)).toEqual(["accepted", "rejected"]);
    expect((fb[1]!.data as any).reason).toBe("the formula is right");
    expect(await stet.feedback("claude-1")).toEqual([]);

    // Sync: accepted change is in the base, rejected change disappears from the workspace.
    expect((await stet.agentStatus("claude-1")).syncNeeded).toBe(true);
    const sync = await stet.sync("claude-1");
    expect(sync.stale).toEqual([]);
    expect(read(wt, "main.tex")).toBe(read(repo, "main.tex"));
    expect((await stet.agentStatus("claude-1")).syncNeeded).toBe(false);
  });

  it("does not commit when the user has uncommitted edits in the file", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "t" });
    edit(repo, "main.tex", "It scales to", "It even scales to");
    const res = await stet.accept([items[0]!.id], { commit: true }); // as with autoCommit "when-clean"
    expect(res.committed).toBeNull();
    expect(res.warnings.join()).toMatch(/uncommitted edits/);
    const text = read(repo, "main.tex");
    expect(text).toContain("effective in real use");
    expect(text).toContain("It even scales to");
    expect(git(repo, "log", "--format=%s")).toBe("init");

    // The agent sees the accepted change after sync even though it is not committed yet.
    await stet.sync("a");
    expect(read(wt, "main.tex")).toContain("effective in real use");
    expect(read(wt, "main.tex")).not.toContain("It even scales to");

    // Once the user commits, the review base is plain HEAD again and no sync is needed.
    git(repo, "commit", "-qam", "my edits");
    const st = await stet.agentStatus("a");
    expect(st.base).toBe(git(repo, "rev-parse", "HEAD"));
    expect(st.syncNeeded).toBe(true);
    await stet.sync("a");
    expect(read(wt, "main.tex")).toContain("It even scales to");
  });

  it("accepts with edited text and reports the final text to the agent", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real-world use");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id], { edited: { [items[0]!.id]: "real use" } });
    expect(read(repo, "main.tex")).toContain("effective in real use.");
    const [ev] = await stet.feedback("a");
    expect((ev!.data as any).finalText).toBe("real use");
  });
});

describe("parallel edits and stale items", () => {
  it("relocates pending items after the user edits elsewhere, and marks conflicting ones stale", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(wt, "main.tex", "It scales to large", "It scales to very large");
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(2);

    // User edits: one unrelated line above, and rewrites the sentence of the second item.
    edit(repo, "main.tex", "\\section{Introduction}", "% intro\n\\section{Introduction}");
    edit(repo, "main.tex", "It scales to large documents.", "It handles big documents.");
    git(repo, "commit", "-qam", "user edits");

    const sync = await stet.sync("a");
    expect(sync.stale.map((s) => s.id)).toEqual([items[1]!.id]);
    const text = read(wt, "main.tex");
    expect(text).toContain("% intro");
    expect(text).toContain("the task of reviewing");
    expect(text).toContain("It handles big documents.");

    const fb = await stet.feedback("a");
    const stale = fb.find((e) => e.type === "stale")!;
    expect((stale.data as any).currentText).toContain("It handles big documents.");

    // The surviving item can still be accepted after the move.
    await stet.accept([items[0]!.id]);
    expect(read(repo, "main.tex")).toContain("the task of reviewing");
  });

  it("marks overlapping items of another agent stale when one is accepted", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const b = await stet.newAgent("b");
    edit(a.worktree, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(b.worktree, "main.tex", "the problem of reviewing", "the challenge of reviewing");
    const ra = await stet.submit("a", { title: "a" });
    const rb = await stet.submit("b", { title: "b" });
    expect(rb.items[0]!.conflictsWith).toEqual([ra.items[0]!.id]);
    const res = await stet.accept([ra.items[0]!.id]);
    expect(res.stale.map((s) => s.id)).toEqual([rb.items[0]!.id]);
    expect((await stet.feedback("b")).map((e) => e.type)).toEqual(["stale"]);
  });
});

describe("revisions, withdrawals and repeats", () => {
  it("supersedes an item when the agent revises it", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.requestRevision(items[0]!.id, "use 'challenge'");
    const [ev] = await stet.feedback("a");
    expect(ev!.type).toBe("revision_requested");

    edit(wt, "main.tex", "the task of reviewing", "the challenge of reviewing");
    const r2 = await stet.submit("a", { title: "revised" });
    expect(r2.superseded).toEqual([items[0]!.id]);
    expect(r2.items[0]!.supersedes).toBe(items[0]!.id);
    expect(r2.items[0]!.newText).toBe("challenge");
  });

  it("withdraws items whose change the agent removed, keeps untouched ones", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    edit(wt, "main.tex", "$a+b=d$", "$a+b=c$");
    const r2 = await stet.submit("a", { title: "undo formula" });
    expect(r2.withdrawn).toEqual([items[1]!.id]);
    expect(r2.items).toEqual([]);
    expect((await statuses(stet))[items[0]!.id]).toBe("pending");
  });

  it("auto-rejects a change that repeats an earlier rejection", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.reject([items[0]!.id], { reason: "no" });
    await stet.sync("a");
    expect(read(wt, "main.tex")).toContain("$a+b=c$");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const r2 = await stet.submit("a", { title: "again" });
    expect(r2.repeats).toEqual([r2.items[0]!.id]);
    expect(r2.items[0]!.status).toBe("rejected");
    expect((await stet.feedback("a")).map((e) => e.type)).toContain("repeat_rejected");
  });

  it("lets the agent withdraw items explicitly", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.withdraw("a", [items[0]!.id], "changed my mind");
    await stet.sync("a");
    expect(read(wt, "main.tex")).toContain("$a+b=c$");
  });
});

describe("grouping", () => {
  it("auto-links a label rename with its references, each its own part", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
    const r = await stet.submit("a", { title: "rename" });
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    expect(g.kind).toBe("linked");
    expect(g.source).toBe("auto");
    expect(g.items).toHaveLength(2);
    // A missing label only warns, so the label and its reference can be accepted separately.
    expect(g.parts?.map((p) => p.items)).toEqual([[g.items[0]], [g.items[1]]]);

    await stet.accept([g.items[0]!]);
    expect((await stet.listGroups())[0]!.state).toBe("open");
    await stet.acceptGroup(g.id);
    expect(read(repo, "main.tex")).not.toContain("sec:intro}");
    expect((await stet.listGroups())[0]!.state).toBe("resolved");
  });

  it("enforces linked accepts when the agent links changes without parts", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
    const r = await stet.submit("a", { title: "rename", groups: [{ kind: "linked", reason: "test of linked groups", title: "Rename", where: ["main.tex"] }] });
    const g = r.groups.find((x) => x.kind === "linked")!;
    expect(g.parts).toBeUndefined();
    await expect(stet.accept([g.items[0]!])).rejects.toThrow(/linked/);
    await expect(stet.reject([g.items[0]!])).rejects.toThrow(/linked/);
  });

  it("links a label and its references across submissions, and keeps the link through revisions", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "Section~\\ref{sec:intro}", "Section~\\ref{sec:introduction}");
    const r1 = await stet.submit("a", { title: "ref first" });
    expect(r1.groups).toEqual([]);
    edit(wt, "main.tex", "\\label{sec:intro}", "\\label{sec:introduction}");
    const r2 = await stet.submit("a", { title: "then the label" });
    expect(r2.groups).toHaveLength(1);
    expect(r2.groups[0]!.items.sort()).toEqual([r1.items[0]!.id, r2.items[0]!.id].sort());
    expect(r2.groups[0]!.title).toBe("Rename label sec:intro → sec:introduction");

    // Revising the \ref keeps it in the linked group.
    await stet.requestRevision(r1.items[0]!.id, "use Section~\\cref");
    edit(wt, "main.tex", "Section~\\ref{sec:introduction}", "\\Cref{sec:introduction}");
    const r3 = await stet.submit("a", { title: "revised" });
    expect(r3.superseded).toEqual([r1.items[0]!.id]);
    const g = (await stet.listGroups()).find((x) => x.kind === "linked")!;
    expect(g.items).toContain(r3.items[0]!.id);
    expect(g.items).not.toContain(r1.items[0]!.id);

    // Accepting the current members resolves the group without a false "broken" alarm.
    await stet.acceptGroup(g.id);
    expect((await stet.listGroups()).find((x) => x.id === g.id)!.state).toBe("resolved");
    expect((await stet.feedback("a")).map((e) => e.type)).not.toContain("group_broken");
  });

  it("never merges a label rename into an atomic rewrite", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(
      wt,
      "main.tex",
      "\\label{sec:intro}\nIn this work we study the problem of reviewing changes.",
      "\\label{sec:introduction}\nWe study how to review changes.",
    );
    const r = await stet.submit("a", { title: "t", groups: [{ kind: "atomic", title: "Rewrite opening", where: ["main.tex:3-4"] }] });
    const label = r.items.find((i) => i.newText === "\\label{sec:introduction}");
    expect(label).toBeDefined();
    expect(r.items.some((i) => i.newText.startsWith("We study") && !i.newText.includes("\\label"))).toBe(true);
  });

  it("breaks a linked group on a forced partial accept", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
    const { groups } = await stet.submit("a", {
      title: "rename",
      groups: [{ kind: "linked", reason: "test of linked groups", title: "Rename", where: ["main.tex"] }],
    });
    const res = await stet.accept([groups[0]!.items[0]!], { overrideLinked: true });
    expect(res.warnings.join()).toMatch(/broken/);
    expect((await stet.listGroups())[0]!.state).toBe("broken");
    expect((await stet.feedback("a")).map((e) => e.type)).toContain("group_broken");
  });

  it("reject with revise-rest asks for revision of the other linked items", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
    const { groups } = await stet.submit("a", {
      title: "rename",
      groups: [{ kind: "linked", reason: "test of linked groups", title: "Rename", where: ["main.tex"] }],
    });
    const [first, second] = groups[0]!.items;
    await stet.reject([first!], { reason: "keep the old label", mode: "revise-rest" });
    expect((await statuses(stet))[second!]).toBe("needs_revision");
  });

  it("applies explicit hints: atomic merges, linked and related groups, notes", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    // line 4: two separate edits in one sentence; line 6 and 8: unrelated edits.
    edit(wt, "main.tex", "we study the problem of reviewing changes", "we examine the problem of checking changes");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    edit(wt, "main.tex", "the approach works", "the method works");
    const r = await stet.submit("a", {
      title: "hints",
      groups: [
        { kind: "atomic", title: "Reword first sentence", where: ["main.tex:4"] },
        { kind: "related", title: "Tone", where: ["main.tex:6", "main.tex:8"] },
        { kind: "linked", reason: "test of linked groups", title: "Nothing", where: ["other.tex:3"] },
      ],
      notes: [{ where: "main.tex:8", note: "'method' matches Section 2" }],
    });
    const byText = Object.fromEntries(r.items.map((i) => [i.newText, i]));
    expect(Object.keys(byText)).toContain("examine the problem of checking");
    expect(byText["examine the problem of checking"]!.note).toBe("Reword first sentence");
    const related = r.groups.find((g) => g.kind === "related")!;
    expect(related.items.sort()).toEqual([byText["real use"]!.id, byText.method!.id].sort());
    expect(byText.method!.note).toBe("'method' matches Section 2");
    expect(r.warnings.join()).toMatch(/other\.tex:3/);
  });

  it("keeps an atomic item stable when the agent edits elsewhere in the file", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "we study the problem of reviewing changes", "we examine the problem of checking changes");
    const r1 = await stet.submit("a", { title: "t", groups: [{ kind: "atomic", title: "one", where: ["main.tex:4"] }] });
    expect(r1.items).toHaveLength(1);
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const r2 = await stet.submit("a", { title: "t2" });
    expect(r2.items.map((i) => i.newText)).toEqual(["$a+b=d$"]);
    expect(r2.superseded).toEqual([]);
  });

  it("merges items into an atomic item and creates groups after submit", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "we study the problem of reviewing changes", "we examine the problem of checking changes");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(3);
    const { merged } = await stet.group("a", [items[0]!.id, items[1]!.id], "atomic", "one change");
    expect(merged!.newText).toBe("examine the problem of checking");
    // Linked without a dependency Stet sees: refused, unless the agent gives a reason.
    await expect(stet.group("a", [merged!.id, items[2]!.id], "linked", "together")).rejects.toThrow(/Not linked: Stet sees no dependency.*"reason"/);
    const { group } = await stet.group("a", [merged!.id, items[2]!.id], "linked", "together", { reason: "the wording only works together" });
    expect(group!.items).toEqual([merged!.id, items[2]!.id]);
    expect(group!.rationale).toBe("Linked because: the wording only works together");
    await stet.ungroup(group!.id);
    expect(await stet.listGroups()).toEqual([]);
  });
});

describe("files", () => {
  it("handles new, deleted and bib files", async () => {
    const bib = "@article{knuth84,\n  title={Literate Programming},\n  year={1984}\n}\n";
    const { stet, repo } = await setup({ "main.tex": PAPER, "refs.bib": bib, "old.tex": "obsolete\n" });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "sections/new.tex", "A new section.\n");
    git(wt, "rm", "-q", "old.tex");
    write(wt, "refs.bib", bib.replace("1984", "1983"));
    const r = await stet.submit("a", { title: "files" });
    const kinds = r.items.map((i) => `${i.kind}:${i.file}`).sort();
    expect(kinds).toEqual(["add-file:sections/new.tex", "delete-file:old.tex", "modify:refs.bib"]);
    await stet.accept(
      r.items.map((i) => i.id),
      { commit: true },
    );
    expect(read(repo, "sections/new.tex")).toBe("A new section.\n");
    expect(() => read(repo, "old.tex")).toThrow();
    expect(read(repo, "refs.bib")).toContain("1983");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("preserves CRLF line endings in the working copy", async () => {
    const crlf = PAPER.replace(/\n/g, "\r\n");
    const { stet, repo } = await setup({ "main.tex": crlf });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(1);
    await stet.accept([items[0]!.id]);
    const text = read(repo, "main.tex");
    expect(text).toContain("the task of reviewing");
    expect(text.split("\r\n").length).toBe(crlf.split("\r\n").length);
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
  });
});

describe("agents and doctor", () => {
  it("adopts a worktree with the agent branch prefix created by another tool", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const path = repo + "-desktop";
    git(repo, "worktree", "add", "-q", "-b", "stet/desktop-1", path);
    const agent = await stet.agentForCwd(path);
    expect(agent.id).toBe("desktop-1");
    edit(path, "main.tex", "$a+b=c$", "$a+b=d$");
    const r = await stet.submit(agent.id, { title: "from desktop" });
    expect(r.items).toHaveLength(1);
  });

  it("refuses to work outside agent workspaces", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    await expect(stet.agentForCwd(repo)).rejects.toThrow(/not a Stet agent workspace/);
  });

  it("doctor reports a healthy setup", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    const checks = await doctor(repo);
    expect(checks.filter((c) => c.status === "error")).toEqual([]);
    expect(checks.find((c) => c.name === "agent a")?.status).toBe("ok");
  });
});

describe("project inside a submodule", () => {
  it("uses the submodule's folder, not its git directory, as the project", async () => {
    // A superproject whose `paper` folder is a submodule: its git directory is
    // outer/.git/modules/paper, and `git worktree list` reports that instead of the folder.
    const { repo: inner } = await setup({ "main.tex": PAPER });
    mkdirSync(join(dirname(inner), "outer"));
    // Git reports real paths; CI temp folders have another spelling (Windows RUNNER~1, macOS /var).
    const outer = realpathSync.native(join(dirname(inner), "outer"));
    git(outer, "init", "-q", "-b", "master");
    git(outer, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "paper");
    const sub = join(outer, "paper");
    git(sub, "config", "user.name", "Test User");
    git(sub, "config", "user.email", "test@example.com");
    git(sub, "config", "core.autocrlf", "false");
    git(sub, "switch", "-q", "master");

    const loc = await Stet.locate(sub);
    expect(foldPath(loc.mainPath)).toBe(foldPath(sub));
    expect(foldPath(loc.toplevel)).toBe(foldPath(loc.mainPath)); // the extension treats it as a project

    const stet = await Stet.init(sub);
    expect(foldPath(stet.mainPath)).toBe(foldPath(sub));
    const { worktree: wt } = await stet.newAgent("a");
    expect(isInside(wt, join(outer, ".git"))).toBe(false);
    expect(foldPath((await Stet.locate(wt)).mainPath)).toBe(foldPath(sub));

    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    const [s1] = (await stet.submit("a", { title: "Wording" })).items;
    await stet.accept([s1!.id]);
    expect(read(sub, "main.tex")).toContain("the task of reviewing");
    expect((await doctor(sub)).filter((c) => c.status === "error")).toEqual([]);
  });
});

describe("status of all agents at once (Codex review 2026-09)", () => {
  it("matches the per-agent status", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    await stet.newAgent("b");
    edit(a.worktree, "main.tex", "effective in practice", "effective in real use");
    const [item] = (await stet.submit("a", { title: "t" })).items;
    await stet.reject([item!.id], { reason: "no" });
    const all = await stet.agentStatuses();
    expect(all.map((s) => s.agent.id)).toEqual(["a", "b"]);
    for (const s of all) expect(s).toEqual(await stet.agentStatus(s.agent.id));
    expect(all[0]!.unreadFeedback).toBe(1);
  });
});
