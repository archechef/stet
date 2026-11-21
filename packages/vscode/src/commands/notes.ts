/** Reviewer notes (spec §7.8) and replies in comment threads. */
import { isNoteId, type Note } from "@stet/core";
import * as vscode from "vscode";
import { announce } from "../announce.js";
import type { Threads } from "../comments.js";
import type { El } from "../common.js";
import type { StetExtension } from "../extension.js";
import type { Project } from "../project.js";
import { LineIndex, toLf } from "../text.js";

export class NoteCommands {
  constructor(private readonly ext: StetExtension) {}

  /** An agent of `p` to address, asked for when there is more than one. */
  private async pickNoteAgent(p: Project): Promise<string | undefined> {
    const agents = p.snapshot.agents.filter((a) => a.state === "active");
    if (!agents.length) return void vscode.window.showInformationMessage("Notes go to an agent: create an agent workspace first (Stet: New agent workspace).");
    if (agents.length === 1) return agents[0]!.id;
    const pick = await vscode.window.showQuickPick(
      agents.map((a) => ({ label: a.id, description: a.kind })),
      { title: "Note for which agent?" },
    );
    return pick?.label;
  }

  /** Leave a note for an agent on the selected passage (or the current line). */
  async noteForAgent(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const p = ed && this.ext.projectFor(ed.document.uri);
    const file = p && ed ? p.relPath(ed.document.uri) : null;
    if (!ed || !p || !file) return void vscode.window.showInformationMessage("Open a file of your Stet project and select the passage the note is about.");
    const agent = await this.pickNoteAgent(p);
    if (!agent) return;
    const body = await vscode.window.showInputBox({
      title: `Note for ${agent}`,
      prompt: "What should the agent do with this passage? It receives the note at its next sync.",
      placeHolder: "e.g. shorten this paragraph, and keep the citation",
    });
    if (!body) return;
    await this.addNote(
      p,
      file,
      ed.document,
      ed.selection.isEmpty ? new vscode.Range(ed.selection.active.line, 0, ed.selection.active.line, Number.MAX_SAFE_INTEGER) : ed.selection,
      agent,
      body,
    );
  }

  /** Leave a note on `range` of `doc` (as shown, unsaved edits included). */
  private async addNote(p: Project, file: string, doc: vscode.TextDocument, range: vscode.Range, agent: string, body: string): Promise<void> {
    const text = toLf(doc.getText());
    const idx = new LineIndex(text);
    const r = doc.validateRange(range);
    const start = idx.offset(r.start.line, r.start.character);
    const end = idx.offset(r.end.line, r.end.character);
    await this.ext.run(p, async () => {
      const n = await p.stet.addNote(agent, { file, start, end, text }, body);
      announce(`$(note) ${n.id} for ${agent}: it arrives at the agent's next sync.`, 5000);
    });
  }

  /** The note a command is about: a tree element, a comment thread, or an id. */
  private noteTarget(arg: unknown): { project: Project; note: Note } | undefined {
    if (arg && typeof arg === "object" && "project" in arg && (arg as El).node?.type === "note") {
      const el = arg as El & { node: { type: "note"; note: Note } };
      return { project: el.project, note: el.node.note };
    }
    const id = typeof arg === "string" ? arg : (arg as vscode.CommentThread | undefined)?.contextValue;
    if (!id || !isNoteId(id)) return undefined;
    const uri = (arg as vscode.CommentThread | undefined)?.uri;
    const ps = uri && typeof arg !== "string" ? [this.ext.projectFor(uri)].filter((x): x is Project => !!x) : this.ext.allProjects();
    for (const project of ps) {
      const note = project.snapshot.notes.find((n) => n.id === id.toUpperCase());
      if (note) return { project, note };
    }
    return undefined;
  }

  async reopenNote(arg: unknown): Promise<void> {
    const t = this.noteTarget(arg);
    if (!t) return;
    const ok = await this.ext.run(t.project, async () => {
      await t.project.stet.reopenNote(t.note.id);
      return true;
    });
    if (ok) announce(`$(note) Note ${t.note.id} is open again; the agent is told.`);
  }

  async resolveNote(arg: unknown): Promise<void> {
    const t = this.noteTarget(arg);
    if (!t) return;
    const ok = await this.ext.run(t.project, async () => {
      await t.project.stet.resolveNote(t.note.id);
      return true;
    });
    if (ok) announce(`$(check) Note ${t.note.id} resolved.`);
  }

  /** Reply in a note's thread (from the editor). */
  async replyNote(p: Project, note: Note, text: string): Promise<void> {
    const ok = await this.ext.run(p, async () => {
      await p.stet.replyNote(note.id, text, "user");
      return true;
    });
    if (ok) {
      this.ext.replies.markRead(p, note);
      announce(`$(comment) Reply on note ${note.id} sent.`);
    }
  }

  /** Create a note from a comment thread the user started on a line without a proposed change. */
  async noteFromThread(thread: vscode.CommentThread, text: string): Promise<boolean> {
    const p = this.ext.projectFor(thread.uri);
    const file = p?.relPath(thread.uri);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
    if (!p || !file || !doc || !thread.range) return false;
    const agent = await this.pickNoteAgent(p);
    if (!agent) return false;
    const r = thread.range;
    await this.addNote(p, file, doc, new vscode.Range(r.start.line, 0, r.end.line, Number.MAX_SAFE_INTEGER), agent, text);
    return true;
  }

  async showNote(arg: unknown): Promise<void> {
    const t = this.noteTarget(arg);
    if (!t) return;
    this.ext.replies.markRead(t.project, t.note);
    const doc = await vscode.workspace.openTextDocument(t.project.fileUri(t.note.file));
    const text = toLf(doc.getText());
    const span = t.project.stet.locateNoteInText(t.note, text);
    const idx = new LineIndex(text);
    const range = span
      ? new vscode.Range(idx.position(span.start).line, idx.position(span.start).character, idx.position(span.end).line, idx.position(span.end).character)
      : new vscode.Range(0, 0, 0, 0);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true, viewColumn: this.ext.navigation.columnFor(doc.uri) });
    ed.selection = new vscode.Selection(range.start, range.end);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!span) void vscode.window.showInformationMessage(`The passage of ${t.note.id} is no longer in ${t.note.file}.`);
  }

  async replyThread(reply: vscode.CommentReply, threads: Threads): Promise<void> {
    const note = threads.noteForThread(reply.thread);
    if (note) return this.replyNote(note.project, note.note, reply.text);
    const hit = await threads.itemForThread(reply.thread);
    if (!hit) {
      // A new thread away from proposed changes: a note for an agent on those lines.
      const own = threads.isOwn(reply.thread);
      const made = !own && (await this.noteFromThread(reply.thread, reply.text));
      if (!made && !own) void vscode.window.showWarningMessage("Comments go on a proposed change, or become a note for an agent: open a Stet project file.");
      if (!own) reply.thread.dispose();
      return;
    }
    if (!threads.isOwn(reply.thread)) reply.thread.dispose();
    const ok = await this.ext.run(hit.project, async () => {
      await hit.project.stet.comment(hit.item.id, reply.text, "user");
      return true;
    });
    if (ok) {
      this.ext.replies.markRead(hit.project, hit.item);
      announce(`$(comment) Reply on ${hit.item.id} sent.`);
    }
  }
}
