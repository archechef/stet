/** What Accept asks: the parts and groups a change is linked with, several changes at once, and its wording. */
import { type Agent, type Changeset, type Group, type Item, StetError } from "@stet/core";
import { describe, expect, it } from "vitest";
import { acceptAction, acceptQuestion, changeActions } from "../src/actions.js";
import { type Snapshot, TreeModel } from "../src/model.js";
import { failedAcceptActions, manyQuestion } from "../src/questions.js";
import { makeItem as item, makeTypItem as typItem } from "./fixtures.js";

function model(g: Partial<Group>, items: Item[] = ["1.1", "1.2", "1.3"].map((i) => item(i))): TreeModel {
  const group: Group = {
    id: "G1",
    agent: "a",
    changeset: "C1",
    kind: "linked",
    title: "Rename label sec:a → sec:b",
    rationale: null,
    source: "auto",
    items: items.filter((i) => i.groups.includes("G1")).map((i) => i.id),
    state: "open",
    ...g,
  };
  const s: Snapshot = { agents: [agent], changesets: [cs], groups: [group], items } as Snapshot;
  return new TreeModel(s, "review");
}

const parts = {
  parts: [
    { title: "Label", items: ["1.1"] },
    { title: "References", items: ["1.2", "1.3"] },
  ],
};

const typSnap = (items: Item[], groups: Group[]): Snapshot => ({
  agents: [],
  changesets: [typCs],
  groups,
  items,
  notes: [],
  syncNeeded: new Set(),
  uncommitted: [],
  unshared: false,
  missing: [],
});

const agent: Agent = {
  id: "a",
  kind: "claude-code",
  branch: "stet/a",
  worktree: "/w/a",
  baseCommit: "b",
  lastTip: "b",
  replayedAt: "",
  feedbackCursor: 0,
  createdAt: "",
  state: "active",
};

const cs: Changeset = { id: "C1", agent: "a", title: "t", rationale: "", submittedAt: "", items: ["1.1", "1.2", "1.3", "1.4"], groups: ["G1"] };

const typCs: Changeset = { id: "C1", agent: "a", title: "t", rationale: "", submittedAt: "", items: [], baseCommit: "b" } as unknown as Changeset;

