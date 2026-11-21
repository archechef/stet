/** Findings of the test and security reports on commit 5e4c6af (2026-11-21). */
import { chmodSync, cpSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { autoGroups, joinTitles } from "../src/grouping.js";
import { LATEX, TYPST } from "../src/lang/index.js";
import { StetMcpServer } from "../src/mcp.js";
import type { Item } from "../src/model.js";
import { settleParts } from "../src/parts.js";
import { splitText } from "../src/split.js";
import { edit, PAPER, read, setup, write } from "./helpers.js";

const cfg = defaultConfig("main");
let n = 0;
function item(oldText: string, newText: string, extra: Partial<Item> = {}): Item {
  n++;
  return {
    id: `1.${n}`, agent: "a", changeset: "C1", file: "main.typ", kind: "modify", baseCommit: "x",
    range: { start: 0, end: oldText.length }, oldText, newText, context: { before: "", after: "" },
    fingerprint: String(n), note: null, groups: [], status: "pending", resolution: null, supersedes: null,
    conflictsWith: [], history: [], thread: [], ...extra,
  };
}
const apply = (old: string, edits: { start: number; end: number; newText: string }[]) => {
  let out = old;
  // From the end; insertions at one place in reverse order, so they come out in order.
  const order = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.i - a.i);
  for (const { e } of order) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
};

describe("security report 5e4c6af", () => {
  it.skipIf(process.platform === "win32")("S1: the MCP server never follows a workspace's redirected git link to a repository the agent made", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    // The agent copies the project's git dir into its workspace, adds a hook that leaves a marker,
    // and points its .git link at the copy, which looks like a complete Stet project.
    const evil = join(wt, "evil");
    cpSync(join(repo, ".git"), evil, { recursive: true });
    const marker = join(wt, "..", "s1-marker");
    writeFileSync(join(evil, "hooks", "reference-transaction"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(evil, "hooks", "reference-transaction"), 0o755);
    const name = readdirSync(join(evil, "worktrees"))[0]!;
    writeFileSync(join(wt, ".git"), `gitdir: ${join(evil, "worktrees", name)}\n`);
    const server = new StetMcpServer({ cwd: wt, workspace: wt, project: repo, agentId: "a", version: "test" });
    const r: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stet_status", arguments: {} } });
    expect(JSON.stringify(r)).toMatch(/refuses to run git/);
    expect(existsSync(marker)).toBe(false);
  });

  it("S13: agent titles reach commit messages on one line, without control characters", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const msg = await stet.commitMessage([], "Fix\u001b[2J it\nnow");
    expect(msg.subject).toBe("Fix⟨U+001B⟩[2J it now");
  });

  it("S17: parts that overlap list each change once", async () => {
    const a = item("is", "was");
    const b = item("an", "the");
    const { parts } = await settleParts([{ title: "x", items: [a.id, b.id] }, { title: "y", items: [b.id] }, { title: "z", items: [item("q", "r").id] }], [a, b]);
    expect(parts).toBeUndefined();
    const c = item("q", "r");
    const r = await settleParts([{ title: "x", items: [a.id, b.id] }, { title: "y", items: [b.id] }, { title: "z", items: [c.id] }], [a, b, c]);
    expect(r.parts?.map((p) => p.items)).toEqual([[a.id, b.id], [c.id]]);
  });
});

