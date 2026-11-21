/** What an agent can't make Stet do through its workspace's git: redirected links, hooks, fsmonitor, filter drivers, signing. */
import { chmodSync, closeSync, cpSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { StetMcpServer } from "../src/mcp.js";
import { writeWorkspaceFiles } from "../src/workspace.js";
import { verifyAgentWorktree } from "../src/worktree.js";
import { edit, FAKE_CLI, git, outsideDir, PAPER, setup, write } from "./helpers.js";

/** Overwrite a file in place (git marks a worktree's .git file hidden, and Windows refuses to replace hidden files). */
function overwrite(path: string, text: string) {
  const fd = openSync(path, "r+");
  ftruncateSync(fd);
  writeSync(fd, text);
  closeSync(fd);
}

describe("a workspace's git link and settings (security audit 2026-09)", () => {
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

describe("agent-controlled git hooks (Codex review 2026-09, F1)", () => {
  it("never runs hooks from the agent's worktree, even with a relative core.hooksPath", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    git(repo, "config", "core.hooksPath", ".hooks");
    const { worktree: wt } = await stet.newAgent("a");
    const marker = join(outsideDir(), "hook-ran").replace(/\\/g, "/");
    write(wt, ".hooks/post-commit", `#!/bin/sh\necho ran > "${marker}"\n`);
    write(wt, ".hooks/prepare-commit-msg", `#!/bin/sh\necho ran > "${marker}"\n`);
    chmodSync(join(wt, ".hooks/post-commit"), 0o755);
    chmodSync(join(wt, ".hooks/prepare-commit-msg"), 0o755);
    // Sanity: plain git in the worktree does run them.
    git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "probe");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    git(wt, "reset", "-q", "--hard", "HEAD~1");

    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const r = await stet.submit("a", { title: "t" });
    expect(r.items.length).toBeGreaterThan(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("programs git could run for the agent (Codex review 2026-09)", () => {
  it("runs no configured filter driver on the agent's files", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const marker = join(outsideDir(), "filter-ran").replace(/\\/g, "/");
    // The project defines a filter whose command is relative: in a worktree it resolves to the agent's file.
    git(repo, "config", "filter.x.clean", "./tools/filter.sh");
    git(repo, "config", "filter.x.smudge", "./tools/filter.sh");
    git(repo, "config", "filter.x.required", "true");
    git(repo, "config", "filter.y.process", "./tools/filter.sh");
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "tools/filter.sh", `#!/bin/sh\necho ran >> "${marker}"\ncat\n`);
    chmodSync(join(wt, "tools/filter.sh"), 0o755);
    write(wt, ".gitattributes", "*.tex filter=x\n*.bib filter=y\n");
    write(wt, "refs.bib", "@misc{a, title={A}}\n");
    // Sanity: plain git in the worktree does run it.
    git(wt, "add", "-n", "main.tex");
    git(wt, "hash-object", "main.tex");
    if (!existsSync(marker)) git(wt, "add", "main.tex");
    expect(existsSync(marker)).toBe(true);
    git(wt, "reset", "-q");
    rmSync(marker);

    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "t" });
    expect(items.some((i) => i.file === "main.tex")).toBe(true);
    await stet.reject(items.filter((i) => i.file === "main.tex").map((i) => i.id), {});
    await stet.sync("a"); // checks files out again (smudge)
    const { doctor } = await import("../src/doctor.js");
    await doctor(repo); // runs status in the worktree
    expect(existsSync(marker)).toBe(false);
  });

  it("never runs a commit-signing program (a relative one would be the agent's file)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const marker = join(outsideDir(), "signer-ran").replace(/\\/g, "/");
    git(repo, "config", "commit.gpgSign", "true");
    git(repo, "config", "gpg.program", "./sign.sh");
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "sign.sh", `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`);
    chmodSync(join(wt, "sign.sh"), 0o755);
    // Sanity: git in the worktree would run it.
    try {
      git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "probe");
    } catch {
      /* the signer fails on purpose */
    }
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const r = await stet.submit("a", { title: "t" });
    const change = r.items.find((i) => i.file === "main.tex")!; // sign.sh itself is proposed too
    await stet.accept([change.id]);
    await stet.sync("a");
    expect(existsSync(marker)).toBe(false);
  });

  it("does not use the worktree's git link after checking it (a swap in between changes nothing)", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const agent = await stet.newAgent("a");
    const marker = join(outsideDir(), "evil-config-used").replace(/\\/g, "/");
    edit(agent.worktree, "main.tex", "effective in practice", "effective in real use");
    const files = await stet.agentFiles(agent); // the check happens here
    // Now the agent points its worktree at a git dir of its own, with a config that runs commands.
    const evil = join(agent.worktree, "evil");
    git(agent.worktree, "init", "-q", "--bare", evil);
    git(evil, "config", "core.fsmonitor", `echo x > "${marker}"; false`);
    git(evil, "config", "core.hooksPath", "/nonexistent");
    const fd = openSync(join(agent.worktree, ".git"), "r+");
    ftruncateSync(fd);
    writeSync(fd, `gitdir: ${evil.replace(/\\/g, "/")}\n`);
    closeSync(fd);

    const tip = await files.commitAll("t");
    expect(existsSync(marker)).toBe(false);
    // The commit landed on the agent branch in the project's repository.
    expect(git(stet.mainPath, "rev-parse", `refs/heads/${agent.branch}`)).toBe(tip);
    expect(git(stet.mainPath, "show", `${tip}:main.tex`)).toContain("effective in real use");
  });
});

describe("the MCP server and a redirected git link", () => {
  it.skipIf(process.platform === "win32")("the MCP server never follows a workspace's redirected git link to a repository the agent made (security report 5e4c6af, S1)", async () => {
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
});
