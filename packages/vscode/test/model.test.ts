import type { Agent, Changeset, Group, Item } from "@stet/core";
import { describe, expect, it } from "vitest";
import {
  archiveChoices,
  bulkQuestion,
  changeAt,
  diffBlock,
  dissolveQuestion,
  filterIsEmpty,
  filterText,
  fitLabel,
  fitsInline,
  ghostText,
  groupDescription,
  itemLabel,
  itemSpoken,
  LineIndex,
  matchesFilter,
  moveNote,
  type Node,
  nodeMajor,
  projectOfQuery,
  projectQuery,
  proposalMarkdown,
  roundLabel,
  type Snapshot,
  suggestAgentId,
  TreeModel,
} from "../src/model.js";
import { isManaged, managedCliPath } from "../src/runtime.js";
import { makeItem } from "./fixtures.js";

const agent = (id: string, state: Agent["state"] = "active"): Agent => ({
  id,
  kind: "claude-code",
  branch: `stet/${id}`,
  worktree: `/w/${id}`,
  baseCommit: "b",
  lastTip: "b",
  replayedAt: "",
  feedbackCursor: 0,
  createdAt: "",
  state,
});
const item = (id: string, cs: string, extra: Partial<Item> = {}): Item => makeItem(id, { agent: "claude-1", changeset: cs, groups: [], ...extra });
const cs = (id: string, items: string[], groups: string[] = []): Changeset => ({
  id,
  agent: "claude-1",
  title: `title ${id}`,
  rationale: "",
  submittedAt: "",
  items,
  groups,
});
const group = (id: string, c: string, kind: Group["kind"], items: string[], extra: Partial<Group> = {}): Group => ({
  id,
  agent: "claude-1",
  changeset: c,
  kind,
  title: `group ${id}`,
  rationale: null,
  source: "agent",
  items,
  state: "open",
  ...extra,
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
    notes: [],
    syncNeeded: new Set(),
    uncommitted: [],
    unshared: false,
    missing: [],
  };
}

