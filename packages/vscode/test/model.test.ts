import { describe, expect, it } from "vitest";
import type { Agent, Changeset, Group, Item } from "@stet/core";
import { diffBlock, fitsInline, ghostText, itemLabel, proposalMarkdown, roundLabel, LineIndex, nodeMajor, suggestAgentId, TreeModel, type Node, type Snapshot } from "../src/model.js";
import { isManaged, managedCliPath } from "../src/runtime.js";

const agent = (id: string, state: Agent["state"] = "active"): Agent => ({
  id, kind: "claude-code", branch: `stet/${id}`, worktree: `/w/${id}`, baseCommit: "b", lastTip: "b",
  replayedAt: "", feedbackCursor: 0, createdAt: "", state,
});
const item = (id: string, cs: string, extra: Partial<Item> = {}): Item => ({
  id, agent: "claude-1", changeset: cs, file: "main.tex", kind: "modify", baseCommit: "b", range: { start: 0, end: 1 },
  oldText: "old", newText: "new", context: { before: "", after: "" }, fingerprint: "", note: null, groups: [],
  status: "pending", resolution: null, supersedes: null, conflictsWith: [], history: [], thread: [], ...extra,
});
const cs = (id: string, items: string[], groups: string[] = []): Changeset => ({ id, agent: "claude-1", title: `title ${id}`, rationale: "", submittedAt: "", items, groups });
const group = (id: string, c: string, kind: Group["kind"], items: string[], extra: Partial<Group> = {}): Group => ({
  id, agent: "claude-1", changeset: c, kind, title: `group ${id}`, rationale: null, source: "agent", items, state: "open", ...extra,
});

function snap(): Snapshot {
  return {
    agents: [agent("claude-1"), agent("old", "archived")],
    changesets: [cs("C1", ["S1", "S2", "S3"], ["G1"]), cs("C2", ["S4", "S5"])],
    groups: [group("G1", "C1", "linked", ["S1", "S2", "S5"])],
    items: [
      item("S1", "C1", { groups: ["G1"] }),
      item("S2", "C1", { groups: ["G1"] }),
      item("S3", "C1", { status: "accepted" }),
      item("S4", "C2", { status: "rejected" }),
      // A revision in a later changeset that inherited the linked group.
      item("S5", "C2", { groups: ["G1"], status: "needs_revision" }),
    ],
    syncNeeded: new Set(),
    uncommitted: [],
    unshared: false,
  };
}

const ids = (nodes: Node[]) =>
  nodes.map((n) => (n.type === "agent" ? n.agent.id : n.type === "changeset" ? n.changeset.id : n.type === "group" ? n.group.id : n.item.id));

describe("tree model", () => {
  it("shows live items as agent → changeset → group → item", () => {
    const m = new TreeModel(snap(), "review");
    const [a] = m.children();
    expect(ids(m.children())).toEqual(["claude-1"]);
    const css = m.children(a);
    expect(ids(css)).toEqual(["C1"]); // C2 has no visible items of its own and no groups
    const [g] = m.children(css[0]);
    expect(ids(m.children(css[0]))).toEqual(["G1"]);
    expect(ids(m.children(g))).toEqual(["S1", "S2", "S5"]);
  });

  it("history shows only decided changes, newest round first", () => {
    const m = new TreeModel(snap(), "history");
    expect(ids(m.children())).toEqual(["claude-1"]);
    const [a] = m.children();
    const css = m.children(a);
    expect(ids(css)).toEqual(["C2", "C1"]);
    expect(ids(m.children(css[0]))).toEqual(["S4"]);
    expect(ids(m.children(css[1]))).toEqual(["S3"]); // G1's members are all still open
    expect(m.outcome(() => true)).toBe("1 accepted · 1 rejected");
  });

  it("history includes archived agents' decisions; review only active agents and open work", () => {
    const s = snap();
    s.items.push(item("S6", "C3", { agent: "old", status: "accepted" }));
    s.changesets.push({ ...cs("C3", ["S6"]), agent: "old" });
    expect(ids(new TreeModel(s, "history").children())).toEqual(["claude-1", "old"]);
    expect(ids(new TreeModel(s, "review").children())).toEqual(["claude-1"]);
  });

  it("numbers changes within their round, after old-style ids", () => {
    const s = snap();
    s.changesets.push(cs("C12", ["12.1", "12.2", "12.10"]));
    s.items.push(item("12.10", "C12"), item("12.2", "C12"), item("12.1", "C12"));
    const m = new TreeModel(s, "review");
    const c12 = m.children(m.children()[0]).find((n) => n.type === "changeset" && n.changeset.id === "C12")!;
    expect(ids(m.children(c12))).toEqual(["12.1", "12.2", "12.10"]);
    expect(itemLabel(item("12.3", "C12", { oldText: "problem", newText: "task" }))).toBe("3  “problem” → “task”");
    expect(roundLabel(cs("C12", []))).toBe("Round 12: title C12");
  });

  it("finds the rest of a linked group", () => {
    const m = new TreeModel(snap(), "review");
    expect(m.linkedRest(["S1"]).map((i) => i.id)).toEqual(["S2", "S5"]);
    expect(m.linkedRest(["S1", "S2", "S5"])).toEqual([]);
    expect(m.linkedGroup(m.item("s2")!)?.id).toBe("G1");
    expect(m.liveCount(() => true)).toBe(3);
  });

  it("hides atomic groups (their members are merged)", () => {
    const s = snap();
    s.groups.push(group("G2", "C1", "atomic", ["S3"]));
    s.items[2] = item("S3", "C1", { groups: ["G2"] });
    const m = new TreeModel(s, "review");
    const c1 = m.children(m.children()[0])[0];
    expect(ids(m.children(c1))).toEqual(["G1", "S3"]);
  });
});