describe("every Accept of a linked change asks what to take along (test report v0.16, D3/D5)", () => {
  it("a label alone in its part: the whole group first, or this one only", () => {
    const m = model(parts);
    const q = acceptQuestion(m, m.item("1.1")!)!;
    expect(q.title).toMatch(/^1\.1 is linked with 1\.2, 1\.3 \(G1 “Rename label/);
    expect(q.choices.map((c) => [c.ids, c.overrideLinked])).toEqual([
      [["1.1", "1.2", "1.3"], false],
      [["1.1"], false],
    ]);
    expect(q.choices[1]!.detail).toMatch(/other parts of G1 stay pending/);
    // The CodeLens, hover and title bar no longer accept it in one click.
    const a = acceptAction(m, "/p", m.item("1.1")!);
    expect(a.command).toBe("stet.accept");
    expect(a.label).toBe("Accept part 1 of 2…");
  });

  it("a member of a part with others: its part, the whole group, or only it (breaking the part)", () => {
    const m = model(parts);
    const q = acceptQuestion(m, m.item("1.2")!)!;
    expect(q.choices.map((c) => c.label)).toEqual([
      "Accept part 2 of 2 “References” (2 changes)",
      "Accept all of G1 (3 changes)",
      "Accept only 1.2 (breaks G1)",
    ]);
    expect(q.choices.map((c) => c.overrideLinked)).toEqual([false, false, true]);
    expect(q.choices[0]!.detail).toMatch(/other parts of G1 stay pending/);
    expect(changeActions(m, "/p", m.item("1.2")!).map((x) => x.label)).toContain("Accept only 1.2 (breaks G1)");
    expect(changeActions(m, "/p", m.item("1.1")!).map((x) => x.label)).not.toContain("Accept only 1.1 (breaks G1)");
  });

  it("a group without parts: all its linked changes, or only this one", () => {
    const m = model({});
    const q = acceptQuestion(m, m.item("1.3")!)!;
    expect(q.choices.map((c) => [c.label, c.ids])).toEqual([
      ["Accept all of G1 (3 changes)", ["1.3", "1.1", "1.2"]],
      ["Accept only 1.3 (breaks G1)", ["1.3"]],
    ]);
    expect(acceptAction(m, "/p", m.item("1.3")!).label).toBe("Accept all of G1…");
  });

  it("nothing to ask once the rest is decided, nor for a change alone", () => {
    const decided = model(parts, [item("1.1"), item("1.2", { status: "accepted" }), item("1.3", { status: "accepted" }), item("1.4", { groups: [] })]);
    expect(acceptQuestion(decided, decided.item("1.1")!)).toBeNull();
    expect(acceptQuestion(decided, decided.item("1.4")!)).toBeNull();
    expect(acceptAction(decided, "/p", decided.item("1.4")!).label).toBe("Accept");
  });
});

describe("several changes selected (test report v0.16)", () => {
  it("asks whether to take along what they are linked with, that first", () => {
    const q = manyQuestion("Accept", 3, ["1.4", "1.5"]);
    expect(q.title).toBe("The 3 selected changes are linked with 1.4, 1.5");
    expect(q.choices.map((c) => [c.label, c.withRest])).toEqual([
      ["Accept the 3 selected and the 2 linked with them", true],
      ["Accept only the 3 selected (breaks their linked groups)", false],
    ]);
    expect(manyQuestion("Reject", 2, ["1.1"]).choices[1]!.label).toBe("Reject only the 2 selected (breaks their linked groups)");
  });
});

describe("questions and wording", () => {
  it("multi-select Accept asks about the other parts of their linked groups (test report 5e4c6af, D2)", () => {
    const q = manyQuestion("Accept", 2, [], ["1.5"]);
    expect(q.title).toContain("1.5");
    expect(q.choices.map((c) => c.label)).toEqual(["Accept the 2 selected and all 1 other changes of their linked groups", "Accept only the 2 selected"]);
    expect(q.choices[0]!.withGroups).toBe(true);
    // Accepting only the selected keeps the group: no override.
    expect(q.choices[1]!.withRest).toBe(true);
    const g: Group = {
      id: "G1",
      kind: "linked",
      title: "Rename",
      rationale: null,
      source: "auto",
      items: ["1.1", "1.2"],
      state: "open",
      parts: [
        { title: "a", items: ["1.1"] },
        { title: "b", items: ["1.2"] },
      ],
    } as unknown as Group;
    const m = new TreeModel(typSnap([typItem("1.1", { groups: ["G1"] }), typItem("1.2", { groups: ["G1"] }), typItem("1.3")], [g]));
    expect(m.linkedRest(["1.1", "1.3"])).toEqual([]);
    expect(m.otherParts(["1.1", "1.3"]).map((i) => i.id)).toEqual(["1.2"]);
    expect(acceptQuestion(m, m.item("1.1")!)).not.toBeNull();
  });

  it("Accept wording is one set of phrases; accepting a Typst change alone says it may not compile", () => {
    const g: Group = { id: "G1", kind: "linked", title: "Rename", rationale: null, source: "auto", items: ["1.1", "1.2"], state: "open" } as unknown as Group;
    const m = new TreeModel(typSnap([typItem("1.1", { groups: ["G1"] }), typItem("1.2", { groups: ["G1"] })], [g]));
    const q = acceptQuestion(m, m.item("1.1")!)!;
    expect(q.choices.map((c) => c.label)).toEqual(["Accept all of G1 (2 changes)", "Accept only 1.1 (breaks G1)"]);
    expect(q.choices[1]!.detail).toMatch(/may not compile/);
  });

  it("a failed accept of a change that can't be found offers Reject and Revise", () => {
    const lost = new StetError("Nothing was applied", { code: "not_applied", lost: ["1.1"] });
    expect(failedAcceptActions(["1.1"], lost)).toEqual(["Reject…", "Revise…"]);
    // Not for other failures, nor when several were accepted.
    expect(failedAcceptActions(["1.1"], new StetError("Nothing was applied", { code: "not_applied", lost: [] }))).toEqual([]);
    expect(failedAcceptActions(["1.1", "1.2"], lost)).toEqual([]);
    expect(failedAcceptActions(["1.1"], new Error("can't be located"))).toEqual([]);
  });
});