const ids = (nodes: Node[]) =>
  nodes.map((n) =>
    n.type === "agent"
      ? n.agent.id
      : n.type === "changeset"
        ? n.changeset.id
        : n.type === "group"
          ? n.group.id
          : n.type === "part"
            ? `${n.group.id}.${n.index + 1}`
            : n.type === "note"
              ? n.note.id
              : n.item.id,
  );

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

  it("shows the parts of a linked group, and links an item only with its part", () => {
    const s = snap();
    s.groups[0] = group("G1", "C1", "linked", ["S1", "S2", "S5"], {
      parts: [
        { title: "Label", items: ["S1"] },
        { title: "References", items: ["S2", "S5"] },
      ],
    });
    const m = new TreeModel(s, "review");
    const g = m.children(m.children(m.children()[0])[0])[0]!;
    const parts = m.children(g);
    expect(parts.map((n) => (n.type === "part" ? n.index : -1))).toEqual([0, 1]);
    expect(ids(m.children(parts[1]))).toEqual(["S2", "S5"]);
    expect(m.children(parts[1]).map((n) => (n.type === "item" ? n.parent : ""))).toEqual(["G1.2", "G1.2"]);
    expect(m.linkedRest(["S1"])).toEqual([]);
    expect(m.linkedRest(["S2"]).map((i) => i.id)).toEqual(["S5"]);
    expect(m.partOf(m.item("S5")!)).toMatchObject({ index: 1 });
    // A part whose changes are all decided disappears from the Review panel.
    s.items[0] = item("S1", "C1", { groups: ["G1"], status: "accepted" });
    const after = new TreeModel(s, "review");
    const g2 = after.children(after.children(after.children()[0])[0])[0]!;
    expect(after.children(g2).map((n) => (n.type === "part" ? n.index : -1))).toEqual([1]);
  });

  it("lists an agent's open notes before its rounds in the Review panel, resolved ones in History", () => {
    const s = snap();
    const note = (id: string, state: "open" | "resolved", agentId = "claude-1") => ({
      id,
      agent: agentId,
      file: "main.tex",
      text: "x",
      range: { start: 0, end: 1 },
      context: { before: "", after: "" },
      body: "b",
      createdAt: "",
      state,
      deliveredAt: null,
      thread: [],
    });
    s.notes = [note("N2", "open"), note("N1", "resolved"), note("N3", "open", "old"), note("N10", "open")];
    const m = new TreeModel(s, "review");
    expect(ids(m.children(m.children()[0]))).toEqual(["N2", "N10", "C1"]);
    const h = new TreeModel(s, "history");
    expect(ids(h.children(h.children()[0])).filter((x) => x.startsWith("N"))).toEqual(["N1"]);
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
    // A paragraph split, joined, or its break moved past a sentence, said in words (test report 2026-11-20).
    expect(itemLabel(item("S1", "C1", { oldText: " ", newText: "\n\n" }))).toBe("S1  “␣” → “¶”  · paragraph split");
    const moved = itemLabel(item("S1", "C1", { oldText: " Beta two is a long sentence here.\n\n", newText: "\n\nBeta two is a long sentence here. " }));
    expect(moved).toMatch(/^S1 {2}“….*here\.¶” → “¶Beta two.*…” {2}· paragraph break moved$/);
    expect(itemSpoken(item("S1", "C1", { oldText: "\n\n", newText: " " }))).toMatch(/^Change S1, paragraphs joined, /);
    expect(itemLabel(item("S1", "C1", { kind: "rename-file", oldFile: "a.tex", file: "b.tex" }))).toBe("S1  rename a.tex → b.tex");
  });

  it("makes ghost text single-line and bounded", () => {
    expect(ghostText("a\nb")).toBe("a ⏎ b");
    // Whitespace alone (a paragraph split or joined) is shown, not an invisible space.
    expect(ghostText("\n\n")).toBe("¶");
    expect(ghostText(" ")).toBe("␣");
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

describe("moves (spec §6.4.7)", () => {
  const PASSAGE = "Our tool splits every proposal into small items. The author accepts or rejects them one at a time.";
  const moveSnap = (changed = 0, newText = PASSAGE): Snapshot => {
    const move = { from: "7.1", to: "7.2", changed };
    return {
      ...snap(),
      changesets: [cs("C7", ["7.1", "7.2", "7.3"], ["G7"])],
      groups: [group("G7", "C7", "linked", ["7.1", "7.2"], { source: "auto", title: "Move “Our tool…” (2 sentences, unchanged)" })],
      items: [
        item("7.1", "C7", { oldText: PASSAGE + "\n\n", newText: "", groups: ["G7"], move }),
        item("7.2", "C7", { oldText: "", newText: "\n" + newText, groups: ["G7"], move }),
        item("7.3", "C7", { oldText: "a", newText: "b" }),
      ],
    };
  };

  it("labels both halves, recognises the move group, and decides the halves together", () => {
    const m = new TreeModel(moveSnap(), "review");
    const [a, b, c] = ["7.1", "7.2", "7.3"].map((id) => m.item(id)!);
    expect(itemLabel(a!)).toMatch(/^1 {2}⇣ moved out: “Our tool splits every proposal into .*…”$/);
    expect(itemLabel(b!)).toMatch(/^2 {2}⇡ moved in: “Our tool/);
    expect(m.isMove(m.group("G7")!)).toBe(true);
    expect(groupDescription(m.group("G7")!, 2, true)).toBe("move");
    expect(m.withMove(b!)).toEqual(["7.2", "7.1"]);
    expect(m.withMove(c!)).toEqual(["7.3"]);
    expect(m.linkedRest(["7.2"]).map((i) => i.id)).toEqual(["7.1"]);
    // Without its group (ungrouped by the agent), the halves still belong together.
    const loose = moveSnap();
    loose.groups = [];
    for (const i of loose.items) i.groups = [];
    expect(new TreeModel(loose).linkedRest(["7.1"]).map((i) => i.id)).toEqual(["7.2"]);
  });

  it("notes in the editor say where the passage goes, and show changed words", () => {
    const m = new TreeModel(moveSnap(), "review");
    const lines = (l: Record<string, number>) => (id: string) => l[id] ?? null;
    expect(moveNote(m.item("7.1")!, m.get, lines({ "7.2": 40 }))).toEqual({ text: "⇣ moved to line 40 (7.2)", changed: false });
    expect(moveNote(m.item("7.2")!, m.get, lines({ "7.1": 12 }))).toEqual({ text: "⇡ moved here from line 12 (7.1), word for word", changed: false });
    expect(moveNote(m.item("7.3")!, m.get, lines({}))).toBeNull();

    const m2 = new TreeModel(moveSnap(1, PASSAGE.replace("small", "short")), "review");
    expect(itemLabel(m2.item("7.2")!, m2.get)).toMatch(/ · 1 word changed$/);
    expect(moveNote(m2.item("7.2")!, m2.get, lines({ "7.1": 12 }))).toEqual({
      text: "⇡ moved here from line 12 (7.1) with 1 word changed: “small” → “short”",
      changed: true,
    });
  });

  it("several blocks landing next to each other: one move, notes naming every source", () => {
    const A = "First moved paragraph with enough words. It has two sentences.";
    const B = "Second moved paragraph, from somewhere else. Also two sentences.";
    const move = { from: ["8.1", "8.2"], to: ["8.3"], changed: 1 };
    const s: Snapshot = {
      ...snap(),
      changesets: [cs("C8", ["8.1", "8.2", "8.3"], ["G8"])],
      groups: [group("G8", "C8", "linked", ["8.1", "8.2", "8.3"], { source: "auto" })],
      items: [
        item("8.1", "C8", { oldText: A + "\n\n", newText: "", groups: ["G8"], move }),
        item("8.2", "C8", { oldText: B + "\n\n", newText: "", groups: ["G8"], move }),
        item("8.3", "C8", { oldText: "", newText: `\n${A}\n\n${B.replace("somewhere", "anywhere")}\n`, groups: ["G8"], move }),
      ],
    };
    const m = new TreeModel(s, "review");
    expect(m.isMove(m.group("G8")!)).toBe(true);
    expect(m.withMove(m.item("8.1")!)).toEqual(["8.1", "8.2", "8.3"]);
    expect(m.linkedRest(["8.2"]).map((i) => i.id)).toEqual(["8.1", "8.3"]);
    const lines = (id: string) => ({ "8.1": 5, "8.2": 9, "8.3": 30 })[id] ?? null;
    expect(moveNote(m.item("8.2")!, m.get, lines)).toEqual({ text: "⇣ moved to line 30 (8.3)", changed: false });
    expect(moveNote(m.item("8.3")!, m.get, lines)).toEqual({
      text: "⇡ moved here from lines 5 and 9 (8.1, 8.2) with 1 word changed: “somewhere” → “anywhere”",
      changed: true,
    });
    // A source in another file is named by its file.
    expect(
      moveNote(
        m.item("8.3")!,
        (id) => (id === "8.2" ? { ...m.get(id)!, file: "appendix.tex" } : m.get(id)),
        (id) => (id === "8.1" ? 5 : null),
      )!.text,
    ).toMatch(/^⇡ moved here from line 5 and appendix\.tex \(8\.1, 8\.2\)/);
  });
});

describe("the change at the cursor, the archive dialog and revision labels (test report v0.14)", () => {
  const at = (l: number, c: number) => ({ line: l, character: c });
  const loc = (id: string, l: number, a: number, b: number, l2 = l) => ({ id, range: { start: at(l, a), end: at(l2, b) } });

  it("B8: a command at the cursor takes the change it is in, else the nearest on the line", () => {
    const located = [loc("first", 3, 0, 10), loc("second", 3, 40, 50), loc("other", 5, 0, 5)];
    expect(changeAt(located, at(3, 45))!.id).toBe("second");
    expect(changeAt(located, at(3, 5))!.id).toBe("first");
    expect(changeAt(located, at(3, 36))!.id).toBe("second"); // nearer the second than the first
    expect(changeAt(located, at(3, 14))!.id).toBe("first");
    expect(changeAt(located, at(4, 0))).toBeUndefined();
    // A change over several lines: on its last line too, and inside it on a middle line.
    expect(changeAt([loc("long", 7, 30, 12, 9)], at(9, 2))!.id).toBe("long");
    expect(changeAt([loc("long", 7, 30, 12, 9)], at(8, 0))!.id).toBe("long");
  });

  it("D5: the archive dialog offers keeping the folder first, and says what deleting loses", () => {
    expect(archiveChoices(0).order).toEqual(["Archive, keep folder", "Archive and delete folder"]);
    const c = archiveChoices(3);
    expect(c.order[0]).toBe(c.keep);
    expect(c.del).toBe("Archive and delete folder, with 3 unsubmitted files");
    expect(archiveChoices(1).del).toMatch(/1 unsubmitted file$/);
  });

  it("B4: labels show a revision and where a long change differs", () => {
    const a = item("3.1", "C3", {
      supersedes: "2.4",
      oldText: "\\begin{equation} r = \\frac{\\ln(N_t) - \\ln(N_0)}{t} \\end{equation}",
      newText: "\\begin{equation} r = \\frac{\\ln N_t - \\ln N_0}{t} \\end{equation}",
    });
    const label = itemLabel(a);
    expect(label).toContain("revises 2.4");
    expect(label).toContain("\\ln(N_t)");
    expect(label).toContain("\\ln N_t");
    expect(itemLabel(item("1.1", "C1", { oldText: " ", newText: "~" }))).toContain("“␣” → “~”");
  });
});

describe("confirmations and screen readers (test report v0.14)", () => {
  it("asks before deciding several changes at once, except a linked group's", () => {
    const s = (count: number, changeset: boolean, linked: boolean) => ({ count, what: "C3 “Polish”", changeset, linked });
    expect(bulkQuestion("Reject", s(5, true, false))).toBe("Reject all 5 changes of C3 “Polish”?");
    expect(bulkQuestion("Accept", s(4, false, false))).toMatch(/^Accept all 4 changes/); // a related group
    expect(bulkQuestion("Accept", s(4, false, true))).toBeNull(); // a linked group goes together anyway
    expect(bulkQuestion("Reject", s(1, true, false))).toBeNull();
    expect(dissolveQuestion({ id: "G2", kind: "linked", title: "Rename" })).toMatch(/can't be undone/);
    expect(dissolveQuestion({ id: "G3", kind: "related", title: "Wording" })).toMatch(/^Dissolve group G3 “Wording”\?.*can't be undone/);
  });

  it("reads a change out in words", () => {
    expect(itemSpoken(item("2.1", "C2", { oldText: "problem", newText: "task" }), 4)).toBe(
      "Change 2.1, replace “problem” with “task”, in main.tex line 4, pending",
    );
    expect(itemSpoken(item("2.2", "C2", { oldText: "", newText: "very ", status: "needs_revision" }))).toBe(
      "Change 2.2, insert “very”, in main.tex, revision requested",
    );
    expect(itemSpoken(item("2.3", "C2", { kind: "add-file", file: "a.tex" }))).toBe("Change 2.3, add file in a.tex, pending");
  });
});

describe("filters and labels (test report v0.14)", () => {
  it("filters what the panel shows by agent, file, status and words, keeping the tree around matches", () => {
    const s = snap();
    s.items.push(
      item("S6", "C1", { file: "intro.tex", oldText: "estimator", newText: "statistic", thread: [{ at: "", author: "user", text: "Why the change?" }] }),
    );
    const m = new TreeModel(s, "review", { file: "intro.tex" });
    const [a] = m.children();
    const [c1] = m.children(a);
    expect(ids(m.children(c1))).toEqual(["S6"]); // G1 has no match: hidden
    m.filter = { status: "needs_revision" };
    expect(ids(m.children(m.children(m.children()[0])[0]))).toEqual(["G1"]);
    expect(ids(m.children(m.children(m.children(m.children()[0])[0])[0]))).toEqual(["S5"]);
    m.filter = { agent: "nobody" };
    expect(m.children()).toEqual([]);
    m.filter = null;
    expect(ids(m.children(m.children(m.children()[0])[0]))).toEqual(["G1", "S6"]);
    // Decisions still see the whole group, whatever is shown.
    m.filter = { text: "statistic" };
    expect(m.members(s.groups[0]!).map((i) => i.id)).toEqual(["S1", "S2", "S5"]);
  });

  it("matches words anywhere in a change, all of them", () => {
    const it = item("3.2", "C3", {
      oldText: "the estimator",
      newText: "the statistic",
      note: "Consistent with Section 2",
      thread: [{ at: "", author: "agent", text: "As asked" }],
    });
    expect(matchesFilter(it, { text: "STATISTIC" })).toBe(true);
    expect(matchesFilter(it, { text: "section estimator" })).toBe(true);
    expect(matchesFilter(it, { text: "asked" })).toBe(true);
    expect(matchesFilter(it, { text: "estimator missing" })).toBe(false);
    expect(matchesFilter(it, { text: "3.2", file: "main.tex" })).toBe(true);
    expect(matchesFilter(it, { file: "other.tex" })).toBe(false);
    expect(filterIsEmpty({ text: "  " })).toBe(true);
    expect(filterText({ agent: "claude-1", file: "a.tex", status: "pending", text: "x" })).toBe("agent claude-1 · a.tex · waiting for you · “x”");
  });

  it("shortens long names at a word, so counts stay visible", () => {
    expect(fitLabel("short", 28)).toBe("short");
    expect(fitLabel("Polish the introduction and the related work section", 40)).toBe("Polish the introduction and the…");
    expect(fitLabel("an-extremely-long-agent-name-without-spaces", 20)).toBe("an-extremely-long-a…");
  });
});

describe("the project in a Stet document's address", () => {
  it("comes back as it was, with % and an encoded space in the folder name (code quality report 6a517ae)", () => {
    for (const path of ["/home/u/50% done", "/home/u/a%20b", "C:\\Users\\u\\thesis & notes+1"]) {
      expect(projectOfQuery(`${projectQuery(path)}&side=current`)).toBe(path);
    }
  });
});
