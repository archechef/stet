import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkToolUse } from "../src/guard.js";
import { findInbox, followInbox, InboxWriter, INBOX_FILE, INBOX_TIMING, parseInboxLine } from "../src/inbox.js";
import { notifyMode } from "../src/model.js";
import { PassThrough } from "node:stream";
import { serveStdio, StetMcpServer } from "../src/mcp.js";
import { edit, git, PAPER, read, setup, write } from "./helpers.js";

const FAKE_CLI = { command: process.execPath, args: ["/opt/stet/cli.js"] };
const keys = (wt: string) =>
  (existsSync(join(wt, INBOX_FILE)) ? readFileSync(join(wt, INBOX_FILE), "utf8") : "")
    .split("\n")
    .map((l) => parseInboxLine(l)?.key)
    .filter(Boolean);

describe("agent inbox", () => {
  it("gets one line per feedback event, waiting note and needed sync, once each", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    await stet.setNotify("a", "now");
    expect(read(a.worktree, INBOX_FILE)).toBe(""); // created with the workspace, so watchers can start at once
    const w = new InboxWriter(stet, "a");
    expect(await w.tick()).toEqual([]);

    edit(a.worktree, "main.tex", "the problem", "the task");
    edit(a.worktree, "main.tex", "$a+b=c$", "$a+b=d$");
    const r = await stet.submit("a", { title: "t" });
    expect(await w.tick()).toEqual([]); // the agent's own submission is no news

    await stet.reject([r.items[0]!.id], { reason: "keep it" });
    await stet.comment(r.items[1]!.id, "Why d?");
    await stet.addNote("a", { file: "main.tex", fromLine: 6 }, "Tone this down.");
    const lines = await w.tick();
    expect(lines.map((l) => l.key)).toEqual([expect.stringMatching(/^feedback#\d+$/), expect.stringMatching(/^feedback#\d+$/), "note:N1"]);
    expect(lines[0]!.text).toMatch(/^REJECTED .*reason: keep it.*stet_get_feedback\)$/);
    expect(lines[2]!.text).toMatch(/note N1 .*"Tone this down\."/);
    expect(await w.tick(true)).toEqual([]); // nothing twice

    // The user commits other work: one line until the agent syncs.
    write(repo, "other.tex", "x\n");
    git(repo, "add", "other.tex");
    git(repo, "commit", "-qm", "other");
    expect((await w.tick()).map((l) => l.key)).toEqual([expect.stringMatching(/^sync:/)]);
    expect(await w.tick(true)).toEqual([]);

    // A second writer (another session in the same workspace) does not repeat what is there.
    expect(await new InboxWriter(stet, "a").tick()).toEqual([]);
    expect(keys(a.worktree)).toHaveLength(4);

    await stet.archiveAgent("a");
    expect((await w.tick(true)).map((l) => l.key)).toEqual(["archived"]);
  });

  it("finishes a running check before stop resolves, and writes nothing after it", async () => {
    // On Windows a check still running (git, the inbox file) kept the workspace from being removed.
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Shorter.");
    const w = new InboxWriter(stet, "a");
    let settled = false;
    const t = w.tick(true).then((l) => ((settled = true), l));
    await w.stop();
    expect(settled).toBe(true);
    expect(await t).toEqual([]); // stopped before it wrote
    expect(read(a.worktree, INBOX_FILE)).toBe("");
    expect(await w.tick(true)).toEqual([]);
  });

  it("is stopped and done when the MCP server's input ends", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Shorter.");
    const server = new StetMcpServer({ cwd: a.worktree, version: "test" });
    const input = new PassThrough();
    const done = serveStdio(server, input, new PassThrough());
    input.end();
    await done;
    const before = read(a.worktree, INBOX_FILE);
    rmSync(a.worktree, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(a.worktree)).toBe(false);
    expect(before === "" || /note:N1/.test(before)).toBe(true);
  });

  it("does not write through a link the agent planted", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    await stet.setNotify("a", "now");
    const target = join(repo, "victim.txt");
    writeFileSync(target, "original\n");
    try {
      rmSync(join(a.worktree, INBOX_FILE));
      symlinkSync(target, join(a.worktree, INBOX_FILE));
    } catch {
      return; // no symlinks here (Windows without privilege)
    }
    await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Shorter.");
    await new InboxWriter(stet, "a").tick();
    expect(readFileSync(target, "utf8")).toBe("original\n");
    expect(keys(a.worktree)).toEqual(["note:N1"]);
  });

  it("stays out of proposals and is protected by the guard, except reading it", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Shorter.");
    await new InboxWriter(stet, "a").tick();
    edit(a.worktree, "main.tex", "the problem", "the task");
    const r = await stet.submit("a", { title: "t" });
    expect(r.items.map((i) => i.file)).toEqual(["main.tex"]);

    const ctx = { worktree: a.worktree, mainPath: stet.mainPath, commonDir: stet.commonDir, cli: FAKE_CLI };
    const bash = (command: string) => checkToolUse({ cwd: a.worktree, tool_name: "Bash", tool_input: { command } }, ctx);
    expect(bash("tail -n 0 -f .stet/inbox")).toBeNull();
    expect(bash("echo hi > .stet/inbox")).toMatch(/Stet manages/);
    expect(checkToolUse({ cwd: a.worktree, tool_name: "Write", tool_input: { file_path: join(a.worktree, INBOX_FILE) } }, ctx)).toMatch(/managed by Stet/);
  });
});

