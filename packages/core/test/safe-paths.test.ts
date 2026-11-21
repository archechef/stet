/** Paths, links and special files: Stet never writes outside the project, through a link, or into .git, and never blocks on a pipe. */
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INBOX_FILE, InboxWriter } from "../src/inbox.js";
import type { Item } from "../src/model.js";
import { readInside } from "../src/safefs.js";
import { isSafeRepoPath } from "../src/text.js";
import { dirLink, edit, git, outsideDir, PAPER, read, setup, write } from "./helpers.js";

describe("accept through links in the project (Codex review 2026-09, F3)", () => {
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

describe("ids and repository paths (security audit 2026-09)", () => {
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
      await stet.store.withLock(() =>
        stet.store.putItem({ ...real!, id: "S99", kind: "add-file", file, oldText: "", newText: "[core]\n", range: { start: 0, end: 0 }, groups: [] }),
      );
      await expect(stet.accept(["S99"])).rejects.toThrow(/Refusing to write/);
    }
    expect(existsSync(join(repo, "..", "evil.tex"))).toBe(false);
    expect(read(repo, ".git/config")).not.toBe("[core]\n");
  });

  it("classifies repository paths", () => {
    for (const p of ["main.tex", "sections/intro.tex", "a/.gitignore", ".github/x.yml", "fig/git~x.png"]) expect(isSafeRepoPath(p), p).toBe(true);
    for (const p of [
      "",
      "../x",
      "a/../../x",
      "/etc/x",
      "C:/x",
      "c:x",
      ".git",
      ".git/config",
      "a/.GIT/x",
      ".git./x",
      ".git /x",
      "GIT~1/config",
      "git~2",
      "a/b:stream",
      "a//b",
      "./a",
    ])
      expect(isSafeRepoPath(p), p).toBe(false);
  });
});

describe("special files in place of Stet's (security review 2026-11-19)", () => {
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
});

describe("a path git won't take (test report v0.14, B7)", () => {
  it("is refused with a message, not a git error; never proposed", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "sub/.GIT/config", "[core]\n");
    edit(wt, "main.tex", "the problem", "the task");
    const r = await stet.submit("a", { title: "t" }).catch((x) => x);
    // Where file names ignore case (macOS, Windows), git takes `.GIT` for a `.git` folder and
    // skips it: the rest is submitted, the folder isn't. Elsewhere git refuses the path.
    if (git(wt, "config", "--bool", "--default", "false", "core.ignorecase") === "true") {
      expect(r.items.map((i: Item) => i.file)).toEqual(["main.tex"]);
    } else {
      expect(r?.constructor?.name).toBe("StetError");
      expect(String(r.message)).toMatch(/sub\/\.GIT/);
    }
  });
});
