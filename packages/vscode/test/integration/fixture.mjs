// Builds a Stet project with one agent and pending proposals, for the VS Code integration test.
// Usage: node fixture.mjs <dir> [paper|proofs|latex-profile] [<it-latex-profile.mjs>]   (prints the project as JSON)
// - paper: a LaTeX paper with three proposals (suite.cjs).
// - proofs: a project in a language of an imported profile, with no LaTeX, Typst or Lean files (custom.cjs).
// - latex-profile: a LaTeX paper whose .tex files an imported profile takes, with LaTeX's preview backend bundled in (custom.cjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Stet } from "@stet/core";

const root = process.argv[2];
const kind = process.argv[3] ?? "paper";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const newRepo = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.name", "Test User");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "core.autocrlf", "false");
  return dir;
};

if (kind === "proofs") {
  const repo = newRepo("proofs");
  writeFileSync(join(repo, "main.prf"), "lemma one: a = a\n  by refl\n\nlemma two: b = b\n  by refl\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const profile = join(root, "proofs.mjs");
  writeFileSync(
    profile,
    `export const apiVersion = 1;
export default {
  id: "proofs", name: "Proofs", files: "proofs", defaultFiles: ["*.prf"], extensions: /\\.prf$/, fence: "prf", document: true,
  buildFiles: ["_out/"],
  agentTerms: { location: 'main.prf:1 "by refl"', linked: "a lemma and its uses", compiles: "a missing lemma is an error", reference: "a lemma with its uses", dependencies: "lemmas and their uses" },
};
`,
  );
  const stet = await Stet.init(repo);
  await stet.importProfile(profile, { use: true });
  const agent = await stet.newAgent("claude-1", { kind: "claude-code" });
  const f = join(agent.worktree, "main.prf");
  writeFileSync(
    f,
    readFileSync(f, "utf8")
      .replace("lemma two: b = b\n  by refl", "lemma two: b = b\n  by rfl")
      // A proposal longer than VS Code's 43 characters of inline text.
      .replace("lemma one: a = a\n  by refl", "lemma one: a = a\n  by simp only [first_long_lemma_name, second_long_lemma_name, third_one]"),
  );
  const r = await stet.submit("claude-1", { title: "Tidy proofs" });
  console.log(JSON.stringify({ kind, repo, worktree: agent.worktree, items: r.items.map((i) => i.id), file: "main.prf", language: "proofs" }));
  process.exit(0);
}

if (kind === "latex-profile") {
  const repo = newRepo("paper");
  writeFileSync(
    join(repo, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\nIn this work we study the problem of reviewing changes.\n\n" +
      "We show that this approach is effective in practice.\n\\end{document}\n",
  );
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  const stet = await Stet.init(repo);
  // The built-in LaTeX profile takes no files here: the imported one does.
  const configFile = join(stet.storeRoot, "config.json");
  const raw = JSON.parse(readFileSync(configFile, "utf8"));
  writeFileSync(configFile, JSON.stringify({ ...raw, files: { ...(raw.files ?? {}), tex: [] } }, null, 2));
  await stet.importProfile(process.argv[4], { use: true });
  const cfg = await stet.config();
  if (stet.profile(cfg, "main.tex").id !== "paper-latex" || cfg.language !== "paper-latex")
    throw new Error(`main.tex is ${stet.profile(cfg, "main.tex").id}, the language ${cfg.language}`);
  const agent = await stet.newAgent("claude-1", { kind: "claude-code" });
  const f = join(agent.worktree, "main.tex");
  writeFileSync(f, readFileSync(f, "utf8").replace("the problem of reviewing", "the task of reviewing"));
  const r = await stet.submit("claude-1", { title: "Wording" });
  console.log(JSON.stringify({ kind, repo, worktree: agent.worktree, items: r.items.map((i) => i.id), file: "main.tex", language: "paper-latex" }));
  process.exit(0);
}

const repo = newRepo("paper");
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
writeFileSync(
  join(repo, "math.tex"),
  String.raw`\begin{align}
  f(x) &= \sum_{i=1}^{n} a_i x^i + b
\end{align}
`,
);
// One long paragraph line: a long proposal in it must wrap across screen lines. Short lines after
// it fill the screen, so the rows the proposal takes push lines out of view (suite.cjs counts them).
writeFileSync(
  join(repo, "wrap.tex"),
  "This paragraph is one long line of text, as LaTeX paragraphs often are when an editor wraps them only on screen, and it goes on for a while so that it needs several lines. It ends here.\n" +
    Array.from({ length: 120 }, (_, i) => `\n% Line ${i + 1}.`).join("") +
    "\n",
);
git(repo, "add", "-A");
git(repo, "commit", "-qm", "init");

// No `cli` recorded: the extension must install and record its bundled one.
const stet = await Stet.init(repo);
const agent = await stet.newAgent("claude-1", { kind: "claude-code" });
const f = join(agent.worktree, "main.tex");
writeFileSync(
  f,
  readFileSync(f, "utf8").replace("the problem of reviewing", "the task of reviewing").replace("effective in practice", "effective in real use"),
);
const m = join(agent.worktree, "math.tex");
writeFileSync(m, readFileSync(m, "utf8").replace("x^i + b", "x^{i+1} - b"));
const w = join(agent.worktree, "wrap.tex");
writeFileSync(
  w,
  readFileSync(w, "utf8").replace(
    "several lines.",
    "several lines. The agent adds a long sentence right here, which is much longer than the forty-three characters VS Code shows of an inline hint by default, so that it has to wrap over two or three screen lines to be read at all.",
  ),
);
const r = await stet.submit("claude-1", { title: "Polish wording", rationale: "Clearer terms." });
console.log(JSON.stringify({ kind, repo, worktree: agent.worktree, items: r.items.map((i) => i.id) }));
