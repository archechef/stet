/** Stet's MCP server: the protocol, tool arguments, malformed messages, and workspaces it refuses. */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { StetMcpServer, serveStdio } from "../src/mcp.js";
import { CLI_DIST, edit, FAKE_CLI, PAPER, read, setup, write } from "./helpers.js";

describe("the protocol, the review loop and the guard hook", () => {
  it("speaks the protocol and runs the review loop through tools", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const server = new StetMcpServer({ cwd: a.worktree, version: "test" });

    const init: any = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toMatch(/stet_submit/);
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    const list: any = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools.map((t: any) => t.name)).toContain("stet_submit");
    const unknown: any = await server.handle({ jsonrpc: "2.0", id: 3, method: "nope" });
    expect(unknown.error.code).toBe(-32601);

    const call = async (name: string, args: object = {}) =>
      ((await server.handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } })) as any).result;

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

  it("runs over stdio from the built CLI", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const a = await stet.newAgent("a");
    const child = spawn(process.execPath, [CLI_DIST, "mcp"], { cwd: a.worktree, stdio: ["pipe", "pipe", "inherit"] });
    const lines: any[] = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i: number;
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

  it("guard hook blocks via exit code 2", async () => {
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

describe("malformed MCP messages (Codex review 2026-09, F7)", () => {
  it("answers invalid envelopes and keeps serving", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    const server = new StetMcpServer({ cwd: wt, version: "test" });
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (d) => (out += d));
    const done = serveStdio(server, input, output);
    input.end(
      [
        "null",
        "5",
        '"x"',
        "[]",
        '[null, {"jsonrpc":"2.0","id":7,"method":"ping"}]',
        '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}',
        '{"jsonrpc":"2.0","id":8,"method":"ping"}',
        "",
      ].join("\n"),
    );
    await done;
    const replies = out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(replies).toHaveLength(7);
    for (const r of replies.slice(0, 4)) expect(r.error.code).toBe(-32600);
    expect(replies[4]).toEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } },
      { jsonrpc: "2.0", id: 7, result: {} },
    ]);
    expect(replies[5].error.code).toBe(-32600);
    expect(replies[6]).toEqual({ jsonrpc: "2.0", id: 8, result: {} });
  });

  it("rejects malformed tool arguments without changing anything", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const server = new StetMcpServer({ cwd: wt, version: "test" });
    for (const args of [
      { title: "t", groups: [{ kind: "weird", title: "x", where: ["main.tex"] }] },
      { title: "t", groups: [{ kind: "linked", title: "x", where: "main.tex" }] },
      { title: "t", groups: "linked" },
      { title: "t", notes: [{ where: ["main.tex"] }] },
    ]) {
      const r = await server.callTool("stet_submit", args);
      expect(r.isError, JSON.stringify(args)).toBe(true);
    }
    expect(await stet.listItems()).toEqual([]);
    const g = await server.callTool("stet_group", { itemIds: "S1", kind: "linked", title: "x" });
    expect(g.isError).toBe(true);
  });
});

describe("MCP tool arguments (test report v0.14, B6)", () => {
  it("are checked against each tool's schema", async () => {
    const { argumentError, TOOLS } = await import("../src/mcp.js");
    const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
    expect(argumentError(tool("stet_withdraw"), {})).toMatch(/needs "itemIds", a non-empty list/);
    expect(argumentError(tool("stet_withdraw"), { itemIds: [] })).toMatch(/needs "itemIds"/);
    expect(argumentError(tool("stet_reply"), { text: "x" })).toMatch(/needs "itemId"/);
    expect(argumentError(tool("stet_reply"), { itemId: 3, text: "x" })).toMatch(/needs "itemId", a non-empty string/);
    expect(argumentError(tool("stet_reply"), { itemId: "1.2", text: "x" })).toBeNull();
  });
});

describe("tool settings changed in the workspace", () => {
  it("the MCP server refuses to start in a workspace whose tool settings were changed (security report 5e4c6af, S5)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const { worktree: wt } = await stet.newAgent("a");
    const call = (server: StetMcpServer) => server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stet_status", arguments: {} } });
    expect(JSON.stringify(await call(new StetMcpServer({ cwd: wt, workspace: wt, project: repo, agentId: "a", version: "t" })))).not.toMatch(/refuses/);
    write(wt, ".codex/config.toml", read(wt, ".codex/config.toml").replace('sandbox_mode = "workspace-write"', 'sandbox_mode = "danger-full-access"'));
    const r = JSON.stringify(await call(new StetMcpServer({ cwd: wt, workspace: wt, project: repo, agentId: "a", version: "t" })));
    expect(r).toMatch(/refuses to work in this workspace: \.codex\/config\.toml was changed/);
    // Written again by Stet: accepted again.
    await stet.refreshWorkspace("a");
    expect(JSON.stringify(await call(new StetMcpServer({ cwd: wt, workspace: wt, project: repo, agentId: "a", version: "t" })))).not.toMatch(/refuses/);
  });
});
