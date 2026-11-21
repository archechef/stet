/** One Stet-enabled repository open in VS Code: service access, snapshot and live updates. */
import { type FSWatcher, watch } from "node:fs";
import { relative, resolve } from "node:path";
import { CHANGED_FILE, foldPath, isSafeRepoPath, isUncommitted, type Stet } from "@stet/core";
import * as vscode from "vscode";
import { warn } from "./log.js";
import { type Snapshot, shownAgentText } from "./model.js";

export class Project implements vscode.Disposable {
  snapshot: Snapshot = { agents: [], changesets: [], groups: [], items: [], notes: [], syncNeeded: new Set(), uncommitted: [], unshared: false, missing: [] };
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
    return this.stet.storeRoot;
  }

  /** The workspace folder's name ("paper-typst"), else the folder's own ("typ"). */
  get name(): string {
    const f = vscode.workspace.workspaceFolders?.find((w) => foldPath(w.uri.fsPath) === foldPath(this.mainPath));
    return f?.name ?? this.mainPath.replace(/\\/g, "/").split("/").pop() ?? this.mainPath;
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
      // The records live in subfolders, which this doesn't watch: the store rewrites `changed`
      // after an operation changed any of them, events and ids aside. Ignore the lock file,
      // which our own reads take (reacting to it would loop).
      // (Prefixes: an atomic write may be reported under its temporary name.)
      const signals = ["events.jsonl", "state.json", "config.json", CHANGED_FILE];
      this.watcher = watch(this.storeRoot, { persistent: false }, (_e, file) => {
        const f = String(file ?? "");
        if (!f || signals.some((s) => f.startsWith(s))) this.scheduleRefresh();
      });
    } catch (e) {
      warn(`Watching ${this.storeRoot} (the panel updates on focus and after Stet's own actions instead)`, e);
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
    const [agents, changesets, groups, items, notes] = await Promise.all([
      this.stet.listAgents(),
      this.stet.listChangesets(),
      this.stet.listGroups(),
      this.stet.listItems(),
      this.stet.listNotes(),
    ]);
    const shown = shownAgentText({ changesets, groups, items, notes });
    const uncommitted = shown.items.filter(isUncommitted);
    this.snapshot = { ...this.snapshot, agents, ...shown, uncommitted };
    this.changed.fire();
    this.scheduleChecks();
  }

  /**
   * Whether agents are behind and whether the user has unshared edits. These rebuild the review
   * base and snapshot the project (about a second after an accept on a large paper), holding the
   * store lock: they run in the background after a 2-second pause, so they don't fall between two
   * decisions and hold up the next accept.
   */
  scheduleChecks(delay = 2000): void {
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
        await this.checkMissing();
      } while (this.checkAgain);
    } finally {
      this.checking = false;
    }
  }

  private async checkAgents(): Promise<void> {
    const syncNeeded = new Set<string>();
    try {
      for (const s of await this.stet.agentStatuses()) if (s.syncNeeded) syncNeeded.add(s.agent.id);
    } catch (e) {
      warn(`Agents of ${this.name}`, e); // e.g. the main branch is missing; doctor explains
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
    } catch (e) {
      warn(`Sharing of ${this.name}`, e);
    }
    if (unshared !== this.snapshot.unshared) {
      this.snapshot = { ...this.snapshot, unshared };
      this.changed.fire();
    }
  }

  /** Accepted changes agents don't get. Nothing is shown while there are none. */
  private async checkMissing(): Promise<void> {
    let missing: Snapshot["missing"] = [];
    try {
      missing = (await this.stet.missingFromBase()).map((m) => ({ id: m.item.id, reason: m.reason }));
    } catch (e) {
      warn(`Review base of ${this.name}`, e);
    }
    const key = (m: Snapshot["missing"]) => m.map((x) => `${x.id}:${x.reason}`).join("|");
    if (key(missing) !== key(this.snapshot.missing)) {
      this.snapshot = { ...this.snapshot, missing };
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
