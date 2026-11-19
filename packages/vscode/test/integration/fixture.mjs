// Builds a Stet project with one agent and two pending proposals, for the VS Code integration test.
// Usage: node fixture.mjs <dir>   (prints the project path)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Stet } from "@stet/core";

const root = process.argv[2];
const repo = join(root, "paper");
mkdirSync(repo, { recursive: true });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
git(repo, "init", "-q", "-b", "master");
git(repo, "config", "user.name", "Test User");
git(repo, "config", "user.email", "test@example.com");
git(repo, "config", "core.autocrlf", "false");
writeFileSync(
  join(repo, "main.tex"),
  `\\documentclass{article}
\\begin{document}
\\section{Introduction}\\label{sec:intro}
In this work we study the problem of reviewing changes. The changes are proposed by an AI.

We show that this approach is effective in practice. It scales to large documents.
\\end{document}
`,
);
// A formula: one item for review, but only the changed parts should be marked.
writeFileSync(join(repo, "math.tex"), String.raw`\begin{align}
  f(x) &= \sum_{i=1}^{n} a_i x^i + b
\end{align}
`);
// One long paragraph line: a long proposal in it must wrap across screen lines.
writeFileSync(
  join(repo, "wrap.tex"),
  "This paragraph is one long line of text, as LaTeX paragraphs often are when an editor wraps them only on screen, and it goes on for a while so that it needs several lines. It ends here.\n",
);
git(repo, "add", "-A");
git(repo, "commit", "-qm", "init");

// No `cli` recorded: the extension must install and record its bundled one.
const stet = await Stet.init(repo);
const agent = await stet.newAgent("claude-1", { kind: "claude-code" });
const f = join(agent.worktree, "main.tex");
writeFileSync(f, readFileSync(f, "utf8").replace("the problem of reviewing", "the task of reviewing").replace("effective in practice", "effective in real use"));
const m = join(agent.worktree, "math.tex");
writeFileSync(m, readFileSync(m, "utf8").replace("x^i + b", "x^{i+1} - b"));
const w = join(agent.worktree, "wrap.tex");
writeFileSync(w, readFileSync(w, "utf8").replace("several lines.", "several lines. The agent adds a long sentence right here, which is much longer than the forty-three characters VS Code shows of an inline hint by default, so that it has to wrap over two or three screen lines to be read at all."));
const r = await stet.submit("claude-1", { title: "Polish wording", rationale: "Clearer terms." });
console.log(JSON.stringify({ repo, worktree: agent.worktree, items: r.items.map((i) => i.id) }));
