import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach } from "vitest";
import { PROFILES } from "../src/lang/index.js";
import { Stet } from "../src/service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

/** A new folder outside every test project, removed after the test: for links that point out of the project. */
export function outsideDir(): string {
  const d = mkdtempSync(join(tmpdir(), "stet-outside-"));
  dirs.push(d);
  return d;
}

/** A directory link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
export function dirLink(target: string, path: string) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

export function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** Replace text in a file, failing loudly if the text isn't there. */
export function edit(root: string, path: string, from: string, to: string) {
  const s = read(root, path);
  if (!s.includes(from)) throw new Error(`'${from}' not found in ${path}`);
  write(root, path, s.replace(from, to));
}

/** A fresh repository with one commit on `master` and Stet initialized. */
export async function setup(files: Record<string, string>, opts: { cli?: { command: string; args: string[] } } = {}): Promise<{ stet: Stet; repo: string }> {
  const root = mkdtempSync(join(tmpdir(), "stet-test-"));
  dirs.push(root);
  const repo = join(root, "paper");
  mkdirSync(repo);
  // Few git calls, and none blocking: tests that build many repositories run them side by side.
  const run = (...args: string[]) => promisify(execFile)("git", args, { cwd: repo, windowsHide: true });
  await run("init", "-q", "-b", "master");
  appendFileSync(join(repo, ".git", "config"), "[user]\n\tname = Test User\n\temail = test@example.com\n[core]\n\tautocrlf = false\n");
  for (const [p, c] of Object.entries(files)) write(repo, p, c);
  await run("add", "-A");
  await run("commit", "-qm", "init");
  const stet = await Stet.init(repo, opts.cli ? { cli: opts.cli } : {});
  return { stet, repo };
}

/** Run git expecting failure; returns stderr. */
export function gitFails(cwd: string, ...args: string[]): string {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    return String(e.stderr ?? e.message);
  }
  throw new Error(`git ${args.join(" ")} unexpectedly succeeded`);
}

/** Path of the built CLI (tests that spawn it are skipped when it isn't built). */
export const CLI_DIST = join(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/index.js");

export const PAPER = `\\documentclass{article}
\\begin{document}
\\section{Introduction}\\label{sec:intro}
In this work we study the problem of reviewing changes. The changes are proposed by an AI.

We show that this approach is effective in practice. It scales to large documents.

As shown in Section~\\ref{sec:intro}, the approach works. The formula $a+b=c$ holds.
\\end{document}
`;

/**
 * The document languages prose tests run in: the same scenarios, written in each language.
 * Typst's runs are skipped until its profile is registered (typst.test.ts specifies it).
 */
export interface DocLang {
  name: string;
  /** The main file, and the extension of others. */
  file: string;
  ext: string;
  available: boolean;
  /** What comes before the first heading (`beginLines` lines), and after the last line. */
  begin: string;
  beginLines: number;
  end: string;
  heading(title: string): string;
  /** A maths shorthand `name` for θ̂: its definition, and a use in inline maths. */
  def(name: string): string;
  use(name: string): string;
  /** Opening and closing lines of a block around paragraphs, which must go together. */
  wrap: [string, string];
  geq: string;
  /** A theorem-like block, a sentence referring to it, and what a move's title calls the block. */
  theorem: string;
  refersToTheorem: string;
  theoremKind: string;
}

export const LATEX_DOC: DocLang = {
  name: "LaTeX",
  file: "main.tex",
  ext: "tex",
  available: true,
  begin: "\\documentclass{article}\n\\begin{document}\n",
  beginLines: 2,
  end: "\\end{document}\n",
  heading: (t) => `\\section{${t}}`,
  def: (name) => `\\newcommand{\\${name}}{\\hat\\theta}`,
  use: (name) => `$\\${name}$`,
  wrap: ["\\begin{proof}", "\\end{proof}"],
  geq: "\\geq",
  theorem: "\\begin{theorem}[Master theorem]\nThe randomized algorithm runs in time $T$.\\footnote{The bound is tight.} It uses space $S$.\n\\end{theorem}",
  refersToTheorem: "The algorithm of \\cref{thm:master} is simple. It has three steps.",
  theoremKind: "theorem environment",
};

export const TYPST_DOC: DocLang = {
  name: "Typst",
  file: "main.typ",
  ext: "typ",
  available: PROFILES.some((p) => p.id === "typst"),
  begin: "",
  beginLines: 0,
  end: "",
  heading: (t) => `= ${t}`,
  def: (name) => `#let ${name} = $hat(theta)$`,
  use: (name) => `$${name}$`,
  wrap: ["#block[", "]"],
  geq: ">=",
  theorem:
    '#figure(kind: "theorem", supplement: [Theorem], caption: [Master theorem])[\n  The randomized algorithm runs in time $T$.#footnote[The bound is tight.] It uses space $S$.\n] <thm:master>',
  refersToTheorem: "The algorithm of @thm:master is simple. It has three steps.",
  theoremKind: "figure",
};

export const DOC_LANGS: DocLang[] = [LATEX_DOC, TYPST_DOC];

/** A stand-in for the stet command, for the workspace files that name it. */
export const FAKE_CLI = { command: process.execPath, args: ["/opt/stet/cli.js"] };

/** PAPER with a label referred to twice. */
export const LABELLED = PAPER.replace("The formula $a+b=c$ holds.", "The formula $a+b=c$ holds, see Section~\\ref{sec:intro}.");

/** The agent renames sec:intro everywhere: one auto linked group with a part per change. */
export async function renamed() {
  const { stet, repo } = await setup({ "main.tex": LABELLED });
  const { worktree: wt } = await stet.newAgent("a");
  write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
  const r = await stet.submit("a", { title: "rename" });
  const g = r.groups.find((x) => x.kind === "linked" && /Rename label/.test(x.title))!;
  if (!g?.parts || g.parts.length < 2) throw new Error("expected a linked group with parts");
  const label = r.items.find((i) => i.newText.includes("\\label") || i.context.before.endsWith("\\label{"))!;
  return { stet, repo, wt, r, g, label, refs: r.items.filter((i) => i !== label) };
}
