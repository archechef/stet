/** Findings of the 2026-09-26 security audit: each test reproduces an attack and checks it fails. */
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { InboxWriter, INBOX_FILE } from "../src/inbox.js";
import { containerArgs, DEFAULT_PREVIEW, insideDir, PreviewBuilder } from "../src/preview.js";
import { LATEX } from "../src/lang/index.js";
import { readInside } from "../src/safefs.js";
import { isSafeRepoPath, oneLine, printable } from "../src/text.js";
import { writeWorkspaceFiles } from "../src/workspace.js";
import { verifyAgentWorktree } from "../src/worktree.js";
import { edit, git, PAPER, read, setup } from "./helpers.js";

/** Overwrite a file in place (git marks a worktree's .git file hidden, and Windows refuses to replace hidden files). */
function overwrite(path: string, text: string) {
  const fd = openSync(path, "r+");
  ftruncateSync(fd);
  writeSync(fd, text);
  closeSync(fd);
}

const FAKE_CLI = { command: "/usr/bin/node", args: ["/opt/stet/cli.js"] };

describe("agent workspace integrity", () => {
  it("refuses to run git in a worktree whose .git file was redirected", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    // The agent builds its own git dir with a config that would run commands, and points .git at it.
    const evil = join(wt, "evil");
    git(wt, "init", "-q", "--bare", evil);
    overwrite(join(wt, ".git"), `gitdir: ${evil.replace(/\\/g, "/")}\n`);
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    await expect(stet.submit("a", { title: "t" })).rejects.toThrow(/refuses to run git/);
    await expect(stet.sync("a")).rejects.toThrow(/refuses to run git/);
    await expect(stet.agentForCwd(wt)).rejects.toThrow(/not a Stet agent workspace|refuses/);
    const checks = await doctor(repo);
    expect(checks.find((c) => c.name.includes("agent a"))?.status).toBe("error");
  });

  it("refuses a worktree whose git dir points to another repository", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    const gitDir = await verifyAgentWorktree(wt, stet.commonDir);
    const other = join(wt, "..", "other.git");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), other.replace(/\\/g, "/") + "\n");
    await expect(stet.submit("a", { title: "t" })).rejects.toThrow(/another repository/);
  });

  it("refuses a worktree with its own config.worktree", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    const gitDir = await verifyAgentWorktree(wt, stet.commonDir);
    writeFileSync(join(gitDir, "config.worktree"), "[core]\n\tfsmonitor = x\n");
    await expect(stet.submit("a", { title: "t" })).rejects.toThrow(/config\.worktree/);
  });

  it("never lets a configured fsmonitor run during Stet's own git calls", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    const marker = join(repo, "..", "fsmonitor-ran").replace(/\\/g, "/");
    git(repo, "config", "core.fsmonitor", `echo x > "${marker}"; false`);
    // Sanity: plain git does run it (otherwise this test proves nothing on this platform).
    git(repo, "status", "--porcelain");
    if (!existsSync(marker)) return;
    const { rmSync } = await import("node:fs");
    rmSync(marker);
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    await stet.sync("a");
    await doctor(repo);
    expect(existsSync(marker)).toBe(false);
    git(repo, "config", "--unset", "core.fsmonitor");
  });

  it("limits the macOS/Linux sandbox to the worktree's private git dir", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const agent = await stet.newAgent("a");
    const gitDir = await verifyAgentWorktree(agent.worktree, stet.commonDir);
    await writeWorkspaceFiles({ agent, mainPath: stet.mainPath, commonDir: stet.commonDir, gitDir, cli: FAKE_CLI, platform: "linux" });
    const settings = JSON.parse(readFileSync(join(agent.worktree, ".claude/settings.json"), "utf8"));
    expect(settings.sandbox.filesystem.allowWrite).toEqual([gitDir.replace(/\\/g, "/")]);
    expect(gitDir.replace(/\\/g, "/")).toMatch(/\/worktrees\/[^/]+$/);
  });
});

