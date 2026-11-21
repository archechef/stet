/** Service calls used by frontends (VS Code extension): locating in unsaved text, finishing a review, runtime config. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { edit, git, PAPER, read, setup } from "./helpers.js";

describe("frontend support", () => {
  it("signals every change to records in the store's folder, also without an event (bug report 2026-11-20)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "proposed by an AI", "proposed by an agent");
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(2);
    const marker = join(repo, ".git", "stet", "changed");
    const signalled = async (fn: () => Promise<unknown>) => {
      rmSync(marker, { force: true });
      await fn();
      return existsSync(marker);
    };
    // Reading signals nothing (the panel's own reloads would loop).
    expect(await signalled(() => Promise.all([stet.listItems(), stet.listGroups(), stet.listChangesets()]))).toBe(false);
    const { group } = await stet.group(
      "a",
      items.map((i) => i.id),
      "related",
      "Wording",
    );
    // Removing a group: items, changeset and group change, no event.
    expect(await signalled(() => stet.ungroup(group!.id, "a"))).toBe(true);
    // Merging changes into one: the old ones superseded, a new one made, no event.
    expect(
      await signalled(() =>
        stet.group(
          "a",
          items.map((i) => i.id),
          "atomic",
          "One change",
        ),
      ),
    ).toBe(true);
  });

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
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Wording");
    expect(git(repo, "log", "-1", "--format=%b")).toContain(`Stet-Applied: ${items[0]!.id}`);
    expect(git(repo, "log", "-1", "--format=%an")).toBe("Test User");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(read(repo, "main.tex")).toContain("It even scales to");
    expect(await stet.uncommittedAccepted()).toEqual([]);
    expect((await stet.commitAcceptedItems()).commit).toBeNull();
  });

  it("commits a whole review in one commit, with the user's summary line", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const c1 = (await stet.submit("a", { title: "Wording" })).items;
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    const c2 = (await stet.submit("a", { title: "Terms" })).items;
    await stet.accept([c1[0]!.id]);
    await stet.accept([c2[0]!.id]);
    expect(git(repo, "log", "--format=%s")).toBe("init");

    const { subject } = await stet.commitMessage(await stet.uncommittedAccepted());
    expect(subject).toBe("Wording; Terms");
    const r = await stet.commitAcceptedItems({ subject: "Polish the introduction" });
    expect(r.items.length).toBe(2);
    expect(git(repo, "log", "--format=%s")).toBe("Polish the introduction\ninit");
    const body = git(repo, "log", "-1", "--format=%b");
    expect(body).toContain(`- Wording (a, ${c1[0]!.changeset}): ${c1[0]!.id}`);
    expect(body).toContain(`Stet-Applied: ${c1[0]!.id},${c2[0]!.id}`);
  });

  it("saves only settings that differ from the defaults", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const saved = () => JSON.parse(readFileSync(join(stet.store.root, "config.json"), "utf8"));
    expect(saved()).toEqual({ mainBranch: "master" });
    expect((await stet.config()).autoCommit).toBe("on-finish");
    await stet.store.saveConfig({ ...(await stet.config()), autoCommit: "when-clean" });
    expect(saved()).toEqual({ mainBranch: "master", autoCommit: "when-clean" });
  });

  it("does not count items the user already committed", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id], { commit: false });
    git(repo, "commit", "-qam", "mine");
    expect(await stet.commitAcceptedItems()).toEqual({ commit: null, items: [], yourEdits: [] });
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
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toMatch(
      /^ELECTRON_RUN_AS_NODE='1' STET_PROJECT='.+' STET_AGENT='a' 'C:\/VS Code\/Code\.exe' 'C:\/p\/\.git\/stet\/bin\/stet\.mjs' guard$/,
    );
    expect(readFileSync(join(wt, ".codex/config.toml"), "utf8")).toContain(`env = { ELECTRON_RUN_AS_NODE = "1", STET_WORKSPACE = `);
  });
});
