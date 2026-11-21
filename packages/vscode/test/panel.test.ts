/** What the panel's rows say, and its menu entries. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Agent, Changeset, Group, Item } from "@stet/core";
import { changeActions } from "../src/actions.js";
import { behindAgents, itemSpoken, type Snapshot, threadText, TreeModel, unreadReplies } from "../src/model.js";

const agent: Agent = { id: "a", kind: "claude-code", branch: "stet/a", worktree: "/w/a", baseCommit: "b", lastTip: "b", replayedAt: "", feedbackCursor: 0, createdAt: "", state: "active" };

const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id, agent: "a", changeset: "C1", file: "main.tex", kind: "modify", baseCommit: "b", range: { start: 0, end: 1 },
  oldText: "old", newText: "new", context: { before: "", after: "" }, fingerprint: "", note: null, groups: ["G1"],
  status: "pending", resolution: null, supersedes: null, conflictsWith: [], history: [], thread: [], ...extra,
});

function model(g: Partial<Group>, items: Item[] = ["1.1", "1.2", "1.3"].map((i) => item(i))): TreeModel {
  const group: Group = { id: "G1", agent: "a", changeset: "C1", kind: "linked", title: "Rename label sec:a → sec:b", rationale: null, source: "auto", items: items.filter((i) => i.groups.includes("G1")).map((i) => i.id), state: "open", ...g };
  const s: Snapshot = { agents: [agent], changesets: [cs], groups: [group], items } as Snapshot;
  return new TreeModel(s, "review");
}

const cs: Changeset = { id: "C1", agent: "a", title: "t", rationale: "", submittedAt: "", items: ["1.1", "1.2", "1.3", "1.4"], groups: ["G1"] };

describe("an archived agent is not behind (test report v0.16, B11)", () => {
  it("only active agents are named as behind your text", () => {
    const old: Agent = { ...agent, id: "old", state: "archived" };
    expect(behindAgents({ agents: [agent, old], syncNeeded: new Set(["a", "old"]) })).toEqual(["a"]);
    expect(behindAgents({ agents: [old], syncNeeded: new Set(["old"]) })).toEqual([]);
  });
});

describe("agent and round rows count what is yours to review (test report v0.16, B14)", () => {
  it("says apart how many wait for the agent's revision", () => {
    const m = model({}, [item("1.1"), item("1.2", { status: "needs_revision" }), item("1.3", { status: "accepted" })]);
    expect(m.openText(() => true)).toBe("1 pending · 1 awaiting revision");
    expect(m.openText((i) => i.id === "1.1")).toBe("1 pending");
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

describe("resolved notes in History (test report v0.16)", () => {
  it("are listed under their agent in History, not in the Review panel", () => {
    const note = (id: string, state: "open" | "resolved") => ({ id, agent: "a", file: "main.tex", text: "", range: { start: 0, end: 0 }, context: { before: "", after: "" }, body: "b", createdAt: "", state, deliveredAt: "", thread: [] });
    const s = { agents: [agent], changesets: [], groups: [], items: [], notes: [note("N1", "open"), note("N2", "resolved")], syncNeeded: new Set(), uncommitted: [], unshared: false, missing: [] } as unknown as Snapshot;
    const ids = (m: TreeModel) => m.children(m.children()[0]).map((n) => (n.type === "note" ? n.note.id : n.type));
    expect(ids(new TreeModel(s, "review"))).toEqual(["N1"]);
    expect(ids(new TreeModel(s, "history"))).toEqual(["N2"]);
  });
});

describe("menu entries", () => {
  it("no preview entries for changes without PDF previews (test report 5e4c6af, B3, B8)", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    const menus = Object.values(pkg.contributes.menus).flat() as { command: string; when?: string }[];
    for (const m of menus.filter((x) => x.command === "stet.preview" && x.when?.includes("viewItem"))) expect(m.when).toContain("\\.pdf/");
    for (const m of menus.filter((x) => x.command === "stet.previewSetup")) expect(m.when).toContain("stet.previews");
    expect(menus.find((x) => x.command === "stet.reopenNote" && x.when === "false")).toBeDefined();
  });
});
