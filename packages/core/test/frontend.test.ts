/** Service calls used by frontends (VS Code extension): locating in unsaved text, finishing a review, runtime config. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { edit, git, PAPER, read, setup } from "./helpers.js";

describe("frontend support", () => {
  it("locates items in unsaved editor text", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const [item] = (await stet.submit("a", { title: "t" })).items;
    // The user typed above the change without saving.
    const buffer = "% a note\n" + PAPER.replace("We show", "Thus we show");
    const span = (await stet.locateInText(item!, buffer))!;
    expect(buffer.slice(span.start, span.end)).toBe(item!.oldText);
    expect(await stet.locateInText(item!, PAPER.replace("practice", "theory"))).toBeNull();
  });

  it("commits accepted items that were left uncommitted (Finish review)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "Wording" });
    edit(repo, "main.tex", "It scales to", "It even scales to");
    expect((await stet.accept([items[0]!.id])).committed).toBeNull();
    expect((await stet.uncommittedAccepted()).map((i) => i.id)).toEqual([items[0]!.id]);

    const r = await stet.commitAcceptedItems();
    expect(r.commit).not.toBeNull();
    expect(r.items.map((i) => i.id)).toEqual([items[0]!.id]);
    expect(git(repo, "log", "-1", "--format=%s")).toContain(`stet: accept ${items[0]!.id}`);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(read(repo, "main.tex")).toContain("It even scales to");
    expect(await stet.uncommittedAccepted()).toEqual([]);
    expect((await stet.commitAcceptedItems()).commit).toBeNull();
  });

  it("does not count items the user already committed", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id], { commit: false });
    git(repo, "commit", "-qam", "mine");
    expect(await stet.commitAcceptedItems()).toEqual({ commit: null, items: [] });
  });

  it("records the runtime command and rewrites agent workspaces, including env", async () => {
    const { stet } = await setup({ "main.tex": PAPER }, { cli: { command: "/usr/bin/node", args: ["/a/stet.mjs"] } });
    const { worktree: wt } = await stet.newAgent("a");
    const cli = { command: "C:/VS Code/Code.exe", args: ["C:/p/.git/stet/bin/stet.mjs"], env: { ELECTRON_RUN_AS_NODE: "1" } };
    expect(await stet.setCli(cli)).toBe(true);
    expect(await stet.setCli(cli)).toBe(false);
    expect((await stet.config()).cli).toEqual(cli);

    const mcp = JSON.parse(readFileSync(join(wt, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.stet).toMatchObject({ command: cli.command, args: [...cli.args, "mcp"], env: { ELECTRON_RUN_AS_NODE: "1" } });
    const settings = JSON.parse(readFileSync(join(wt, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(`ELECTRON_RUN_AS_NODE="1" "C:/VS Code/Code.exe" "C:/p/.git/stet/bin/stet.mjs" guard`);
    expect(readFileSync(join(wt, ".codex/config.toml"), "utf8")).toContain(`env = { ELECTRON_RUN_AS_NODE = "1", STET_WORKSPACE = `);
  });
});
