/** Findings of the test report of Stet v0.16.0 (2026-11-20, VS Code focus): each test reproduces a tester's scenario. */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { CLI_DIST, git, PAPER, read, setup, write } from "./helpers.js";

const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} computes omega${i + 1} in every round.`).join("\n") + "\n";

describe("D1: undo after editing an accepted change", () => {
  it("refuses instead of reverting another accepted change with the same words", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds").replace("omega10 in every round", "omega10 in all rounds"));
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
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds").replace("omega10 in every round", "omega10 in all rounds"));
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept(items.map((i) => i.id));
    write(repo, "main.tex", read(repo, "main.tex").replace("Line 10 computes", "Line ten computes"));
    const first = items.find((i) => i.range.start < LINES.indexOf("omega10"))!;
    await stet.undo(first.id);
    expect(read(repo, "main.tex")).toContain("omega3 in every round");
    expect(read(repo, "main.tex")).toContain("Line ten computes omega10 in all rounds");
  });
});

const LABELLED = PAPER.replace("The formula $a+b=c$ holds.", "The formula $a+b=c$ holds, see Section~\\ref{sec:intro}.");

async function renamed() {
  const { stet, repo } = await setup({ "main.tex": LABELLED });
  const { worktree: wt } = await stet.newAgent("a");
  write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
  const r = await stet.submit("a", { title: "rename" });
  const g = r.groups.find((x) => x.kind === "linked" && /Rename label/.test(x.title))!;
  expect(g.parts?.length).toBeGreaterThan(1);
  const label = r.items.find((i) => i.newText.includes("\\label") || i.context.before.endsWith("\\label{"))!;
  return { stet, repo, g, label, refs: r.items.filter((i) => i !== label) };
}

describe("D3: accepting one part of a label rename", () => {
  it("warns that the rest of the linked group is still to decide", async () => {
    const { stet, g, label, refs } = await renamed();
    const r = await stet.accept([label.id]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(g.id);
    expect(r.warnings[0]).toMatch(new RegExp(`partly accepted: ${label.id.replace(".", "\\.")} accepted, .*${refs[0]!.id.replace(".", "\\.")}.* still to decide`));
    // Accepting the rest makes the group whole again: no warning.
    expect((await stet.accept(refs.map((i) => i.id))).warnings).toEqual([]);
  });

  it("rejecting a part while nothing is accepted says nothing", async () => {
    const { stet, label } = await renamed();
    expect(await stet.partlyDecided(await stet.reject([label.id]))).toEqual([]);
  });

  it.skipIf(!existsSync(CLI_DIST))("`stet accept` prints the warning", async () => {
    const { repo, label } = await renamed();
    const r = spawnSync(process.execPath, [CLI_DIST, "accept", label.id], { cwd: repo, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/! G\d+ \(Rename label .*\) is a linked group, now partly accepted: .* still to decide/);
  });
});

describe("D7: an accept that will fail is known before the editor saves", () => {
  it("checkAccept judges the editor's unsaved text and writes nothing", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds"));
    const { items } = await stet.submit("a", { title: "t" });
    const id = items[0]!.id;
    // The unsaved buffer rewrote the sentence the change is in: the accept would fail.
    const buffer = LINES.replace("Line 3 computes omega3 in every round.", "Line 3 is gone.");
    await expect(stet.checkAccept([id], { unsaved: { "main.tex": buffer } })).rejects.toThrow(/could not be applied/);
    expect(read(repo, "main.tex")).toBe(LINES);
    expect((await stet.getItem(id))!.status).toBe("pending");
    expect((await stet.getItem(id))!.acceptFailed).toBeUndefined();
    // Unsaved edits elsewhere in the file don't stop it; nor do the linked-group checks differ from accept's.
    await stet.checkAccept([id], { unsaved: { "main.tex": LINES.replace("Line 1 ", "Line one ") } });
    await stet.checkAccept([id]);
  });
});

describe("D6: what Finish review would commit", () => {
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

describe("B1: setup without a git identity", () => {
  it("gitIdentity says who commits, or null when git can't", async () => {
    const { gitIdentity } = await import("../src/git.js");
    const { repo } = await setup({ "main.tex": PAPER });
    const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "EMAIL"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      git(repo, "config", "user.name", "Ada");
      git(repo, "config", "user.email", "ada@example.org");
      expect(await gitIdentity(repo)).toBe("Ada <ada@example.org>");
      git(repo, "config", "--unset", "user.name");
      git(repo, "config", "--unset", "user.email");
      git(repo, "config", "user.useConfigOnly", "true"); // no guessing from the host name
      expect(await gitIdentity(repo)).toBeNull();
    } finally {
      for (const k of keys) if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
});

describe("B5: undoing a revision request", () => {
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

describe("B9: rewording a change as a whole in the Review file", () => {
  it("saves the wording, wider, and accepts it", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("the problem of", "the task of"));
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(1);
    const doc = await stet.reviewOf("main.tex", read(repo, "main.tex"));
    expect(doc.content).toContain("we study the task of reviewing");
    const r = await stet.saveReview(doc, doc.content.replace("study the task of", "study a hard task of"));
    expect(r).toEqual({ changed: [items[0]!.id] });
    const it = (await stet.getItem(items[0]!.id))!;
    expect(it.draft).toBe("a hard task");
    expect(it.oldText.endsWith("problem")).toBe(true);
    expect(it.newText.endsWith("task")).toBe(true);
    // The review document still shows it, wider, and an accept writes it.
    const again = await stet.reviewOf("main.tex", read(repo, "main.tex"));
    expect(again.content).toContain("we study a hard task of reviewing");
    await stet.accept([it.id]);
    expect(read(repo, "main.tex")).toContain("we study a hard task of reviewing changes.");
    // Undo takes the whole wider change back.
    await stet.undo(it.id);
    expect(read(repo, "main.tex")).toBe(PAPER);
  });

  it("refuses words next to a change that the user changed in the file since", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("the problem of", "the task of"));
    const { items } = await stet.submit("a", { title: "t" });
    write(repo, "main.tex", PAPER.replace("study the problem", "study this problem"));
    const doc = await stet.reviewOf("main.tex", read(repo, "main.tex"));
    expect(doc.content).toContain("study this task of");
    const r = await stet.saveReview(doc, doc.content.replace("study this task", "study a hard task"));
    expect(r).toHaveProperty("error");
    expect((await stet.getItem(items[0]!.id))!.draft).toBeUndefined();
  });
});

describe("B13: feedback sentences end in one full stop", () => {
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

describe("UX: ids in order", () => {
  it("lists 1.2 before 1.10", async () => {
    const { stet } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    let t = read(wt, "main.tex");
    for (let i = 1; i <= 12; i++) t = t.replace(`omega${i} in every round`, `omega${i} in all rounds`);
    write(wt, "main.tex", t);
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(12);
    expect((await stet.listItems()).map((i) => i.id)).toEqual(Array.from({ length: 12 }, (_, i) => `1.${i + 1}`));
  });
});

describe("UX: merged linked groups don't confuse the agent", () => {
  it("parts sharing a change are joined, quietly when the groups were merged", async () => {
    const { settleParts } = await import("../src/parts.js");
    const mk = (id: string): any => ({ id, file: "a.tex", kind: "modify", oldText: id, newText: id + "!", status: "pending", groups: [], range: { start: 0, end: 0 }, context: { before: "", after: "" } });
    const [a, b, c] = [mk("1.1"), mk("1.2"), mk("1.3")];
    const drafts = [{ title: "Old", items: ["1.1", "1.2"] }, { title: "New", items: ["1.2", "1.3"] }];
    const loud = await settleParts(drafts, [a, b, c]);
    expect(loud.notes.join(" ")).toMatch(/both contain 1\.2/);
    const quiet = await settleParts(drafts, [a, b, c], undefined, { quietOverlaps: true });
    expect(quiet.parts).toBeUndefined(); // one part: the whole group
    expect(quiet.notes).toEqual([]);
  });
});

describe("UX: locating while typing", () => {
  it("locateMany uses the items the caller has, without reading the store", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds"));
    const { items } = await stet.submit("a", { title: "t" });
    const all = await stet.listItems();
    const reads = { n: 0 };
    const orig = stet.store.items;
    (stet.store as any).items = async () => (reads.n++, orig());
    const text = read(repo, "main.tex");
    const r = await stet.locateMany(items, text, all);
    expect(reads.n).toBe(0);
    expect(r.get(items[0]!.id)!.line).toBe(3);
    (stet.store as any).items = orig;
  });
});

describe("Resolved notes can be opened again", () => {
  it("reopenNote opens it and tells the agent", async () => {
    const { describeFeedback } = await import("../src/mcp.js");
    const { stet } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    const n = await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Too long.");
    await stet.sync("a");
    await stet.resolveNote(n.id);
    expect((await stet.reopenNote(n.id)).state).toBe("open");
    const fb = await stet.feedback("a");
    expect(fb.map((e) => e.type)).toEqual(["note_resolved", "note_reopened"]);
    expect(describeFeedback(fb[1]!)).toMatch(/^NOTE REOPENED N1 \(main\.tex\): the reviewer opened it again/);
    // Open already: nothing happens.
    await stet.reopenNote(n.id);
    expect(await stet.feedback("a")).toEqual([]);
  });
});
