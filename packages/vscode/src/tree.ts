/** The Review panel and the History view: their rows, their order, moving through them, and the panel's filter. */
import {
  foldPath,
  type Item,
  isLiveItem,
  NOTIFY_TRIGGER_TEXT,
  NOTIFY_TRIGGERS,
  notifyMode,
  notifyTriggers,
  parsePartId,
  partId,
  profileByName,
  roundOf,
} from "@stet/core";
import * as vscode from "vscode";
import { type El, NOTIFY_PICKS } from "./common.js";
import { esc, itemMarkdown } from "./editor.js";
import type { StetExtension } from "./extension.js";
import {
  behindAgents,
  documentOrder,
  fence,
  filterIsEmpty,
  filterText,
  fitLabel,
  groupDescription,
  groupLabel,
  itemRow,
  LOST_NEXT,
  LOST_TEXT,
  nextItemIndex,
  oneLine,
  type PanelFilter,
  partLabel,
  roundLabel,
  spokenRow,
  type TreeMode,
} from "./model.js";
import type { Project } from "./project.js";
import { setting } from "./settings.js";

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
    case "changeset":
      return `${p}|cs|${n.changeset.id}`;
    case "group":
      return `${p}|group|${n.group.id}`;
    case "part":
      return `${p}|part|${partId(n.group.id, n.index)}`;
    case "item":
      return `${p}|${n.parent}|${n.item.id}`;
  }
}

