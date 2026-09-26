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
git(repo, "add", "-A");
git(repo, "commit", "-qm", "init");

// No `cli` recorded: the extension must install and record its bundled one.
const stet = await Stet.init(repo);
const agent = await stet.newAgent("claude-1", { kind: "claude-code" });
const f = join(agent.worktree, "main.tex");
writeFileSync(f, readFileSync(f, "utf8").replace("the problem of reviewing", "the task of reviewing").replace("effective in practice", "effective in real use"));
const r = await stet.submit("claude-1", { title: "Polish wording", rationale: "Clearer terms." });
console.log(JSON.stringify({ repo, worktree: agent.worktree, items: r.items.map((i) => i.id) }));
