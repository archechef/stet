/** Findings of the test report of Stet v0.16.0 (2026-11-20) that the extension's pure helpers decide. */
import { describe, expect, it } from "vitest";
import type { Agent, Changeset, Group, Item } from "@stet/core";
import { acceptAction, acceptQuestion, changeActions } from "../src/actions.js";
import { actionsTitle, behindAgents, manyQuestion, changesAt, documentOrder, threadText, unreadReplies, draftMarkdown, editedPart, itemSpoken, editFrame, FINISH_SAVE, finishQuestion, fromPanel, nextItemIndex, TreeModel, type Snapshot } from "../src/model.js";

const agent: Agent = { id: "a", kind: "claude-code", branch: "stet/a", worktree: "/w/a", baseCommit: "b", lastTip: "b", replayedAt: "", feedbackCursor: 0, createdAt: "", state: "active" };
const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id, agent: "a", changeset: "C1", file: "main.tex", kind: "modify", baseCommit: "b", range: { start: 0, end: 1 },
  oldText: "old", newText: "new", context: { before: "", after: "" }, fingerprint: "", note: null, groups: ["G1"],
  status: "pending", resolution: null, supersedes: null, conflictsWith: [], history: [], thread: [], ...extra,
});
const cs: Changeset = { id: "C1", agent: "a", title: "t", rationale: "", submittedAt: "", items: ["1.1", "1.2", "1.3", "1.4"], groups: ["G1"] };
function model(g: Partial<Group>, items: Item[] = ["1.1", "1.2", "1.3"].map((i) => item(i))): TreeModel {
  const group: Group = { id: "G1", agent: "a", changeset: "C1", kind: "linked", title: "Rename label sec:a → sec:b", rationale: null, source: "auto", items: items.filter((i) => i.groups.includes("G1")).map((i) => i.id), state: "open", ...g };
  const s: Snapshot = { agents: [agent], changesets: [cs], groups: [group], items } as Snapshot;
  return new TreeModel(s, "review");
}
const parts = { parts: [{ title: "Label", items: ["1.1"] }, { title: "References", items: ["1.2", "1.3"] }] };

