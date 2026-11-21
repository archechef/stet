/** Replies you haven't seen yet (test report v0.16.0): counted per change and note, remembered per workspace. */
import { isLiveItem } from "@stet/core";
import type { StetExtension } from "./extension.js";
import { unreadReplies } from "./model.js";
import type { Project } from "./project.js";

export class UnreadReplies {
  constructor(private readonly ext: StetExtension) {}

  /** How many entries of each thread you have seen, by `project|id`; `project|*` marks a project counted from. */
  seen: Record<string, number> = {};
  static readonly SEEN = "stet.seenThreads";

  private seenKey = (p: Project, id: string) => `${p.mainPath}|${id}`;

  /** Agent replies on a change or note you haven't seen. */
  unread(p: Project, x: { id: string; thread: readonly { author: string }[] }): number {
    return unreadReplies(x.thread, this.seen[this.seenKey(p, x.id)] ?? 0);
  }

  /** Unread replies on the changes and notes of `p` that match `pred`. */
  unreadOf(p: Project, pred: (x: { agent: string }) => boolean): number {
    const s = p.snapshot;
    return [...s.items.filter((i) => isLiveItem(i) || i.thread.length), ...s.notes].filter(pred).reduce((n, x) => n + this.unread(p, x), 0);
  }

  /**
   * " in paper-typst" when the window has several projects: ids repeat across projects, and with
   * a screen reader these results are all the feedback there is (test report 5e4c6af, multi-root).
   */
  inWhich(p: Project): string {
    return this.ext.projects.size > 1 ? ` in ${p.name}` : "";
  }

  /** You saw the thread of a change or note (went to it, replied). */
  markRead(p: Project, x: { id: string; thread: readonly unknown[] }): void {
    const k = this.seenKey(p, x.id);
    if ((this.seen[k] ?? 0) >= x.thread.length) return;
    this.seen[k] = x.thread.length;
    void this.ext.ctx.workspaceState.update(UnreadReplies.SEEN, this.seen);
    void this.ext.onProjectChanged();
  }

  /** The first time a project is seen here, its replies so far count as read: no flood of old ones. */
  baselineSeen(): void {
    let changed = false;
    for (const p of this.ext.projects.values()) {
      const mark = this.seenKey(p, "*");
      if (this.seen[mark]) continue;
      for (const x of [...p.snapshot.items, ...p.snapshot.notes]) if (x.thread.length) this.seen[this.seenKey(p, x.id)] = x.thread.length;
      if (!p.snapshot.items.length && !p.snapshot.notes.length && !p.snapshot.agents.length) continue; // not loaded yet
      this.seen[mark] = 1;
      changed = true;
    }
    if (changed) void this.ext.ctx.workspaceState.update(UnreadReplies.SEEN, this.seen);
  }
}
