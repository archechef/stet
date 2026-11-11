/** Item threads through the VS Code Comments API (spec §12.2). */
import * as vscode from "vscode";
import type { Item } from "@stet/core";
import { inlineMax, type Host, type Locator } from "./editor.js";
import { fitsInline, itemDiff, proposalMarkdown } from "./model.js";
import type { Project } from "./project.js";

export type LongMode = "expanded" | "collapsed" | "hover";

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
  private disposables: vscode.Disposable[] = [];
  private syncing: Promise<void> | undefined;
  private syncAgain = false;
  private reset = false;

  constructor(
    private host: Host,
    private locator: Locator,
    private projects: () => Project[],
  ) {
    this.controller.options = { placeHolder: "Message to the agent…", prompt: "Comment on this proposed change" };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (doc) => (await this.locator.locate(doc)).map((l) => new vscode.Range(l.range.start.line, 0, l.range.end.line, 0)),
    };
    this.disposables.push(
      this.controller,
      host.onDidChange(() => void this.sync()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("stet.longChanges") || e.affectsConfiguration("stet.newTextStyle") || e.affectsConfiguration("editor.wordWrap")) void this.rebuild();
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
    return vscode.workspace.getConfiguration("stet").get<LongMode>("longChanges", "expanded");
  }

  /** Whether the item's full new text goes into its thread (ghost text can't show it). */
  private showsProposal(project: Project, item: Item): boolean {
    if (this.longMode() === "hover" || item.kind !== "modify" || !item.newText) return false;
    // Only the changed parts are shown inline; the panel is for parts too long for that.
    const max = inlineMax(project.fileUri(item.file));
    return itemDiff(item).inserted.some((i) => !fitsInline(i.text, max));
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
      for (const t of this.threads.values()) t.thread.dispose();
      this.threads.clear();
    }
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
        thread.label = `${item.id} · ${item.agent}`;
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
      ? [new StetComment(new vscode.MarkdownString(proposalMarkdown(item)), { name: item.agent })]
      : [];
    return proposal.concat(item.thread.map(
      // Plain text: agent replies must not render links or remote images.
      (t) => new StetComment(new vscode.MarkdownString().appendText(t.text), { name: t.author === "user" ? "You" : item.agent }, new Date(t.at)),
    ));
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
    return [...this.threads.values()].some((t) => t.thread === thread);
  }

  dispose(): void {
    for (const t of this.threads.values()) t.thread.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
