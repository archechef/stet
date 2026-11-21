/** The command line, run through the built CLI: messages, exit codes, and what review, show and the other commands say. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLI_DIST, edit, git, LABELLED, PAPER, read, setup, write } from "./helpers.js";

/** Run `stet` in `cwd`: exit code, output and errors (no colours: not a terminal). */
function stet(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [CLI_DIST, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!existsSync(CLI_DIST))("the command line", () => {
  it("says what is wrong with the command line, without a stack trace, and has --version (test report v0.14, B1)", async () => {
    const { repo } = await setup({ "main.tex": PAPER });
    for (const args of [["review", "--frob"], ["reject", "1.1", "-m"], ["--nope"]]) {
      const r = stet(repo, ...args);
      expect(r.code).toBe(2);
      expect(r.err).toMatch(/^error: .+ Run `stet --help`\.\n$/);
      expect(r.err).not.toMatch(/at .*\.js:\d+/);
    }
    for (const v of [["--version"], ["-v"], ["version"]]) expect(stet(repo, ...v).out).toMatch(/^stet \d+\.\d+\.\d+\n$/);
    expect(JSON.parse(stet(repo, "--version", "--json").out).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("review says when a paragraph is split, joined, or its break moved past a sentence", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    // "It scales …" leaves paragraph two to start paragraph three; and paragraph one is split.
    write(
      wt,
      "main.tex",
      read(wt, "main.tex")
        .replace("practice. It scales to large documents.\n\nAs shown", "practice.\n\nIt scales to large documents. As shown")
        .replace("changes. The changes", "changes.\n\nThe changes"),
    );
    await s.submit("a", { title: "t" });
    const out = stet(repo, "review").out;
    expect(out).toMatch(/paragraph split: "␣" → "¶"/);
    expect(out).toMatch(/paragraph break moved: /);
    expect(out).not.toMatch(/moved (in|out)/);
    const id = /(\d+\.\d+) pending main\.tex:\d+ {2}paragraph break moved/.exec(out)![1]!;
    // Only the breaks, made visible: not the sentence removed and added again.
    expect(stet(repo, "show", id).out).toContain("practice.[-␣-]{+¶+}It scales to large documents.[-¶-]{+␣+}As shown");
  });

  it("exit codes: 3 for an unknown id or name, 2 for a missing argument, 1 otherwise", async () => {
    const { repo } = await setup({ "main.tex": PAPER });
    expect(stet(repo, "show", "9.9").code).toBe(3);
    expect(stet(repo, "show", "G9").code).toBe(3);
    expect(stet(repo, "accept").code).toBe(2);
    expect(stet(repo, "show").code).toBe(2);
    expect(stet(repo, "undo", "9.9").code).toBe(3);
  });

  it("refuses a status or agent that doesn't exist instead of finding nothing (test report v0.14, B5)", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    await s.newAgent("a");
    const st = stet(repo, "review", "--status", "acepted");
    expect(st.code).toBe(2);
    expect(st.err).toMatch(/Unknown status 'acepted' \(use pending, needs_revision, accepted/);
    const ag = stet(repo, "review", "--agent", "nobody");
    expect(ag.code).toBe(3);
    expect(ag.err).toMatch(/Unknown agent 'nobody' \(there are: a\)/);
    expect(stet(repo, "review", "--status", "accepted,rejected").code).toBe(0);
    expect(stet(repo, "notes", "--agent", "nobody").code).toBe(3);
  });

  it("a revision says what it revises, and show gives the reviewer's request (test report v0.14, B4)", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const first = (await s.submit("a", { title: "t" })).items[0]!;
    await s.requestRevision(first.id, "Say 'the question' instead");
    await s.sync("a");
    edit(wt, "main.tex", "the task", "the question");
    const second = (await s.submit("a", { title: "t2" })).items[0]!;
    expect(second.supersedes).toBe(first.id);
    expect(stet(repo, "review").out).toContain(`(revises ${first.id})`);
    const show = stet(repo, "show", second.id).out;
    expect(show).toContain(`revises: ${first.id} (superseded), where you asked: Say 'the question' instead`);
  });

  it("show gives the wording that was accepted, and your wording before it is (test report v0.14, B11)", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const [it] = (await s.submit("a", { title: "t" })).items;
    await s.setDraft(it!.id, "the puzzle");
    expect(stet(repo, "show", it!.id).out).toMatch(/your wording \(not accepted yet\): .*the puzzle/);
    expect(stet(repo, "accept", it!.id, "--text", "the riddle").code).toBe(0);
    const show = stet(repo, "show", it!.id).out;
    expect(show).toMatch(/accepted with your wording: .*the riddle/);
    expect(show).toMatch(/the agent proposed: .*\{\+task\+\}/);
    expect(read(repo, "main.tex")).toContain("the riddle");
  });

  it("rejecting part of a linked group whose other part is accepted warns the reviewer, and show says so (test report v0.14, D3)", async () => {
    const { repo, stet: s } = await setup({ "main.tex": LABELLED });
    const { worktree: wt } = await s.newAgent("a");
    write(wt, "main.tex", read(wt, "main.tex").replaceAll("sec:intro", "sec:introduction"));
    const r = await s.submit("a", { title: "rename" });
    const g = r.groups.find((x) => /Rename label/.test(x.title))!;
    const label = r.items.find((i) => i.context.before.endsWith("\\label{") || i.newText.includes("\\label"))!;
    const refs = r.items.filter((i) => i !== label).map((i) => i.id);
    expect(stet(repo, "accept", ...refs).code).toBe(0);
    const rej = stet(repo, "reject", label.id, "-m", "keep the old label");
    expect(rej.code).toBe(0);
    expect(rej.out).toMatch(new RegExp(`! ${g.id} .* is a linked group, now partly accepted`));
    expect(stet(repo, "show", g.id).out).toMatch(/now partly accepted/);
  });

  it("commit names the files whose own edits it takes along (test report v0.14, D8)", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const [it] = (await s.submit("a", { title: "t" })).items;
    await s.accept([it!.id]);
    edit(repo, "main.tex", "It scales", "It also scales");
    const r = stet(repo, "commit");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/! Stet commits whole files: this includes your own edits in main\.tex\./);
    expect(git(repo, "log", "-1", "--format=%B")).toMatch(/Also the reviewer's own edits in main\.tex\./);
  });

  it("archive --remove refuses unsubmitted changes unless --force (test report v0.14, D4)", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const r = stet(repo, "agent", "archive", "a", "--remove");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/did not submit \(main\.tex\).*--force/s);
    expect(existsSync(wt)).toBe(true);
    expect(stet(repo, "agent", "archive", "a", "--remove", "--force").code).toBe(0);
    expect(existsSync(wt)).toBe(false);
  });

  it("whole-file changes show their size; whitespace changes are visible (test report v0.14, D10 and UX)", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    write(wt, "chapters/new.tex", "x".repeat(3000) + "\n");
    edit(wt, "main.tex", "Section~\\ref", "Section \\ref");
    await s.submit("a", { title: "t" });
    const out = stet(repo, "review").out;
    expect(out).toMatch(/add-file chapters\/new\.tex(:1)? \(3 KB\)/);
    expect(out).toMatch(/"~" → "␣"/);
  });

  it("refuses the reviewer's commands in an agent's workspace", async () => {
    const { stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const [it] = (await s.submit("a", { title: "t" })).items;
    for (const args of [["accept", it!.id], ["reject", it!.id], ["commit"], ["agent", "archive", "a"], ["share"]]) {
      const r = stet(wt, ...args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toMatch(/is for the reviewer, and this is an agent's workspace/);
    }
    expect((await s.getItem(it!.id))!.status).toBe("pending");
    expect(stet(wt, "status").code).toBe(0); // the agent's own commands still work
  });

  it("init: says when Stet is already set up, and warns about uncommitted edits", async () => {
    const { repo } = await setup({ "main.tex": PAPER });
    edit(repo, "main.tex", "It scales", "It also scales");
    const r = stet(repo, "init");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already set up/);
    expect(r.out).toMatch(/uncommitted edits\. Agents start from your last commit/);
    expect(r.out).not.toMatch(/Next: stet agent new/);
  });

  it("review: names accepted changes not committed, suggests next steps, and no share reminder without agents", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const none = stet(repo, "review").out;
    expect(none).toMatch(/Nothing to review\.\nCreate a workspace for an agent/);
    expect(none).not.toMatch(/stet share/);
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "It scales", "It grows");
    const items = (await s.submit("a", { title: "t" })).items;
    expect(stet(repo, "review").out).toMatch(/Next: stet show <id>/);
    await s.accept([items[0]!.id]);
    expect(stet(repo, "review").out).toMatch(
      new RegExp(`1 accepted change not committed yet \\(${items[0]!.id.replace(".", "\\.")}\\): \`stet commit\` finishes the review`),
    );
  });

  it("review: marks changes no longer found in your file, with what to do", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem of reviewing changes", "the task of reviewing changes");
    const [it] = (await s.submit("a", { title: "t" })).items;
    edit(repo, "main.tex", "In this work we study the problem of reviewing changes.", "Here we look at something else.");
    expect(stet(repo, "review").out).toMatch(
      new RegExp(`Not found in your file any more \\(you edited there\\): ${it!.id.replace(".", "\\.")}\\. Accept with your own text`),
    );
  });

  it("accepts and rejects a whole round by its id", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    edit(wt, "main.tex", "It scales", "It grows");
    const r1 = await s.submit("a", { title: "one" });
    const acc = stet(repo, "accept", r1.changeset!.id);
    expect(acc.code).toBe(0);
    expect((await s.listItems({ changeset: r1.changeset!.id })).every((i) => i.status === "accepted")).toBe(true);
    await s.sync("a");
    edit(wt, "main.tex", "effective in practice", "effective in real use");
    const r2 = await s.submit("a", { title: "two" });
    expect(stet(repo, "reject", r2.changeset!.id.toLowerCase(), "-m", "no").code).toBe(0);
    expect((await s.listItems({ changeset: r2.changeset!.id })).every((i) => i.status === "rejected")).toBe(true);
    expect(stet(repo, "accept", r2.changeset!.id).err).toMatch(/has no pending changes/);
    expect(stet(repo, "accept", "C99").code).toBe(3);
  });

  it("shows statuses in words, times in local time, and explains the diff markers", async () => {
    const { repo, stet: s } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await s.newAgent("a");
    edit(wt, "main.tex", "the problem", "the task");
    const [it] = (await s.submit("a", { title: "t" })).items;
    await s.requestRevision(it!.id, "Shorter, please");
    const show = stet(repo, "show", it!.id).out;
    expect(show).toMatch(/needs revision/);
    expect(show).not.toMatch(/needs_revision/);
    expect(show).toMatch(/\(\[-…-\] is removed, \{\+…\+\} is added\)/);
    expect(show).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} user: Shorter, please/);
    expect(stet(repo, "review", "--all").out).toMatch(/needs revision/);
  });
});