/** The notification modes as offered in the panel. */
function itemIcon(it: Item): vscode.ThemeIcon {
  const c = (id: string) => new vscode.ThemeColor(id);
  switch (it.status) {
    case "pending":
      return new vscode.ThemeIcon(
        it.kind === "modify" ? "diff-modified" : it.kind === "add-file" ? "diff-added" : it.kind === "delete-file" ? "diff-removed" : "diff-renamed",
      );
    case "needs_revision":
      return new vscode.ThemeIcon("sync", c("problemsWarningIcon.foreground"));
    case "accepted":
      return new vscode.ThemeIcon("check", c("testing.iconPassed"));
    case "rejected":
      return new vscode.ThemeIcon("close", c("testing.iconFailed"));
    case "stale":
      return new vscode.ThemeIcon("warning", c("problemsWarningIcon.foreground"));
    default:
      return new vscode.ThemeIcon("circle-slash");
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
        return agent && { project: p, node: { type: "agent", agent } };
      }
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
      case "item": {
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
    const E = vscode.TreeItemCollapsibleState.Expanded;
    if (!el.node) {
      const t = new vscode.TreeItem(el.project.name, E);
      t.iconPath = new vscode.ThemeIcon("repo");
      t.tooltip = el.project.mainPath;
      // Each project's own counts: the status bar adds them up.
      const model = this.ext.model(el.project, mode);
      const done = el.project.snapshot.uncommitted.length;
      t.description = mode === "history" ? model.outcome(() => true) : [model.openText(() => true), ...(done ? [`${done} to commit`] : [])].join(" · ");
      return t;
    }
    const n = el.node;
    const model = this.ext.model(el.project, mode);
    const history = mode === "history";
    const snap = el.project.snapshot;
    switch (n.type) {
      case "agent": {
        // An agent that hasn't proposed anything yet says what to do, not "0 pending".
        const fresh = !history && n.agent.state === "active" && !snap.changesets.some((c) => c.agent === n.agent.id);
        const t = new vscode.TreeItem(fitLabel(n.agent.id, 28), fresh && !model.children(n).length ? vscode.TreeItemCollapsibleState.None : E);
        const parts = [history ? model.outcome((i) => i.agent === n.agent.id) : fresh ? "no proposals yet" : model.openText((i) => i.agent === n.agent.id)];
        const behind = behindAgents(snap).includes(n.agent.id);
        if (behind) parts.push("behind your text");
        if (n.agent.state === "archived") parts.push("archived");
        const replies = this.ext.replies.unreadOf(el.project, (x) => x.agent === n.agent.id);
        if (replies && !history) parts.push(`${replies} new repl${replies === 1 ? "y" : "ies"}`);
        const notify = notifyMode(n.agent);
        if (n.agent.state === "active" && notify === "off") parts.push("not notified");
        t.description = parts.join(" · ");
        t.iconPath = new vscode.ThemeIcon(n.agent.kind === "codex" ? "terminal" : "hubot");
        t.tooltip = new vscode.MarkdownString(
          `**${esc(n.agent.id)}** (${n.agent.kind})\n\nWorkspace: ${esc(n.agent.worktree)}` +
            (fresh
              ? `\n\nOpen this folder in ${n.agent.kind === "codex" ? "Codex" : n.agent.kind === "claude-code" ? "the Claude desktop app (Code tab) or Claude Code" : "your agent"} and give it a task: its proposals appear here. *Open agent workspace…* (the folder button on the row) copies the path.`
              : "") +
            (behind ? "\n\nThe agent works on an older version of your text; it catches up the next time it syncs with your text." : "") +
            (n.agent.state === "active"
              ? `\n\nNotifications: ${NOTIFY_PICKS.find((x) => x.mode === notify)!.label}` +
                (notifyTriggers(n.agent).length < NOTIFY_TRIGGERS.length
                  ? `, for ${
                      notifyTriggers(n.agent)
                        .map((t) => NOTIFY_TRIGGER_TEXT[t].toLowerCase())
                        .join(", ") || "nothing"
                    }`
                  : "") +
                " (bell button). The megaphone wakes it now."
              : ""),
        );
        t.contextValue = n.agent.state === "active" ? `agent.active.notify-${notify}` : "agent.archived";
        return t;
      }
      case "note": {
        const nt = n.note;
        const t = new vscode.TreeItem(`${nt.id}  ${oneLine(nt.body, 50)}`, vscode.TreeItemCollapsibleState.None);
        const fresh = this.ext.replies.unread(el.project, nt);
        const replies = nt.thread.length ? ` · ${nt.thread.length} repl${nt.thread.length === 1 ? "y" : "ies"}${fresh ? ` (${fresh} new)` : ""}` : "";
        t.description = `${nt.file}${nt.deliveredAt ? "" : " · not delivered yet"}${replies}`;
        t.iconPath = fresh
          ? new vscode.ThemeIcon("comment-unresolved", new vscode.ThemeColor("notificationsInfoIcon.foreground"))
          : new vscode.ThemeIcon("note");
        t.tooltip = new vscode.MarkdownString(
          `**${nt.id}** note for ${esc(nt.agent)} on ${esc(nt.file)}${nt.deliveredAt ? "" : " (the agent receives it at its next sync)"}\n\n${esc(nt.body)}\n\n${fence(nt.text, profileByName(nt.file).fence)}` +
            nt.thread
              .slice(-3)
              .map((r) => `\n\n> **${r.author === "user" ? "You" : esc(nt.agent)}:** ${esc(r.text)}`)
              .join(""),
        );
        t.contextValue = nt.state === "resolved" ? "note.resolved" : "note.open";
        if (nt.state === "resolved") t.description = `${t.description} · resolved`;
        t.command = { command: "stet.showNote", title: "Go to note", arguments: [el] };
        return t;
      }
      case "changeset": {
        const cs = n.changeset;
        // Old rounds stay closed in History, so it reads as a list of rounds.
        const t = new vscode.TreeItem(roundLabel(cs), history ? vscode.TreeItemCollapsibleState.Collapsed : E);
        const live = model.liveCount((i) => i.changeset === cs.id);
        t.description = history ? model.outcome((i) => i.changeset === cs.id) : model.openText((i) => i.changeset === cs.id);
        t.iconPath = new vscode.ThemeIcon("layers");
        t.tooltip = new vscode.MarkdownString(
          `**Round ${roundOf(cs.id)}** (${cs.id}) ${esc(cs.title)}\n\n${cs.stetNote ? `⚠ ${esc(cs.stetNote)}\n\n` : ""}${esc(cs.rationale)}\n\n*${new Date(cs.submittedAt).toLocaleString()}*`,
        );
        t.contextValue = live ? "changeset.live" : "changeset.done";
        return t;
      }
      case "group": {
        const g = n.group;
        const members = model.members(g);
        const t = new vscode.TreeItem(groupLabel(g), E);
        const move = model.isMove(g);
        t.description = groupDescription(g, members.length, move);
        t.iconPath =
          g.state === "broken"
            ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"))
            : new vscode.ThemeIcon(move ? "arrow-swap" : g.kind === "linked" ? "link" : "symbol-namespace");
        t.tooltip = new vscode.MarkdownString(
          `**${g.id}** ${g.kind}${g.source === "auto" ? " (detected by Stet)" : ""}: ${esc(g.title)}` +
            (g.rationale ? `\n\n${esc(g.rationale)}` : "") +
            (g.kind === "linked"
              ? g.parts
                ? `\n\n${g.parts.length} parts: each can be accepted or rejected on its own; the changes within a part go together.`
                : "\n\nAccept or reject these together: accepting only some can break the document."
              : "") +
            (g.state === "broken" ? "\n\n⚠ Some members were resolved differently; the agent was asked to repair the document." : ""),
        );
        t.contextValue = members.some(isLiveItem) ? `group.live.${g.kind}` : `group.done.${g.kind}`;
        return t;
      }
      case "part": {
        const g = n.group;
        const members = model.partMembers(g, n.index);
        const t = new vscode.TreeItem(partLabel(g, n.index), E);
        t.description = history ? model.outcome((i) => members.includes(i)) : `${members.length}`;
        t.iconPath = new vscode.ThemeIcon("symbol-field");
        t.tooltip = new vscode.MarkdownString(
          `**${partId(g.id, n.index)}** part ${n.index + 1} of ${g.parts?.length ?? 1} of ${g.id} “${esc(g.title)}”` +
            "\n\nAccept or reject this part on its own: the document still compiles without the other parts, " +
            "which stay acceptable. Its own changes go together.",
        );
        t.contextValue = members.some(isLiveItem) ? "part.live" : "part.done";
        return t;
      }
      case "item": {
        const it = n.item;
        const unread = this.ext.replies.unread(el.project, it);
        const row = itemRow(it, model, await this.placeOf(el.project, it), { history, unread });
        const lost = row.lost;
        const t = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
        t.description = row.description;
        t.iconPath = lost
          ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"))
          : unread
            ? new vscode.ThemeIcon("comment-unresolved", new vscode.ThemeColor("notificationsInfoIcon.foreground"))
            : itemIcon(it);
        t.accessibilityInformation = { label: row.spoken };
        const md = new vscode.MarkdownString((lost ? `⚠ **${LOST_TEXT}.** ${LOST_NEXT}\n\n` : "") + itemMarkdown(it, model));
        t.tooltip = md;
        t.contextValue = row.contextValue;
        // Decided changes open as a diff of the change itself; open ones are shown in the file.
        t.command = history
          ? { command: "stet.showDiff", title: "Show diff", arguments: [el] }
          : { command: "stet.showItem", title: "Go to change", arguments: [el, true] };
        return t;
      }
    }
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
