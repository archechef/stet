/** Item threads through the VS Code Comments API (spec §12.2). */

import type { Item, Note } from "@stet/core";
import * as vscode from "vscode";
import { type Host, inlineMax, type Locator } from "./editor.js";
import { warn } from "./log.js";
import { proposalMarkdown } from "./markdown.js";
import type { Project } from "./project.js";
import { type Settings, setting } from "./settings.js";
import { fitsInline, itemDiff, LineIndex, toLf } from "./text.js";

export type LongMode = Settings["longChanges"];

class StetComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(
    public body: vscode.MarkdownString,
    public author: vscode.CommentAuthorInformation,
    public timestamp?: Date,
  ) {}
}

export class Threads implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController("stet", "Stet");
  /** item id → thread */
  private threads = new Map<string, { thread: vscode.CommentThread; sig: string; project: Project }>();
  /** note id@project → thread of an open reviewer note (spec §7.8) */
  private notes = new Map<string, { thread: vscode.CommentThread; sig: string; project: Project; note: Note }>();
  private disposables: vscode.Disposable[] = [];
  private syncing: Promise<void> | undefined;
  private syncAgain = false;
  private reset = false;

  constructor(
    private host: Host,
    private locator: Locator,
    private projects: () => Project[],
  ) {
    this.controller.options = { placeHolder: "Message to the agent…", prompt: "Comment on a proposed change, or leave a note for an agent" };
    // Any line of a project file: on a proposed change it's a comment, elsewhere a note for an agent.
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => (this.host.projectFor(doc.uri) && doc.lineCount ? [new vscode.Range(0, 0, doc.lineCount - 1, 0)] : []),
    };
    this.disposables.push(
      this.controller,
      host.onDidChange(() => void this.sync()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("stet.longChanges") ||
          e.affectsConfiguration("stet.newTextStyle") ||
          e.affectsConfiguration("stet.inlineTextLength") ||
          e.affectsConfiguration("editor.wordWrap") ||
          e.affectsConfiguration("editor.inlayHints")
        )
          void this.rebuild();
      }),
    );
  }

  /** Recreate all threads (their initial open/closed state depends on the setting). */
  private rebuild(): Promise<void> {
    this.reset = true;
    return this.sync();
  }

  /** How proposals too long for ghost text are shown (setting stet.longChanges). */
  private longMode(): LongMode {
    return setting("longChanges");
  }

  /** Whether the item's full new text goes into its thread (ghost text can't show it). */
  private showsProposal(project: Project, item: Item): boolean {
    // A move shows where its passage comes from instead (editor label and hover), not the text again.
    if (this.longMode() === "hover" || item.kind !== "modify" || !item.newText || item.move) return false;
    // Only the changed parts are shown inline; the panel is for parts too long for that.
    const max = inlineMax(project.fileUri(item.file));
    return itemDiff(item, project.profile(item.file)).inserted.some((i) => !fitsInline(i.text, max));
  }

  /**
   * Create or update threads for items that have a conversation or a proposal too long for ghost
   * text, and drop the others. One pass at a time; calls during a pass coalesce into one more. Two
   * passes at once would both create a thread for a new item, leaving one untracked, or an older
   * pass would re-create threads of items a newer one had just dropped (e.g. an archived agent's).
   */
  sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        await this.syncOnce();
      } while (this.syncAgain);
    })().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async syncOnce(): Promise<void> {
    if (this.reset) {
      this.reset = false;
      for (const t of [...this.threads.values(), ...this.notes.values()]) t.thread.dispose();
      this.threads.clear();
      this.notes.clear();
    }
    await this.syncNotes();
    const seen = new Set<string>();
    for (const p of this.projects()) {
      const live = p.snapshot.items.filter((i) => i.status === "pending" || i.status === "needs_revision");
      for (const item of live.filter((i) => i.thread.length || this.showsProposal(p, i))) {
        seen.add(item.id + "@" + p.mainPath);
        const key = item.id + "@" + p.mainPath;
        const existing = this.threads.get(key);
        const range = await this.rangeOf(p, item);
        const sig = this.signature(p, item);
        if (existing) {
          if (existing.sig !== sig) {
            existing.thread.comments = this.comments(p, item);
            existing.sig = sig;
          }
          if (range && !existing.thread.range?.isEqual(range)) existing.thread.range = range;
          continue;
        }
        const thread = this.controller.createCommentThread(p.fileUri(item.file), range ?? new vscode.Range(0, 0, 0, 0), this.comments(p, item));
        thread.label = `${item.id} · ${item.agent}${inProject(p)}`;
        thread.canReply = true;
        thread.contextValue = item.id;
        // Open by default only to show a long proposal; the user's collapsing is kept afterwards.
        thread.collapsibleState =
          this.showsProposal(p, item) && this.longMode() === "expanded"
            ? vscode.CommentThreadCollapsibleState.Expanded
            : vscode.CommentThreadCollapsibleState.Collapsed;
        this.threads.set(key, { thread, sig, project: p });
      }
    }
    for (const [key, t] of this.threads) {
      if (!seen.has(key)) {
        t.thread.dispose();
        this.threads.delete(key);
      }
    }
  }

  /** Threads for open reviewer notes, at their passage as it is now (in the editor if open, else on disk). */
  private async syncNotes(): Promise<void> {
    const seen = new Set<string>();
    for (const p of this.projects()) {
      for (const note of p.snapshot.notes.filter((n) => n.state === "open")) {
        const key = note.id + "@" + p.mainPath;
        seen.add(key);
        const range = await this.noteRange(p, note);
        const sig = `${note.thread.length}|${note.deliveredAt ?? ""}`;
        const existing = this.notes.get(key);
        if (existing) {
          existing.note = note;
          if (existing.sig !== sig) {
            existing.thread.comments = this.noteComments(note);
            existing.thread.label = this.noteLabel(note, p);
            existing.sig = sig;
          }
          if (range && !existing.thread.range?.isEqual(range)) existing.thread.range = range;
          continue;
        }
        const thread = this.controller.createCommentThread(p.fileUri(note.file), range ?? new vscode.Range(0, 0, 0, 0), this.noteComments(note));
        thread.label = this.noteLabel(note, p);
        thread.canReply = true;
        thread.contextValue = note.id;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        this.notes.set(key, { thread, sig, project: p, note });
      }
    }
    for (const [key, t] of this.notes) {
      if (!seen.has(key)) {
        t.thread.dispose();
        this.notes.delete(key);
      }
    }
  }

  private noteLabel(n: Note, p: Project): string {
    return `${n.id} · note for ${n.agent}${inProject(p)}${n.deliveredAt ? "" : " (arrives at its next sync)"}`;
  }

  private noteComments(n: Note): vscode.Comment[] {
    const text = (s: string) => new vscode.MarkdownString().appendText(s);
    return [
      new StetComment(text(n.body), { name: "You" }, new Date(n.createdAt)),
      ...n.thread.map((t) => new StetComment(text(t.text), { name: t.author === "user" ? "You" : n.agent }, new Date(t.at))),
    ];
  }

  private async noteRange(p: Project, note: Note): Promise<vscode.Range | null> {
    const doc = vscode.workspace.textDocuments.find((d) => p.relPath(d.uri) === note.file);
    let text: string;
    try {
      text = toLf(doc ? doc.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(p.fileUri(note.file))));
    } catch (e) {
      // A note on a file removed since is not located; anything else is noted.
      if (!(e instanceof vscode.FileSystemError && e.code === "FileNotFound")) warn(`Reading ${note.file} for note ${note.id}`, e);
      return null;
    }
    const span = p.stet.locateNoteInText(note, text);
    if (!span) return null;
    const idx = new LineIndex(text);
    return new vscode.Range(idx.position(span.start).line, 0, idx.position(Math.max(span.start, span.end - 1)).line, 0);
  }

  /** The note a thread shows, if it is one of ours. */
  noteForThread(thread: vscode.CommentThread): { project: Project; note: Note } | undefined {
    for (const t of this.notes.values()) if (t.thread === thread) return { project: t.project, note: t.note };
    return undefined;
  }

  private async rangeOf(p: Project, item: Item): Promise<vscode.Range | null> {
    const doc = vscode.workspace.textDocuments.find((d) => p.relPath(d.uri) === item.file);
    if (doc) {
      const hit = (await this.locator.locate(doc)).find((l) => l.item.id === item.id);
      if (hit) return new vscode.Range(hit.range.start.line, 0, hit.range.end.line, 0);
    }
    const { line } = await p.stet.locateInWorkingCopy(item).catch(() => ({ line: 1 }));
    return new vscode.Range(line - 1, 0, line - 1, 0);
  }

  /** What the thread shows; changes when the proposal or the conversation does. */
  private signature(project: Project, item: Item): string {
    return `${this.showsProposal(project, item) ? item.newText : ""}\0${item.thread.length}`;
  }

  private comments(project: Project, item: Item): vscode.Comment[] {
    const proposal = this.showsProposal(project, item)
      ? [new StetComment(new vscode.MarkdownString(proposalMarkdown(item, project.profile(item.file))), { name: item.agent })]
      : [];
    return proposal.concat(
      item.thread.map(
        // Plain text: agent replies must not render links or remote images.
        (t) => new StetComment(new vscode.MarkdownString().appendText(t.text), { name: t.author === "user" ? "You" : item.agent }, new Date(t.at)),
      ),
    );
  }

  /** The item a reply belongs to: known thread, or the item under a thread the user just opened. */
  async itemForThread(thread: vscode.CommentThread): Promise<{ project: Project; item: Item } | undefined> {
    for (const t of this.threads.values()) {
      if (t.thread === thread) {
        const item = t.project.snapshot.items.find((i) => i.id === thread.contextValue);
        return item ? { project: t.project, item } : undefined;
      }
    }
    const p = this.host.projectFor(thread.uri);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
    if (!p || !doc || !thread.range) return undefined;
    const line = thread.range.start.line;
    const hit = (await this.locator.locate(doc)).find((l) => l.range.start.line <= line && line <= l.range.end.line);
    return hit ? { project: p, item: hit.item } : undefined;
  }

  /** Threads the user created (not ours) are replaced by the item's own thread after refresh. */
  isOwn(thread: vscode.CommentThread): boolean {
    return [...this.threads.values(), ...this.notes.values()].some((t) => t.thread === thread);
  }

  dispose(): void {
    for (const t of [...this.threads.values(), ...this.notes.values()]) t.thread.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** " · paper-a" in a window with several folders, where two projects have the same ids; else "". */
export function inProject(p: Project): string {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? ` · ${p.name}` : "";
}
