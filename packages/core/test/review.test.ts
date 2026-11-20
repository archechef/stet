import { describe, expect, it } from "vitest";
import { mapReviewEdits, reviewDocument } from "../src/review.js";

const TEXT = "We study the problem of reviewing changes. It scales to large documents.";
const at = (s: string) => TEXT.indexOf(s);
const change = (id: string, old: string, text: string) => ({ id, start: at(old), end: at(old) + old.length, text });

describe("review document of a file", () => {
  const doc = reviewDocument(TEXT, [change("1.2", "large", "long"), change("1.1", "problem", "task")]);

  it("applies every change, in order, and knows where each one is", () => {
    expect(doc.content).toBe("We study the task of reviewing changes. It scales to long documents.");
    expect(doc.regions.map((r) => [r.id, doc.content.slice(r.start, r.end)])).toEqual([["1.1", "task"], ["1.2", "long"]]);
    expect(reviewDocument(TEXT, [change("a", "problem of", "x"), change("b", "of reviewing", "y")]).skipped).toEqual(["b"]);
  });

  it("maps the reviewer's edits back to their changes", () => {
    const r = mapReviewEdits(doc, "We study the hard task of reviewing changes. It scales to very long documents.") as { texts: Map<string, string> };
    expect(Object.fromEntries(r.texts)).toEqual({ "1.1": "hard task", "1.2": "very long" });
    const same = mapReviewEdits(doc, doc.content) as { texts: Map<string, string> };
    expect(Object.fromEntries(same.texts)).toEqual({ "1.1": "task", "1.2": "long" });
    // Typed right after a change: part of it. Emptied: an empty text.
    const after = mapReviewEdits(doc, "We study the tasks of reviewing changes. It scales to  documents.") as { texts: Map<string, string> };
    expect(Object.fromEntries(after.texts)).toEqual({ "1.1": "tasks", "1.2": "" });
  });

  it("refuses edits outside every change", () => {
    const r = mapReviewEdits(doc, "We analyse the task of reviewing changes. It scales to long documents.");
    expect("error" in r && r.error).toMatch(/outside the proposed changes \(near “/);
  });

  it("grows a change over words reworded right next to it (test report v0.16.0, B9)", () => {
    // "the task" retyped as "a hard task": by letters, "the" is outside the change "task".
    const r = mapReviewEdits(doc, "We study a hard task of reviewing changes. It scales to long documents.") as { texts: Map<string, string>; grown: Map<string, unknown> };
    expect(r.texts.get("1.1")).toBe("a hard task");
    expect(r.grown.get("1.1")).toEqual({ before: "the ".length, after: 0 });
    expect(r.texts.get("1.2")).toBe("long");
    expect(r.grown.has("1.2")).toBe(false);
    // Across punctuation and spaces too, never across a word, a paragraph, or into another change.
    const d = reviewDocument("Fast, cheap and good.\n\nNext.", [{ id: "a", start: 6, end: 11, text: "cheap" }]);
    expect((mapReviewEdits(d, "Quick, cheap and good.\n\nNext.") as { texts: Map<string, string> }).texts.get("a")).toBe("Quick, cheap");
    expect(mapReviewEdits(d, "Fast, cheap and great.\n\nNext.")).toHaveProperty("error");
    expect(mapReviewEdits(d, "Fast, cheap and good.\n\nLast.")).toHaveProperty("error");
    expect(mapReviewEdits(doc, "We study the task of reviewing changes. It grows to long documents.")).toHaveProperty("error");
  });

  it("gives text typed where two changes meet to the later one", () => {
    const d = reviewDocument("ab", [{ id: "x", start: 0, end: 1, text: "A" }, { id: "y", start: 1, end: 2, text: "B" }]);
    const r = mapReviewEdits(d, "A-B") as { texts: Map<string, string> };
    expect(Object.fromEntries(r.texts)).toEqual({ x: "A", y: "-B" });
  });

  it("handles a pure insertion", () => {
    const d = reviewDocument(TEXT, [{ id: "i", start: at(" It"), end: at(" It"), text: " Indeed." }]);
    expect(d.content).toContain("changes. Indeed. It scales");
    const r = mapReviewEdits(d, d.content.replace("Indeed.", "Indeed, it works.")) as { texts: Map<string, string> };
    expect(r.texts.get("i")).toBe(" Indeed, it works.");
  });
});

describe("reviewing a whole file", () => {
  it("keeps edited changes pending with the reviewer's wording, until they accept them", async () => {
    const { setup, edit, read, PAPER } = await import("./helpers.js");
    const { describeFeedback } = await import("../src/mcp.js");
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    const [task, formula] = [...items].sort((x, y) => x.range.start - y.range.start);

    const doc = await stet.reviewOf("main.tex", read(repo, "main.tex"));
    expect(doc.content).toContain("the task of reviewing");
    expect(doc.content).toContain("$a+b=d$");

    // The reviewer rewords the first change and saves: nothing is accepted.
    const saved = await stet.saveReview(doc, doc.content.replace("the task of", "the hard task of"));
    expect(saved).toEqual({ changed: [task!.id] });
    expect((await stet.getItem(task!.id))!.status).toBe("pending");
    expect((await stet.getItem(task!.id))!.draft).toBe("hard task");
    expect(read(repo, "main.tex")).toBe(PAPER);
    // The review shows their wording now.
    expect((await stet.reviewOf("main.tex", read(repo, "main.tex"))).content).toContain("the hard task of");

    // Edits outside the changes are refused, and change nothing.
    expect(await stet.saveReview(doc, doc.content.replace("We show", "We prove"))).toEqual({ error: expect.stringMatching(/outside the proposed changes/) });

    // Accepting uses their wording; the agent is told.
    await stet.accept([task!.id]);
    expect(read(repo, "main.tex")).toContain("the hard task of reviewing");
    expect((await stet.getItem(task!.id))!.draft).toBeUndefined();
    const fb = (await stet.feedback("a")).find((e) => e.type === "accepted")!;
    expect(describeFeedback(fb)).toMatch(/the reviewer edited it to: "hard task"/);

    // "Agent's wording" drops a draft.
    const doc2 = await stet.reviewOf("main.tex", read(repo, "main.tex"));
    await stet.saveReview(doc2, doc2.content.replace("$a+b=d$", "$a+b=e$"));
    expect((await stet.getItem(formula!.id))!.draft).toBe("$a+b=e$"); // formulas are one change, whole
    await stet.clearDraft(formula!.id);
    expect((await stet.getItem(formula!.id))!.draft).toBeUndefined();
  });

  it("keeps the reviewer's wording for a change without accepting it", async () => {
    const { setup, edit, read, PAPER } = await import("./helpers.js");
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const [item] = (await stet.submit("a", { title: "t" })).items;
    expect(await stet.setDraft(item!.id, "hard task")).toBe(true);
    expect(await stet.setDraft(item!.id, "hard task")).toBe(false);
    expect((await stet.getItem(item!.id))!).toMatchObject({ status: "pending", draft: "hard task" });
    expect(read(repo, "main.tex")).toBe(PAPER);
    // The agent's text again: no wording of the reviewer's.
    await stet.setDraft(item!.id, item!.newText);
    expect((await stet.getItem(item!.id))!.draft).toBeUndefined();
    await stet.setDraft(item!.id, "hard task");
    await stet.accept([item!.id]);
    expect(read(repo, "main.tex")).toContain("the hard task of");
    await expect(stet.setDraft(item!.id, "x")).rejects.toThrow(/accepted already/);
  });

  it("reviews one change on its own: only it is applied, and only it can be edited", async () => {
    const { setup, edit, read, PAPER } = await import("./helpers.js");
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    const [task, formula] = [...items].sort((x, y) => x.range.start - y.range.start);

    const doc = await stet.reviewOf("main.tex", read(repo, "main.tex"), [formula!.id]);
    expect(doc.regions.map((r) => r.id)).toEqual([formula!.id]);
    expect(doc.content).toContain("the problem of reviewing");
    expect(doc.content).toContain("$a+b=d$");
    expect(await stet.saveReview(doc, doc.content.replace("the problem", "the task"))).toEqual({ error: expect.stringMatching(/outside the proposed changes/) });
    expect(await stet.saveReview(doc, doc.content.replace("$a+b=d$", "$a+b=e$"))).toEqual({ changed: [formula!.id] });
    expect((await stet.getItem(task!.id))!.draft).toBeUndefined();
  });
});
