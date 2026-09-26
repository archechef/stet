/** Item threads through the VS Code Comments API (spec §12.2). */
import * as vscode from "vscode";
import type { Item } from "@stet/core";
import type { Host, Locator } from "./editor.js";
import type { Project } from "./project.js";

class StetComment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  constructor(
    public body: vscode.MarkdownString,
    public author: vscode.CommentAuthorInformation,
    public timestamp: Date,
  ) {}
}

export class Threads implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController("stet", "Stet");
  /** item id → thread */
  private threads = new Map<string, { thread: vscode.CommentThread; count: number; project: Project }>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private host: Host,
    private locator: Locator,
    private projects: () => Project[],
  ) {
    this.controller.options = { placeHolder: "Message to the agent…", prompt: "Comment on this proposed change" };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: async (doc) => (await this.locator.locate(doc)).map((l) => new vscode.Range(l.range.start.line, 0, l.range.end.line, 0)),
    };
    this.disposables.push(this.controller, host.onDidChange(() => void this.sync()));
  }

  /** Create or update threads for items that have a conversation. */
  async sync(): Promise<void> {
    const seen = new Set<string>();
    for (const p of this.projects()) {
      for (const item of p.snapshot.items.filter((i) => i.thread.length && (i.status === "pending" || i.status === "needs_revision"))) {
        seen.add(item.id + "@" + p.mainPath);
        const key = item.id + "@" + p.mainPath;
        const existing = this.threads.get(key);
        const range = await this.rangeOf(p, item);
        if (existing) {
          if (existing.count !== item.thread.length) {
            existing.thread.comments = this.comments(item);
            existing.count = item.thread.length;
          }
          if (range && !existing.thread.range?.isEqual(range)) existing.thread.range = range;
          continue;
        }
        const thread = this.controller.createCommentThread(p.fileUri(item.file), range ?? new vscode.Range(0, 0, 0, 0), this.comments(item));
        thread.label = `${item.id} · ${item.agent}`;
        thread.canReply = true;
        thread.contextValue = item.id;
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
        this.threads.set(key, { thread, count: item.thread.length, project: p });
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

  private comments(item: Item): vscode.Comment[] {
    return item.thread.map(
      // Plain text: agent replies must not render links or remote images.
      (t) => new StetComment(new vscode.MarkdownString().appendText(t.text), { name: t.author === "user" ? "You" : item.agent }, new Date(t.at)),
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
    return [...this.threads.values()].some((t) => t.thread === thread);
  }

  dispose(): void {
    for (const t of this.threads.values()) t.thread.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