describe("notification modes", () => {
  it("batched (the default) waits until the reviewer pauses, then writes everything at once", async () => {
    const quiet = INBOX_TIMING.quiet;
    INBOX_TIMING.quiet = 300;
    try {
      const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
      const a = await stet.newAgent("a");
      expect(notifyMode(a)).toBe("batched");
      const w = new InboxWriter(stet, "a");
      await w.tick();
      edit(a.worktree, "main.tex", "the problem", "the task");
      edit(a.worktree, "main.tex", "$a+b=c$", "$a+b=d$");
      const { items } = await stet.submit("a", { title: "t" });
      await stet.reject([items[0]!.id]);
      expect(await w.tick()).toEqual([]); // the reviewer is still at it
      await stet.reject([items[1]!.id]);
      expect(await w.tick()).toEqual([]);
      await new Promise((r) => setTimeout(r, 350));
      expect((await w.tick()).map((l) => l.key)).toEqual([expect.stringMatching(/^feedback#/), expect.stringMatching(/^feedback#/)]);
    } finally {
      INBOX_TIMING.quiet = quiet;
    }
  });

  it("off writes nothing; switched on again, what arrived meanwhile is written", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    expect(await stet.setNotify("a", "off")).toBe(true);
    expect(await stet.setNotify("a", "off")).toBe(false);
    const w = new InboxWriter(stet, "a");
    await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Shorter.");
    expect(await w.tick(true)).toEqual([]);
    expect(read(a.worktree, INBOX_FILE)).toBe("");
    await stet.setNotify("a", "now");
    expect((await w.tick()).map((l) => l.key)).toEqual(["note:N1"]);
    await expect(stet.setNotify("a", "loud" as any)).rejects.toThrow(/Unknown notification mode/);
  });
});

describe("stet watch", () => {
  it("is allowed by the guard exactly as the instructions give it", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    // As installed by the VS Code extension: in the project's git dir, on VS Code's runtime.
    const cli = { command: process.execPath, args: [join(stet.commonDir, "stet", "bin", "stet.mjs")], env: { ELECTRON_RUN_AS_NODE: "1" } };
    const ctx = { worktree: a.worktree, mainPath: stet.mainPath, commonDir: stet.commonDir, cli };
    const bash = (command: string) => checkToolUse({ cwd: a.worktree, tool_name: "Bash", tool_input: { command } }, ctx);
    const q = (s: string) => `'${s}'`;
    const cmd = `ELECTRON_RUN_AS_NODE='1' ${q(process.execPath)} ${q(cli.args[0]!)}`;
    expect(bash(`${cmd} watch`)).toBeNull();
    expect(bash(`${cmd} watch --once`)).toBeNull();
    expect(bash(`stet watch --once`)).toBeNull();
    // Anything more still refers to the project's git dir.
    expect(bash(`${cmd} watch; rm -rf x`)).not.toBeNull();
    expect(bash(`${cmd} sync`)).not.toBeNull();
    expect(bash(`${cmd} watch --out ${q(join(stet.commonDir, "x"))}`)).not.toBeNull();
    expect(bash(`ELECTRON_RUN_AS_NODE=0 ${q(process.execPath)} ${q(cli.args[0]!)} watch`)).not.toBeNull();
    expect(checkToolUse({ cwd: a.worktree, tool_name: "Bash", tool_input: { command: `${cmd} watch` } }, { ...ctx, cli: undefined as any })).not.toBeNull();
  });

  it("follows the inbox from now on; --once ends after the first batch", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    await stet.setNotify("a", "now");
    const w = new InboxWriter(stet, "a");
    await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Old news.");
    await w.tick();
    const inbox = await findInbox(join(a.worktree));
    expect(inbox).toBe(join(a.worktree, INBOX_FILE));

    const got: string[] = [];
    const done = (async () => {
      for await (const l of followInbox(inbox!, { once: true, poll: 20, settle: 50 })) got.push(l.key);
    })();
    await new Promise((r) => setTimeout(r, 60));
    await stet.addNote("a", { file: "main.tex", fromLine: 6 }, "One.");
    await stet.addNote("a", { file: "main.tex", fromLine: 8 }, "Two.");
    await w.tick();
    await done;
    expect(got).toEqual(["note:N2", "note:N3"]);
  });
});

describe("MCP tool results", () => {
  it("mention what arrived while the agent worked", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: FAKE_CLI });
    const a = await stet.newAgent("a");
    const server = new StetMcpServer({ cwd: a.worktree, version: "test" });
    edit(a.worktree, "main.tex", "the problem", "the task");
    const r = await stet.submit("a", { title: "t" });
    const quiet = await server.callTool("stet_list", {});
    expect(quiet.content).toHaveLength(1);

    await stet.reject([r.items[0]!.id]);
    await stet.addNote("a", { file: "main.tex", fromLine: 6 }, "Tone this down.");
    const loud = await server.callTool("stet_list", {});
    expect(loud.content.at(-1)!.text).toBe(
      "Stet: 1 unread feedback event(s) (call stet_get_feedback); 1 note(s) from the reviewer waiting (call stet_sync).",
    );
    // The tools that report this anyway don't repeat it.
    expect((await server.callTool("stet_status", {})).content).toHaveLength(1);
  });
});
