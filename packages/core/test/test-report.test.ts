/** Findings of the test report of 2026-11-20 (Stet 0.14.0): each test reproduces a tester's scenario. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { edit, git, PAPER, read, setup, write } from "./helpers.js";
import { inlineDiff } from "../src/inline.js";
import { changeSummary, paragraphChange } from "../src/text.js";

/** PAPER with a label referred to twice. */
const LABELLED = PAPER.replace("The formula $a+b=c$ holds.", "The formula $a+b=c$ holds, see Section~\\ref{sec:intro}.");

/** The agent renames sec:intro everywhere: one auto linked group with a part per change. */
async function renamed() {
  const { stet, repo } = await setup({ "main.tex": LABELLED });
  const { worktree: wt } = await stet.newAgent("a");
  write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
  const r = await stet.submit("a", { title: "rename" });
  const g = r.groups.find((x) => x.kind === "linked" && /Rename label/.test(x.title))!;
  expect(g.parts?.length).toBeGreaterThan(1);
  const label = r.items.find((i) => i.newText.includes("\\label") || i.context.before.endsWith("\\label{"))!;
  return { stet, repo, wt, r, g, label, refs: r.items.filter((i) => i !== label) };
}

describe("D1: files that are not UTF-8", () => {
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

describe("D2: undo after deciding a linked group", () => {
  it("undoes everything the group's accept took along, not just one part", async () => {
    const { stet, repo, g, label } = await renamed();
    await stet.acceptGroup(g.id);
    expect(read(repo, "main.tex")).not.toContain("{sec:intro}");
    const r = await stet.undo(label.id);
    expect(r.reopened.length).toBe(g.items.length);
    expect(read(repo, "main.tex")).toBe(LABELLED);
  });

  it("still undoes parts accepted one at a time on their own", async () => {
    const { stet, repo, label, refs } = await renamed();
    await stet.accept(refs.map((i) => i.id)); // the same \ref change twice: one part
    await stet.accept([label.id]);
    const r = await stet.undo(label.id);
    expect(r.reopened.map((i) => i.id)).toEqual([label.id]);
    expect(read(repo, "main.tex")).toContain("\\ref{sec:introduction}");
  });

  it("takes back the revision requests of a rejection undone (reject --revise-rest)", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    const { items } = await stet.submit("a", {
      title: "together",
      groups: [{ kind: "linked", reason: "test of linked groups", title: "both", where: ["main.tex:4", "main.tex:8"] }],
    });
    await stet.reject([items[0]!.id], { mode: "revise-rest", reason: "no" });
    expect((await stet.getItem(items[1]!.id))!.status).toBe("needs_revision");
    const r = await stet.undo(items[0]!.id);
    expect(r.reopened.map((i) => i.id).sort()).toEqual(items.map((i) => i.id).sort());
    expect((await stet.getItem(items[1]!.id))!.status).toBe("pending");
  });
});

describe("D3: a linked group decided differently in its parts", () => {
  it("tells the reviewer, on the accept and on the reject", async () => {
    const { stet, label, refs } = await renamed();
    const acc = await stet.accept(refs.map((i) => i.id));
    // The label is still pending: that is said too (test report v0.16.0, D3).
    expect(acc.warnings.join(" ")).toMatch(/partly accepted: .* still to decide/);
    const rejected = await stet.reject([label.id]);
    const w = await stet.partlyDecided(rejected);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/partly accepted: .* accepted, .* rejected/);
    // And when the reject came first.
    await stet.undo(refs[0]!.id);
    const acc2 = await stet.accept(refs.map((i) => i.id));
    expect(acc2.warnings.join(" ")).toMatch(/partly accepted/);
  });
});

describe("D4: archiving an agent with its folder", () => {
  it("refuses to delete changes the agent did not submit, unless told to", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    await expect(stet.archiveAgent("a", { removeWorktree: true })).rejects.toThrow(/did not submit \(main\.tex\)/);
    expect(existsSync(wt)).toBe(true);
    expect((await stet.listAgents())[0]!.state).toBe("active");
    const r = await stet.archiveAgent("a", { removeWorktree: true, discardUnsubmitted: true });
    expect(r.worktreeRemoved).toBe(true);
  });

  it("deletes a folder with nothing unsubmitted without asking", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    await stet.submit("a", { title: "t" });
    expect((await stet.archiveAgent("a", { removeWorktree: true })).worktreeRemoved).toBe(true);
  });
});

