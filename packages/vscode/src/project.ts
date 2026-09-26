/** One Stet-enabled repository open in VS Code: service access, snapshot and live updates. */
import { watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";
import * as vscode from "vscode";
import { Stet } from "@stet/core";
import type { Snapshot } from "./model.js";

const norm = (p: string) => {
  const s = resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? s.toLowerCase() : s;
};

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
    const f = norm(uri.fsPath);
    const m = norm(this.mainPath);
    if (!f.startsWith(m + "/")) return null;
    return relative(this.mainPath, uri.fsPath).replace(/\\/g, "/");
  }

  fileUri(rel: string): vscode.Uri {
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
    const [agents, changesets, groups, items, uncommitted] = await Promise.all([
      this.stet.listAgents(),
      this.stet.listChangesets(),
      this.stet.listGroups(),
      this.stet.listItems(),
      this.stet.uncommittedAccepted(),
    ]);
    const syncNeeded = new Set<string>();
    for (const a of agents.filter((a) => a.state === "active")) {
      try {
        if ((await this.stet.agentStatus(a.id)).syncNeeded) syncNeeded.add(a.id);
      } catch {
        /* e.g. worktree deleted by hand; doctor explains */
      }
    }
    this.snapshot = { agents, changesets, groups, items, syncNeeded, uncommitted };
    this.changed.fire();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.changed.dispose();
  }
}
