/** Accepting: all or nothing, recovery after an interruption, checks before saving, and what needs confirming. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../src/doctor.js";
import { effectOf } from "../src/effects.js";
import { StetError } from "../src/errors.js";
import { edit, PAPER, read, setup, write } from "./helpers.js";

const sha = (s: string) => createHash("sha256").update(Buffer.from(s)).digest("hex");

const ACCEPTED = PAPER.replace("effective in practice", "effective in real use");

const LINES = Array.from({ length: 12 }, (_, i) => `Line ${i + 1} computes omega${i + 1} in every round.`).join("\n") + "\n";

describe("all-or-nothing accept (Codex review 2026-09, F4)", () => {
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

describe("recovery after an interrupted accept (Codex review 2026-09)", () => {
  it("stops at a record of an interrupted accept it can't read, and doctor says so (code quality report 6a517ae, swallowed errors)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    writeFileSync(join(stet.store.root, "txn.json"), '{"items": [');
    await expect(stet.agentStatus("a")).rejects.toThrow(/An accept was interrupted, and Stet can't read its record/);
    expect(existsSync(join(stet.store.root, "txn.json"))).toBe(true);
    const checks = await doctor(repo);
    expect(checks).toContainEqual(expect.objectContaining({ name: "review base", status: "error", message: expect.stringContaining("can't read its record") }));
  });

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
});

describe("files that take effect", () => {
  it("changes to files that take effect are accepted only when confirmed (security report 5e4c6af, S12)", async () => {
    expect(effectOf(".latexmkrc")).toMatch(/Perl/);
    expect(effectOf("chapters/latexmkrc")).toMatch(/Perl/);
    expect(effectOf(".vscode/tasks.json")).toMatch(/VS Code/);
    expect(effectOf("AGENTS.md")).toMatch(/instructions/);
    expect(effectOf("main.tex")).toBeNull();
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, ".latexmkrc", "$pdflatex = 'x';\n");
    const r = await stet.submit("a", { title: "t" });
    await expect(stet.accept(r.items.map((i) => i.id))).rejects.toThrow(/latexmk runs it as Perl code.*--confirm/);
    await stet.accept(
      r.items.map((i) => i.id),
      { confirmEffects: true },
    );
    expect(read(repo, ".latexmkrc")).toContain("pdflatex");
  });
});

describe("the end of a .bib file", () => {
  it("deleting the last .bib entry leaves no blank line at the end (test report 5e4c6af, B7)", async () => {
    const BIB = "@article{lamport94,\n  title = {LaTeX},\n  year = {1994}\n}\n";
    const BIB2 = BIB + "\n@book{knuth84,\n  title = {The TeXbook},\n  year = {1984}\n}\n";
    const { stet, repo } = await setup({ "main.typ": "Text.\n", "refs.bib": BIB2 });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "refs.bib", BIB);
    const r = await stet.submit("a", { title: "t" });
    await stet.accept(r.items.map((i) => i.id));
    expect(read(repo, "refs.bib")).toBe(BIB);
  });
});

describe("an accept that will fail is known before the editor saves (test report v0.16, D7)", () => {
  it("checkAccept judges the editor's unsaved text and writes nothing", async () => {
    const { stet, repo } = await setup({ "main.tex": LINES });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replace("omega3 in every round", "omega3 in all rounds"));
    const { items } = await stet.submit("a", { title: "t" });
    const id = items[0]!.id;
    // The unsaved buffer rewrote the sentence the change is in: the accept would fail.
    const buffer = LINES.replace("Line 3 computes omega3 in every round.", "Line 3 is gone.");
    await expect(stet.checkAccept([id], { unsaved: { "main.tex": buffer } })).rejects.toThrow(/could not be applied/);
    expect(read(repo, "main.tex")).toBe(LINES);
    expect((await stet.getItem(id))!.status).toBe("pending");
    expect((await stet.getItem(id))!.acceptFailed).toBeUndefined();
    // Unsaved edits elsewhere in the file don't stop it; nor do the linked-group checks differ from accept's.
    await stet.checkAccept([id], { unsaved: { "main.tex": LINES.replace("Line 1 ", "Line one ") } });
    await stet.checkAccept([id]);
  });
});

describe("what a failed accept says, for code to act on (code quality report 6a517ae)", () => {
  it("names the changes that can't be located, without its message being read", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", { title: "t" });
    edit(repo, "main.tex", "$a+b=c$", "$a + b = c$");
    const e = await stet.accept([items[0]!.id]).catch((x) => x);
    expect(e).toBeInstanceOf(StetError);
    expect(e.code).toBe("not_applied");
    expect(e.lost).toEqual([items[0]!.id]);
  });

  it("tells an unknown id, and a linked change rejected alone, apart from other failures", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing", "the task of reviewing");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.group(
      "a",
      items.map((i) => i.id),
      "linked",
      "Together",
      { reason: "they go together" },
    );
    expect(await stet.accept(["9.9"]).catch((x) => x.code)).toBe("not_found");
    expect(await stet.reject([items[0]!.id]).catch((x) => x.code)).toBe("linked");
  });
});