describe("second review pass", () => {
  it("quotes the guard hook command so the shell expands nothing in folder names", async () => {
    // A tool path with shell syntax in it: run as the hook would be, it must stay literal.
    const cli = { command: "printf", args: ["%s|%s|", "/tmp/$(echo EXPANDED)`echo X`"] };
    const { stet } = await setup({ "main.tex": PAPER }, { cli });
    const agent = await stet.newAgent("a");
    const cmd: string = JSON.parse(readFileSync(join(agent.worktree, ".claude/settings.json"), "utf8")).hooks.PreToolUse[0].hooks[0].command;
    let out: string;
    try {
      out = execFileSync("sh", ["-c", cmd.replace(/ guard$/, "")], { encoding: "utf8" });
    } catch {
      return; // no POSIX shell on this machine
    }
    // printf's format is the first argument; the path arrives literally, nothing was run.
    expect(out).toBe("/tmp/$(echo EXPANDED)`echo X`||");
  });

  it("rejects unsafe or broken settings", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const cfgPath = join(stet.store.root, "config.json");
    const base = JSON.parse(readFileSync(cfgPath, "utf8"));
    for (const bad of [{ agentBranchPrefix: "stet/*) rm -rf ~ ;; (x" }, { agentBranchPrefix: "stet" }, { mainBranch: "master; echo" }, { autoCommit: "sometimes" }]) {
      writeFileSync(cfgPath, JSON.stringify({ ...base, ...bad }));
      await expect(stet.config()).rejects.toThrow(/Invalid Stet setting/);
    }
    writeFileSync(cfgPath, JSON.stringify({ ...base, worktreeRoot: "./agents" }));
    await expect(stet.newAgent("a")).rejects.toThrow(/outside your project/);
  });

  it("skips a damaged record file and reports it", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    await stet.submit("a", { title: "t" });
    writeFileSync(join(stet.store.root, "items", "S99.json"), "{ not json");
    expect((await stet.listItems()).length).toBe(1);
    const checks = await doctor(repo);
    expect(checks.some((c) => c.name === "store" && c.status === "error" && /S99\.json/.test(c.message))).toBe(true);
  });

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

describe("store and paths", () => {
  it("does not let ids name paths", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await expect(stet.getItem("../config")).resolves.toBeNull();
    await expect(stet.getItem("..\\state")).resolves.toBeNull();
    await expect(stet.store.getAgent("../../config")).resolves.toBeNull();
  });

  it("refuses to accept a forged item that writes outside the project or into .git", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const [real] = (await stet.submit("a", { title: "t" })).items;
    for (const file of ["../evil.tex", "GIT~1/config", ".git/config", ".GIT./hooks/x"]) {
      // An agent that can write the store forges an innocent-looking new-file proposal.
      await stet.store.putItem({ ...real!, id: "S99", kind: "add-file", file, oldText: "", newText: "[core]\n", range: { start: 0, end: 0 }, groups: [] });
      await expect(stet.accept(["S99"])).rejects.toThrow(/Refusing to write/);
    }
    expect(existsSync(join(repo, "..", "evil.tex"))).toBe(false);
    expect(read(repo, ".git/config")).not.toBe("[core]\n");
  });

  it("classifies repository paths", () => {
    for (const p of ["main.tex", "sections/intro.tex", "a/.gitignore", ".github/x.yml", "fig/git~x.png"]) expect(isSafeRepoPath(p), p).toBe(true);
    for (const p of ["", "../x", "a/../../x", "/etc/x", "C:/x", "c:x", ".git", ".git/config", "a/.GIT/x", ".git./x", ".git /x", "GIT~1/config", "git~2", "a/b:stream", "a//b", "./a"])
      expect(isSafeRepoPath(p), p).toBe(false);
  });
});

