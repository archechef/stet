/** The command table: help from it, options checked per command, and runs in the test's own process. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { edit, outsideDir, PAPER, read, setup, write } from "../../core/test/helpers.js";
import { COMMANDS } from "../src/commands.js";
import { EXIT, help, main } from "../src/main.js";
import { GLOBAL_OPTIONS, OPTIONS } from "../src/options.js";
import { VERSION } from "../src/version.js";

/** Run `stet` in-process, collecting its output. */
async function stet(cwd: string, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { cwd, stdout: (s) => out.push(s), stderr: (s) => err.push(s), color: false, self: { command: "node", args: ["stet"] } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("the command table (code quality report 6a517ae, refactoring 5)", () => {
  it("is where the help comes from: every command, under its section", () => {
    const h = help();
    for (const c of COMMANDS) {
      expect(c.usage[0]).toMatch(new RegExp(`^stet ${c.name}\\b`));
      for (const u of c.usage) expect(h).toContain(`  ${u}`);
    }
    expect(h.indexOf("stet init")).toBeLessThan(h.indexOf("Review:"));
    expect(h.indexOf("stet submit")).toBeGreaterThan(h.indexOf("Agent side"));
  });

  it("lets each command take the options its help names", () => {
    for (const c of COMMANDS) {
      const named = c.usage.join(" ").match(/(?<![\w-])--[a-z][\w-]*/g) ?? [];
      for (const flag of named) expect([...GLOBAL_OPTIONS, ...c.options], `stet ${c.name} ${flag}`).toContain(flag.slice(2));
      for (const o of c.options) expect(OPTIONS).toHaveProperty(o);
    }
  });

  it("refuses an option of another command, an unknown option and an unknown command", async () => {
    const { repo } = await setup({ "main.tex": PAPER });
    const commit = await stet(repo, "review", "--commit");
    expect(commit.code).toBe(EXIT.usage);
    expect(commit.err).toBe("error: `stet review` has no option --commit. Run `stet --help`.");
    expect((await stet(repo, "status", "-t", "x")).err).toContain("`stet status` has no option --title");
    expect((await stet(repo, "--nope")).code).toBe(EXIT.usage);
    const unknown = await stet(repo, "frobnicate");
    expect(unknown.code).toBe(EXIT.unknown);
    expect(unknown.err).toContain("Unknown command 'frobnicate'");
    expect((await stet(repo, "--json", "frobnicate")).out).toBe(JSON.stringify({ error: "Unknown command 'frobnicate'. Run `stet --help`." }));
  });

  it("runs commands in the caller's process and folder, and refuses the reviewer's commands in an agent's workspace", async () => {
    const { stet: s, repo } = await setup({ "main.tex": PAPER });
    const { worktree } = await s.newAgent("a");
    edit(worktree, "main.tex", "the problem", "the task");
    expect((await stet(worktree, "submit", "-t", "Wording")).code).toBe(0);
    const review = await stet(repo, "review");
    expect(review.err).toBe("");
    expect(review.code).toBe(0);
    expect(review.out).toContain('1.1 pending main.tex:4  "problem" → "task"');
    const json = JSON.parse((await stet(repo, "show", "1.1", "--json")).out);
    expect(json.newText).toBe("task");
    const refused = await stet(worktree, "accept", "1.1");
    expect(refused.code).toBe(EXIT.error);
    expect(refused.err).toContain("is for the reviewer, and this is an agent's workspace");
    expect((await stet(worktree, "agent", "list")).code).toBe(0);
  });
});

describe("stet profile import", () => {
  it("installs a profile, makes it the project's language with --use, and ignores its build files on request", async () => {
    const dir = outsideDir();
    write(
      dir,
      "proofs.mjs",
      `export const apiVersion = 1;
export default {
  id: "proofs", name: "Proofs", files: "proofs", defaultFiles: ["*.prf"], extensions: /\\.prf$/, fence: "prf", document: true,
  buildFiles: ["_out/"],
  agentTerms: { location: 'main.prf:1 "step"', linked: "x", compiles: "x", reference: "x", dependencies: "x" },
};
`,
    );
    const { repo } = await setup({ "main.prf": "a\n" });
    const first = await stet(repo, "profile", "import", join(dir, "proofs.mjs"));
    expect(first.err).toBe("");
    expect(first.out).toContain("Installed the language profile 'proofs' (Proofs).");
    expect(first.out).toContain("--use");
    expect(first.out).toContain("Its build files git doesn't ignore yet: _out/ (add them with --ignore-build-files)");
    const used = await stet(repo, "profile", "import", join(dir, "proofs.mjs"), "--use", "--ignore-build-files");
    expect(used.out).toContain("It is the project's language");
    expect(used.out).toContain("Added to .gitignore: _out/");
    expect(read(repo, ".gitignore")).toContain("_out/\n");
    expect(JSON.parse((await stet(repo, "profile", "import", join(dir, "proofs.mjs"), "--json")).out)).toMatchObject({
      id: "proofs",
      language: "proofs",
      buildFiles: [],
    });
    expect((await stet(repo, "profile", "list")).code).toBe(EXIT.usage);
  });
});

describe("the version (code quality report 6a517ae)", () => {
  it("is the package's, in the file the release script sets", () => {
    const root = join(__dirname, "..", "..", "..");
    const pkg = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
    // scripts/release.mjs finds the version by these two lines; they must still point at VERSION.
    const release = readFileSync(join(root, "scripts", "release.mjs"), "utf8");
    const file = /const CLI_SRC = "([^"]+)";/.exec(release)?.[1];
    expect(file).toBeDefined();
    expect(/const VERSION = "([^"]+)";/.exec(readFileSync(join(root, file!), "utf8"))?.[1]).toBe(pkg.version);
  });
});
