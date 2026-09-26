/** Findings F1–F7 of the Codex security review (2026-09-26): each test reproduces the report's scenario. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { serveStdio, StetMcpServer } from "../src/mcp.js";
import { LOCK_TIMING, Store } from "../src/store.js";
import { edit, git, PAPER, read, setup, write } from "./helpers.js";

const FAKE_CLI = { command: "/usr/bin/node", args: ["/opt/stet/cli.js"] };
const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");
const ACCEPTED = PAPER.replace("effective in practice", "effective in real use");
const outside: string[] = [];
afterEach(() => {
  for (const d of outside.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});
function outsideDir(): string {
  const d = mkdtempSync(join(tmpdir(), "stet-outside-"));
  outside.push(d);
  return d;
}
/** A directory link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
function dirLink(target: string, path: string) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("F1: agent-controlled git hooks", () => {
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

describe("F2: workspace refresh through links", () => {
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

describe("F3: accept through links in the project", () => {
  it("refuses to write through a linked folder, wherever it points", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "alias/new.tex", "proposal\n");
    const [item] = (await stet.submit("a", { title: "t" })).items;
    for (const target of [outsideDir(), join(repo, ".git")]) {
      rmSync(join(repo, "alias"), { recursive: true, force: true });
      dirLink(target, join(repo, "alias"));
      await expect(stet.accept([item!.id], { commit: false })).rejects.toThrow(/link/);
      expect(existsSync(join(target, "new.tex"))).toBe(false);
    }
    expect((await stet.getItem(item!.id))!.status).toBe("pending");
  });
});

describe("F4: all-or-nothing accept", () => {
  async function linkedPair() {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "a.txt", "A\n");
    write(wt, "z/new.txt", "Z\n");
    const { items } = await stet.submit("a", { title: "t" });
    const ids = items.map((i) => i.id);
    await stet.group("a", ids, "linked", "pair");
    return { stet, repo, ids };
  }

  it("checks every destination before writing anything", async () => {
    const { stet, repo, ids } = await linkedPair();
    write(repo, "z", "a file where a folder is needed\n");
    await expect(stet.accept(ids, { commit: false })).rejects.toThrow(/Nothing was applied/);
    expect(existsSync(join(repo, "a.txt"))).toBe(false);
    expect((await stet.listItems()).map((i) => i.status)).toEqual(["pending", "pending"]);
    expect(existsSync(join(stet.store.root, "txn.json"))).toBe(false);
  });

  it.runIf(process.platform === "win32")("restores written files when a later write fails", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "a.txt", "A\n"); // written first (whole-file items go first)
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const ids = (await stet.submit("a", { title: "t" })).items.map((i) => i.id);
    await stet.group("a", ids, "linked", "pair");
    // A read-only main.tex cannot be replaced on Windows: the second write fails.
    chmodSync(join(repo, "main.tex"), 0o444);
    try {
      await expect(stet.accept(ids, { commit: false })).rejects.toThrow(/restored/);
      expect(existsSync(join(repo, "a.txt"))).toBe(false);
      expect(read(repo, "main.tex")).toBe(PAPER);
      expect((await stet.listItems()).map((i) => i.status)).toEqual(["pending", "pending"]);
      expect(existsSync(join(stet.store.root, "txn.json"))).toBe(false);
    } finally {
      chmodSync(join(repo, "main.tex"), 0o644);
    }
  });

  it("undoes an accept cut off while writing, and finishes one cut off after writing", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const [item] = (await stet.submit("a", { title: "t" })).items;
    const journal = (filesDone: boolean) =>
      JSON.stringify({
        items: [{ id: item!.id, appliedText: "real use", edited: false }],
        filesDone,
        files: [{ path: "main.tex", original: Buffer.from(PAPER).toString("base64"), before: sha(PAPER), after: sha(ACCEPTED) }],
      });

    // Cut off while writing: the file is half-changed, the item still pending.
    edit(repo, "main.tex", "effective in practice", "effective in real use");
    writeFileSync(join(stet.store.root, "txn.json"), journal(false));
    await stet.agentStatus("a");
    expect(read(repo, "main.tex")).toBe(PAPER);
    expect((await stet.getItem(item!.id))!.status).toBe("pending");

    // Cut off after writing: the files are complete, the review state is finished.
    edit(repo, "main.tex", "effective in practice", "effective in real use");
    writeFileSync(join(stet.store.root, "txn.json"), journal(true));
    await stet.agentStatus("a");
    expect(read(repo, "main.tex")).toContain("effective in real use");
    expect((await stet.getItem(item!.id))!.status).toBe("accepted");
    expect(existsSync(join(stet.store.root, "txn.json"))).toBe(false);
  });
});

describe("follow-up reports", () => {
  it("recovery never overwrites a file the user edited after the interruption", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const [item] = (await stet.submit("a", { title: "t" })).items;
    // Stet stopped after journaling, before writing; then the user edited the file.
    writeFileSync(
      join(stet.store.root, "txn.json"),
      JSON.stringify({
        items: [{ id: item!.id, appliedText: "real use", edited: false }],
        filesDone: false,
        files: [{ path: "main.tex", original: Buffer.from(PAPER).toString("base64"), before: sha(PAPER), after: sha(ACCEPTED) }],
      }),
    );
    edit(repo, "main.tex", "It scales to", "It even scales to");
    const mine = read(repo, "main.tex");
    await stet.agentStatus("a"); // triggers recovery
    expect(read(repo, "main.tex")).toBe(mine);
    expect(existsSync(join(stet.store.root, "txn.json"))).toBe(false);
    expect((await stet.getItem(item!.id))!.status).toBe("pending");
  });

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
});

describe("F5: store lock", () => {
  const saved = { ...LOCK_TIMING };
  afterEach(() => Object.assign(LOCK_TIMING, saved));

  it("keeps a live owner's lock beyond the stale threshold", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, timeout: 5000 });
    const root = outsideDir();
    const a = new Store(root);
    const b = new Store(root);
    const log: string[] = [];
    const first = a.withLock(async () => {
      log.push("A in");
      await new Promise((r) => setTimeout(r, 800)); // > stale threshold
      log.push("A out");
    });
    await new Promise((r) => setTimeout(r, 50));
    await b.withLock(async () => void log.push("B in"));
    await first;
    expect(log).toEqual(["A in", "A out", "B in"]);
    expect(existsSync(join(root, "lock"))).toBe(false);
  });

  it("takes over a lock whose owner is gone, and never removes someone else's lock", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, timeout: 5000 });
    const root = outsideDir();
    // A crashed owner on this machine (pid that does not exist), with a fresh timestamp.
    writeFileSync(join(root, "lock"), JSON.stringify({ pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(), token: "dead", at: Date.now() }));
    const s = new Store(root);
    let entered = false;
    await s.withLock(async () => {
      entered = true;
      // Someone replaces our lock (e.g. after a takeover): our release must leave theirs alone.
      writeFileSync(join(root, "lock"), JSON.stringify({ pid: process.pid, host: "x", token: "other" }));
    });
    expect(entered).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "lock"), "utf8")).token).toBe("other");
  });

  it("takes over a lock whose heartbeat stopped", async () => {
    Object.assign(LOCK_TIMING, { heartbeat: 40, stale: 250, timeout: 5000 });
    const root = outsideDir();
    writeFileSync(join(root, "lock"), JSON.stringify({ pid: process.pid, host: "another-machine", token: "old" }));
    const old = new Date(Date.now() - 10_000);
    utimesSync(join(root, "lock"), old, old);
    let entered = false;
    await new Store(root).withLock(async () => void (entered = true));
    expect(entered).toBe(true);
  });
});

describe("F6: accepted binary replacements", () => {
  it("stays uncommitted until its content is committed", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER, "image.bin": "" });
    writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2]));
    git(repo, "commit", "-qam", "binary");
    const { worktree: wt } = await stet.newAgent("a");
    writeFileSync(join(wt, "image.bin"), Buffer.from([0, 4, 5]));
    const [item] = (await stet.submit("a", { title: "t" })).items;
    expect(item!.kind).toBe("binary");
    await stet.accept([item!.id], { commit: false });
    await stet.agentStatus("a"); // runs ensureBase
    expect((await stet.uncommittedAccepted()).map((i) => i.id)).toEqual([item!.id]);
    expect([...readFileSync(join(repo, "image.bin"))]).toEqual([0, 4, 5]);
    const r = await stet.commitAcceptedItems();
    expect(r.commit).not.toBeNull();
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("recognizes an added file only when its content matches", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "new.tex", "from the agent\n");
    const [item] = (await stet.submit("a", { title: "t" })).items;
    await stet.accept([item!.id], { commit: false });
    // The user commits a different file of the same name.
    write(repo, "new.tex", "something else\n");
    git(repo, "add", "new.tex");
    git(repo, "commit", "-qm", "mine");
    await stet.agentStatus("a");
    expect((await stet.getItem(item!.id))!.resolution!.committed).toMatch(/^external:/);
  });
});

describe("F7: malformed MCP messages", () => {
  it("answers invalid envelopes and keeps serving", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    const server = new StetMcpServer({ cwd: wt, version: "test" });
    const input = new PassThrough();
    const output = new PassThrough();
    let out = "";
    output.on("data", (d) => (out += d));
    const done = serveStdio(server, input, output);
    input.end(['null', '5', '"x"', '[]', '[null, {"jsonrpc":"2.0","id":7,"method":"ping"}]', '{"jsonrpc":"2.0","id":{"a":1},"method":"ping"}', '{"jsonrpc":"2.0","id":8,"method":"ping"}', ""].join("\n"));
    await done;
    const replies = out.trim().split("\n").map((l) => JSON.parse(l));
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
