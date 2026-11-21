/** Edit & accept: the input box shows the change in the words around it. */
import { describe, expect, it } from "vitest";
import type { Item } from "@stet/core";
import { editedPart, editFrame } from "../src/model.js";

const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id, agent: "a", changeset: "C1", file: "main.tex", kind: "modify", baseCommit: "b", range: { start: 0, end: 1 },
  oldText: "old", newText: "new", context: { before: "", after: "" }, fingerprint: "", note: null, groups: ["G1"],
  status: "pending", resolution: null, supersedes: null, conflictsWith: [], history: [], thread: [], ...extra,
});

describe("Edit & accept in the input box shows where the change is (test report v0.16, D2)", () => {
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
