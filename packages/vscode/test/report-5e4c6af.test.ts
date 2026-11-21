/** Findings of the test and security reports on commit 5e4c6af (2026-11-21) that the extension's pure helpers decide. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Changeset, Group, Item } from "@stet/core";
import { acceptQuestion } from "../src/actions.js";
import { diffBlock, esc, fence, finishQuestion, linkTitle, manyQuestion, noLinks, shownAgentText, spokenRow, TreeModel, type Snapshot } from "../src/model.js";

const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id, agent: "a", changeset: "C1", file: "main.typ", kind: "modify", baseCommit: "b", range: { start: 0, end: 1 },
  oldText: "old", newText: "new", context: { before: "", after: "" }, fingerprint: "", note: null, groups: [],
  status: "pending", resolution: null, supersedes: null, conflictsWith: [], history: [], thread: [], ...extra,
});
const cs: Changeset = { id: "C1", agent: "a", title: "t", rationale: "", submittedAt: "", items: [], baseCommit: "b" } as unknown as Changeset;
const snap = (items: Item[], groups: Group[]): Snapshot => ({ agents: [], changesets: [cs], groups, items, notes: [], syncNeeded: new Set(), uncommitted: [], unshared: false, missing: [] });
const src = (f: string) => readFileSync(join(__dirname, "../src", f), "utf8");

describe("security report 5e4c6af", () => {
  it("S2: a link tooltip stays one line, its quotes escaped", () => {
    const t = linkTitle('G1 "x"\n\n[Reject…](command:stet.accept?%5B%5D) \\');
    expect(t).not.toMatch(/\n/);
    expect(t).toContain('\\"x\\"');
    expect(t.endsWith("\\\\")).toBe(true);
    // The hover's action row uses it.
    expect(src("editor.ts")).toContain("linkTitle(a.detail)");
  });

  it("S2, S3: escaped agent text can't open a fence, a link or a line of its own", () => {
    expect(esc("~~~")).toBe("\\~\\~\\~");
    expect(esc("[x](command:y)")).toBe("\\[x\\]\\(command\\:y\\)");
    expect(esc("a\rb")).toBe("a\nb");
  });

  it("S3: a lone CR in a change can't end Stet's diff fence", () => {
    const d = diffBlock("old", "new\r```\r[x](command:stet.accept)");
    const lines = d.split("\n");
    // Every line between the fences is a diff line.
    expect(lines.slice(1, -1).every((l) => l.startsWith("- ") || l.startsWith("+ "))).toBe(true);
    expect(fence("a‮b")).toContain("⟨U+202E⟩");
  });

  it("S4: agent text in a notification can't be a command link", () => {
    expect(noLinks("see [here](command:stet.accept)")).toBe("see [here] (command:stet.accept)");
  });

  it("S9: titles, rationales and replies are shown on one line where needed, with invisible characters marked", () => {
    const g: Group = { id: "G1", kind: "linked", title: "Fix\n\n[x](command:y)‮", rationale: null, source: "agent", items: ["1.1"], state: "open", parts: [{ title: "p\r1", items: ["1.1"] }] } as unknown as Group;
    const s = shownAgentText({ changesets: [{ ...cs, title: "A\nB" } as Changeset], groups: [g], items: [item("1.1", { thread: [{ author: "agent", text: "x​y", at: "" }] as any })], notes: [] });
    expect(s.changesets[0]!.title).toBe("A B");
    expect(s.groups[0]!.title).toBe("Fix [x] (command:y)⟨U+202E⟩");
    expect(s.groups[0]!.parts![0]!.title).toBe("p 1");
    expect(s.items[0]!.thread[0]!.text).toBe("x⟨U+200B⟩y");
    // The change's own text is left as it is.
    expect(s.items[0]!.newText).toBe("new");
  });
});

describe("test report 5e4c6af", () => {
  it("D2: multi-select Accept asks about the other parts of their linked groups", () => {
    const q = manyQuestion("Accept", 2, [], ["1.5"]);
    expect(q.title).toContain("1.5");
    expect(q.choices.map((c) => c.label)).toEqual(["Accept the 2 selected and all 1 other changes of their linked groups", "Accept only the 2 selected"]);
    expect(q.choices[0]!.withGroups).toBe(true);
    // Accepting only the selected keeps the group: no override.
    expect(q.choices[1]!.withRest).toBe(true);
    const g: Group = { id: "G1", kind: "linked", title: "Rename", rationale: null, source: "auto", items: ["1.1", "1.2"], state: "open", parts: [{ title: "a", items: ["1.1"] }, { title: "b", items: ["1.2"] }] } as unknown as Group;
    const m = new TreeModel(snap([item("1.1", { groups: ["G1"] }), item("1.2", { groups: ["G1"] }), item("1.3")], [g]));
    expect(m.linkedRest(["1.1", "1.3"])).toEqual([]);
    expect(m.otherParts(["1.1", "1.3"]).map((i) => i.id)).toEqual(["1.2"]);
    expect(acceptQuestion(m, m.item("1.1")!)).not.toBeNull();
  });

  it("D3: Escape in \"which one?\" decides nothing", () => {
    const e = src("extension.ts");
    expect(e).toContain("if (here === CANCELLED) return undefined;");
    expect(e).not.toContain("return (await this.atCursor()) ?? sel;");
  });

  it("B3, B8: no preview entries for changes without PDF previews", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf8"));
    const menus = Object.values(pkg.contributes.menus).flat() as { command: string; when?: string }[];
    for (const m of menus.filter((x) => x.command === "stet.preview" && x.when?.includes("viewItem"))) expect(m.when).toContain("\\.pdf/");
    for (const m of menus.filter((x) => x.command === "stet.previewSetup")) expect(m.when).toContain("stet.previews");
    expect(menus.find((x) => x.command === "stet.reopenNote" && x.when === "false")).toBeDefined();
  });

  it("multi-root: Finish review names the project", () => {
    expect(finishQuestion(2, ["main.typ"], [], [], "paper-typst").message).toBe("Commit 2 accepted changes in paper-typst?");
    expect(finishQuestion(1, ["main.typ"], [], []).message).toBe("Commit 1 accepted change?");
  });

  it("accessibility: rows are read out in words", () => {
    expect(spokenRow("G1 linked · 💬 3 (1 new) · ⚠ broken")).toBe("G1 linked, 3 messages (1 new), warning: broken");
  });
});