describe("D6: a new file and what reads it in", () => {
  it("links an added chapter with its \\input, and a figure with its \\includegraphics", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "chapters/discussion.tex", "\\section{Discussion}\nIt works.\n");
    write(wt, "figs/plot.pdf", "%PDF-1.4\n\u0000binary\n");
    edit(wt, "main.tex", "\\end{document}", "\\input{chapters/discussion}\n\\includegraphics[width=3cm]{figs/plot}\n\\end{document}");
    const r = await stet.submit("a", { title: "t" });
    const linked = r.groups.filter((g) => g.kind === "linked");
    const of = (f: string) => r.items.find((i) => i.file === f)!.id;
    const main = r.items.filter((i) => i.file === "main.tex").map((i) => i.id);
    expect(linked.some((g) => g.items.includes(of("chapters/discussion.tex")) && g.items.some((i) => main.includes(i)))).toBe(true);
    expect(linked.some((g) => g.items.includes(of("figs/plot.pdf")) && g.items.some((i) => main.includes(i)))).toBe(true);
  });

  it("links a deleted chapter with the \\input taken out", async () => {
    const { stet } = await setup({ "main.tex": PAPER.replace("\\end{document}", "\\input{old}\n\\end{document}"), "old.tex": "Old.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    git(wt, "rm", "-q", "old.tex");
    edit(wt, "main.tex", "\\input{old}\n", "");
    const r = await stet.submit("a", { title: "t" });
    expect(r.groups.some((g) => g.kind === "linked" && g.items.length === 2 && /Delete old\.tex/.test(g.title))).toBe(true);
  });
});

describe("D7: whitespace in verbatim text", () => {
  const DOC = "\\begin{document}\nText.\n\\begin{lstlisting}\nx  =  1\n\\end{lstlisting}\n\\begin{verbatim}\na    b\n\\end{verbatim}\n\\end{document}\n";
  it("proposes a change of spaces in a listing or verbatim block", async () => {
    const { stet, repo } = await setup({ "main.tex": DOC });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "x  =  1", "x = 1");
    edit(wt, "main.tex", "a    b", "a b");
    const { items } = await stet.submit("a", { title: "ws" });
    expect(items.length).toBeGreaterThan(0);
    await stet.accept(items.map((i) => i.id));
    expect(read(repo, "main.tex")).toBe(read(wt, "main.tex"));
  });
});

describe("D8: committing whole files", () => {
  it("names the files where the commit takes the reviewer's own edits along", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER, "other.tex": "Other.\n" });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "other.tex", "Other.", "Another.");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept(items.map((i) => i.id));
    edit(repo, "main.tex", "It scales", "It also scales");
    const r = await stet.commitAcceptedItems();
    expect(r.yourEdits).toEqual(["main.tex"]);
    expect(git(repo, "log", "-1", "--format=%B")).toMatch(/Also the reviewer's own edits in main\.tex\./);
  });

  it("names none when the files hold only the accepted changes", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept(items.map((i) => i.id), { edited: { [items[0]!.id]: "the job" } });
    expect((await stet.commitAcceptedItems()).yourEdits).toEqual([]);
  });
});

describe("D9: a commit with accepted changes dropped from main", () => {
  it("makes the change pending again when git reset --hard took it out", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    await stet.commitAcceptedItems();
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    await stet.missingFromBase(); // any locked operation notices
    const it = (await stet.getItem(items[0]!.id))!;
    expect(it.status).toBe("pending");
    expect(it.history.at(-1)!.note).toMatch(/no longer on master \(git reset\?\)/);
    await stet.accept([it.id]);
    expect(read(repo, "main.tex")).toContain("the task");
  });

  it("makes it uncommitted again when the working copy still has it (git reset --mixed)", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    await stet.commitAcceptedItems();
    git(repo, "reset", "-q", "HEAD~1");
    await stet.missingFromBase();
    const it = (await stet.getItem(items[0]!.id))!;
    expect(it.status).toBe("accepted");
    expect(it.resolution!.committed).toBeNull();
    await stet.undo(it.id);
    expect(read(repo, "main.tex")).toBe(PAPER);
  });
});

describe("D10: very large files", () => {
  it("refuses a file larger than maxFileMB", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "huge.tex", "x".repeat(21 * 1024 * 1024));
    await expect(stet.submit("a", { title: "t" })).rejects.toThrow(/huge\.tex is 21\.0 MB, more than the 20 MB/);
  });
});