describe("review before 0.10 (2026-11-19)", () => {
  it("never blocks on a named pipe the agent puts in place of its inbox or AGENTS.md", async () => {
    if (process.platform === "win32") return;
    const { stet } = await setup({ "main.tex": PAPER }, { cli: { command: process.execPath, args: ["/opt/stet/cli.js"] } });
    const a = await stet.newAgent("a");
    await stet.setNotify("a", "now");
    const inbox = join(a.worktree, INBOX_FILE);
    rmSync(inbox);
    execFileSync("mkfifo", [inbox]);
    execFileSync("mkfifo", [join(a.worktree, "AGENTS.md")]);
    await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Shorter.");
    const quick = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hung")), 3000))]);
    // Each returns (or fails) at once instead of waiting for a reader forever.
    await quick(new InboxWriter(stet, "a").tick(true).catch(() => []));
    await quick(stet.pingAgent("a").catch(() => undefined));
    expect(await quick(readInside(a.worktree, "AGENTS.md"))).toBeNull();
    await quick(stet.refreshWorkspace("a").catch(() => null));
  });

  it("shows terminal escapes, direction overrides and invisible characters in agent text as markers", () => {
    // Shown, not dropped: dropped, the file still got them unseen (security report 5e4c6af, S11).
    const evil = "fine\u001b[2J\u001b]0;pwned\u0007 text\u202e txet\u2066";
    expect(printable(evil)).toBe("fine⟨U+001B⟩[2J⟨U+001B⟩]0;pwned⟨U+0007⟩ text⟨U+202E⟩ txet⟨U+2066⟩");
    expect(oneLine("a\u001b[31mred\nb")).toBe("a⟨U+001B⟩[31mred b");
    expect(printable("line\nbreak\ttab")).toBe("line\nbreak\ttab");
    expect(printable("\\ref{a\u200b} \u00ad\ufeff\u{e0041}")).toBe("\\ref{a⟨U+200B⟩} ⟨U+00AD⟩⟨U+FEFF⟩⟨U+E0041⟩");
    // A lone CR is the line break TeX and Markdown see; a terminal would print over the line (S10).
    expect(printable("shown\rhidden\r\nnext")).toBe("shown\nhidden\nnext");
  });

  it("runs previews only in the user's image, with limits, and never downloads one", () => {
    const env = { status: "ready" as const, isolation: "container" as const, message: "", bin: "/tl/bin", mounts: [["/tl", "/tl"]] as [string, string][], memoryLimit: true };
    const args = containerArgs(env, "localhost/stet-preview:1", "/w", "n", ["latexmk"]);
    expect(args).toContain("--pull=never");
    expect(args.join(" ")).toMatch(/--ulimit fsize=\d+:\d+/);
    expect(args.join(" ")).toMatch(/--ulimit nofile=\d+:\d+/);
    expect(args).toContain("--memory=2g");
    expect(containerArgs({ ...env, memoryLimit: false }, "i", "/w", "n", ["x"])).not.toContain("--memory=2g");
  });

  it("trusts preview images only in the change's own cache folder, and only real commit names", async () => {
    expect(insideDir("/c/abc/items/1.1-x/after.png", "/c/abc/items/1.1-x")).toBe(true);
    expect(insideDir("/home/me/.ssh/id_ed25519", "/c/abc/items/1.1-x")).toBe(false);
    expect(insideDir("/c/abc/items/1.1-x/../../x.png", "/c/abc/items/1.1-x")).toBe(false);
    const { stet } = await setup({ "main.tex": PAPER });
    const ready = { status: "ready" as const, isolation: "container" as const, message: "", bin: "/tl/bin", mounts: [["/tl", "/tl"]] as [string, string][] };
    const b = new PreviewBuilder(stet.repo, join(stet.store.root, "previews"), DEFAULT_PREVIEW, ready, LATEX);
    const req = { base: "../../../../tmp", key: "1.1-abc", target: 0, changes: [{ file: "main.tex", baseText: PAPER, eol: "lf" as const, range: { start: 0, end: 1 }, newText: "x" }] };
    expect((await b.preview(req)).status).toBe("unavailable");
    expect((await b.preview({ ...req, base: "a".repeat(40), key: "../x" })).status).toBe("unavailable");
  });
});
