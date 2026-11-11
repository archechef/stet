import { describe, expect, it } from "vitest";
import { describeNote } from "../src/notes.js";
import { describeFeedback } from "../src/mcp.js";
import { edit, PAPER, setup } from "./helpers.js";

describe("reviewer notes", () => {
  it("arrive at the agent's next sync, located in its workspace, once", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    await stet.newAgent("b");
    const n = await stet.addNote("a", { file: "main.tex", fromLine: 6, toLine: 6 }, "Tone this claim down.");
    expect(n.id).toBe("N1");
    expect(n.text).toBe("We show that this approach is effective in practice. It scales to large documents.");

    expect((await stet.agentStatus("a")).notesWaiting).toBe(1);
    expect((await stet.agentStatus("b")).notesWaiting).toBe(0);
    const r = await stet.sync("a");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]!.lines).toEqual({ from: 6, to: 6 });
    expect(describeNote(r.notes[0]!)).toMatch(/^NOTE N1 from the reviewer on main\.tex:6: Tone this claim down\./);
    expect((await stet.agentStatus("a")).notesWaiting).toBe(0);
    expect((await stet.sync("a")).notes).toEqual([]);
    expect((await stet.sync("b")).notes).toEqual([]);
  });

  it("arrive even when the sync refuses, and find the passage after the agent's edits", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const { worktree: wt } = await stet.newAgent("a");
    const text = PAPER;
    const start = text.indexOf("effective in practice");
    await stet.addNote("a", { file: "main.tex", start, end: start + "effective in practice".length }, "Say how effective.");
    edit(wt, "main.tex", "\\section{Introduction}", "\\section{Introduction}\nA new first line.\n");
    await expect(stet.sync("a")).rejects.toThrow(/uncommitted changes[\s\S]*NOTE N1 from the reviewer on main\.tex:8: Say how effective/);
    expect((await stet.agentStatus("a")).notesWaiting).toBe(0);
  });

  it("say so when the passage can't be found", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    // A passage only in the reviewer's editor (unsaved), which the agent's copy doesn't have.
    const mine = PAPER.replace("\\end{document}", "A paragraph only I have so far, still unsaved.\n\\end{document}");
    const start = mine.indexOf("A paragraph only");
    await stet.addNote("a", { file: "main.tex", start, end: start + 20, text: mine }, "Expand this.");
    const [d] = (await stet.sync("a")).notes;
    expect(d!.lines).toBeNull();
    expect(describeNote(d!)).toMatch(/could not be found in your workspace any more; it read: "A paragraph only I h"/);
  });

  it("carry a conversation: early replies come with the note, later ones as feedback", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    const n = await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Too long.");
    await stet.replyNote(n.id, "Especially the second sentence.", "user");
    const [d] = (await stet.sync("a")).notes;
    expect(describeNote(d!)).toMatch(/Reviewer: Especially the second sentence\./);
    expect(await stet.feedback("a")).toEqual([]);

    await stet.replyNote(n.id, "Shall I merge the two sentences?", "agent");
    await stet.replyNote(n.id, "Yes.", "user");
    await stet.resolveNote(n.id);
    const fb = await stet.feedback("a");
    expect(fb.map((e) => e.type)).toEqual(["note_comment", "note_resolved"]);
    expect(describeFeedback(fb[0]!)).toBe("REVIEWER ON NOTE N1 (main.tex): Yes. (answer with stet_reply)");
    expect((await stet.getNote("n1")).thread.map((t) => t.author)).toEqual(["user", "agent", "user"]);
  });

  it("are not delivered once resolved, and close when the agent is archived", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    const n1 = await stet.addNote("a", { file: "main.tex", fromLine: 4 }, "One.");
    await stet.addNote("a", { file: "main.tex", fromLine: 6 }, "Two.");
    await stet.resolveNote(n1.id);
    expect((await stet.sync("a")).notes.map((d) => d.note.body)).toEqual(["Two."]);
    await stet.addNote("a", { file: "main.tex", fromLine: 8 }, "Three.");
    await stet.archiveAgent("a");
    expect(await stet.listNotes({ state: "open" })).toEqual([]);
    await expect(stet.addNote("a", { file: "main.tex", fromLine: 4 }, "Four.")).rejects.toThrow(/archived/);
  });

  it("refuse paths outside the project and empty notes", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    await stet.newAgent("a");
    await expect(stet.addNote("a", { file: "../x.tex", fromLine: 1 }, "x")).rejects.toThrow(/not a file in the project/);
    await expect(stet.addNote("a", { file: "missing.tex", fromLine: 1 }, "x")).rejects.toThrow(/does not exist/);
    await expect(stet.addNote("a", { file: "main.tex", fromLine: 1 }, "  ")).rejects.toThrow(/empty/);
  });
});
