import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { hookStatus, uninstallHooks } from "../src/hooks.js";
import { StetMcpServer } from "../src/mcp.js";
import { CLI_DIST, edit, git, gitFails, PAPER, read, setup, write } from "./helpers.js";

const FAKE_CLI = { command: process.execPath, args: ["/opt/stet/cli.js"] };

describe("workspace files", () => {
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
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(/cli\.js" guard$/);
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
});

describe("git hooks", () => {
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

async function reinit(path: string) {
  const { Stet } = await import("../src/service.js");
  await Stet.init(path);
}

describe("MCP server", () => {
  it("speaks the protocol and runs the review loop through tools", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const server = new StetMcpServer({ cwd: a.worktree, version: "test" });

    const init: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toMatch(/stet_submit/);
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list: any = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((t: any) => t.name)).toContain("stet_submit");
    const unknown: any = await server.handle({ jsonrpc: "2.0", id: 3, method: "nope" });
    expect(unknown.error.code).toBe(-32601);

    const call = async (name: string, args: object = {}) => ((await server.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } })) as any).result;

    write(a.worktree, "main.tex", read(a.worktree, "main.tex").replaceAll("sec:intro", "sec:introduction"));
    const sub = await call("stet_submit", { title: "Rename label", rationale: "clearer" });
    expect(sub.isError).toBeUndefined();
    expect(sub.content[0].text).toMatch(/Submitted C1/);
    expect(sub.content[0].text).toMatch(/linked, auto-detected/);

    const g = (await stet.listGroups())[0]!;
    await stet.reject(g.items, { reason: "keep the short label", mode: "all" });
    const fb = await call("stet_get_feedback");
    expect(fb.content[0].text).toMatch(/REJECTED .*keep the short label/);

    const st = await call("stet_status");
    expect(st.content[0].text).toMatch(/2 rejected/);
    const sync = await call("stet_sync");
    expect(sync.content[0].text).toMatch(/Synced/);
    expect(read(a.worktree, "main.tex")).toContain("sec:intro}");

    const bad = await call("stet_reply", { itemId: "S999", text: "?" });
    expect(bad.isError).toBe(true);
  });

  it("explains itself outside an agent workspace", async () => {
    const { repo } = await setup({ "main.tex": PAPER });
    const server = new StetMcpServer({ cwd: repo, version: "test" });
    const r: any = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stet_status", arguments: {} } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/not a Stet agent workspace/);
  });

  it.skipIf(!existsSync(CLI_DIST))("runs over stdio from the built CLI", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const child = spawn(process.execPath, [CLI_DIST, "mcp"], { cwd: a.worktree, stdio: ["pipe", "pipe", "inherit"] });
    const lines: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (o: object) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stet_status", arguments: {} } });
    child.stdin.end();
    await new Promise((r) => child.on("close", r));
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[1].result.content[0].text).toMatch(/Agent a on branch stet\/a/);
  });

  it.skipIf(!existsSync(CLI_DIST))("guard hook blocks via exit code 2", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const run = (input: object) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const c = spawn(process.execPath, [CLI_DIST, "guard"], { stdio: ["pipe", "ignore", "pipe"] });
        let err = "";
        c.stderr.on("data", (d) => (err += d));
        c.on("close", (code) => resolve({ code, err }));
        c.stdin.end(JSON.stringify(input));
      });
    const blocked = await run({ cwd: a.worktree, tool_name: "Edit", tool_input: { file_path: join(repo, "main.tex") } });
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/outside your proposal workspace/);
    const ok = await run({ cwd: a.worktree, tool_name: "Edit", tool_input: { file_path: "main.tex" } });
    expect(ok.code).toBe(0);
    const userSession = await run({ cwd: repo, tool_name: "Bash", tool_input: { command: "git push" } });
    expect(userSession.code).toBe(0);
  });
});

describe("doctor (M2)", () => {
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
