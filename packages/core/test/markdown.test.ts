/**
 * The Markdown profile: word- and sentence-level changes in prose, code and maths kept as they
 * are, and headings, reference definitions, footnotes and files linked with what uses them.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { documentProfile, hasPreview, LATEX, languageCounts, MARKDOWN, PLAIN, profileByName, profileFor, profileRenderer } from "../src/lang/index.js";
import { anchorOf } from "../src/lang/markdown.js";
import { type Edit, splitText } from "../src/split.js";
import { edit, read, setup, write } from "./helpers.js";

const cfg = defaultConfig("main");
const split = cfg.split;
const strict = { ...split, ignoreReflow: false };
const pairs = (edits: Edit[]) => edits.map((e) => [e.oldText, e.newText]);
const s = (o: string, nw: string, c = split) => splitText(MARKDOWN, o, nw, c);
function apply(old: string, edits: Edit[]): string {
  let out = old;
  // Last first; pieces inserted at the same place, the later one first.
  const order = edits.map((e, k) => ({ e, k })).sort((a, b) => b.e.start - a.e.start || b.k - a.k);
  for (const { e } of order) out = out.slice(0, e.start) + e.newText + out.slice(e.end);
  return out;
}

const README = [
  "# Stet",
  "",
  "Stet lets you review changes that an AI proposes to your document. See [getting started](#getting-started) below.",
  "",
  "## Getting started",
  "",
  "Install it from the [marketplace][vsix] and open your project.[^1]",
  "",
  "![The review panel](images/panel.png)",
  "",
  "[vsix]: https://example.com/stet.vsix",
  "[^1]: Any folder in a git repository works.",
  "",
].join("\n");

describe("Markdown: files and projects", () => {
  it("a .md file gets the Markdown profile, by the config's patterns and by its name", () => {
    expect(cfg.files.md).toEqual(["*.md", "*.markdown"]);
    expect(profileFor("README.md", cfg.files)).toBe(MARKDOWN);
    expect(profileFor("docs/guide.markdown", cfg.files)).toBe(MARKDOWN);
    expect(profileFor("notes.txt", cfg.files)).toBe(PLAIN);
    expect(profileByName("docs/guide.md")).toBe(MARKDOWN);
    expect(MARKDOWN.fence).toBe("markdown");
  });

  it("a README doesn't make a LaTeX project a Markdown one; a project of Markdown alone is one", async () => {
    expect(languageCounts(["main.tex", "README.md", "CHANGELOG.md"], cfg.files)).toEqual({ latex: 1 });
    expect(languageCounts(["README.md", "docs/a.md"], cfg.files)).toEqual({ markdown: 2 });
    const latex = await setup({ "main.tex": "\\documentclass{article}\n", "README.md": "# Paper\n", "NOTES.md": "Notes.\n" });
    expect((await latex.stet.config()).language).toBe("latex");
    const md = await setup({ "README.md": README, "docs/guide.md": "# Guide\n" });
    expect((await md.stet.config()).language).toBe("markdown");
    expect(documentProfile(await md.stet.config())).toBe(MARKDOWN);
    const none = await setup({ "notes.txt": "Hello.\n" });
    expect(documentProfile(await none.stet.config())).toBe(LATEX);
  });

  it("agents of a Markdown project are told so, with Markdown examples", async () => {
    const { stet } = await setup({ "README.md": README }, { cli: { command: process.execPath, args: ["/opt/stet/cli.js"] } });
    const { worktree: wt } = await stet.newAgent("a");
    const t = read(wt, "CLAUDE.local.md");
    expect(t).toContain("for a Markdown project");
    expect(t).not.toContain("\\label");
    expect(t).toContain(MARKDOWN.agentTerms!.reference);
  });

  it("has no PDF previews; front ends render its changes themselves", async () => {
    expect(hasPreview("README.md")).toBe(false);
    expect(profileRenderer(MARKDOWN)).toBe("markdown");
    expect(profileRenderer(LATEX)).toBeNull();
    const { stet } = await setup({ "README.md": README });
    const env = await stet.previewStatus();
    expect(env.status).toBe("unavailable");
    expect(env.message).toMatch(/Markdown/);
  });
});

describe("Markdown: tokens", () => {
  const types = (t: string) => MARKDOWN.syntax!.tokenize(t).map((x) => `${x.type}:${x.text}`);

  it("splits words, emphasis and punctuation; keeps hyphens and apostrophes in words", () => {
    expect(types("A **bold** state-of-the-art isn't.")).toEqual([
      "word:A",
      "ws: ",
      "punct:*",
      "punct:*",
      "word:bold",
      "punct:*",
      "punct:*",
      "ws: ",
      "word:state-of-the-art",
      "ws: ",
      "word:isn't",
      "punct:.",
    ]);
  });

  it("headings, list markers, quotes, task boxes and table pipes are markup at the start of a line", () => {
    expect(types("## Title")).toEqual(["cmd:##", "ws: ", "word:Title"]);
    expect(types("- [x] done\n1. first")).toEqual(["cmd:-", "ws: ", "cmd:[x]", "ws: ", "word:done", "ws:\n", "cmd:1.", "ws: ", "word:first"]);
    expect(types("> quoted")).toEqual(["cmd:>", "ws: ", "word:quoted"]);
    expect(types("| a | b |\n|---|:-:|")).toEqual(["cmd:|", "ws: ", "word:a", "ws: ", "cmd:|", "ws: ", "word:b", "ws: ", "cmd:|", "ws:\n", "cmd:|---|:-:|"]);
    expect(types("a - b # c")).toEqual(["word:a", "ws: ", "punct:-", "ws: ", "word:b", "ws: ", "punct:#", "ws: ", "word:c"]);
  });

  it("a link's text is words in brackets; its target is one token", () => {
    expect(types('see [the docs](https://x.org/a_b "T") now')).toEqual([
      "word:see",
      "ws: ",
      "lbrace:[",
      "word:the",
      "ws: ",
      "word:docs",
      "rbrace:]",
      'cmd:(https://x.org/a_b "T")',
      "ws: ",
      "word:now",
    ]);
    expect(types("![a plot](fig.png)")).toEqual(["lbrace:![", "word:a", "ws: ", "word:plot", "rbrace:]", "cmd:(fig.png)"]);
    expect(types("[text][ref] and [^1]")).toEqual(["lbrace:[", "word:text", "rbrace:]", "cmd:[ref]", "ws: ", "word:and", "ws: ", "cmd:[^1]"]);
    // Not a link: brackets are punctuation.
    expect(types("[sic]")).toEqual(["punct:[", "word:sic", "punct:]"]);
    // A URL in a link's text stops at the text's end.
    expect(types("[https://x.org](https://x.org)")).toEqual(["lbrace:[", "cmd:https://x.org", "rbrace:]", "cmd:(https://x.org)"]);
  });

  it("URLs, autolinks, HTML tags and comments are one token each", () => {
    expect(types("at https://example.com/a?b=c.")).toEqual(["word:at", "ws: ", "cmd:https://example.com/a?b=c", "punct:."]);
    expect(types("<https://x.org> <br/> <!-- note -->")).toEqual(["cmd:<https://x.org>", "ws: ", "cmd:<br/>", "ws: ", "comment:<!-- note -->"]);
  });

  it("code spans and fenced code are words and punctuation only", () => {
    expect(types("run `npm *test*` now")).toEqual([
      "word:run",
      "ws: ",
      "punct:`",
      "word:npm",
      "ws: ",
      "punct:*",
      "word:test",
      "punct:*",
      "punct:`",
      "ws: ",
      "word:now",
    ]);
    expect(types("```js\n# [a](b)\n```")).toEqual([
      "cmd:```js",
      "ws:\n",
      "punct:#",
      "ws: ",
      "punct:[",
      "word:a",
      "punct:]",
      "punct:(",
      "word:b",
      "punct:)",
      "ws:\n",
      "cmd:```",
    ]);
  });

  it("maths: `$…$` and `$$…$$`, but not prices", () => {
    expect(types("$x^2$ and $$\\alpha$$")).toEqual([
      "math:$",
      "word:x",
      "punct:^",
      "word:2",
      "math:$",
      "ws: ",
      "word:and",
      "ws: ",
      "math:$$",
      "cmd:\\alpha",
      "math:$$",
    ]);
    expect(types("costs $5 or $10").filter((t) => t.startsWith("math"))).toEqual([]);
  });

  it("records offsets", () => {
    expect(MARKDOWN.syntax!.tokenize("ab  [cd](e)").map((x) => x.start)).toEqual([0, 2, 4, 5, 7, 8]);
  });
});

describe("Markdown: splitting a change into edits", () => {
  it("produces a word-level edit inside a sentence, and keeps sentences apart", () => {
    expect(pairs(s("We study the problem of reviewing changes.\n", "We study the task of reviewing changes.\n"))).toEqual([["problem", "task"]]);
    expect(pairs(s("The cat sat on the mat. The dog ran in the park.\n", "The cat lay on the mat. The dog ran in the garden.\n"))).toEqual([
      ["sat", "lay"],
      ["park", "garden"],
    ]);
  });

  it("a heading is a structure of its own; list items are units of their own", () => {
    expect(pairs(s("# Introduction\nSome text that stays the same here.\n", "# Overview\nSome text that stays the same here.\n"))).toEqual([
      ["Introduction", "Overview"],
    ]);
    expect(s("- first point here\n- second point here\n", "- first point there\n- second point there\n")).toHaveLength(2);
  });

  it("a link's target is a change of its own, apart from its text", () => {
    expect(pairs(s("Read [the guide](a.md) first.\n", "Read [the guide](b.md) first.\n"))).toEqual([["(a.md)", "(b.md)"]]);
    expect(pairs(s("Read [the old guide](a.md) first.\n", "Read [the new guide](a.md) first.\n"))).toEqual([["old", "new"]]);
  });

  it("takes maths whole", () => {
    expect(pairs(s("The formula $a + b = c$ holds.\n", "The formula $a + b = d$ holds.\n"))).toEqual([["$a + b = c$", "$a + b = d$"]]);
  });

  it("spaces in code are content; elsewhere reflow is ignored", () => {
    const raw = "Code:\n\n```\nx  =  1\n```\n";
    expect(s(raw, raw.replace("x  =  1", "x = 1")).length).toBeGreaterThan(0);
    expect(s("Inline `a  b` here.\n", "Inline `a b` here.\n").length).toBeGreaterThan(0);
    const old = "A sentence that is\nwrapped here and there.\n";
    const neu = "A sentence that is wrapped\nhere and there.\n";
    expect(s(old, neu)).toEqual([]);
    expect(s(old, neu, strict).length).toBeGreaterThan(0);
  });

  it("new paragraphs are a change each, but a code block with blank lines in it stays whole", () => {
    const old = "Intro.\n";
    const neu = "Intro.\n\nFirst new paragraph here.\n\n```python\ndef f():\n\n    return 1\n```\n\nSecond new paragraph here.\n";
    const edits = s(old, neu);
    expect(edits.map((e) => e.newText.trim())).toEqual(["First new paragraph here.", "```python\ndef f():\n\n    return 1\n```", "Second new paragraph here."]);
    expect(apply(old, edits)).toBe(neu);
  });

  it("reconstructs the new text exactly when edits are applied (strict mode)", () => {
    const neu = README.replace("review changes", "review the changes")
      .replace("(#getting-started)", "(#installation)")
      .replace("## Getting started", "## Installation")
      .replace("[^1]: Any folder", "[^1]: Every folder");
    expect(apply(README, s(README, neu, strict))).toBe(neu);
  });
});

describe("Markdown: anchors, references and files", () => {
  it("makes a heading's anchor as GitHub does", () => {
    expect(anchorOf("Getting started")).toBe("getting-started");
    expect(anchorOf("What's new in **v2.0**?")).toBe("whats-new-in-v20");
    expect(anchorOf("The `snake_case` [API](api.md)")).toBe("the-snake_case-api");
    expect(anchorOf("Über Größen")).toBe("über-größen");
  });

  it("links a renamed heading with the links to its anchor, here and in other files", async () => {
    const { stet, repo } = await setup({ "README.md": README, "docs/faq.md": "# FAQ\n\nStart with [the setup](../README.md#getting-started).\n" });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "README.md", "## Getting started", "## Installation");
    edit(wt, "README.md", "(#getting-started)", "(#installation)");
    edit(wt, "docs/faq.md", "README.md#getting-started", "README.md#installation");
    const r = await stet.submit("a", { title: "rename" });
    const g = r.groups.find((x) => x.kind === "linked")!;
    expect(g.title).toBe("Rename heading anchor #getting-started → #installation");
    expect(g.items).toHaveLength(3);
    await stet.accept(g.items);
    expect(read(repo, "README.md")).toBe(read(wt, "README.md"));
  });

  it("links a renamed reference definition and footnote with their uses", async () => {
    const { stet } = await setup({ "README.md": README });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "README.md", README.replaceAll("[vsix]", "[download]").replaceAll("[^1]", "[^folders]"));
    const r = await stet.submit("a", { title: "rekey" });
    const titles = r.groups.filter((x) => x.kind === "linked").map((g) => g.title);
    expect(titles).toContain("Rename link definition [vsix] → [download]");
    expect(titles).toContain("Rename footnote [^1] → [^folders]");
  });

  it("links a new image with the ![](…) that shows it", async () => {
    const { stet } = await setup({ "README.md": README });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "images/flow.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    edit(wt, "README.md", "open your project.", "open your project.\n\n![How a change flows](images/flow.svg)");
    const r = await stet.submit("a", { title: "figure" });
    const img = r.items.find((i) => i.file === "images/flow.svg")!;
    const use = r.items.find((i) => i.newText.includes("flow.svg"))!;
    expect(r.groups.some((g) => g.kind === "linked" && g.items.includes(img.id) && g.items.includes(use.id))).toBe(true);
  });

  it("headings and links in code are neither anchors nor uses", async () => {
    const doc = "# Setup\n\nText.\n\n```sh\n# Setup\necho '[x](#setup)'\n```\n";
    const { stet } = await setup({ "README.md": doc });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "README.md", "echo '[x](#setup)'", "echo '[x](#install)'");
    const r = await stet.submit("a", { title: "code" });
    expect(r.groups.filter((g) => g.kind === "linked")).toEqual([]);
  });
});
