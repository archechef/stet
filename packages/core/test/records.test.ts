/** Checks of records read from the store: what every Stet version wrote passes, damage is named. */
import { describe, expect, it } from "vitest";
import { recordProblem } from "../src/records.js";
import { makeItem } from "./helpers.js";

describe("recordProblem (code quality report 6a517ae, record validation)", () => {
  it("passes an item as Stet writes it, and one as the first version wrote it", () => {
    expect(recordProblem("items", makeItem("a", "b"))).toBeNull();
    // Fields added since (draft, shownText, move, headBlob, …) are optional.
    const { draft: _d, shownText: _s, move: _m, ...old } = makeItem("a", "b", { resolution: { appliedText: "b", edited: false, committed: null } });
    expect(recordProblem("items", old)).toBeNull();
  });

  it("names the first field that is missing or of the wrong type", () => {
    const it = makeItem("a", "b");
    const { fingerprint: _f, ...noPrint } = it;
    expect(recordProblem("items", noPrint)).toBe("fingerprint: missing");
    expect(recordProblem("items", { ...it, status: "done" })).toMatch(/^status: not one of pending, /);
    expect(recordProblem("items", { ...it, history: [{ at: "x", status: "pending", by: "robot" }] })).toBe("history[0].by: not one of user, agent, stet");
    expect(recordProblem("items", { ...it, resolution: { appliedText: "b", edited: "no", committed: null } })).toBe("resolution.edited: not true or false");
    expect(recordProblem("items", { ...it, draft: 3 })).toBe("draft: not text");
    expect(recordProblem("items", [])).toBe("record: not an object");
  });

  it("checks groups, agents, rounds and notes", () => {
    const group = { id: "G1", agent: "a", changeset: "C1", kind: "linked", title: "t", rationale: null, source: "agent", items: ["1.1"], state: "open" };
    expect(recordProblem("groups", group)).toBeNull();
    expect(recordProblem("groups", { ...group, parts: [{ title: "p", items: [1] }] })).toBe("parts[0].items[0]: not text");
    expect(recordProblem("changesets", { id: "C1", agent: "a", title: "t", rationale: "", submittedAt: "x", items: [], groups: [] })).toBeNull();
    expect(
      recordProblem("agents", {
        id: "a",
        kind: "codex",
        branch: "b",
        worktree: "w",
        baseCommit: "c",
        lastTip: "c",
        replayedAt: "",
        feedbackCursor: 0.5,
        createdAt: "x",
        state: "active",
      }),
    ).toBe("feedbackCursor: not a whole number");
    expect(recordProblem("notes", { id: "N1" })).toBe("agent: missing");
  });
});