describe("labels and text", () => {
  it("labels items by kind", () => {
    expect(itemLabel(item("S1", "C1", { oldText: "problem", newText: "task" }))).toBe("S1  “problem” → “task”");
    expect(itemLabel(item("S1", "C1", { oldText: "", newText: "inserted\n text" }))).toBe("S1  + “inserted text”");
    expect(itemLabel(item("S1", "C1", { kind: "rename-file", oldFile: "a.tex", file: "b.tex" }))).toBe("S1  rename a.tex → b.tex");
  });

  it("makes ghost text single-line and bounded", () => {
    expect(ghostText("a\nb")).toBe("a ⏎ b");
    expect(ghostText("x".repeat(100), 10)).toBe("xxxxxxxxx…");
  });

  it("knows when ghost text can't show a proposal, and shows it in full otherwise", () => {
    expect(fitsInline("short")).toBe(true);
    expect(fitsInline("a\nb")).toBe(false);
    expect(fitsInline("x".repeat(81))).toBe(false);
    const long = "First line with `code`.\nSecond line ``` [link](http://x)\n" + "y".repeat(200);
    const md = proposalMarkdown(item("S1", "C1", { newText: long }));
    expect(md).toContain(long); // in full, not shortened
    expect(md).toMatch(/````latex\n/); // fenced: the agent's text is never rendered as Markdown
  });

  it("fences diffs safely", () => {
    const d = diffBlock("a ```b", "c");
    expect(d.startsWith("````diff\n- a ```b\n+ c\n````")).toBe(true);
  });

  it("maps LF offsets to line/character", () => {
    const idx = new LineIndex("ab\ncd\n\nef");
    expect(idx.position(0)).toEqual({ line: 0, character: 0 });
    expect(idx.position(4)).toEqual({ line: 1, character: 1 });
    expect(idx.position(7)).toEqual({ line: 3, character: 0 });
    expect(idx.position(9)).toEqual({ line: 3, character: 2 });
  });

  it("suggests agent names and parses node versions", () => {
    expect(suggestAgentId("claude-code", ["claude-1"])).toBe("claude-2");
    expect(suggestAgentId("codex", [])).toBe("codex-1");
    expect(nodeMajor("v22.11.0\n")).toBe(22);
    expect(nodeMajor("nope")).toBeNull();
  });

  it("recognizes the CLI copy the extension manages", () => {
    const root = "C:\\p\\.git\\stet";
    expect(isManaged({ command: "node", args: [managedCliPath(root).replace(/\\/g, "/")] }, root)).toBe(true);
    expect(isManaged({ command: "node", args: ["/usr/lib/stet/index.js"] }, root)).toBe(false);
    expect(isManaged(undefined, root)).toBe(false);
  });
});
