/** The files Stet writes into an agent's workspace (instructions, MCP config, guard settings), and refreshing them safely. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { Stet } from "../src/service.js";
import { dirLink, edit, FAKE_CLI, git, outsideDir, PAPER, read, setup } from "./helpers.js";

describe("instructions, MCP config and guard settings", () => {
  it("writes instructions, MCP config and guard settings, and keeps them out of proposals", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER, "AGENTS.md": "# Project rules\nUse British spelling.\n" }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a", { kind: "claude-code" });
    for (const f of ["CLAUDE.local.md", "AGENTS.override.md", ".mcp.json", ".claude/settings.json", ".codex/config.toml"])
      expect(existsSync(join(a.worktree, f)), f).toBe(true);

    expect(read(a.worktree, "AGENTS.override.md")).toMatch(/^# Project rules\nUse British spelling\.[\s\S]*Stet review/);
    const mcp = JSON.parse(read(a.worktree, ".mcp.json"));
    expect(mcp.mcpServers.stet.args).toEqual(["/opt/stet/cli.js", "mcp"]);
    expect(mcp.mcpServers.stet.env.STET_WORKSPACE).toBe(a.worktree);
    const settings = JSON.parse(read(a.worktree, ".claude/settings.json"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(/cli\.js' guard$/);
    expect(settings.permissions.deny).toContain("Bash(git push *)");
    expect(settings.permissions.deny.some((d: string) => d.startsWith("Edit(//"))).toBe(true);
    expect(read(a.worktree, ".codex/config.toml")).toMatch(/\[mcp_servers\.stet\]/);

    edit(a.worktree, "main.tex", "$a+b=c$", "$a+b=d$");
    const r = await stet.submit("a", { title: "t" });
    expect(r.items.map((i) => i.file)).toEqual(["main.tex"]);
    expect(git(a.worktree, "show", "--name-only", "--format=", "HEAD")).toBe("main.tex");

    // Files survive a sync, and the user's project never sees them.
    await stet.accept([r.items[0]!.id]);
    await stet.sync("a");
    expect(existsSync(join(a.worktree, "CLAUDE.local.md"))).toBe(true);
    expect(existsSync(join(repo, "CLAUDE.local.md"))).toBe(false);
  });

  it("never overwrites files the project tracks", async () => {
    const { stet } = await setup({ "main.tex": PAPER, ".mcp.json": '{"mcpServers":{}}\n', ".claude/settings.json": "{}\n" }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    expect(read(a.worktree, ".mcp.json")).toBe('{"mcpServers":{}}\n');
    expect(read(a.worktree, ".claude/settings.json")).toBe("{}\n");
    expect(JSON.parse(read(a.worktree, ".claude/settings.local.json")).hooks).toBeDefined();
    const r = await stet.refreshWorkspace("a");
    expect(r!.skipped.map((s) => s.file).sort()).toEqual([".claude/settings.json", ".mcp.json"]);
  });

  it("refreshes all active agents at once (the panel's Refresh), past one that fails", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    const b = await stet.newAgent("b");
    await stet.newAgent("c");
    await stet.archiveAgent("c");
    writeFileSync(join(a.worktree, "CLAUDE.local.md"), "old instructions\n");
    rmSync(b.worktree, { recursive: true, force: true });

    const r = await stet.refreshWorkspaces();
    expect(r.map((x) => x.agent)).toEqual(["a", "b"]);
    expect(r[0]!.result!.written).toContain("CLAUDE.local.md");
    expect(r[1]!.error).toBeTruthy();
    expect(read(a.worktree, "CLAUDE.local.md")).toMatch(/Stet review/);
  });
});

describe("workspace refresh through links (Codex review 2026-09, F2)", () => {
  it("replaces a planted directory link instead of writing through it", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const { worktree: wt } = await stet.newAgent("a");
    const ext = outsideDir();
    rmSync(join(wt, ".claude"), { recursive: true, force: true });
    dirLink(ext, join(wt, ".claude"));
    await stet.refreshWorkspace("a");
    expect(existsSync(join(ext, "settings.json"))).toBe(false);
    expect(JSON.parse(read(wt, ".claude/settings.json")).hooks).toBeDefined();
  });

  it("replaces a planted file link instead of writing through it", async (ctx) => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const { worktree: wt } = await stet.newAgent("a");
    const victim = join(outsideDir(), "victim.txt");
    writeFileSync(victim, "keep me");
    rmSync(join(wt, ".mcp.json"));
    try {
      symlinkSync(victim, join(wt, ".mcp.json"), "file");
    } catch {
      return ctx.skip(); // file symlinks need extra rights on Windows
    }
    await stet.refreshWorkspace("a");
    expect(readFileSync(victim, "utf8")).toBe("keep me");
    expect(JSON.parse(read(wt, ".mcp.json")).mcpServers.stet).toBeDefined();
  });
});

describe("the guard hook and its settings (security audit 2026-09)", () => {
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
    for (const bad of [
      { agentBranchPrefix: "stet/*) rm -rf ~ ;; (x" },
      { agentBranchPrefix: "stet" },
      { mainBranch: "master; echo" },
      { autoCommit: "sometimes" },
    ]) {
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

  it("skips a record that lacks a field or has one of the wrong type, and says which (code quality report 6a517ae, record validation)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const [it] = (await stet.submit("a", { title: "t" })).items;
    const file = join(stet.store.root, "items", `${it!.id}.json`);
    const good = readFileSync(file, "utf8");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(good), range: { start: 0, end: "12" } }));
    const fresh = await Stet.open(repo);
    expect(await fresh.listItems()).toEqual([]);
    await expect(fresh.store.getItem(it!.id)).rejects.toThrow(/is damaged \(range\.end: not a whole number\)/);
    const checks = await doctor(repo);
    expect(checks).toContainEqual(
      expect.objectContaining({ name: "store", status: "error", message: expect.stringContaining("range.end: not a whole number") }),
    );
    writeFileSync(file, good);
    expect((await (await Stet.open(repo)).listItems()).map((i) => i.id)).toEqual([it!.id]);
  });
});
