/** The Review panel and the History view: their rows, their order, moving through them, and the panel's filter. */
import { join } from "node:path";
import { foldPath, type Item, isLiveItem, parsePartId, partId } from "@stet/core";
import * as vscode from "vscode";
import type { El } from "./common.js";
import type { StetExtension } from "./extension.js";
import { documentOrder, filterIsEmpty, filterText, nextItemIndex, type PanelFilter, type TreeMode } from "./model.js";
import type { Project } from "./project.js";
import { rowView } from "./rows.js";
import { setting } from "./settings.js";
import { spokenRow } from "./text.js";

/** Stable id of a tree element (VS Code uses it to keep selection and to reveal elements). */
function elId(el: El): string {
  const n = el.node;
  const p = el.project.mainPath;
  if (!n) return p;
  switch (n.type) {
    case "agent":
      return `${p}|agent|${n.agent.id}`;
    case "note":
      return `${p}|note|${n.note.id}`;
    case "notes":
      return `${p}|notes|${n.agent.id}`;
    case "changeset":
      return `${p}|cs|${n.changeset.id}`;
    case "group":
      return `${p}|group|${n.group.id}`;
    case "part":
      return `${p}|part|${partId(n.group.id, n.index)}`;
    case "file":
      return `${p}|file|${n.agent.id}|${n.file}`;
    case "older":
      return `${p}|older|${n.agent.id}|${n.file}`;
    case "item":
      return `${p}|${n.parent}|${n.item.id}`;
  }
}

export class ReviewTree implements vscode.TreeDataProvider<El> {
  constructor(private readonly ext: StetExtension) {}

  readonly treeChanged = new vscode.EventEmitter<El | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  lines = new Map<string, { line: number; found: boolean }>();
  readonly historyChanged = new vscode.EventEmitter<El | undefined>();

  getChildren(el?: El): El[] {
    return this.childrenOf(el, "review");
  }

  getTreeItem(el: El): Promise<vscode.TreeItem> {
    return this.treeItemOf(el, "review");
  }

  childrenOf(el: El | undefined, mode: TreeMode): El[] {
    const ps = this.ext.allProjects();
    if (!el) {
      if (ps.length === 1)
        return this.ext
          .model(ps[0]!, mode)
          .children()
          .map((node) => ({ project: ps[0]!, node }));
      return ps.map((project) => ({ project }));
    }
    return this.ext
      .model(el.project, mode)
      .children(el.node)
      .map((node) => ({ project: el.project, node }));
  }

  async treeItemOf(el: El, mode: TreeMode): Promise<vscode.TreeItem> {
    const t = await this.buildTreeItem(el, mode);
    t.id = elId(el);
    // Every row read out in words: only change rows were, and the others' "💬 3 (1 new)", "⚠" and
    // "·" were left to the screen reader.
    if (!t.accessibilityInformation) {
      const label = typeof t.label === "string" ? t.label : (t.label?.label ?? "");
      const desc = typeof t.description === "string" ? t.description : "";
      t.accessibilityInformation = { label: spokenRow([label, desc].filter(Boolean).join(", ")) };
    }
    return t;
  }

  /** Parent of a tree element (needed to reveal and select elements programmatically). */
  getParent(el: El): El | undefined {
    const p = el.project;
    const n = el.node;
    if (!n) return undefined;
    const snap = p.snapshot;
    switch (n.type) {
      case "agent":
        return this.ext.allProjects().length > 1 ? { project: p } : undefined;
      case "note": {
        const agent = snap.agents.find((a) => a.id === n.note.agent);
        // Resolved notes are in History, under their agent's notes.
        return agent && { project: p, node: n.note.state === "resolved" ? { type: "notes", agent } : { type: "agent", agent } };
      }
      case "notes":
        return { project: p, node: { type: "agent", agent: n.agent } };
      case "changeset": {
        const agent = snap.agents.find((a) => a.id === n.changeset.agent);
        return agent && { project: p, node: { type: "agent", agent } };
      }
      case "group": {
        const changeset = snap.changesets.find((c) => c.id === n.group.changeset);
        return changeset && { project: p, node: { type: "changeset", changeset } };
      }
      case "part":
        return { project: p, node: { type: "group", group: n.group } };
      case "file":
        return { project: p, node: { type: "agent", agent: n.agent } };
      case "older":
        return { project: p, node: { type: "file", agent: n.agent, file: n.file } };
      case "item": {
        if (n.parent.startsWith("file|")) {
          const agent = snap.agents.find((a) => a.id === n.item.agent);
          return agent && { project: p, node: { type: "file", agent, file: n.item.file } };
        }
        const pid = parsePartId(n.parent);
        const owner = snap.groups.find((g) => g.id === (pid ? pid.group : n.parent));
        if (owner && pid) return { project: p, node: { type: "part", group: owner, index: pid.index } };
        if (owner) return { project: p, node: { type: "group", group: owner } };
        const changeset = snap.changesets.find((c) => c.id === (n.parent || n.item.changeset));
        return changeset && { project: p, node: { type: "changeset", changeset } };
      }
    }
  }

