/** One Stet-enabled repository open in VS Code: service access, snapshot and live updates. */
import { watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";
import * as vscode from "vscode";
import { foldPath, isSafeRepoPath, Stet } from "@stet/core";
import type { Snapshot } from "./model.js";

export class Project implements vscode.Disposable {
  snapshot: Snapshot = { agents: [], changesets: [], groups: [], items: [], syncNeeded: new Set(), uncommitted: [], unshared: false };
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private checkTimer: NodeJS.Timeout | undefined;
  private checking = false;
  private checkAgain = false;
  private loading: Promise<void> | undefined;
  private again = false;

  constructor(readonly stet: Stet) {}

  get mainPath(): string {
    return this.stet.mainPath;
  }

  get storeRoot(): string {
    return this.stet.store.root;
  }

  get name(): string {
    return this.mainPath.replace(/\\/g, "/").split("/").pop() ?? this.mainPath;
  }

  /** Path of `uri` relative to the project (forward slashes), or null if outside. */
  relPath(uri: vscode.Uri): string | null {
    if (uri.scheme !== "file") return null;
    const f = foldPath(uri.fsPath);
    const m = foldPath(this.mainPath);
    if (!f.startsWith(m + "/")) return null;
    return relative(this.mainPath, uri.fsPath).replace(/\\/g, "/");
  }

  /** The project file an item refers to. Item paths come from the store: never leave the project. */
  fileUri(rel: string): vscode.Uri {
    if (!isSafeRepoPath(rel)) throw new Error(`Stet: '${rel}' is not a path inside the project.`);
    return vscode.Uri.file(resolve(this.mainPath, rel));
  }

  /** Watch the store for changes made by agents, the CLI or other windows. */
  startWatching(): void {
    try {
      // Every change of interest appends an event or allocates an id; ignore the lock file,
      // which our own reads take (reacting to it would loop).
      this.watcher = watch(this.storeRoot, { persistent: false }, (_e, file) => {
        const f = String(file ?? "");
        if (!f || /^(events\.jsonl|state\.json|config\.json)/.test(f)) this.scheduleRefresh();
      });
    } catch {
      /* fall back to refresh on focus and after our own actions */
    }
  }

  scheduleRefresh(delay = 200): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /** Reload everything; concurrent calls coalesce. */
  async refresh(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = (async () => {
      do {
        this.again = false;
        await this.load();
      } while (this.again);
    })().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async load(): Promise<void> {
    const [agents, changesets, groups, items] = await Promise.all([
      this.stet.listAgents(),
      this.stet.listChangesets(),
      this.stet.listGroups(),
      this.stet.listItems(),
    ]);
    const uncommitted = items.filter((i) => i.status === "accepted" && i.resolution && !i.resolution.committed);
    this.snapshot = { ...this.snapshot, agents, changesets, groups, items, uncommitted };
    this.changed.fire();
    this.scheduleChecks();
  }

  /**
   * Whether agents are behind and whether the user has unshared edits. These rebuild the review
   * base and snapshot the project (about a second after an accept), and they hold the store lock:
   * they run in the background, once the user pauses, so a series of decisions isn't slowed down.
   */
  scheduleChecks(delay = 800): void {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => void this.runChecks(), delay);
  }

  private async runChecks(): Promise<void> {
    if (this.checking) {
      this.checkAgain = true;
      return;
    }
    this.checking = true;
    try {
      do {
        this.checkAgain = false;
        await this.checkAgents();
        await this.checkShare();
      } while (this.checkAgain);
    } finally {
      this.checking = false;
    }
  }

  private async checkAgents(): Promise<void> {
    const syncNeeded = new Set<string>();
    try {
      for (const s of await this.stet.agentStatuses()) if (s.syncNeeded) syncNeeded.add(s.agent.id);
    } catch {
      /* e.g. the main branch is missing; doctor explains */
    }
    const before = this.snapshot.syncNeeded;
    if (syncNeeded.size !== before.size || [...syncNeeded].some((a) => !before.has(a))) {
      this.snapshot = { ...this.snapshot, syncNeeded };
      this.changed.fire();
    }
  }

  /** Whether agents see the saved files. */
  private async checkShare(): Promise<void> {
    let unshared = false;
    try {
      // Only with sharing by button: "saved" shares by itself, "committed" never.
      const st = await this.stet.shareStatus();
      unshared = st.unshared && st.mode === "manual";
    } catch {
      /* e.g. the main branch is missing; doctor explains */
    }
    if (unshared !== this.snapshot.unshared) {
      this.snapshot = { ...this.snapshot, unshared };
      this.changed.fire();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    clearTimeout(this.checkTimer);
    this.watcher?.close();
    this.changed.dispose();
  }
}
