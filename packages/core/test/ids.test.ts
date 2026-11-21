import { describe, expect, it } from "vitest";
import { compareItemIds, numberInRound } from "../src/model.js";
import { edit, PAPER, read, setup, write } from "./helpers.js";

const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} computes omega${i + 1} in every round.`).join("\n") + "\n";

describe("item ids: round.number", () => {
  it("numbers the changes of each submission within its round", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const first = await stet.submit("a", { title: "one" });
    expect(first.changeset.id).toBe("C1");
    expect(first.items.map((i) => i.id)).toEqual(["1.1", "1.2"]);
    edit(wt, "main.tex", "It scales to", "It even scales to");
    const second = await stet.submit("a", { title: "two" });
    expect(second.items.map((i) => i.id)).toEqual(["2.1"]);
    // Ids work everywhere an id is expected.
    expect((await stet.getItem("2.1"))?.newText).toContain("even");
    await stet.accept(["1.2"]);
    expect((await stet.getItem("1.2"))?.status).toBe("accepted");
  });

  it("gives a merged change the next free number of its round", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(wt, "main.tex", "The changes are proposed", "The edits are proposed");
    const { items } = await stet.submit("a", { title: "one" });
    expect(items.map((i) => i.id)).toEqual(["1.1", "1.2"]);
    const r = await stet.group("a", ["1.1", "1.2"], "atomic", "one sentence");
    expect(r.merged?.id).toBe("1.3");
  });

  it("sorts old and new ids", () => {
    expect(["12.10", "S7", "12.2", "3.1", "S12"].sort(compareItemIds)).toEqual(["S7", "S12", "3.1", "12.2", "12.10"]);
    expect(numberInRound("12.3")).toBe(3);
    expect(numberInRound("S12")).toBeNull();
  });
});

describe("ids in order (test report v0.16, UX)", () => {
  it("lists 1.2 before 1.10", async () => {
    const { stet } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    let t = read(wt, "main.tex");
    for (let i = 1; i <= 12; i++) t = t.replace(`omega${i} in every round`, `omega${i} in all rounds`);
    write(wt, "main.tex", t);
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(12);
    expect((await stet.listItems()).map((i) => i.id)).toEqual(Array.from({ length: 12 }, (_, i) => `1.${i + 1}`));
  });
});
