/** One Stet-enabled repository open in VS Code: service access, snapshot and live updates. */
import { watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";
import * as vscode from "vscode";
import { foldPath, isSafeRepoPath, Stet } from "@stet/core";
import type { Snapshot } from "./model.js";

export class Project implements vscode.Disposable {
  snapshot: Snapshot = { agents: [], changesets: [], groups: [], items: [], syncNeeded: new Set(), uncommitted: [] };
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
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
    // Show the review state right away; whether agents are behind comes second (it may rebuild the review base).
    this.snapshot = { agents, changesets, groups, items, syncNeeded: this.snapshot.syncNeeded, uncommitted };
    this.changed.fire();
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

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.changed.dispose();
  }
}
