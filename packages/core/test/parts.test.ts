import { describe, expect, it } from "vitest";
import { parseWhere } from "../src/grouping.js";
import type { Item } from "../src/model.js";
import { settleParts } from "../src/parts.js";
import { edit, makeItem as item, PAPER, read, setup, write } from "./helpers.js";

const one = (...items: Item[]) => items.map((i) => ({ title: i.id, items: [i.id] }));
const ids = (parts: { items: string[] }[] | undefined) => parts?.map((p) => p.items);

describe("settleParts", () => {
  it("keeps independent parts", async () => {
    const a = item("\\label{a}", "\\label{b}");
    const r1 = item("\\ref{a}", "\\ref{b}");
    const c = item("\\cref{a}", "\\cref{b}");
    const { parts, notes } = await settleParts(one(a, r1, c), [a, r1, c]);
    expect(ids(parts)).toEqual([[a.id], [r1.id], [c.id]]);
    expect(notes).toEqual([]);
  });

  it("joins identical changes into one part", async () => {
    const a = item("\\label{a}", "\\label{b}");
    const r1 = item("\\ref{a}", "\\ref{b}");
    const r2 = item("\\ref{a}", " \\ref{b} ");
    const { parts, notes } = await settleParts(one(a, r1, r2), [a, r1, r2]);
    expect(ids(parts)).toEqual([[a.id], [r1.id, r2.id]]);
    expect(parts![1]!.title).toBe(`${r1.id} + ${r2.id}`);
    expect(notes.join()).toMatch(/same change/);
  });

  it("has no parts when only repeats of one change remain", async () => {
    const xs = [1, 2, 3].map(() => item("\\mathcal{A}", "\\mathsf{A}"));
    expect((await settleParts(one(...xs), xs)).parts).toBeUndefined();
  });

  it("joins a macro definition with its uses, but not a label with its references", async () => {
    const def = item("\\newcommand{\\foo}{x}", "\\newcommand{\\foo}[1]{x_#1}");
    const use = item("\\foo", "\\foo{1}");
    const other = item("is", "was");
    const { parts, notes } = await settleParts(one(def, use, other), [def, use, other]);
    expect(ids(parts)).toEqual([[def.id, use.id], [other.id]]);
    expect(notes.join()).toMatch(/defines \\foo, which .* uses/);
  });

  it("sees a definition on the changed line even when the change itself is only part of it", async () => {
    const def = item("1", "2", { context: { before: "\\newcommand{\\foo}[", after: "]{#1}\n" } });
    const use = item("\\foo{a}", "\\foo{a}{b}");
    expect((await settleParts(one(def, use), [def, use])).parts).toBeUndefined();
  });

  it("joins environments with their definitions", async () => {
    const def = item("\\newenvironment{claim}{}{}", "\\newenvironment{claim2}{}{}");
    const use = item("\\begin{claim}", "\\begin{claim2}");
    expect((await settleParts(one(def, use), [def, use])).parts).toBeUndefined();
  });

  it("keeps a package change with everything", async () => {
    const pkg = item("", "\\usepackage{amsmath}\n");
    const a = item("x", "y");
    const { parts, notes } = await settleParts(one(pkg, a), [pkg, a]);
    expect(parts).toBeUndefined();
    expect(notes.join()).toMatch(/package/);
  });

  it("joins parts whose braces only balance together", async () => {
    const open = item("a", "\\textbf{a");
    const close = item("b", "b}");
    const other = item("c", "d");
    const { parts } = await settleParts(one(open, close, other), [open, close, other]);
    expect(ids(parts)).toEqual([[open.id, close.id], [other.id]]);
  });

  it("joins parts that interfere and leaves decided parts alone", async () => {
    const a = item("a", "b");
    const b = item("c", "d");
    const c = item("e", "f", { status: "accepted" });
    const d = item("e", "f");
    const { parts } = await settleParts(one(a, b, c, d), [a, b, c, d], async (lists) => {
      // Accepting the part holding `a` blocks the one holding `b`.
      const ia = lists.findIndex((l) => l.some((x) => x.id === a.id));
      const ib = lists.findIndex((l) => l.some((x) => x.id === b.id));
      return [[ia, ib]];
    });
    // c is decided, so the identical d is not joined to it.
    expect(ids(parts)).toEqual([[a.id, b.id], [c.id], [d.id]]);
  });

  it("puts changes no part names into one more part", async () => {
    const a = item("a", "b");
    const b = item("c", "d");
    const c = item("e", "f");
    const { parts } = await settleParts([{ title: "A", items: [a.id] }], [a, b, c]);
    expect(parts).toEqual([
      { title: "A", items: [a.id] },
      { title: "Other changes", items: [b.id, c.id] },
    ]);
  });
});