describe("B2: an archived agent's name", () => {
  it("can be used again once its folder and branch are gone", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a2");
    await stet.archiveAgent("a2");
    await expect(stet.newAgent("a2")).rejects.toThrow(/archived, but its folder or branch is still there/);
    await stet.archiveAgent("a2", { removeWorktree: true });
    const again = await stet.newAgent("a2");
    expect(again.state).toBe("active");
    expect(existsSync(again.worktree)).toBe(true);
  });
});

describe("B6: MCP tool arguments", () => {
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

describe("B7: a path git won't take", () => {
  it("is refused with a message, not a git error", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "sub/.GIT/config", "[core]\n");
    edit(wt, "main.tex", "the problem", "the task");
    const e = await stet.submit("a", { title: "t" }).catch((x) => x);
    expect(e?.constructor?.name).toBe("StetError");
    expect(String(e.message)).toMatch(/sub\/\.GIT/);
  });
});

describe("B4, UX: change summaries", () => {
  it("show where two long texts differ, and whitespace", async () => {
    const { changeSummary } = await import("../src/text.js");
    const [o, n] = changeSummary("\\begin{equation} r = \\frac{\\ln(N_t) - \\ln(N_0)}{t}, \\label{eq:growth} \\end{equation}", "\\begin{equation} r = \\frac{\\ln N_t - \\ln N_0}{t}, \\label{eq:growth} \\end{equation}");
    expect(o).not.toBe(n);
    expect(o).toContain("\\ln(N_t)");
    expect(n).toContain("\\ln N_t");
    expect(changeSummary(" ", "~")).toEqual(["␣", "~"]);
    expect(changeSummary(" ", "\n\n")).toEqual(["␣", "¶"]);
    expect(changeSummary("short", "text")).toEqual(["short", "text"]);
  });
});

describe("B3: many changes in one long file", () => {
  /** `n` lines of words from a 16-word vocabulary (every paragraph shares its words with every other), a blank every tenth. */
  function lines(n: number) {
    const vocab = "alpha beta gamma delta method result theorem proof lemma paper study analysis data model system approach".split(" ");
    let seed = 3;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: n }, (_, i) => (i % 10 === 9 ? "" : Array.from({ length: 12 }, () => vocab[Math.floor(r() * vocab.length)]).join(" ") + ` line${i}.`));
  }

  it("submits an edit in each of 150 paragraphs quickly, each paragraph its own change", async () => {
    const before = lines(1500);
    const after = before.map((l, i) => (i % 10 === 3 ? l.replace(" ", " very ") : l));
    const { stet, repo } = await setup({ "big.tex": before.join("\n") + "\n" });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "big.tex", after.join("\n") + "\n");
    const t0 = performance.now();
    const { items } = await stet.submit("a", { title: "t" });
    // Before: about 40 s (every pair of the 150 paragraphs diffed word by word).
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(items).toHaveLength(150);
    expect(items.every((i) => i.oldText === "" && i.newText.trim() === "very")).toBe(true);
    // Each change is where it belongs, and accepting them all gives the agent's file.
    await stet.accept(items.map((i) => i.id));
    expect(read(repo, "big.tex")).toBe(after.join("\n") + "\n");
  }, 60_000);

  it("pairs a long region the same way, with paragraphs added, removed and rewritten among the edits", async () => {
    const before = lines(800).filter((l) => l);
    const after = before.flatMap((l, i) =>
      i % 9 === 0 ? [] : i % 13 === 0 ? [l, "A new paragraph about something else entirely."] : i % 5 === 0 ? [l.replace(/\w+/, "changed")] : [l],
    );
    const doc = (ls: string[]) => ls.join("\n\n") + "\n";
    const { stet, repo } = await setup({ "big.tex": doc(before) });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "big.tex", doc(after));
    const { items } = await stet.submit("a", { title: "t" });
    expect(items.length).toBeGreaterThan(100);
    // No change swallows a neighbouring paragraph: none crosses a paragraph break both ways.
    expect(items.filter((i) => i.oldText.includes("\n\n") && i.newText.includes("\n\n") && i.oldText !== i.newText).length).toBe(0);
    await stet.accept(items.map((i) => i.id), { overrideLinked: true });
    expect(read(repo, "big.tex")).toBe(doc(after));
  }, 60_000);

  it("locateMany finds what locateInWorkingCopy finds, item by item", async () => {
    const { stet, repo } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "$a+b=c$", "$a+b=d$");
    edit(wt, "main.tex", "It scales", "It also scales");
    const { items } = await stet.submit("a", { title: "t" });
    await stet.accept([items[0]!.id]);
    edit(repo, "main.tex", "\\section{Introduction}", "\\section{Introduction}\nA line of mine.");
    const pending = items.slice(1);
    const many = await stet.locateMany(pending);
    for (const it of pending) expect(many.get(it.id)).toEqual(await stet.locateInWorkingCopy(it));
    const inText = await stet.locateMany(pending, read(repo, "main.tex"));
    for (const it of pending) expect(inText.get(it.id)!.span).toEqual(await stet.locateInText(it, read(repo, "main.tex")));
  });

  it("the read-only items within a locked operation follow its writes", async () => {
    const { Store } = await import("../src/store.js");
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const { items } = await stet.submit("a", { title: "t" });
    const store: InstanceType<typeof Store> = (stet as any).store;
    await store.withLock(async () => {
      const a = await store.itemsReadOnly();
      expect(await store.itemsReadOnly()).toBe(a); // shared, not read again
      const it = (await store.getItem(items[0]!.id))!;
      it.note = "changed";
      await store.putItem(it);
      const b = await store.itemsReadOnly();
      expect(b).not.toBe(a);
      expect(b.find((i) => i.id === it.id)!.note).toBe("changed");
    });
    // Outside the lock: a fresh read each time.
    expect((await store.itemsReadOnly()).find((i) => i.id === items[0]!.id)!.note).toBe("changed");
  });
});

