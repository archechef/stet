/** Text an agent wrote, in hovers, notifications and the panel: escaped, on one line, invisible characters marked. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Changeset, Group, Item } from "@stet/core";
import { diffBlock, esc, fence, linkTitle, noLinks, shownAgentText } from "../src/model.js";

const typItem = (id: string, extra: Partial<Item> = {}): Item => ({
  id, agent: "a", changeset: "C1", file: "main.typ", kind: "modify", baseCommit: "b", range: { start: 0, end: 1 },
  oldText: "old", newText: "new", context: { before: "", after: "" }, fingerprint: "", note: null, groups: [],
  status: "pending", resolution: null, supersedes: null, conflictsWith: [], history: [], thread: [], ...extra,
});

const typCs: Changeset = { id: "C1", agent: "a", title: "t", rationale: "", submittedAt: "", items: [], baseCommit: "b" } as unknown as Changeset;
const src = (f: string) => readFileSync(join(__dirname, "../src", f), "utf8");

describe("escaping and invisible characters", () => {
  it("a link tooltip stays one line, its quotes escaped (security report 5e4c6af, S2)", () => {
    const t = linkTitle('G1 "x"\n\n[Reject…](command:stet.accept?%5B%5D) \\');
    expect(t).not.toMatch(/\n/);
    expect(t).toContain('\\"x\\"');
    expect(t.endsWith("\\\\")).toBe(true);
    // The hover's action row uses it.
    expect(src("editor.ts")).toContain("linkTitle(a.detail)");
  });

  it("escaped agent text can't open a fence, a link or a line of its own (security report 5e4c6af, S2, S3)", () => {
    expect(esc("~~~")).toBe("\\~\\~\\~");
    expect(esc("[x](command:y)")).toBe("\\[x\\]\\(command\\:y\\)");
    expect(esc("a\rb")).toBe("a\nb");
  });

  it("a lone CR in a change can't end Stet's diff fence (security report 5e4c6af, S3)", () => {
    const d = diffBlock("old", "new\r```\r[x](command:stet.accept)");
    const lines = d.split("\n");
    // Every line between the fences is a diff line.
    expect(lines.slice(1, -1).every((l) => l.startsWith("- ") || l.startsWith("+ "))).toBe(true);
    expect(fence("a‮b")).toContain("⟨U+202E⟩");
  });

  it("agent text in a notification can't be a command link (security report 5e4c6af, S4)", () => {
    expect(noLinks("see [here](command:stet.accept)")).toBe("see [here] (command:stet.accept)");
  });

  it("titles, rationales and replies are shown on one line where needed, with invisible characters marked (security report 5e4c6af, S9)", () => {
    const g: Group = { id: "G1", kind: "linked", title: "Fix\n\n[x](command:y)‮", rationale: null, source: "agent", items: ["1.1"], state: "open", parts: [{ title: "p\r1", items: ["1.1"] }] } as unknown as Group;
    const s = shownAgentText({ changesets: [{ ...typCs, title: "A\nB" } as Changeset], groups: [g], items: [typItem("1.1", { thread: [{ author: "agent", text: "x​y", at: "" }] as any })], notes: [] });
    expect(s.changesets[0]!.title).toBe("A B");
    expect(s.groups[0]!.title).toBe("Fix [x] (command:y)⟨U+202E⟩");
    expect(s.groups[0]!.parts![0]!.title).toBe("p 1");
    expect(s.items[0]!.thread[0]!.text).toBe("x⟨U+200B⟩y");
    // The change's own text is left as it is.
    expect(s.items[0]!.newText).toBe("new");
  });
});