const LONG = `\\documentclass{article}
\\begin{document}
\\section{Introduction}\\label{sec:intro}
We use $\\mathcal{A}$ for the adversary.

\\section{Model}
The adversary $\\mathcal{A}$ is efficient. See Section~\\ref{sec:intro}.

\\section{Proofs}
Assume $\\mathcal{A}$ wins. By Section~\\ref{sec:intro}, this is a contradiction.
\\end{document}
`;

describe("parts in review", () => {
  it("splits a label rename into parts that are accepted one at a time", async () => {
    const { stet, repo } = await setup({ "main.tex": LONG });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
    const r = await stet.submit("a", { title: "rename" });
    const g = r.groups[0]!;
    expect(g.kind).toBe("linked");
    // The label is one part; the two identical \ref changes are the other.
    expect(g.parts!.map((p) => p.items.length)).toEqual([1, 2]);
    expect(g.parts![1]!.title).toMatch(/\(2×\)$/);

    // A reference alone is still tied to the other identical reference.
    await expect(stet.accept([g.parts![1]!.items[0]!])).rejects.toThrow(/linked/);
    // The label part on its own is fine.
    await stet.acceptGroup(`${g.id}.1`);
    expect(read(repo, "main.tex")).toContain("\\label{sec:introduction}");
    expect(read(repo, "main.tex")).toContain("\\ref{sec:intro}");
    expect((await stet.listGroups())[0]!.state).toBe("open");

    // Rejecting the other part resolves the group; the agent hears that it was partly accepted.
    await stet.reject((await stet.groupTarget(`${g.id}.2`)).pending, { reason: "keep the old references for now" });
    expect((await stet.listGroups())[0]!.state).toBe("resolved");
    const fb = await stet.feedback("a");
    expect(fb.map((e) => e.type)).toContain("group_partial");
    expect(fb.map((e) => e.type)).not.toContain("group_broken");
  });

  it("keeps the agent's parts unless they repeat the same change", async () => {
    const { stet } = await setup({ "main.tex": LONG });
    const { worktree: wt } = await stet.newAgent("a");
    const notation = (t: string) => t.replaceAll("\\mathcal{A}", "\\mathsf{A}");
    const sections = [
      { title: "Introduction", where: ["main.tex:4"] },
      { title: "Model", where: ["main.tex:7"] },
      { title: "Proofs", where: ["main.tex:10"] },
    ];
    // One section per part, each repeating the notation change: identical changes stay linked.
    write(wt, "main.tex", notation(read(wt, "main.tex")));
    const r1 = await stet.submit("a", {
      title: "notation",
      groups: [{ kind: "linked", reason: "test of linked groups", title: "Adversary in sans-serif", where: ["main.tex"], parts: sections }],
    });
    const g1 = r1.groups.find((x) => x.kind === "linked")!;
    expect(g1.items).toHaveLength(3);
    expect(g1.parts).toBeUndefined();
    expect(r1.warnings.join("\n")).toMatch(/same change/);
    await stet.acceptGroup(g1.id);

    // Different wording per section: the parts stay.
    await stet.sync("a");
    let t = read(wt, "main.tex");
    t = t.replace("for the adversary", "for an adversary");
    t = t.replace("is efficient", "runs in polynomial time");
    t = t.replace("this is a contradiction", "we reach a contradiction");
    write(wt, "main.tex", t);
    const r2 = await stet.submit("a", {
      title: "wording",
      groups: [{ kind: "linked", reason: "test of linked groups", title: "Wording", where: ["main.tex"], parts: sections }],
    });
    const g2 = r2.groups.find((x) => x.kind === "linked")!;
    expect(g2.parts?.map((p) => p.title)).toEqual(["Introduction", "Model", "Proofs"]);
    expect(r2.warnings).toEqual([]);
  });

  it("groups submitted items with parts through stet_group", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    edit(wt, "main.tex", "the approach works", "the method works");
    const r = await stet.submit("a", { title: "wording" });
    const [x, y, z] = r.items.map((i) => i.id);
    await expect(stet.group("a", [x!, y!], "related", "t", undefined, [{ title: "one", items: [x!] }])).rejects.toThrow(/Only linked/);
    const { group: g } = await stet.group(
      "a",
      [x!, y!, z!],
      "linked",
      "Wording",
      undefined,
      [
        { title: "Intro", items: [x!] },
        { title: "Rest", items: [y!, z!] },
      ],
      "test of linked groups",
    );
    expect(g!.parts).toEqual([
      { title: "Intro", items: [x] },
      { title: "Rest", items: [y, z] },
    ]);
    await expect(stet.reject([y!])).rejects.toThrow(/linked with/);
    await stet.acceptGroup(`${g!.id}.2`);
    expect(read(repo, "main.tex")).toContain("the method works");
    expect(read(repo, "main.tex")).toContain("the problem of reviewing");
    await stet.acceptGroup(`${g!.id}.1`);
    expect((await stet.listGroups()).find((x) => x.id === g!.id)!.state).toBe("resolved");
    expect((await stet.feedback("a")).map((e) => e.type)).not.toContain("group_partial");
  });
});

