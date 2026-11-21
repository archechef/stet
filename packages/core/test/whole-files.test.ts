/** Whole files: binary replacements, files that aren't UTF-8, and very large files. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lineDiff, textWithBadBytes } from "../src/text.js";
import { edit, git, PAPER, setup, write } from "./helpers.js";

describe("accepted binary replacements (Codex review 2026-09, F6)", () => {
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
    const r = (await stet.getItem(item!.id))!.resolution!;
    expect(r.committed).toBe(git(repo, "rev-parse", "HEAD"));
    expect(r.committedWithEdits).toBe(true);
  });
});

describe("renamed binary files (Codex review 2026-09)", () => {
  it("accepts a renamed binary file", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER, "a.bin": "" });
    writeFileSync(join(repo, "a.bin"), Buffer.from([0, 1, 2, 0]));
    git(repo, "commit", "-qam", "binary");
    const { worktree: wt } = await stet.newAgent("a");
    git(wt, "mv", "a.bin", "b.bin");
    const [item] = (await stet.submit("a", { title: "rename" })).items;
    expect(item).toMatchObject({ kind: "binary", file: "b.bin", oldFile: "a.bin" });
    await stet.accept([item!.id], { commit: false });
    expect(existsSync(join(repo, "a.bin"))).toBe(false);
    expect([...readFileSync(join(repo, "b.bin"))]).toEqual([0, 1, 2, 0]);
    await stet.agentStatus("a");
    expect((await stet.uncommittedAccepted()).map((i) => i.id)).toEqual([item!.id]);
    expect((await stet.commitAcceptedItems()).commit).not.toBeNull();
    expect(git(repo, "status", "--porcelain")).toBe("");
  });
});

describe("files that are not UTF-8 (test report v0.14, D1)", () => {
  it("accepts a change in a Latin-1 file byte for byte, and undoes it", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const latin = Buffer.from("Caf\u00e9 na\u00efve.\nLine two.\n", "latin1");
    writeFileSync(join(repo, "lat.tex"), latin);
    git(repo, "add", "lat.tex");
    git(repo, "commit", "-qm", "latin");
    const { worktree: wt } = await stet.newAgent("a");
    const changed = Buffer.from("Caf\u00e9 na\u00efve.\nLine 2, \u00e0 la carte.\n", "latin1");
    writeFileSync(join(wt, "lat.tex"), changed);
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("binary");
    await stet.accept([items[0]!.id]);
    expect(readFileSync(join(repo, "lat.tex")).equals(changed)).toBe(true);
    await stet.undo(items[0]!.id);
    expect(readFileSync(join(repo, "lat.tex")).equals(latin)).toBe(true);
  });

  it("refuses to change a file the user saved as Latin-1 since, and leaves it as it is", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    const mine = Buffer.from(PAPER.replace("In this work", "In this caf\u00e9"), "latin1");
    writeFileSync(join(repo, "main.tex"), mine);
    await expect(stet.accept([items[0]!.id])).rejects.toThrow(/not UTF-8/);
    expect(readFileSync(join(repo, "main.tex")).equals(mine)).toBe(true);
    expect((await stet.locateInWorkingCopy(items[0]!)).span).toBeNull();
  });
});

describe("text with bytes that aren't UTF-8", () => {
  it("a text file with a byte that isn't UTF-8 is shown as text, the byte marked (security report 5e4c6af, S7)", async () => {
    expect(textWithBadBytes(Buffer.from([0x61, 0x0a, 0x25, 0xff, 0x0a, 0x62]))).toBe("a\n%⟨0xFF⟩\nb");
    expect(textWithBadBytes(Buffer.from([0x00, 0x01]))).toBeNull();
    expect(lineDiff("a\nb\nc\nd\ne\nf", "a\nb\nc\nX\ne\nf", 1)).toEqual(["…", "  c", "- d", "+ X", "  e", "…"]);
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    writeFileSync(join(wt, "main.tex"), Buffer.concat([Buffer.from(PAPER), Buffer.from("%\xff\n\\immediate\\write18{x}\n", "latin1")]));
    const r = await stet.submit("a", { title: "t" });
    const it = r.items.find((i) => i.kind === "binary")!;
    expect(it.shownText?.new).toContain("%⟨0xFF⟩");
    expect(it.shownText?.new).toContain("\\immediate\\write18{x}");
  });
});

describe("very large files (test report v0.14, D10)", () => {
  it("refuses a file larger than maxFileMB", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "huge.tex", "x".repeat(21 * 1024 * 1024));
    await expect(stet.submit("a", { title: "t" })).rejects.toThrow(/huge\.tex is 21\.0 MB, more than the 20 MB/);
  });
});
