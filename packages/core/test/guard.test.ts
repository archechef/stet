import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolUse, type GuardContext } from "../src/guard.js";

const root = resolve("/work");
const ctx: GuardContext = {
  worktree: join(root, "paper.stet", "a"),
  mainPath: join(root, "paper"),
  commonDir: join(root, "paper", ".git"),
};
const wt = ctx.worktree;
const bash = (command: string) => checkToolUse({ cwd: wt, tool_name: "Bash", tool_input: { command } }, ctx);
const edit = (file_path: string, tool = "Edit") => checkToolUse({ cwd: wt, tool_name: tool, tool_input: { file_path } }, ctx);

describe("guard: file tools", () => {
  it("allows edits inside the workspace", () => {
    expect(edit("main.tex")).toBeNull();
    expect(edit(join(wt, "sections", "intro.tex"), "Write")).toBeNull();
  });

  it("blocks edits in the user's project and elsewhere", () => {
    expect(edit(join(ctx.mainPath, "main.tex"))).toMatch(/outside your proposal workspace/);
    expect(edit("../../paper/main.tex")).toMatch(/outside/);
    expect(edit(join(root, "other", "x.tex"), "Write")).toMatch(/outside/);
  });

  it("blocks edits to Stet's own workspace files", () => {
    expect(edit(".claude/settings.json")).toMatch(/managed by Stet/);
    expect(edit("CLAUDE.local.md", "Write")).toMatch(/managed by Stet/);
  });

  it("checks every file of a MultiEdit", () => {
    const r = checkToolUse(
      { cwd: wt, tool_name: "MultiEdit", tool_input: { edits: [{ file_path: "a.tex" }, { file_path: join(ctx.mainPath, "b.tex") }] } },
      ctx,
    );
    expect(r).toMatch(/outside/);
  });
});

describe("guard: shell commands", () => {
  it("allows ordinary work", () => {
    for (const c of [
      "git status",
      "git diff",
      "git log --oneline",
      "latexmk -pdf main.tex",
      "git restore main.tex",
      "git checkout -- main.tex",
      "grep -n foo *.tex",
      "git branch --show-current",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("blocks git commands that bypass review", () => {
    for (const c of [
      "git push",
      "git push origin stet/a",
      "git merge stet/a",
      "git rebase master",
      "git switch master",
      "git checkout master",
      "git -c x=y merge foo",
      "git branch -f master HEAD",
      "git branch -D stet/b",
      "git worktree add ../x",
      "git update-ref refs/heads/master HEAD",
      "cd /tmp && git push",
    ])
      expect(bash(c), c).toMatch(/not allowed/);
  });

  it("blocks pointing git elsewhere", () => {
    expect(bash(`git -C "${ctx.mainPath}" commit -am x`)).toMatch(/another folder/);
    expect(bash("git --git-dir=../x/.git log")).toMatch(/not allowed/);
    expect(bash("STET_INTERNAL=1 git merge x")).toMatch(/not allowed/);
  });

  it("blocks writes into the user's project but allows reading it", () => {
    const main = ctx.mainPath.replace(/\\/g, "/");
    expect(bash(`echo hi > "${main}/main.tex"`)).toMatch(/project folder/);
    expect(bash(`cp main.tex "${main}/main.tex"`)).toMatch(/project folder/);
    expect(bash(`sed -i s/a/b/ ../../paper/main.tex`)).toMatch(/project folder/);
    expect(bash(`cat "${main}/main.tex"`)).toBeNull();
  });

  it("blocks shell commands that change Stet's own workspace files", () => {
    for (const c of [
      "sed -i '/hooks/d' .claude/settings.json",
      "python -c \"open('.claude/settings.json','w').write('{}')\"",
      "rm -rf .claude",
      "echo x > CLAUDE.local.md",
      "mv .mcp.json .mcp.json.bak",
    ])
      expect(bash(c), c).toMatch(/Stet manages/);
    expect(bash("cat .claude/settings.json")).toBeNull();
    expect(bash("grep -n hooks .claude/settings.json")).toBeNull();
  });

  it("blocks git config and remote changes (shared with the user's project), allows reading", () => {
    for (const c of [
      "git config core.fsmonitor 'echo pwned'",
      "git config --global alias.x push",
      "git config core.hooksPath hooks",
      "git -c core.HOOKSPATH=h commit -m x",
      "git -c alias.p=push p",
      "GIT_CONFIG_COUNT=1 git status",
      "git remote add evil https://example.com/x.git",
      "git remote set-url origin x",
      "git submodule add https://example.com/x.git",
    ])
      expect(bash(c), c).toMatch(/not allowed/);
    for (const c of [
      "git config --get user.name",
      "git config --list",
      "git config -l",
      "git config get user.email",
      "git remote -v",
      "git remote show origin",
    ])
      expect(bash(c), c).toBeNull();
  });

  it("treats the project's git dir as part of the project", () => {
    const hooks = join(ctx.commonDir, "hooks", "post-checkout").replace(/\\/g, "/");
    expect(bash(`echo evil > "${hooks}"`)).toMatch(/project folder/);
    expect(bash("cp evil.mjs ../../paper/.git/stet/bin/stet.mjs")).toMatch(/project folder/);
    expect(bash("echo {} > ../../paper/.git/stet/items/S1.json")).toMatch(/project folder/);
    expect(edit(join(ctx.commonDir, "config"), "Write")).toMatch(/git directory/);
    expect(bash("cat ../../paper/.git/config")).toBeNull();
  });

  it("protects the worktree's .git link", () => {
    expect(bash('echo "gitdir: ./evil" > .git')).toMatch(/Stet manages/);
    expect(edit(".git", "Write")).toMatch(/managed by Stet/);
    expect(bash("cat .git")).toBeNull();
    expect(edit(".gitignore")).toBeNull();
  });

  it.runIf(process.platform === "win32")("matches Stet's files case-insensitively on Windows", () => {
    expect(bash("echo {} > .CLAUDE/settings.json")).toMatch(/Stet manages/);
    expect(edit(".Claude/Settings.json", "Write")).toMatch(/managed by Stet/);
  });

  it("applies the same rules to PowerShell", () => {
    expect(checkToolUse({ cwd: wt, tool_name: "PowerShell", tool_input: { command: "git push" } }, ctx)).toMatch(/not allowed/);
  });

  it("ignores other tools", () => {
    expect(checkToolUse({ cwd: wt, tool_name: "Read", tool_input: { file_path: join(ctx.mainPath, "main.tex") } }, ctx)).toBeNull();
  });
});

describe("guard: path spellings", () => {
  // CI temp folders have two spellings (macOS /var → /private/var, Windows RUNNER~1); a link does the same here.
  it("compares real paths, so a linked spelling of the project is still the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "stet-guard-"));
    try {
      const home = join(dir, "real");
      mkdirSync(join(home, "paper", ".git"), { recursive: true });
      mkdirSync(join(home, "paper.stet", "a"), { recursive: true });
      const alias = join(dir, "alias");
      symlinkSync(home, alias, "junction");
      const c: GuardContext = { worktree: join(alias, "paper.stet", "a"), mainPath: join(alias, "paper"), commonDir: join(alias, "paper", ".git") };
      const e = (file_path: string) => checkToolUse({ cwd: c.worktree, tool_name: "Edit", tool_input: { file_path } }, c);
      expect(e(join(home, "paper", "main.tex"))).toMatch(/outside your proposal workspace/);
      expect(e(join(home, "paper", ".git", "config"))).toMatch(/git directory/);
      expect(e(join(home, "paper.stet", "a", "main.tex"))).toBeNull();
      expect(e("main.tex")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