  /** Items in panel order. */
  itemsInOrder(): El[] {
    return this.rowsInOrder().filter((e) => e.node?.type === "item");
  }

  /** Every row of the panel in order: projects, agents, rounds, groups, parts and changes. */
  private rowsInOrder(): El[] {
    const out: El[] = [];
    const walk = (el?: El) => {
      for (const c of this.getChildren(el)) {
        out.push(c);
        if (c.node?.type !== "item") walk(c);
      }
    };
    walk();
    return out;
  }

  /** The panel row last selected, as it is now (a change by its id), while a refresh has emptied the selection. */
  lastSelected: El | undefined;

  panelSelection(): El | undefined {
    const sel = this.ext.tree.selection[0];
    if (sel) return sel;
    const last = this.lastSelected;
    if (last?.node?.type !== "item") return last && this.ext.projects.get(foldPath(last.project.mainPath)) === last.project ? last : undefined;
    const item = this.ext.model(last.project).item(last.node.item.id);
    return item ? { project: last.project, node: { ...last.node, item } } : undefined;
  }

  /** Select the next (or previous) change in the panel and show it in the editor (`j` / `k`). */
  async step(dir: 1 | -1): Promise<void> {
    const rows = this.rowsInOrder();
    const cur = this.panelSelection();
    // From a round or group row too: the change after (or before) it, not the panel's first or last.
    const i = nextItemIndex(
      rows.map((e) => e.node?.type === "item"),
      cur ? rows.findIndex((e) => elId(e) === elId(cur)) : -1,
      dir,
    );
    if (i < 0) return;
    let next = rows[i]!;
    // Or by file and line, if you'd rather go through the document (stet.navigationOrder).
    if (setting("navigationOrder") === "document" && cur?.node?.type === "item") {
      const items = rows.filter((e) => e.node?.type === "item");
      // Projects in the panel's order, not by path: they were crossed the other way round.
      const rank = [...new Set(rows.map((e) => e.project.mainPath))];
      const placed = await Promise.all(
        items.map(async (e) => {
          const it = (e.node as { item: Item }).item;
          return {
            el: e,
            project: String(rank.indexOf(e.project.mainPath)).padStart(6, "0"),
            file: it.file,
            line: await this.lineOf(e.project, it),
            id: it.id,
          };
        }),
      );
      const order = documentOrder(placed);
      const k = order.findIndex((x) => elId(x.el) === elId(cur));
      if (k >= 0) next = order[Math.min(order.length - 1, Math.max(0, k + dir))]!.el;
    }
    await this.ext.tree.reveal(next, { select: true, focus: true });
    await this.ext.navigation.showItem(next, true);
  }

  /**
   * Run a decision on `anchor` (accept, reject, …), then select the next pending change in panel
   * order and show it, so reviewing is one key per change. Nothing moves if the decision was
   * cancelled or failed. `fromPanel`: keep the focus in the panel (keyboard review); otherwise
   * (CodeLens, hover) the editor moves to the next change.
   */
  async decide(p: Project, anchor: string, fromPanel: boolean, action: () => Promise<void>): Promise<void> {
    const idOf = (e: El) => (e.node?.type === "item" ? e.node.item.id : "");
    const before = this.itemsInOrder()
      .filter((e) => e.project === p)
      .map(idOf);
    const status = this.ext.model(p).item(anchor)?.status;
    await action();
    if (!setting("autoAdvance")) return;
    if (this.ext.model(p).item(anchor)?.status === status) return;
    const live = new Map(
      this.itemsInOrder()
        .filter((e) => e.project === p && e.node?.type === "item" && isLiveItem(e.node.item))
        .map((e) => [idOf(e), e]),
    );
    const i = before.indexOf(anchor);
    const next = [...before.slice(i + 1), ...before.slice(0, Math.max(i, 0))].map((id) => live.get(id)).find((e) => e !== undefined);
    if (!next) return;
    // From the editor with the panel closed, only the editor moves (revealing would open the panel).
    if (fromPanel || this.ext.tree.visible) await this.ext.tree.reveal(next, { select: true, focus: fromPanel });
    await this.ext.navigation.showItem(next, fromPanel);
  }