describe("D3/D5: every Accept of a linked change asks what to take along", () => {
  it("a label alone in its part: the whole group first, or this one only", () => {
    const m = model(parts);
    const q = acceptQuestion(m, m.item("1.1")!)!;
    expect(q.title).toMatch(/^1\.1 is linked with 1\.2, 1\.3 \(G1 “Rename label/);
    expect(q.choices.map((c) => [c.ids, c.overrideLinked])).toEqual([[["1.1", "1.2", "1.3"], false], [["1.1"], false]]);
    expect(q.choices[1]!.detail).toMatch(/rest of G1 stays pending/);
    // The CodeLens, hover and title bar no longer accept it in one click.
    const a = acceptAction(m, "/p", m.item("1.1")!);
    expect(a.command).toBe("stet.accept");
    expect(a.label).toBe("Accept part 1 of 2…");
  });

  it("a member of a part with others: its part, the whole group, or only it (breaking the part)", () => {
    const m = model(parts);
    const q = acceptQuestion(m, m.item("1.2")!)!;
    expect(q.choices.map((c) => c.label)).toEqual(["Accept part 2 “References” (2 changes)", "Accept all 3 changes of G1", "Accept only 1.2"]);
    expect(q.choices.map((c) => c.overrideLinked)).toEqual([false, false, true]);
    expect(q.choices[0]!.detail).toMatch(/other parts of G1 stay pending/);
    expect(changeActions(m, "/p", m.item("1.2")!).map((x) => x.label)).toContain("Accept only 1.2");
    expect(changeActions(m, "/p", m.item("1.1")!).map((x) => x.label)).not.toContain("Accept only 1.1");
  });

  it("a group without parts: all its linked changes, or only this one", () => {
    const m = model({});
    const q = acceptQuestion(m, m.item("1.3")!)!;
    expect(q.choices.map((c) => [c.label, c.ids])).toEqual([["Accept all 3 linked changes", ["1.3", "1.1", "1.2"]], ["Accept only 1.3", ["1.3"]]]);
    expect(acceptAction(m, "/p", m.item("1.3")!).label).toBe("Accept all 3 linked…");
  });

  it("nothing to ask once the rest is decided, nor for a change alone", () => {
    const decided = model(parts, [item("1.1"), item("1.2", { status: "accepted" }), item("1.3", { status: "accepted" }), item("1.4", { groups: [] })]);
    expect(acceptQuestion(decided, decided.item("1.1")!)).toBeNull();
    expect(acceptQuestion(decided, decided.item("1.4")!)).toBeNull();
    expect(acceptAction(decided, "/p", decided.item("1.4")!).label).toBe("Accept");
  });
});

describe("D2: Edit & accept in the input box shows where the change is", () => {
  const it2 = item("1.1", { oldText: "idea that is easy to explain", newText: "easily explained idea", context: { before: "\\section{Intro}\nOur method relies on a simple ", after: ". It scales well.\nNext line." } });

  it("holds the change in the words around it on its line", () => {
    const f = editFrame(it2);
    expect(f).toEqual({ pre: "Our method relies on a simple ", post: ". It scales well." });
  });

  it("takes an edit of the change, and refuses one that reaches the words around it", () => {
    const f = editFrame(it2);
    const shown = f.pre + it2.newText + f.post;
    expect(editedPart(f, shown)).toBe("easily explained idea");
    expect(editedPart(f, shown.replace("easily explained idea", "clear idea"))).toBe("clear idea");
    // Typing at the change's ends is still the change.
    expect(editedPart(f, f.pre + "very " + it2.newText + f.post)).toBe("very easily explained idea");
    expect(editedPart(f, f.pre + f.post)).toBe("");
    // The tester's slip: retyping "a simple" is now visible, and editing outside is refused.
    expect(editedPart(f, shown.replace("a simple easily explained", "an easily explained"))).toBeNull();
    expect(editedPart(f, shown.replace("scales well", "scales"))).toBeNull();
  });

  it("cuts long context at a space, never in a word", () => {
    const long = item("1.2", { context: { before: "x".repeat(10) + " " + "word ".repeat(30), after: " tail ".repeat(30) } });
    const f = editFrame(long);
    expect(f.pre.length).toBeLessThanOrEqual(60);
    expect(f.pre.startsWith("word ")).toBe(true);
    expect(f.post.length).toBeLessThanOrEqual(60);
    expect(f.post.endsWith("tail")).toBe(true);
  });
});

describe("D6: Finish review says what it commits", () => {
  it("names your own edits, unsaved text, and that undo ends", () => {
    const q = finishQuestion(3, ["main.tex", "intro.tex"], ["intro.tex"], ["main.tex"]);
    expect(q.message).toBe("Commit 3 accepted changes?");
    expect(q.detail).toMatch(/Your own edits in intro\.tex are committed too/);
    expect(q.detail).toMatch(/main\.tex has unsaved edits: “Commit” leaves them out/);
    expect(q.detail).toMatch(/Undo no longer takes these changes back/);
    expect(q.buttons).toEqual(["Commit", FINISH_SAVE]);
  });

  it("asks only Commit when nothing is unsaved, and says nothing of your edits when there are none", () => {
    const q = finishQuestion(1, ["main.tex"], [], []);
    expect(q.message).toBe("Commit 1 accepted change?");
    expect(q.detail).not.toMatch(/own edits|unsaved/);
    expect(q.buttons).toEqual(["Commit"]);
  });
});

describe("B4: j/k from a round or group row", () => {
  // agent, round, change, change, group, change, change
  const rows = [false, false, true, true, false, true, true];
  it("goes to the change after or before the row, not to the panel's ends", () => {
    expect(nextItemIndex(rows, 4, 1)).toBe(5);
    expect(nextItemIndex(rows, 4, -1)).toBe(3);
    expect(nextItemIndex(rows, 1, 1)).toBe(2);
    expect(nextItemIndex(rows, 1, -1)).toBe(-1); // nothing before the first round's changes
  });
  it("steps between changes, stays at the ends, and starts at an end without a selection", () => {
    expect(nextItemIndex(rows, 2, 1)).toBe(3);
    expect(nextItemIndex(rows, 3, 1)).toBe(5);
    expect(nextItemIndex(rows, 6, 1)).toBe(6);
    expect(nextItemIndex(rows, 2, -1)).toBe(2);
    expect(nextItemIndex(rows, -1, 1)).toBe(2);
    expect(nextItemIndex(rows, -1, -1)).toBe(6);
    expect(nextItemIndex([false, false], -1, 1)).toBe(-1);
  });
});

describe("B6: palette commands keep the focus where it is", () => {
  it("only a key in the panel or a row's button counts as the panel", () => {
    expect(fromPanel("panel")).toBe(true);
    expect(fromPanel({ project: {}, node: { type: "item" } })).toBe(true);
    expect(fromPanel(undefined)).toBe(false); // the palette, a user's key binding
    expect(fromPanel({ path: "/p", id: "1.1" })).toBe(false); // CodeLens, hover
    expect(fromPanel("1.1")).toBe(false);
  });
});

describe("B11: an archived agent is not behind", () => {
  it("only active agents are named as behind your text", () => {
    const old: Agent = { ...agent, id: "old", state: "archived" };
    expect(behindAgents({ agents: [agent, old], syncNeeded: new Set(["a", "old"]) })).toEqual(["a"]);
    expect(behindAgents({ agents: [old], syncNeeded: new Set(["old"]) })).toEqual([]);
  });
});

describe("B12: hovers with your wording", () => {
  it("put the code block on lines of its own, so it is one", () => {
    const md = draftMarkdown({ draft: "a \\emph{hard} task", file: "main.tex" });
    expect(md).toMatch(/which Accept uses:\n\n```latex\na \\emph\{hard\} task\n```$/);
  });
});

describe("B13: More… names a change once", () => {
  it("gives the id, then the label without its number", () => {
    const it2 = item("4.12", { oldText: "fast", newText: "quick" });
    expect(actionsTitle(it2)).toMatch(/^4\.12: \S/);
    expect(actionsTitle(it2)).not.toMatch(/^4\.12: 12\b/);
  });
});

describe("B14: agent and round rows count what is yours to review", () => {
  it("says apart how many wait for the agent's revision", () => {
    const m = model({}, [item("1.1"), item("1.2", { status: "needs_revision" }), item("1.3", { status: "accepted" })]);
    expect(m.openText(() => true)).toBe("1 pending · 1 awaiting revision");
    expect(m.openText((i) => i.id === "1.1")).toBe("1 pending");
  });
});

describe("Accessibility: a change's spoken label says what its row shows", () => {
  it("your wording, the conversation, and the status words of the row", () => {
    const it2 = item("2.1", { oldText: "problem", newText: "task", draft: "hard task", thread: [{ at: "", author: "agent", text: "ok" }, { at: "", author: "user", text: "?" }] });
    expect(itemSpoken(it2, 4)).toBe("Change 2.1, replace “problem” with “hard task”, in main.tex line 4, pending, your wording, 2 messages");
    expect(itemSpoken(item("2.2", { status: "needs_revision" }))).toMatch(/, revision requested$/);
  });
  it("the wording a change was accepted with", () => {
    const acc = item("2.3", { oldText: "problem", newText: "task", status: "accepted", resolution: { appliedText: "job", edited: true, committed: null } });
    expect(itemSpoken(acc)).toBe("Change 2.3, replace “problem” with “job”, in main.tex, accepted");
  });
});

describe("Replies you haven't seen", () => {
  const thread = [{ author: "user" }, { author: "agent" }, { author: "user" }, { author: "agent" }];
  it("counts the agent's replies after what you have seen", () => {
    expect(unreadReplies(thread, 0)).toBe(2);
    expect(unreadReplies(thread, 2)).toBe(1);
    expect(unreadReplies(thread, 4)).toBe(0);
    expect(unreadReplies([{ author: "user" }], 0)).toBe(0); // your own messages are never news
  });
  it("shows them on the row and in the spoken label", () => {
    expect(threadText(4, 1)).toBe("💬 4 (1 new)");
    expect(threadText(4, 0)).toBe("💬 4");
    expect(threadText(0, 0)).toBe("");
    const it2 = item("2.1", { thread: [{ at: "", author: "agent", text: "done" }] });
    expect(itemSpoken(it2, undefined, 1)).toMatch(/1 message, 1 new$/);
  });
});

describe("A change that can't be found in your file", () => {
  it("offers Reject and Revise first, and says Accept can't work", () => {
    const m = model({}, [item("1.1", { groups: [] })]);
    const normal = changeActions(m, "/p", m.item("1.1")!).map((a) => a.label);
    expect(normal.slice(0, 2)).toEqual(["Accept", "Reject…"]);
    const lost = changeActions(m, "/p", m.item("1.1")!, { lost: true });
    expect(lost.slice(0, 3).map((a) => a.label)).toEqual(["Reject…", "Revise…", "Accept"]);
    expect(lost[2]!.detail).toMatch(/^Can't work now/);
  });
});

describe("stet.navigationOrder: document", () => {
  it("orders changes by project, file and line, then id", () => {
    const xs = [
      { project: "/a", file: "b.tex", line: 3, id: "1.1" },
      { project: "/a", file: "a.tex", line: 9, id: "2.4" },
      { project: "/a", file: "a.tex", line: 2, id: "1.10" },
      { project: "/a", file: "a.tex", line: 2, id: "1.2" },
    ];
    expect(documentOrder(xs).map((x) => x.id)).toEqual(["1.2", "1.10", "2.4", "1.1"]);
  });
});

describe("Resolved notes in History", () => {
  it("are listed under their agent in History, not in the Review panel", () => {
    const note = (id: string, state: "open" | "resolved") => ({ id, agent: "a", file: "main.tex", text: "", range: { start: 0, end: 0 }, context: { before: "", after: "" }, body: "b", createdAt: "", state, deliveredAt: "", thread: [] });
    const s = { agents: [agent], changesets: [], groups: [], items: [], notes: [note("N1", "open"), note("N2", "resolved")], syncNeeded: new Set(), uncommitted: [], unshared: false, missing: [] } as unknown as Snapshot;
    const ids = (m: TreeModel) => m.children(m.children()[0]).map((n) => (n.type === "note" ? n.note.id : n.type));
    expect(ids(new TreeModel(s, "review"))).toEqual(["N1"]);
    expect(ids(new TreeModel(s, "history"))).toEqual(["N2"]);
  });
});

describe("Overlapping changes at the cursor", () => {
  const r = (l0: number, c0: number, l1: number, c1: number, id: string) => ({ id, range: { start: { line: l0, character: c0 }, end: { line: l1, character: c1 } } });
  it("are all named, so the command can ask which", () => {
    const a = r(2, 0, 2, 20, "1.1");
    const b = r(2, 5, 2, 30, "2.1");
    expect(changesAt([a, b], { line: 2, character: 10 }).map((x) => x.id)).toEqual(["1.1", "2.1"]);
    expect(changesAt([a, b], { line: 2, character: 25 })).toEqual([]); // only in one
    expect(changesAt([a], { line: 2, character: 10 })).toEqual([]);
  });
});

describe("Several changes selected", () => {
  it("asks whether to take along what they are linked with, that first", () => {
    const q = manyQuestion("Accept", 3, ["1.4", "1.5"]);
    expect(q.title).toBe("The 3 selected changes are linked with 1.4, 1.5");
    expect(q.choices.map((c) => [c.label, c.withRest])).toEqual([["Accept the 3 selected and the 2 linked with them", true], ["Accept only the 3 selected", false]]);
    expect(manyQuestion("Reject", 2, ["1.1"]).choices[1]!.label).toBe("Reject only the 2 selected");
  });
});
