/** Setting up a project: git hooks, stet doctor, git identity, and the project's language. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { doctor } from "../src/doctor.js";
import { hookStatus, uninstallHooks } from "../src/hooks.js";
import { detectLanguage, languageCounts } from "../src/lang/index.js";
import { CLI_DIST, edit, git, gitFails, PAPER, read, setup } from "./helpers.js";

async function reinit(path: string) {
  const { Stet } = await import("../src/service.js");
  await Stet.init(path);
}

describe("git hooks in the project", () => {
  it("block agent branches from bypassing review", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    expect((await hookStatus(stet.repo, stet.commonDir)).missing).toEqual([]);
    const a = await stet.newAgent("a");
    edit(a.worktree, "main.tex", "$a+b=c$", "$a+b=d$");
    await stet.submit("a", { title: "t" });

    // From the agent workspace: moving the main branch, or pushing.
    expect(gitFails(a.worktree, "update-ref", "refs/heads/master", "HEAD")).toMatch(/may not update the main branch/);
    // git itself refuses (master is checked out in the project); the hook would too.
    expect(gitFails(a.worktree, "branch", "-f", "master", "HEAD")).toMatch(/may not update the main branch|cannot force update/);
    const bare = join(repo, "..", "remote.git");
    git(repo, "init", "-q", "--bare", bare);
    expect(gitFails(a.worktree, "push", bare, "HEAD:refs/heads/x")).toMatch(/pushing from an agent workspace/);

    // From the project: merging (fast-forward or not) or pushing an agent branch.
    const head = git(repo, "rev-parse", "HEAD");
    expect(gitFails(repo, "merge", "--ff-only", "stet/a")).toMatch(/agent branch[\s\S]*git restore/);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    // Known limitation: a fast-forward writes the working tree before any hook can object.
    git(repo, "restore", "--staged", "--worktree", ":/");
    expect(gitFails(repo, "merge", "--no-ff", "-m", "m", "stet/a")).toMatch(/agent branch/);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    git(repo, "merge", "--abort");
    expect(gitFails(repo, "push", bare, "stet/a")).toMatch(/must not be pushed/);
    expect(gitFails(repo, "update-ref", "refs/stet/base", "HEAD")).toMatch(/only Stet/);

    // Normal work is unaffected.
    edit(repo, "main.tex", "It scales", "It really scales");
    git(repo, "commit", "-qam", "user edit");
    git(repo, "push", "-q", bare, "master");
    expect(read(repo, "main.tex")).toContain("$a+b=c$");
  });

  it("chains and restores pre-existing hooks", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await uninstallHooks(stet.repo, stet.commonDir);
    const hook = join(stet.commonDir, "hooks", "pre-push");
    writeFileSync(hook, "#!/bin/sh\necho custom >&2\nexit 0\n");
    await reinit(stet.mainPath);
    expect(readFileSync(hook, "utf8")).toMatch(/stet-guard-hook/);
    expect(readFileSync(hook + ".stet-orig", "utf8")).toMatch(/custom/);
    await uninstallHooks(stet.repo, stet.commonDir);
    expect(readFileSync(hook, "utf8")).toMatch(/custom/);
  });
});

describe("hooks the project had before (security audit 2026-09)", () => {
  it("runs a chained hook by itself, and only if it is executable", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const hooks = join(stet.commonDir, "hooks");
    const marker = join(repo, "..", "orig-ran").replace(/\\/g, "/");
    // A non-shell hook (its own interpreter via the shebang) that was there before Stet.
    writeFileSync(join(hooks, "pre-push.stet-orig"), `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    const script = readFileSync(join(hooks, "pre-push"), "utf8");
    expect(script).toContain('if [ -x "$orig" ]; then');
    expect(script).toContain('| "$orig" "$@"');
    expect(script).not.toContain('sh "$orig"');
  });
});

describe("stet doctor", () => {
  it("reports hooks, the stet command and agent workspace files", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER }, { cli: { command: process.execPath, args: [CLI_DIST] } });
    await stet.newAgent("a");
    const checks = await doctor(repo);
    const by = (n: string) => checks.find((c) => c.name === n);
    expect(by("git hooks")?.status).toBe("ok");
    expect(by("agent a")?.status).toBe("ok");
    expect(by("stet command")?.status).toBe(existsSync(CLI_DIST) ? "ok" : "error");
  });
});

describe("git identity from the environment (test report v0.14, B10)", () => {
  it("counts for stet doctor", async () => {
    const { doctor } = await import("../src/doctor.js");
    const { repo } = await setup({ "main.tex": PAPER });
    git(repo, "config", "--unset", "user.name");
    git(repo, "config", "--unset", "user.email");
    const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      const check = async () => (await doctor(repo)).find((c) => c.name === "git identity")!;
      expect((await check()).status).toBe("warn");
      Object.assign(process.env, {
        GIT_AUTHOR_NAME: "Env User",
        GIT_AUTHOR_EMAIL: "env@example.com",
        GIT_COMMITTER_NAME: "Env User",
        GIT_COMMITTER_EMAIL: "env@example.com",
      });
      const ok = await check();
      expect(ok.status).toBe("ok");
      expect(ok.message).toBe("Env User <env@example.com> (from the environment)");
    } finally {
      for (const k of keys)
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
  });
});

describe("setup without a git identity (test report v0.16, B1)", () => {
  it("gitIdentity says who commits, or null when git can't", async () => {
    const { gitIdentity } = await import("../src/git.js");
    const { repo } = await setup({ "main.tex": PAPER });
    const keys = [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "EMAIL",
    ] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      git(repo, "config", "user.name", "Ada");
      git(repo, "config", "user.email", "ada@example.org");
      expect(await gitIdentity(repo)).toBe("Ada <ada@example.org>");
      git(repo, "config", "--unset", "user.name");
      git(repo, "config", "--unset", "user.email");
      git(repo, "config", "user.useConfigOnly", "true"); // no guessing from the host name
      expect(await gitIdentity(repo)).toBeNull();
    } finally {
      for (const k of keys)
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
  });
});

describe("the project's language", () => {
  it("mixed folders: the language with more files, LaTeX on a tie; init can be told", async () => {
    const files = defaultConfig("main").files;
    expect(languageCounts(["a.typ", "b.typ", "old.tex"], files)).toEqual({ latex: 1, typst: 2 });
    expect(detectLanguage(["a.typ", "b.typ", "old.tex"], files)).toBe("typst");
    expect(detectLanguage(["a.typ", "old.tex"], files)).toBe("latex");
    const { stet } = await setup({ "main.typ": "= Hi\n", "old.tex": "x\n" });
    expect((await stet.config()).language).toBe("latex");
    await (await import("../src/service.js")).Stet.init(stet.mainPath, { language: "typst" });
    expect((await stet.config()).language).toBe("typst");
  });
});
