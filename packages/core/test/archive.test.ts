/** Archiving an agent: the agent, its folder and the reviewer learn clearly what happened. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StetMcpServer } from "../src/mcp.js";
import { CLI_DIST, edit, PAPER, setup } from "./helpers.js";

async function withPending() {
  const s = await setup({ "main.tex": PAPER }, { cli: { command: process.execPath, args: [CLI_DIST] } });
  const agent = await s.stet.newAgent("a");
  edit(agent.worktree, "main.tex", "effective in practice", "effective in real use");
  const { items } = await s.stet.submit("a", { title: "t" });
  return { ...s, agent, ids: items.map((i) => i.id) };
}

/** The agent's Stet server as its workspace config starts it. */
const serverFor = (repo: string, worktree: string) =>
  new StetMcpServer({ cwd: worktree, workspace: worktree, project: repo, agentId: "a", version: "test" });

describe("archiving an agent", () => {
  it("withdraws its changes, deletes the folder, and tells the agent on its next tool call", async () => {
    const { stet, repo, agent, ids } = await withPending();
    const r = await stet.archiveAgent("a", { removeWorktree: true });
    expect(r).toMatchObject({ withdrawn: ids, worktreeRemoved: true });
    expect(existsSync(agent.worktree)).toBe(false);
    expect((await stet.getItem(ids[0]!))!.status).toBe("withdrawn");
    expect((await stet.events()).at(-1)).toMatchObject({ type: "archived", agent: "a", items: ids });

    for (const tool of ["stet_status", "stet_submit", "stet_get_feedback"]) {
      const res = await serverFor(repo, agent.worktree).callTool(tool, { title: "x" });
      expect(res.isError, tool).toBe(true);
      const text = res.content[0]!.text;
      expect(text).toMatch(/archived this workspace \(agent a\)/);
      expect(text).toContain(ids.join(", "));
      expect(text).toMatch(/folder was deleted/);
      expect(text).toMatch(/new agent workspace/);
    }
  });

  it("keeps the folder on request, with a notice in place of the instructions", async () => {
    const { stet, repo, agent, ids } = await withPending();
    const r = await stet.archiveAgent("a");
    expect(r.worktreeRemoved).toBe(false);
    for (const f of ["CLAUDE.local.md", "AGENTS.override.md"]) {
      const notice = readFileSync(join(agent.worktree, f), "utf8");
      expect(notice).toMatch(/This workspace is archived/);
      expect(notice).toContain(ids[0]!);
    }
    await expect(stet.submit("a", { title: "t" })).rejects.toThrow(/archived this workspace/);
    await expect(stet.agentForCwd(agent.worktree)).rejects.toThrow(/archived this workspace/);
    const res = await serverFor(repo, agent.worktree).callTool("stet_status", {});
    expect(res.content[0]!.text).toMatch(/archived this workspace/);
  });

  it.skipIf(!existsSync(CLI_DIST))("guard hook blocks with the explanation, also when the folder is gone", async () => {
    const { stet, repo, agent } = await withPending();
    const guard = (env: Record<string, string>, input: object) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const c = spawn(process.execPath, [CLI_DIST, "guard"], { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, ...env } });
        let err = "";
        c.stderr.on("data", (d) => (err += d));
        c.on("close", (code) => resolve({ code, err }));
        c.stdin.end(JSON.stringify(input));
      });
    const env = { STET_PROJECT: repo, STET_AGENT: "a" };
    const edit = { cwd: agent.worktree, tool_name: "Edit", tool_input: { file_path: join(agent.worktree, "main.tex") } };
    expect((await guard(env, edit)).code).toBe(0); // active: allowed

    await stet.archiveAgent("a", { removeWorktree: true });
    const blocked = await guard(env, edit);
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/archived this workspace \(agent a\)/);
  });
});
