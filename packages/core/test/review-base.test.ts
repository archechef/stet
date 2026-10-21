import { describe, expect, it } from "vitest";
import { insideNewText } from "../src/anchor.js";
import { edit, git, read, setup } from "./helpers.js";

// Bug report 2026-10-21: accepted items whose new text contains their old text (pk → \pk,
// H → \Hash) were applied a second time when building the review base: \\pk, \\Hashash.
const PAPER = String.raw`\documentclass{article}
\begin{document}
\begin{pcvstack}
\procedure{Game}{
  b \gets \A^{\Osign,\ket{H}}(pk_1,\dots,pk_n) \\
  (pk_i,sk_i) \gets \mathsf{KGen}() \\
  \mathsf{Commit}(sk_i)
}
\end{pcvstack}
\end{document}
`;

/** A macro applied twice: \\pk, \\sk, \\Hash, or \Hashash. */
const DOUBLED = /\\\\(pk|sk|Hash)|Hashash/;

async function acceptAll(stet: Awaited<ReturnType<typeof setup>>["stet"], agent: string) {
  const items = await stet.listItems({ agent, status: ["pending"] });
  await stet.accept(items.map((i) => i.id), { overrideLinked: true });
  return items;
}

describe("review base: accepted changes are applied exactly once", () => {
  async function scenario() {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", String.raw`\ket{H}}(pk_1,\dots,pk_n)`, String.raw`\ket{\Hash}}(\pk_1,\dots,\pk_n)`);
    edit(wt, "main.tex", String.raw`(pk_i,sk_i) \gets`, String.raw`(\pk_i,\sk_i) \gets`);
    edit(wt, "main.tex", String.raw`\mathsf{Commit}(sk_i)`, String.raw`\mathsf{Commit}(\sk_i)`);
    await stet.submit("a", { title: "macros" });
    const items = await acceptAll(stet, "a");
    // Token-level items, as in the report (outside $…$, so not whole math).
    expect(items.map((i) => i.oldText).sort()).toEqual(["H", "pk", "pk", "pk", "sk", "sk"]);
    const expected = read(repo, "main.tex");
    expect(expected).not.toMatch(DOUBLED);
    expect(expected).toContain(String.raw`\ket{\Hash}}(\pk_1,\dots,\pk_n)`);
    return { stet, repo, wt, expected };
  }

  it("with shared edits (the reported case): sync twice, the workspace equals the document", async () => {
    const { stet, wt, expected } = await scenario();
    await stet.shareEdits();
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(expected);
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(expected);
  });

  it("without shared edits (HEAD + accepted items)", async () => {
    const { stet, wt, expected } = await scenario();
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(expected);
  });

  it("after the user commits the accepted changes with git instead of Finish review", async () => {
    const { stet, repo, wt, expected } = await scenario();
    git(repo, "commit", "-qam", "accepted by hand");
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(expected);
    // The items count as committed now: Finish review has nothing left to do.
    expect((await stet.commitAcceptedItems()).commit).toBeNull();
  });

  it("with saved edits shared automatically, plus an own edit", async () => {
    const { stet, repo, wt, expected } = await scenario();
    await stet.setShareEdits("saved");
    edit(repo, "main.tex", "KGen", "KeyGen");
    await stet.sync("a");
    expect(read(wt, "main.tex")).toBe(expected.replace("KGen", "KeyGen"));
  });
});

describe("pending changes that are already in the text", () => {
  it("accepting pk → \pk where the text already reads \pk does not double the macro", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", String.raw`(pk_i,sk_i) \gets`, String.raw`(\pk_i,sk_i) \gets`);
    const { items } = await stet.submit("a", { title: "macro" });
    // The user made the same change by hand in the meantime.
    edit(repo, "main.tex", String.raw`(pk_i,sk_i) \gets`, String.raw`(\pk_i,sk_i) \gets`);
    const r = await stet.accept([items[0]!.id]).catch((e) => e);
    expect(read(repo, "main.tex")).not.toMatch(DOUBLED);
    expect(read(repo, "main.tex")).toContain(String.raw`(\pk_i,sk_i) \gets`);
    // Refused with an explanation rather than applied a second time.
    expect(r).toBeInstanceOf(Error);
    expect(r.message).toMatch(/could not be applied/);
  });
});

describe("insideNewText", () => {
  const span = (start: number, len: number) => ({ start, end: start + len });
  it("recognises old text that is part of the applied new text", () => {
    expect(insideNewText("pk", String.raw`\pk`, String.raw`(\pk_i)`, span(2, 2))).toBe(true);
    expect(insideNewText("H", String.raw`\Hash`, String.raw`\ket{\Hash}`, span(6, 1))).toBe(true);
    expect(insideNewText("ab", "abab", "xxabab", span(4, 2))).toBe(true); // second occurrence
  });
  it("leaves old text alone that isn't part of the new text", () => {
    expect(insideNewText("pk", String.raw`\pk`, "(pk_i)", span(1, 2))).toBe(false);
    expect(insideNewText(String.raw`\pk`, "pk", "(pk_i)", span(1, 2))).toBe(false); // new text shorter
    expect(insideNewText("pk", "pk", "(pk_i)", span(1, 2))).toBe(false); // same text
  });
  it("handles pure insertions", () => {
    expect(insideNewText("", String.raw`\,`, String.raw`a\,b`, span(1, 0))).toBe(true);
    expect(insideNewText("", String.raw`\,`, "ab", span(1, 0))).toBe(false);
  });
});
