/** Service calls used by frontends (VS Code extension): locating in unsaved text, finishing a review, runtime config. */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeItem, firstLines, SHOWN_LINES } from "../src/describe.js";
import { canUndo, type Group, type Item, isAccepted, isUncommitted, linkedRest, parseId, pendingInRound } from "../src/model.js";
import { Stet } from "../src/service.js";
import { edit, git, makeItem, PAPER, read, setup, write } from "./helpers.js";

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
    const cfg = { ...(await stet.config()), autoCommit: "when-clean" as const };
    await stet.store.withLock(() => stet.store.saveConfig(cfg));
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

describe("rules both front ends share (code quality report 6a517ae, refactoring 4)", () => {
  it("reads ids the same way everywhere", () => {
    expect(parseId("g3")).toEqual({ kind: "group", id: "G3" });
    expect(parseId("G3.2")).toEqual({ kind: "part", id: "G3.2", group: "G3", index: 1 });
    expect(parseId(" c12 ")).toEqual({ kind: "round", id: "C12" });
    expect(parseId("n4")).toEqual({ kind: "note", id: "N4" });
    expect(parseId("12.3")).toEqual({ kind: "item", id: "12.3" });
    expect(parseId("G3.0").kind).toBe("item"); // no part 0: not found as a change
  });

  it("can undo a rejection, a revision request and an accept until it is committed", () => {
    const r = (committed: string | null) => ({ appliedText: "x", edited: false, committed });
    expect(canUndo(makeItem("a", "b", { status: "rejected" }))).toBe(true);
    expect(canUndo(makeItem("a", "b", { status: "needs_revision" }))).toBe(true);
    expect(canUndo(makeItem("a", "b", { status: "accepted", resolution: r(null) }))).toBe(true);
    expect(canUndo(makeItem("a", "b", { status: "accepted", resolution: r("abc") }))).toBe(false);
    expect(canUndo(makeItem("a", "b", { status: "pending" }))).toBe(false);
    expect(canUndo(makeItem("a", "b", { status: "stale" }))).toBe(false);
  });

  it("tells accepted items, with their resolution, and those not committed yet (code quality report 6a517ae, Item types)", () => {
    const r = (committed: string | null) => ({ appliedText: "x", edited: false, committed });
    const open = makeItem("a", "b", { status: "accepted", resolution: r(null) });
    const done = makeItem("a", "b", { status: "accepted", resolution: r("abc") });
    expect([isAccepted(open), isUncommitted(open)]).toEqual([true, true]);
    expect([isAccepted(done), isUncommitted(done)]).toEqual([true, false]);
    // A pending item has no resolution; an accepted one without (a damaged record) counts as not accepted.
    expect(isAccepted(makeItem("a", "b"))).toBe(false);
    expect(isAccepted(makeItem("a", "b", { status: "accepted", resolution: null }))).toBe(false);
    const all = [open, done, makeItem("a", "b")];
    expect(all.filter(isUncommitted).map((i) => i.resolution.appliedText)).toEqual(["x"]);
  });

  it("decides a change with the rest of its linked part and of its move, and the move's linked groups", () => {
    const items = new Map<string, Item>();
    const add = (id: string, extra: Partial<Item> = {}) => items.set(id, makeItem("a", "b", { id, ...extra }));
    const group = (id: string, members: string[], parts?: string[][]): Group => ({
      id,
      agent: "a",
      changeset: "C1",
      kind: "linked",
      title: "t",
      rationale: null,
      source: "auto",
      items: members,
      state: "open",
      ...(parts ? { parts: parts.map((p, k) => ({ title: `part ${k + 1}`, items: p })) } : {}),
    });
    const groups = new Map([
      ["G1", group("G1", ["1.1", "1.2", "1.3"], [["1.1", "1.2"], ["1.3"]])],
      ["G2", group("G2", ["1.5", "1.6"])],
    ]);
    add("1.1", { groups: ["G1"] });
    add("1.2", { groups: ["G1"] });
    add("1.3", { groups: ["G1"] });
    // A move: 1.4 takes the text out, 1.5 puts it in; 1.5 is linked with 1.6.
    const move = { from: ["1.4"], to: ["1.5"], changed: 0 };
    add("1.4", { move });
    add("1.5", { move, groups: ["G2"] });
    add("1.6", { groups: ["G2"] });
    add("1.7", { status: "accepted", groups: ["G2"] });
    const look = { item: (id: string) => items.get(id), group: (id: string) => groups.get(id) };
    const ids = (xs: Item[]) => xs.map((i) => i.id);
    expect(ids(linkedRest(["1.1"], look))).toEqual(["1.2"]);
    expect(ids(linkedRest(["1.3"], look))).toEqual([]);
    expect(ids(linkedRest(["1.4"], look))).toEqual(["1.5", "1.6"]);
    expect(ids(linkedRest(["1.1", "1.2"], look))).toEqual([]);
    expect(ids(pendingInRound([...items.values()], "C1"))).toEqual(["1.1", "1.2", "1.3", "1.4", "1.5", "1.6"]);
  });

  it("describes a change once: what it revises, your wording, its move, and the first lines of a whole file", () => {
    const asked = makeItem("problem", "issue", { status: "superseded", thread: [{ at: "", author: "user", text: "shorter, please" }] });
    const rev = makeItem("problem", "task", { supersedes: asked.id, draft: "job" });
    const get = (id: string) => [asked, rev].find((i) => i.id === id);
    const d = describeItem(rev, get);
    expect(d.revises).toEqual({ id: asked.id, item: asked, asked: "shorter, please" });
    expect(d.yours).toEqual({ text: "job", accepted: false });
    expect(d.move).toBeNull();
    const accepted = describeItem({ ...rev, draft: undefined, status: "accepted", resolution: { appliedText: "chore", edited: true, committed: null } }, get);
    expect(accepted.yours).toEqual({ text: "chore", accepted: true });

    const file = makeItem("", Array.from({ length: SHOWN_LINES + 5 }, (_, k) => `line ${k}`).join("\n"), { kind: "add-file", file: "new.tex" });
    const whole = describeItem(file, () => undefined).whole!;
    expect(firstLines(whole.new)).toEqual({ shown: whole.new.slice(0, SHOWN_LINES), more: 5 });
    expect(whole.old).toEqual([]);
  });

  it("knows before setup whether a folder is set up, an agent's workspace, and of which languages", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER, "notes.typ": "= Notes\n", "more.typ": "= More\n" });
    const set = await Stet.inspectSetup(repo);
    expect(set.setUp).toBe(true);
    expect(set.languages).toEqual([
      ["typst", 2],
      ["latex", 1],
    ]);
    expect(set.located.agentWorkspace).toBe(false);
    const { worktree } = await stet.newAgent("a");
    expect((await Stet.locate(worktree)).agentWorkspace).toBe(true);
    expect(await stet.uncommittedEdits()).toBe(false);
    write(repo, "main.tex", `${PAPER}\nMore.\n`);
    expect(await stet.uncommittedEdits()).toBe(true);
    rmSync(join(repo, ".git", "stet"), { recursive: true });
    expect((await Stet.inspectSetup(repo)).setUp).toBe(false);
  });
});