describe("test report 5e4c6af", () => {
  it("B5: undoing many accepted changes at once restores the file", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    edit(wt, "main.tex", "reviewing changes", "reviewing edits");
    const r = await stet.submit("a", { title: "t" });
    expect(r.items.length).toBeGreaterThan(1);
    await stet.accept(r.items.map((i) => i.id));
    const res = await stet.undoMany(r.items.map((i) => i.id));
    expect(res.reopened.map((i) => i.id).sort()).toEqual(r.items.map((i) => i.id).sort());
    expect(read(repo, "main.tex")).toBe(PAPER);
  });

  it("B7: deleting the last .bib entry leaves no blank line at the end", async () => {
    const BIB = "@article{lamport94,\n  title = {LaTeX},\n  year = {1994}\n}\n";
    const BIB2 = BIB + "\n@book{knuth84,\n  title = {The TeXbook},\n  year = {1984}\n}\n";
    const { stet, repo } = await setup({ "main.typ": "Text.\n", "refs.bib": BIB2 });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "refs.bib", BIB);
    const r = await stet.submit("a", { title: "t" });
    await stet.accept(r.items.map((i) => i.id));
    expect(read(repo, "refs.bib")).toBe(BIB);
  });

  it("B1: joined titles keep each title once", () => {
    expect(joinTitles("@intro → @start + See @intro", "See @intro + @intro → @start")).toBe("@intro → @start + See @intro");
    expect(joinTitles("a", "b + a + c")).toBe("a + b + c");
  });

  it("B2: Typst comments and strings in code are neither labels nor references", () => {
    const refs = TYPST.references!;
    const win = (it: Item, t: string) => it.context.before + t + it.context.after;
    const comment = item("// a note about <intro> and @intro", "// a note about <start> and @start");
    expect(refs.definitions(comment)[0]!.added).toEqual([]);
    expect(refs.uses("label", win(comment, comment.oldText), win(comment, comment.newText), cfg.grouping).added).toEqual([]);
    const str = item('#"see @intro"', '#"see @start"');
    expect(refs.uses("label", str.oldText, str.newText, cfg.grouping).added).toEqual([]);
    // Quotes in markup are text: a reference in them counts.
    const quoted = item('He said "see @intro".', 'He said "see @start".');
    expect(refs.uses("label", quoted.oldText, quoted.newText, cfg.grouping).added).toEqual(["start"]);
  });

  it("D1: in Typst a label rename and its references are one unit; in LaTeX a part each", () => {
    const def = item("<intro>", "<start>");
    const use = item("@intro", "@start");
    const g = autoGroups([def, use], cfg.grouping).find((x) => x.kind === "linked")!;
    expect(g.parts).toBeUndefined();
    const ldef = item("\\label{intro}", "\\label{start}", { file: "main.tex" });
    const luse = item("\\ref{intro}", "\\ref{start}", { file: "main.tex" });
    expect(autoGroups([ldef, luse], cfg.grouping).find((x) => x.kind === "linked")!.parts).toHaveLength(2);
  });

  it("D1: Typst parts never put a label and its references apart", async () => {
    const label = item("= Intro <intro>", "= Intro <start>");
    const ref = item("See @intro.", "See @start.");
    const other = item("is", "was");
    const { parts, notes } = await settleParts([{ title: "label", items: [label.id] }, { title: "ref", items: [ref.id] }, { title: "o", items: [other.id] }], [label, ref, other], undefined, { grouping: cfg.grouping });
    expect(parts?.map((p) => p.items)).toEqual([[label.id, ref.id], [other.id]]);
    expect(notes.join()).toMatch(/stops the build/);
  });

  it("D1: a partial accept of a Typst linked group says the document may not compile", async () => {
    const doc = "= Intro <intro>\nText.\n\nSee @intro.\n\nMore text here.\n";
    const { stet } = await setup({ "main.typ": doc });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", doc.replaceAll("intro", "start"));
    const r = await stet.submit("a", { title: "rename" });
    const g = r.groups.find((x) => x.kind === "linked")!;
    const res = await stet.accept([g.items[0]!], { overrideLinked: true });
    expect(res.warnings.join(" ")).toMatch(/may not compile/);
  });

  it("D4: a sentence added before a new heading is an insertion, not the old sentence replaced", () => {
    const cases: [typeof TYPST, string, string][] = [
      [TYPST, "The bound is tight.\n$ x <= y $\n", "The bound is tight. We now state it.\n= Statement\nHere it is:\n$ x <= y $\n"],
      [TYPST, "Some text here. The bound is tight.\n$ x <= y $\nMore.\n", "Some text here. The bound is tight. We now state it.\n= Statement\nHere it is:\n$ x <= y $\nMore.\n"],
      [TYPST, "The bound is tight.\n```py\nx=1\n```\n", "The bound is tight. We now state it.\n= Code\nHere it is:\n```py\nx=1\n```\n"],
      [LATEX, "The bound is tight.\n\\bibliography{refs}\n", "The bound is tight. We now state it.\n\\section{Statement}\nHere it is:\n\\bibliography{refs}\n"],
    ];
    for (const [p, o, nw] of cases) {
      const edits = splitText(p, o, nw, cfg.split);
      expect(apply(o, edits)).toBe(nw);
      // Nothing of the old text is taken out: each change only inserts.
      expect(edits.map((e) => e.oldText.trim()), JSON.stringify(edits)).toEqual(edits.map(() => ""));
      // And each alone leaves the old text whole, with no words run together.
      for (const e of edits) expect(apply(o, [e]), JSON.stringify(e)).not.toMatch(/\.[A-Z=\\]/);
    }
  });

  it("D7: a re-indented code block is one change, in Typst and LaTeX", () => {
    const o = "Text before.\n\n```python\ndef f(x):\n  if x:\n    return 1\n  return 2\n```\n\nAfter.\n";
    const nw = "Text before.\n\n```python\ndef f(x):\n    if x:\n        return 1\n    return 2\n```\n\nAfter.\n";
    expect(splitText(TYPST, o, nw, cfg.split)).toHaveLength(1);
    const v = (t: string) => t.replace("```python", "\\begin{verbatim}").replace("```\n\nAfter", "\\end{verbatim}\n\nAfter");
    expect(splitText(LATEX, v(o), v(nw), cfg.split)).toHaveLength(1);
  });

  it("D8: a citation key renamed next to a maths edit is a change of its own", () => {
    const o = "The damping is $alpha = 3 times 10^(-4)$ as measured in @chumak2015 for YIG films.\n";
    const nw = "The damping is $alpha = (3.1 plus.minus 0.2) times 10^(-4)$ as measured in @chumak2015magnon for YIG films.\n";
    expect(splitText(TYPST, o, nw, cfg.split).map((e) => e.newText)).toEqual(["$alpha = (3.1 plus.minus 0.2) times 10^(-4)$", "@chumak2015magnon"]);
  });

  it("D5: in Typst a new label and a new reference to it are linked", () => {
    const def = item("= Method", "= Method <sec:method>");
    const use = item("", "The method is in @sec:method.");
    const g = autoGroups([def, use], cfg.grouping).find((x) => x.kind === "linked");
    expect(g?.items.sort()).toEqual([def.id, use.id].sort());
    expect(g?.parts).toBeUndefined();
    // LaTeX: "??" until both are there, so nothing to link.
    const ldef = item("\\section{Method}", "\\section{Method}\\label{sec:method}", { file: "main.tex" });
    const luse = item("", "The method is in \\ref{sec:method}.", { file: "main.tex" });
    expect(autoGroups([ldef, luse], cfg.grouping).find((x) => x.kind === "linked")).toBeUndefined();
  });

  it("D5: a new reference is linked with a pending rename of its label from an earlier round", async () => {
    const doc = "= Intro <intro>\nText.\n\nSee @intro.\n\nMore text here.\n";
    const { stet } = await setup({ "main.typ": doc });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.typ", doc.replaceAll("intro", "start"));
    const r1 = await stet.submit("a", { title: "rename" });
    edit(wt, "main.typ", "More text here.", "More text here, as in @start.");
    const r2 = await stet.submit("a", { title: "use it" });
    const g = (await stet.listGroups()).find((x) => x.kind === "linked" && x.items.includes(r2.items[0]!.id));
    expect(g?.items).toEqual(expect.arrayContaining([...r1.items.map((i) => i.id), r2.items[0]!.id]));
  });

  it("D6: a new image read in by a relative path from a subfolder is grouped with the #image", async () => {
    const doc = '#include "chapters/one.typ"\n';
    const { stet } = await setup({ "main.typ": doc, "chapters/one.typ": "= One\nText.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "chapters/one.typ", "Text.", 'Text.\n#image("../figures/x.png")');
    write(wt, "figures/x.png", "PNG");
    const r = await stet.submit("a", { title: "figure" });
    const fig = r.items.find((i) => i.file === "figures/x.png")!;
    const use = r.items.find((i) => i.newText.includes("#image"))!;
    expect(r.groups.find((g) => g.kind === "linked")?.items.sort()).toEqual([fig.id, use.id].sort());
    expect(read(wt, "chapters/one.typ")).toContain("../figures/x.png");
  });
});
