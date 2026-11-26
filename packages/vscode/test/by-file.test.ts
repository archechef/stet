/** Changes grouped by file (setting stet.groupBy): the trees, History's rounds per file, and deciding a file. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Changeset, Group, Item } from "@stet/core";
import { describe, expect, it } from "vitest";
import { fileParent, type Node, type Snapshot, TreeModel, type TreeView } from "../src/model.js";
import { fileQuestion, scopeQuestion } from "../src/questions.js";
import { contextValueOf, rowView } from "../src/rows.js";
import { makeItem } from "./fixtures.js";

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
const cs = (id: string): Changeset => ({ id, agent: "a", title: id, rationale: "", submittedAt: "", items: [], groups: [] });
const item = (id: string, file: string, changeset: string, start: number, extra: Partial<Item> = {}): Item =>
  makeItem(id, { file, changeset, groups: [], range: { start, end: start + 1 }, ...extra });
const linked = (id: string, items: string[], extra: Partial<Group> = {}): Group => ({
  id,
  agent: "a",
  changeset: "C1",
  kind: "linked",
  title: id,
  rationale: null,
  source: "auto",
  items,
  state: "open",
  ...extra,
});

function snap(items: Item[], groups: Group[] = []): Snapshot {
  const rounds = [...new Set(items.map((i) => i.changeset))].map(cs);
  return { agents: [agent], changesets: rounds, groups, items, notes: [], syncNeeded: new Set(), uncommitted: [], unshared: false, missing: [] };
}

const byFile =
  (more: Record<string, number> = {}, roundsPerFile = 3): (() => TreeView) =>
  () => ({
    groupBy: "file",
    roundsPerFile,
    more: (_a, f) => more[f] ?? 0,
  });
const names = (nodes: Node[]) =>
  nodes.map((n) =>
    n.type === "file"
      ? `file:${n.file}`
      : n.type === "item"
        ? n.item.id
        : n.type === "older"
          ? `older:${n.rounds}/${n.changes}/${n.hidden}`
          : n.type === "changeset"
            ? n.changeset.id
            : n.type,
  );
const tree = (m: TreeModel) => {
  const [a] = m.children();
  return m.children(a).map((f) => [names([f])[0], names(m.children(f))]);
};

describe("the Review panel grouped by file", () => {
  const items = [
    item("2.1", "main.tex", "C2", 50),
    item("1.2", "main.tex", "C1", 10),
    item("1.1", "intro.tex", "C1", 5),
    item("1.3", "main.tex", "C1", 80, { status: "accepted" }),
  ];

  it("lists each agent's files by path, their changes in file order, rounds merged", () => {
    const m = new TreeModel(snap(items), "review", null, undefined, undefined, byFile());
    expect(tree(m)).toEqual([
      ["file:intro.tex", ["1.1"]],
      ["file:main.tex", ["1.2", "2.1"]],
    ]);
    // Under its file, a change knows its parent (to be revealed and selected).
    const [a] = m.children();
    const [, main] = m.children(a);
    expect(m.children(main)[0]).toMatchObject({ parent: fileParent("main.tex") });
  });

  it("by round stays as before", () => {
    const m = new TreeModel(snap(items), "review");
    const [a] = m.children();
    expect(names(m.children(a))).toEqual(["C2", "C1"]);
  });

  it("a file's row says what is open in it, and offers Accept all and Reject all", () => {
    const m = new TreeModel(snap(items), "review", null, undefined, undefined, byFile());
    const [a] = m.children();
    const [, main] = m.children(a);
    const row = rowView(main!, m, { history: false, unread: 0 });
    expect(row).toMatchObject({ label: "main.tex", description: "2 pending", contextValue: "file.live" });
    // Its changes say their line, round and group instead of the file.
    const change = rowView(m.children(main)[0]!, m, { history: false, unread: 0, place: { line: 4, found: true } });
    expect(change.description).toBe("line 4 · round 1");
  });
});

describe("History grouped by file: the latest rounds of each file", () => {
  // main.tex changed in five rounds, intro.tex in one.
  const items = [
    ...[1, 2, 3, 4, 5].map((r) => item(`${r}.1`, "main.tex", `C${r}`, 10, { status: "accepted" })),
    item("5.2", "main.tex", "C5", 5, { status: "rejected" }),
    item("1.2", "intro.tex", "C1", 0, { status: "accepted" }),
  ];

  it("shows a file's latest rounds, the latest first, and a row for the older ones", () => {
    const m = new TreeModel(snap(items), "history", null, undefined, undefined, byFile({}, 2));
    expect(tree(m)).toEqual([
      ["file:intro.tex", ["1.2"]],
      ["file:main.tex", ["5.2", "5.1", "4.1", "older:2/2/3"]],
    ]);
    const [a] = m.children();
    const older = m.children(m.children(a)[1]).at(-1)!;
    expect(rowView(older, m, { history: true, unread: 0 })).toMatchObject({
      label: "Show 2 older rounds",
      description: "2 changes · 3 older rounds in all",
      contextValue: "older",
    });
  });

  it("Show older rounds shows that file's next rounds; 0 shows them all", () => {
    expect(tree(new TreeModel(snap(items), "history", null, undefined, undefined, byFile({ "main.tex": 2 }, 2)))[1]).toEqual([
      "file:main.tex",
      ["5.2", "5.1", "4.1", "3.1", "2.1", "older:1/1/1"],
    ]);
    expect(tree(new TreeModel(snap(items), "history", null, undefined, undefined, byFile({}, 0)))[1]).toEqual([
      "file:main.tex",
      ["5.2", "5.1", "4.1", "3.1", "2.1", "1.1"],
    ]);
  });
});

describe("deciding all of a file's changes", () => {
  // In main.tex: 1.1 alone, 1.2 linked with 1.3 (also main.tex), 1.4 linked with 1.5 in refs.bib.
  const items = [
    item("1.1", "main.tex", "C1", 0),
    item("1.2", "main.tex", "C1", 10, { groups: ["G1"] }),
    item("1.3", "main.tex", "C1", 20, { groups: ["G1"] }),
    item("1.4", "main.tex", "C1", 30, { groups: ["G2"] }),
    item("1.5", "refs.bib", "C1", 0, { groups: ["G2"] }),
  ];
  const m = new TreeModel(snap(items, [linked("G1", ["1.2", "1.3"]), linked("G2", ["1.4", "1.5"])]), "review");

  it("tells the changes that stand alone from those linked with other files", () => {
    expect(m.standAlone(["1.1", "1.2", "1.3", "1.4"], "main.tex")).toEqual(["1.1", "1.2", "1.3"]);
    // A part of a linked group that lies in this file stands alone.
    const parted = new TreeModel(
      snap(items, [
        linked("G2", ["1.4", "1.5", "1.1"], {
          parts: [
            { title: "here", items: ["1.1"] },
            { title: "both", items: ["1.4", "1.5"] },
          ],
        }),
      ]),
      "review",
    );
    expect(parted.standAlone(["1.1", "1.4"], "main.tex")).toEqual(["1.1"]);
  });

  it("asks whether to take the linked changes along or to decide only those that stand alone", () => {
    const q = fileQuestion("Accept", { file: "main.tex", count: 4, alone: 3, outside: [{ id: "1.5", file: "refs.bib" }] })!;
    expect(q.message).toBe("Accept all changes in main.tex?");
    expect(q.detail).toBe(
      "1 of its 4 changes is linked with 1 change in refs.bib (1.5), which must be accepted with it. The other 3 can be accepted on their own.",
    );
    expect(q.choices).toEqual([
      { label: "Accept all 5, with those in refs.bib", take: "all" },
      { label: "Accept only the 3 without links elsewhere", take: "alone" },
    ]);
    // Nothing stands alone: no such choice.
    const none = fileQuestion("Reject", {
      file: "a.tex",
      count: 2,
      alone: 0,
      outside: [
        { id: "1.5", file: "b.tex" },
        { id: "1.6", file: "c.tex" },
      ],
    })!;
    expect(none.detail).toBe("All 2 of its changes are linked with 2 changes in b.tex, c.tex (1.5, 1.6), which must be rejected with them.");
    expect(none.choices.map((c) => c.take)).toEqual(["all"]);
    expect(none.choices[0]!.label).toBe("Reject all 4, with those in other files");
  });

  it("without links elsewhere it asks as for a round, and not for one change", () => {
    expect(fileQuestion("Accept", { file: "a.tex", count: 3, alone: 3, outside: [] })).toEqual({
      message: "Accept all 3 changes in a.tex?",
      choices: [{ label: "Accept all", take: "all" }],
    });
    expect(fileQuestion("Accept", { file: "a.tex", count: 1, alone: 1, outside: [] })).toBeNull();
  });
});

describe("deciding all of a group whose changes are linked with others outside it", () => {
  // In one round: G1 links 1.1 and 1.2; the related group G2 has 1.1 and 1.3.
  const items = [
    item("1.1", "main.tex", "C1", 0, { groups: ["G1", "G2"] }),
    item("1.2", "main.tex", "C1", 10, { groups: ["G1"] }),
    item("1.3", "main.tex", "C1", 20, { groups: ["G2"] }),
  ];
  const m = new TreeModel(
    snap(items, [linked("G1", ["1.1", "1.2"], { title: "Terms" }), linked("G2", ["1.1", "1.3"], { kind: "related", title: "Polish" })]),
    "review",
  );

  it("knows what comes along and what stands alone", () => {
    expect(m.linkedRest(["1.1", "1.3"]).map((i) => i.id)).toEqual(["1.2"]);
    const own = new Set(["1.1", "1.3"]);
    expect(m.standAloneIn(["1.1", "1.3"], (r) => own.has(r.id))).toEqual(["1.3"]);
  });

  it("asks whether to take them along, naming their group, or to decide only those that stand alone", () => {
    const q = scopeQuestion("Accept", { what: "of G2 “Polish”", count: 2, alone: 1, outside: [{ id: "1.2", where: "G1 “Terms”" }], elsewhere: "other groups" });
    expect(q.message).toBe("Accept all changes of G2 “Polish”?");
    expect(q.detail).toBe(
      "1 of its 2 changes is linked with 1 change in G1 “Terms” (1.2), which must be accepted with it. The other 1 can be accepted on its own.",
    );
    expect(q.choices).toEqual([
      { label: "Accept all 3, with those in G1 “Terms”", take: "all" },
      { label: "Accept only the 1 without links elsewhere", take: "alone" },
    ]);
    const two = scopeQuestion("Reject", {
      what: "of G2 “Polish”",
      count: 1,
      alone: 0,
      outside: [
        { id: "1.2", where: "G1 “Terms”" },
        { id: "1.5", where: "G4 “Moves”" },
      ],
      elsewhere: "other groups",
    });
    expect(two.choices).toEqual([{ label: "Reject all 3, with those in other groups", take: "all" }]);
  });
});

describe("menus of file rows", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
  const entries = pkg.contributes.menus["view/item/context"] as { command: string; when?: string; group?: string }[];
  const on = (value: string) =>
    entries
      .filter((e) => e.when?.startsWith("view == stet.review && viewItem =~ "))
      .filter((e) => new RegExp(e.when!.replace("view == stet.review && viewItem =~ ", "").slice(1, -1)).test(value))
      .map((e) => e.command);

  it("a file with open changes can be accepted, rejected and reviewed whole", () => {
    const m = new TreeModel(snap([item("1.1", "main.tex", "C1", 0)]), "review", null, undefined, undefined, byFile());
    const value = contextValueOf({ type: "file", agent, file: "main.tex" }, m);
    expect(value).toBe("file.live");
    expect(on(value)).toEqual(expect.arrayContaining(["stet.acceptGroup", "stet.rejectGroup", "stet.reviewFile"]));
    // Its buttons: the diff of the whole file (Review file), then Accept all and Reject all.
    const inline = entries
      .filter((e) => e.group?.startsWith("inline") && e.when?.startsWith("view == stet.review && viewItem =~ "))
      .filter((e) => new RegExp(e.when!.replace("view == stet.review && viewItem =~ ", "").slice(1, -1)).test(value))
      .sort((a, b) => a.group!.localeCompare(b.group!))
      .map((e) => e.command);
    expect(inline).toEqual(["stet.reviewFile", "stet.acceptGroup", "stet.rejectGroup"]);
    expect(on("file.done")).not.toContain("stet.reviewFile");
  });
});