  private async buildTreeItem(el: El, mode: TreeMode): Promise<vscode.TreeItem> {
    const model = this.ext.model(el.project, mode);
    if (!el.node) {
      const t = new vscode.TreeItem(el.project.name, vscode.TreeItemCollapsibleState.Expanded);
      t.iconPath = new vscode.ThemeIcon("repo");
      t.tooltip = el.project.mainPath;
      // Each project's own counts: the status bar adds them up.
      const done = el.project.snapshot.uncommitted.length;
      t.description = mode === "history" ? model.outcome(() => true) : [model.openText(() => true), ...(done ? [`${done} to commit`] : [])].join(" · ");
      return t;
    }
    const n = el.node;
    const history = mode === "history";
    const unread =
      n.type === "agent"
        ? this.ext.replies.unreadOf(el.project, (x) => x.agent === n.agent.id)
        : n.type === "note"
          ? this.ext.replies.unread(el.project, n.note)
          : n.type === "item"
            ? this.ext.replies.unread(el.project, n.item)
            : 0;
    const place = n.type === "item" ? await this.placeOf(el.project, n.item) : undefined;
    const row = rowView(n, model, { history, unread, ...(place ? { place } : {}) });
    const expand = {
      none: vscode.TreeItemCollapsibleState.None,
      expanded: vscode.TreeItemCollapsibleState.Expanded,
      collapsed: vscode.TreeItemCollapsibleState.Collapsed,
    };
    const t = new vscode.TreeItem(row.label, expand[row.expand]);
    t.description = row.description;
    t.tooltip = new vscode.MarkdownString(row.tooltip);
    t.iconPath = new vscode.ThemeIcon(row.icon.id, row.icon.color ? new vscode.ThemeColor(row.icon.color) : undefined);
    t.contextValue = row.contextValue;
    if (row.spoken) t.accessibilityInformation = { label: row.spoken };
    if (n.type === "note") t.command = { command: "stet.showNote", title: "Go to note", arguments: [el] };
    // A file's row shows the file's icon in your icon theme.
    if (n.type === "file") {
      t.resourceUri = vscode.Uri.file(join(el.project.mainPath, n.file));
      t.iconPath = vscode.ThemeIcon.File;
    }
    if (n.type === "older") t.command = { command: "stet.showOlderRounds", title: "Show older rounds", arguments: [el] };
    // Decided changes open as a diff of the change itself; open ones are shown in the file.
    if (n.type === "item")
      t.command = history
        ? { command: "stet.showDiff", title: "Show diff", arguments: [el] }
        : { command: "stet.showItem", title: "Go to change", arguments: [el, true] };
    return t;
  }

  async lineOf(p: Project, it: Item): Promise<number> {
    return (await this.placeOf(p, it)).line;
  }

  /**
   * Where a change is in your file (the editor's text if open, else the file on disk), and
   * whether it is there at all: you may have edited the words around it since.
   */
  async placeOf(p: Project, it: Item): Promise<{ line: number; found: boolean }> {
    const key = `${p.mainPath}|${it.id}`;
    const hit = this.lines.get(key);
    if (hit !== undefined) return hit;
    const doc = vscode.workspace.textDocuments.find((d) => p.relPath(d.uri) === it.file);
    let place: { line: number; found: boolean } | undefined;
    if (doc && isLiveItem(it)) {
      const l = (await this.ext.locator.locate(doc)).find((x) => x.item.id === it.id);
      if (l) place = { line: l.range.start.line + 1, found: true };
    }
    if (!place) {
      const w = (await this.workingLines(p)).get(it.id) ?? (await p.stet.locateInWorkingCopy(it).catch(() => ({ line: 1, span: null })));
      place = { line: w.line, found: it.kind !== "modify" || !isLiveItem(it) || (!doc && w.span !== null) };
    }
    this.lines.set(key, place);
    return place;
  }