describe("parts within one line (bug report 2026-11-19)", () => {
  const LINE =
    "We define the \\emph{review base} as the text agents see, and the \\emph{proposal} as what one agent changes in its own copy before it submits.";
  const DOC = `\\documentclass{article}\n\\begin{document}\n${LINE}\n\\end{document}\n`;

  it("reads locations with a snippet", () => {
    expect(parseWhere('main.tex:12 "sug gestion"')).toEqual({ file: "main.tex", from: 12, to: 12, text: "sug gestion" });
    expect(parseWhere('main.tex:3-5 "say \\"hi\\""')).toEqual({ file: "main.tex", from: 3, to: 5, text: 'say "hi"' });
    expect(parseWhere('./sec/a.tex "x"')).toEqual({ file: "sec/a.tex", text: "x" });
    expect(parseWhere("main.tex:7")).toEqual({ file: "main.tex", from: 7, to: 7 });
  });

  it("keeps changes on one paragraph line in separate parts when the agent names them by snippet", async () => {
    const { stet } = await setup({ "main.tex": DOC });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "review base", "shared base");
    edit(wt, "main.tex", "proposal", "suggestion");
    const r = await stet.submit("a", {
      title: "terms",
      groups: [
        {
          kind: "linked",
          reason: "test of linked groups",
          title: "terms",
          where: ["main.tex:3"],
          parts: [
            { title: "base", where: ['main.tex:3 "shared"'] },
            { title: "proposal", where: ['main.tex:3 "suggestion"'] },
          ],
        },
      ],
    });
    expect(r.warnings).toEqual([]);
    const g = r.groups.find((x) => x.kind === "linked")!;
    expect(g.parts!.map((p) => p.items)).toEqual([[r.items[0]!.id], [r.items[1]!.id]]);
    // Each part is accepted on its own, the other one still applies.
    await stet.accept([r.items[1]!.id]);
    await stet.accept([r.items[0]!.id]);
  });

  it("warns when a snippet matches no change, and a snippet for a deletion looks at the old text", async () => {
    const { stet } = await setup({ "main.tex": DOC });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", " in its own copy", "");
    edit(wt, "main.tex", "proposal", "suggestion");
    const r = await stet.submit("a", {
      title: "t",
      groups: [
        {
          kind: "linked",
          reason: "test of linked groups",
          title: "t",
          where: ["main.tex:3"],
          parts: [
            { title: "cut", where: ['main.tex:3 "own copy"'] },
            { title: "word", where: ['main.tex:3 "nowhere"'] },
          ],
        },
      ],
    });
    expect(r.warnings).toContain(`'main.tex:3 "nowhere"' matched no change.`);
    const g = r.groups.find((x) => x.kind === "linked")!;
    expect(g.parts!.some((p) => p.title === "cut" && p.items.length === 1)).toBe(true);
  });
});