describe("B10: git identity from the environment", () => {
  it("counts for stet doctor", async () => {
    const { doctor } = await import("../src/doctor.js");
    const { repo } = await setup({ "main.tex": PAPER });
    git(repo, "config", "--unset", "user.name");
    git(repo, "config", "--unset", "user.email");
    const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      Object.assign(process.env, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
      const check = async () => (await doctor(repo)).find((c) => c.name === "git identity")!;
      expect((await check()).status).toBe("warn");
      Object.assign(process.env, { GIT_AUTHOR_NAME: "Env User", GIT_AUTHOR_EMAIL: "env@example.com", GIT_COMMITTER_NAME: "Env User", GIT_COMMITTER_EMAIL: "env@example.com" });
      const ok = await check();
      expect(ok.status).toBe("ok");
      expect(ok.message).toBe("Env User <env@example.com> (from the environment)");
    } finally {
      for (const k of keys) if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
});

describe("D7: verbatim text", () => {
  it("still ignores reflowed text outside verbatim blocks", async () => {
    const DOC = "\\begin{document}\nSome text that is\nwrapped here.\n\\begin{verbatim}\na  b\n\\end{verbatim}\n\\end{document}\n";
    const { stet } = await setup({ "main.tex": DOC });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "main.tex", "Some text that is\nwrapped here.", "Some text that is wrapped\nhere.");
    const { items } = await stet.submit("a", { title: "reflow" });
    expect(items).toHaveLength(0);
  });
});

describe("D6: edits that rebuild one sentence", () => {
  const S = "Plants are sessile organisms and therefore cannot escape stress.";
  const doc = (s: string) => `\\begin{document}\nIntroduction. ${s} More text follows here.\n\\end{document}\n`;
  async function submitted(after: string) {
    const { stet, repo } = await setup({ "main.tex": doc(S) });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", doc(after));
    return { ...(await stet.submit("a", { title: "t" })), stet, repo };
  }

  it("are one change (the tester's sentence)", async () => {
    const after = "Because plants are sessile organisms, they cannot escape stress.";
    const { items, stet, repo } = await submitted(after);
    expect(items).toHaveLength(1);
    await stet.accept([items[0]!.id]);
    expect(read(repo, "main.tex")).toBe(doc(after));
  });

  it("but word swaps a few words apart stay apart", async () => {
    const { items } = await submitted("Plants are immobile organisms and therefore cannot avoid stress.");
    expect(items.map((i) => [i.oldText, i.newText])).toEqual([["sessile", "immobile"], ["escape", "avoid"]]);
  });

  it("and so do edits in different sentences, or far apart", async () => {
    const far = await submitted("Plants are sessile organisms and therefore, sadly, cannot escape any stress.");
    expect(far.items.length).toBeGreaterThanOrEqual(1);
    const two = await submitted(S.replace("Plants", "Trees"));
    expect(two.items).toHaveLength(1);
    const { stet, repo } = await setup({ "main.tex": doc(S) });
    const { worktree: wt } = await stet.newAgent("a");
    write(wt, "main.tex", doc(S).replace("Introduction.", "Introduction, briefly.").replace("Plants are", "Trees are"));
    const { items } = await stet.submit("a", { title: "t" });
    expect(items).toHaveLength(2); // one sentence ends between them
    void repo;
  });
});

describe("Split and joined paragraphs (a paragraph break moved past a sentence)", () => {
  const PARAS = `\\documentclass{article}
\\begin{document}
\\section{Intro}
Alpha one is the first sentence of the first paragraph here and it
goes on for a while. Beta two is the second sentence of that same
first paragraph, also somewhat long to fill a line.

Gamma three opens the second paragraph with some words that wrap
onto another line. Delta four closes the second paragraph with more
words that also wrap.

Epsilon five is a third paragraph standing on its own with words
that wrap around as well, like the others do here.

Zeta six is the last paragraph, kept so the document has a tail
that does not change at all in any of the cases.
\\end{document}
`;
  async function submitted(change: (s: string) => string) {
    const { stet, repo } = await setup({ "main.tex": PARAS });
    const { worktree: wt } = await stet.newAgent("a");
    const after = change(PARAS);
    write(wt, "main.tex", after);
    return { ...(await stet.submit("a", { title: "t" })), stet, repo, after };
  }
  // "Beta two …" ends paragraph one: it starts paragraph two instead (the tester's split + merge).
  const down = (s: string) => s.replace("while. Beta", "while.\n\nBeta").replace("line.\n\nGamma", "line. Gamma");
  // "Gamma three …" starts paragraph two: it ends paragraph one instead.
  const up = (s: string) => s.replace("line.\n\nGamma", "line. Gamma").replace("another line. Delta", "another line.\n\nDelta");

  it("is one change, not a move 'word for word', and accepts and undoes as one", async () => {
    for (const change of [down, up]) {
      const { items, stet, repo, after } = await submitted(change);
      expect(items).toHaveLength(1);
      expect(items[0]!.move).toBeUndefined();
      expect(paragraphChange(items[0]!.oldText, items[0]!.newText)).toBe("paragraph break moved");
      await stet.accept([items[0]!.id]);
      expect(read(repo, "main.tex")).toBe(after);
      await stet.undo(items[0]!.id);
      expect(read(repo, "main.tex")).toBe(PARAS);
    }
  });

  it("is one change too with a word of the sentence changed", async () => {
    const { items } = await submitted((s) => down(s).replace("the second sentence of", "the 2nd sentence of"));
    expect(items).toHaveLength(1);
    expect(items[0]!.move).toBeUndefined();
    expect(items[0]!.newText).toContain("2nd");
  });

  it("but a paragraph moved past another stays a move", async () => {
    const third = "Epsilon five is a third paragraph standing on its own with words\nthat wrap around as well, like the others do here.";
    const { items } = await submitted((s) => s.replace(`\n\n${third}`, "").replace("Alpha one", `${third}\n\nAlpha one`));
    expect(items.some((i) => i.move)).toBe(true);
  });

  it("names a split, a join and a moved break, and summarises each side at its break", () => {
    expect(paragraphChange(" ", "\n\n")).toBe("paragraph split");
    expect(paragraphChange("\n\n", " ")).toBe("paragraphs joined");
    expect(paragraphChange("a. b.\n\n", "a.\n\nb. ")).toBe("paragraph break moved");
    expect(paragraphChange("a b", "a c")).toBeNull();
    expect(paragraphChange("a b", "a\nb")).toBeNull(); // a line break: no paragraph
    const o = " Beta two is the second sentence of that same\nfirst paragraph, also long to fill a line.\n\n";
    const n = "\n\nBeta two is the second sentence of that same\nfirst paragraph, also long to fill a line. ";
    const [a, b] = changeSummary(o, n, 28);
    expect(a).toMatch(/^….*line\.¶$/);
    expect(b).toMatch(/^¶Beta two .*…$/);
    expect(a.length).toBeLessThanOrEqual(28);
    expect(b.length).toBeLessThanOrEqual(28);
  });

  it("shows only the breaks in the editor, not the whole text struck through", () => {
    const o = " Beta two is long.\n\n";
    const n = "\n\nBeta two is long. ";
    const d = inlineDiff(o, n);
    expect(d.removed).toEqual([[0, 1], [o.length - 2, o.length]]);
    expect(d.inserted).toEqual([{ at: 1, text: "\n\n" }, { at: o.length, text: " " }]);
  });
});