  /**
   * Lines of all open changes of a project in its files on disk, found in one go after each
   * refresh: row by row, a panel of 424 changes took 6.5 s to redraw.
   */
  lineBatches = new Map<string, Promise<Map<string, { line: number; span: unknown }>>>();

  private workingLines(p: Project): Promise<Map<string, { line: number; span: unknown }>> {
    let b = this.lineBatches.get(p.mainPath);
    if (!b) {
      const live = p.snapshot.items.filter((i) => isLiveItem(i) && i.kind === "modify");
      b = p.stet.locateMany(live, undefined, p.snapshot.items).catch(() => new Map<string, { line: number; span: unknown }>());
      this.lineBatches.set(p.mainPath, b);
    }
    return b;
  }

  filter: PanelFilter | null = null;
  missingMessage: string | undefined;

  showPanelMessage(): void {
    const f = this.filter && !filterIsEmpty(this.filter) ? `Showing only: ${filterText(this.filter)} (✕ in the title clears it)` : undefined;
    this.ext.tree.message = [f, this.missingMessage].filter(Boolean).join("\n") || undefined;
  }

  /** Show only the changes matching `f` in the Review panel (null: all of them). */
  async setFilter(f: PanelFilter | null): Promise<void> {
    this.filter = filterIsEmpty(f) ? null : f;
    for (const [key, m] of this.ext.models) if (key.startsWith("review|")) m.filter = this.filter;
    await vscode.commands.executeCommand("setContext", "stet.filtered", !!this.filter);
    this.showPanelMessage();
    this.treeChanged.fire(undefined);
  }

  /** *Filter…*: by agent, file or status, or words in the changes; picks add to the filter. */
  async pickFilter(): Promise<void> {
    const ps = this.ext.allProjects();
    const live = ps.flatMap((p) => p.snapshot.items.filter(isLiveItem));
    const cur = this.filter ?? {};
    type Pick = vscode.QuickPickItem & { set?: PanelFilter; search?: true; clear?: true };
    const mark = (on: boolean) => (on ? "$(check) " : "");
    const agents = [...new Set(live.map((i) => i.agent))].sort();
    const files = [...new Set(live.map((i) => i.file))].sort();
    const count = (pred: (i: Item) => boolean) => `${live.filter(pred).length} pending`;
    const picks: Pick[] = [
      {
        label: "$(search) Search the changes…",
        detail: cur.text ? `now: “${cur.text}”` : "Words in a change's text, its note or its conversation",
        search: true,
      },
      ...(this.filter ? [{ label: "$(clear-all) Show everything", clear: true } as Pick] : []),
      { label: "Agents", kind: vscode.QuickPickItemKind.Separator },
      ...agents.map(
        (a): Pick => ({
          label: `${mark(cur.agent === a)}${a}`,
          description: count((i) => i.agent === a),
          set: { ...cur, agent: cur.agent === a ? undefined : a },
        }),
      ),
      { label: "Files", kind: vscode.QuickPickItemKind.Separator },
      ...files.map(
        (f): Pick => ({ label: `${mark(cur.file === f)}${f}`, description: count((i) => i.file === f), set: { ...cur, file: cur.file === f ? undefined : f } }),
      ),
      { label: "Status", kind: vscode.QuickPickItemKind.Separator },
      { label: `${mark(cur.status === "pending")}Waiting for you`, set: { ...cur, status: cur.status === "pending" ? undefined : "pending" } },
      {
        label: `${mark(cur.status === "needs_revision")}Waiting for the agent's revision`,
        set: { ...cur, status: cur.status === "needs_revision" ? undefined : "needs_revision" },
      },
    ];
    const pick = await vscode.window.showQuickPick(picks, {
      title: "Show only…",
      placeHolder: "Pick an agent, a file or a status (again to drop it), or search",
    });
    if (!pick) return;
    if (pick.clear) return this.setFilter(null);
    if (pick.search) {
      const text = await vscode.window.showInputBox({
        title: "Search the changes",
        value: cur.text ?? "",
        prompt: "All of these words, in a change's text, note or conversation (empty: no search)",
      });
      if (text === undefined) return;
      return this.setFilter({ ...cur, text });
    }
    if (pick.set) return this.setFilter(pick.set);
  }
}
