/** Stet for VS Code (spec §12.2): review panel, in-editor review, threads and setup without a command line. */

import { PreviewPanel, previewNotice } from "./preview.js";
import { join } from "node:path";
import * as vscode from "vscode";
import { doctor, foldPath, isNoteId, notifyMode, notifyTriggers, NOTIFY_TRIGGERS, NOTIFY_TRIGGER_TEXT, type NotifyTrigger, parsePartId, partId, pathExists, Repo, roundOf, Stet, type Agent, type AgentKind, type Group, type Item, type Note, type NotifyMode, type ShareMode } from "@stet/core";
import { esc, itemMarkdown, DiffContent, EditorIntegration, Locator, type Host } from "./editor.js";
import { Threads } from "./comments.js";
import {
  AGENT_ID,
  fence,
  groupDescription,
  groupLabel,
  isLive,
  isRef,
  itemLabel,
  LineIndex,
  oneLine,
  partLabel,
  roundLabel,
  STATUS_TEXT,
  suggestAgentId,
  toLf,
  TreeModel,
  type TreeMode,
  type Node,
} from "./model.js";
import { Project } from "./project.js";
import { cliCommand, installCli, isManaged, type RuntimeMode } from "./runtime.js";

type El = { project: Project; node?: Node };

/** Put a folder path on the clipboard, in the form the platform's apps expect (backslashes on Windows). */
const copyPath = (p: string) => vscode.env.clipboard.writeText(process.platform === "win32" ? p.replace(/\//g, "\\") : p);

/**
 * Green for Stet's proposed text in word-wrapped editors. Inlay hints can't be coloured per hint,
 * only per kind in the user's colour customizations; Stet's hints are of kind "parameter".
 */
const HIGHLIGHT: Record<string, string> = {
  "editorInlayHint.parameterForeground": "#2DA44E",
  "editorInlayHint.parameterBackground": "#2EA04326",
};
const HIGHLIGHT_PREVIOUS = "stet.highlightPrevious";

class StetExtension implements Host, vscode.TreeDataProvider<El>, vscode.Disposable {
  private projects = new Map<string, Project>();
  private models = new Map<string, TreeModel>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly treeChanged = new vscode.EventEmitter<El | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private lines = new Map<string, number>();
  private readonly tree: vscode.TreeView<El>;
  /** Decided changes, by round (the Review panel shows only open ones). */
  private readonly history: vscode.TreeView<El>;
  private readonly historyChanged = new vscode.EventEmitter<El | undefined>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel("Stet");
  readonly locator: Locator;
  /** PDF previews: built in the background, shown when ready. */
  readonly preview: PreviewPanel;
  private previewFollow: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private ctx: vscode.ExtensionContext) {
    this.locator = new Locator(this);
    this.preview = new PreviewPanel(
      (p) => this.setupPreview(p),
      (t, n) => {
        const live = this.itemsInOrder().filter((e) => e.project === t.project && e.node?.type === "item" && isLive(e.node.item));
        const i = live.findIndex((e) => e.node?.type === "item" && e.node.item.id === t.item.id);
        return live.slice(i + 1, i + 1 + n).map((e) => ({ project: e.project, item: (e.node as { item: Item }).item }));
      },
    );
    this.tree = vscode.window.createTreeView("stet.review", { treeDataProvider: this, showCollapseAll: true });
    this.history = vscode.window.createTreeView("stet.history", {
      showCollapseAll: true,
      treeDataProvider: {
        onDidChangeTreeData: this.historyChanged.event,
        getChildren: (el?: El) => this.childrenOf(el, "history"),
        getTreeItem: (el: El) => this.treeItemOf(el, "history"),
        getParent: (el: El) => this.getParent(el),
      },
    });
    this.status.command = "stet.review.focus";
    this.disposables.push(
      this.tree,
      this.history,
      this.historyChanged,
      this.status,
      this.output,
      this.tree.onDidChangeSelection((e) => {
        const el = e.selection[0];
        if (e.selection.length === 1 && el?.node?.type === "item" && isLive(el.node.item)) void this.showItem(el, true);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("stet.runtime")) void this.applyRuntime();
        if (e.affectsConfiguration("workbench.colorCustomizations")) void this.updateHighlightContext();
        if (e.affectsConfiguration("stet.shareEdits")) for (const p of this.projects.values()) void this.applyShareMode(p, true);
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) for (const p of this.projects.values()) p.scheduleRefresh(0);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.locator.forget(d)),
      this.preview,
      // The preview follows the change under the cursor while it is open.
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!this.preview.visible) return;
        clearTimeout(this.previewFollow);
        this.previewFollow = setTimeout(async () => {
          const p = this.projectFor(e.textEditor.document.uri);
          const pos = e.textEditor.selection.active;
          const hit = p && (await this.locator.locate(e.textEditor.document)).find((l) => l.range.contains(pos));
          if (p && hit) this.preview.follow({ project: p, item: hit.item });
        }, 300);
      }),
      vscode.workspace.onDidSaveTextDocument((d) => this.projectFor(d.uri)?.scheduleChecks()),
    );
  }

  // -------------------------------------------------------------------------
  // Projects

  async discover(): Promise<void> {
    const found = new Map<string, Stet>();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      try {
        const loc = await Stet.locate(f.uri.fsPath);
        // Agent workspaces are for the agent; review happens in the project window.
        if (foldPath(loc.toplevel) !== foldPath(loc.mainPath)) continue;
        const stet = await Stet.open(f.uri.fsPath);
        found.set(foldPath(stet.mainPath), stet);
      } catch {
        /* not a git repo, or Stet not set up */
      }
    }
    for (const [key, p] of this.projects) {
      if (!found.has(key)) {
        p.dispose();
        this.projects.delete(key);
      }
    }
    for (const [key, stet] of found) {
      if (this.projects.has(key)) continue;
      const p = new Project(stet);
      this.projects.set(key, p);
      p.onDidChange(() => this.onProjectChanged());
      p.startWatching();
      await this.ensureRuntime(p).catch((e) => this.output.appendLine(`Runtime setup for ${p.mainPath}: ${e?.message ?? e}`));
      await this.applyShareMode(p, false);
      await p.refresh().catch((e) => this.output.appendLine(`Loading ${p.mainPath}: ${e?.message ?? e}`));
      void this.checkPreviews(p);
    }
    await this.onProjectChanged();
  }

  /** Say once what PDF previews need here (nothing when they work). Never sets anything up unasked. */
  private async checkPreviews(p: Project): Promise<void> {
    try {
      const env = await p.stet.previewStatus();
      this.output.appendLine(`PDF previews in ${p.name}: ${env.status}. ${env.message}`);
      if (await previewNotice(env, this.ctx.globalState, p.name)) await this.setupPreview(p);
    } catch (e: any) {
      this.output.appendLine(`PDF previews in ${p.name}: ${e?.message ?? e}`);
    }
  }

  /** Build the preview image: downloads packages, so only on the user's click. */
  async setupPreview(p?: Project): Promise<void> {
    p ??= await this.pickProject();
    if (!p) return;
    const project = p;
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Stet: building the PDF preview image (downloads Debian, Perl and Poppler)…" },
      () => project.stet.setupPreview().catch((e: any) => ({ ok: false, log: String(e?.message ?? e), status: undefined })),
    );
    if (r.ok) void vscode.window.showInformationMessage(`Stet: ${r.status?.message ?? "PDF previews are set up."}`);
    else {
      this.output.appendLine(r.log);
      void vscode.window.showErrorMessage("Stet: building the PDF preview image failed. Details are in the Stet output.", "Show output").then((c) => c && this.output.show());
    }
    this.preview.refresh();
  }

  /** Open the PDF preview of a change. */
  async showPreview(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (t) this.preview.show(t);
  }

  /** Point agents' tools at the CLI bundled with this extension, unless another `stet` is configured and present. */
  private async ensureRuntime(p: Project): Promise<void> {
    const cfg = await p.stet.config();
    const present = cfg.cli && (await pathExists(cfg.cli.command)) && (await Promise.all(cfg.cli.args.slice(0, 1).map(pathExists))).every(Boolean);
    if (cfg.cli && present && !isManaged(cfg.cli, p.storeRoot)) return;
    const script = await installCli(this.ctx.asAbsolutePath("dist/stet.mjs"), p.storeRoot);
    const mode = vscode.workspace.getConfiguration("stet").get<RuntimeMode>("runtime", "auto");
    const cli = await cliCommand(mode, script);
    if (await p.stet.setCli(cli)) {
      const runner = cli.env?.ELECTRON_RUN_AS_NODE ? "VS Code's runtime" : "Node.js";
      this.output.appendLine(`Agent workspaces of ${p.name} now run ${script} with ${runner} (${cli.command}).`);
      vscode.window.setStatusBarMessage(`$(check) Stet: agents of ${p.name} now use ${runner}`, 5000);
    }
  }

  /**
   * Write `stet.shareEdits` to the project's Stet config, which the agents' `stet` reads too.
   * On startup only a value the user set: the default must not override `stet share <mode>`.
   */
  private async applyShareMode(p: Project, changed: boolean): Promise<void> {
    const conf = vscode.workspace.getConfiguration("stet", vscode.Uri.file(p.mainPath));
    const i = conf.inspect<ShareMode>("shareEdits");
    const set = i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
    if (!changed && set === undefined) return;
    await this.run(p, async () => {
      if (await p.stet.setShareEdits(conf.get<ShareMode>("shareEdits", "manual"))) p.scheduleRefresh(0);
    });
  }

  private async onProjectChanged(): Promise<void> {
    this.models.clear();
    this.lines.clear();
    const all = [...this.projects.values()];
    const snaps = all.map((p) => p.snapshot);
    const pending = snaps.reduce((n, s) => n + s.items.filter(isLive).length, 0);
    const uncommitted = snaps.reduce((n, s) => n + s.uncommitted.length, 0);
    const sync = snaps.flatMap((s) => [...s.syncNeeded]);
    const unshared = all.filter((p) => p.snapshot.unshared).map((p) => p.name);
    const missing = all.flatMap((p) => p.snapshot.missing.map((m) => ({ ...m, project: p.name })));
    // Shown only when something is wrong: accepted changes agents would never see.
    this.tree.message = missing.length
      ? `⚠ Agents don't get accepted ${missing.map((m) => m.id).join(", ")} (${missing[0]!.reason}${missing.length > 1 ? ", …" : ""}). ` +
        "Finish the review, or share your edits, to pass them on."
      : undefined;
    // Redraw first: selecting the next change waits for the tree, not for the context keys.
    this.treeChanged.fire(undefined);
    this.historyChanged.fire(undefined);
    this.changed.fire();
    this.tree.badge = pending ? { value: pending, tooltip: `${pending} proposed change${pending === 1 ? "" : "s"} to review` } : undefined;
    if (all.length) {
      this.status.text =
        `$(checklist) ${pending}` + (uncommitted ? ` $(git-commit) ${uncommitted}` : "") + (sync.length ? " $(sync)" : "") + (unshared.length ? " $(cloud-upload)" : "") + (missing.length ? " $(warning)" : "");
      const tip = [`Stet: ${pending} change${pending === 1 ? "" : "s"} to review`];
      if (uncommitted) tip.push(`${uncommitted} accepted, not committed yet (Finish review)`);
      if (unshared.length) tip.push(`Agents don't see your latest saved edits${all.length > 1 ? ` in ${unshared.join(", ")}` : ""} (Share my edits)`);
      if (sync.length) tip.push(`Behind your latest text: ${sync.join(", ")}. Agents catch up when they next call stet_sync.`);
      for (const m of missing) tip.push(`Agents don't get accepted ${m.id}: ${m.reason}. Finish the review or share your edits.`);
      this.status.tooltip = tip.join("\n");
      this.status.show();
    } else this.status.hide();
    const context: [string, boolean][] = [
      ["stet.active", all.length > 0],
      ["stet.hasAgents", snaps.some((s) => s.agents.some((a) => a.state === "active"))],
      ["stet.uncommitted", uncommitted > 0],
      ["stet.unshared", unshared.length > 0],
    ];
    await Promise.all(context.map(([k, v]) => vscode.commands.executeCommand("setContext", k, v)));
  }

  projectFor(uri: vscode.Uri): Project | undefined {
    return [...this.projects.values()].find((p) => p.relPath(uri) !== null);
  }

  model(p: Project, mode: TreeMode = "review"): TreeModel {
    const key = `${mode}|${p.mainPath}`;
    let m = this.models.get(key);
    if (!m) this.models.set(key, (m = new TreeModel(p.snapshot, mode)));
    return m;
  }

  allProjects(): Project[] {
    return [...this.projects.values()];
  }

  // -------------------------------------------------------------------------
  // Tree

  getChildren(el?: El): El[] {
    return this.childrenOf(el, "review");
  }

  getTreeItem(el: El): Promise<vscode.TreeItem> {
    return this.treeItemOf(el, "review");
  }

  private childrenOf(el: El | undefined, mode: TreeMode): El[] {
    const ps = this.allProjects();
    if (!el) {
      if (ps.length === 1) return this.model(ps[0]!, mode).children().map((node) => ({ project: ps[0]!, node }));
      return ps.map((project) => ({ project }));
    }
    return this.model(el.project, mode).children(el.node).map((node) => ({ project: el.project, node }));
  }

  private async treeItemOf(el: El, mode: TreeMode): Promise<vscode.TreeItem> {
    const t = await this.buildTreeItem(el, mode);
    t.id = elId(el);
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
        return this.allProjects().length > 1 ? { project: p } : undefined;
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
  private itemsInOrder(): El[] {
    const out: El[] = [];
    const walk = (el?: El) => {
      for (const c of this.getChildren(el)) {
        if (c.node?.type === "item") out.push(c);
        else walk(c);
      }
    };
    walk();
    return out;
  }

  /** Select the next (or previous) change in the panel and show it in the editor (`j` / `k`). */
  async step(dir: 1 | -1): Promise<void> {
    const list = this.itemsInOrder();
    if (!list.length) return;
    const cur = this.tree.selection[0];
    let i = cur ? list.findIndex((e) => elId(e) === elId(cur)) : -1;
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir));
    const next = list[i]!;
    await this.tree.reveal(next, { select: true, focus: true });
    await this.showItem(next, true);
  }

  /**
   * Run a decision on `anchor` (accept, reject, …), then select the next pending change in panel
   * order and show it, so reviewing is one key per change. Nothing moves if the decision was
   * cancelled or failed. `fromPanel`: keep the focus in the panel (keyboard review); otherwise
   * (CodeLens, hover) the editor moves to the next change.
   */
  private async decide(p: Project, anchor: string, fromPanel: boolean, action: () => Promise<void>): Promise<void> {
    const idOf = (e: El) => (e.node?.type === "item" ? e.node.item.id : "");
    const before = this.itemsInOrder().filter((e) => e.project === p).map(idOf);
    const status = this.model(p).item(anchor)?.status;
    await action();
    if (!vscode.workspace.getConfiguration("stet").get<boolean>("autoAdvance", true)) return;
    if (this.model(p).item(anchor)?.status === status) return;
    const live = new Map(this.itemsInOrder().filter((e) => e.project === p && e.node?.type === "item" && isLive(e.node.item)).map((e) => [idOf(e), e]));
    const i = before.indexOf(anchor);
    const next = [...before.slice(i + 1), ...before.slice(0, Math.max(i, 0))].map((id) => live.get(id)).find((e) => e !== undefined);
    if (!next) return;
    // From the editor with the panel closed, only the editor moves (revealing would open the panel).
    if (fromPanel || this.tree.visible) await this.tree.reveal(next, { select: true, focus: fromPanel });
    await this.showItem(next, fromPanel);
  }

  private async buildTreeItem(el: El, mode: TreeMode): Promise<vscode.TreeItem> {
    const E = vscode.TreeItemCollapsibleState.Expanded;
    if (!el.node) {
      const t = new vscode.TreeItem(el.project.name, E);
      t.iconPath = new vscode.ThemeIcon("repo");
      t.tooltip = el.project.mainPath;
      return t;
    }
    const n = el.node;
    const model = this.model(el.project, mode);
    const history = mode === "history";
    const snap = el.project.snapshot;
    switch (n.type) {
      case "agent": {
        const t = new vscode.TreeItem(n.agent.id, E);
        const pending = model.liveCount((i) => i.agent === n.agent.id);
        const parts = history ? [model.outcome((i) => i.agent === n.agent.id)] : [`${pending} pending`];
        if (snap.syncNeeded.has(n.agent.id)) parts.push("behind your text");
        if (n.agent.state === "archived") parts.push("archived");
        const notify = notifyMode(n.agent);
        if (n.agent.state === "active" && notify === "off") parts.push("not notified");
        t.description = parts.join(" · ");
        t.iconPath = new vscode.ThemeIcon(n.agent.kind === "codex" ? "terminal" : "hubot");
        t.tooltip = new vscode.MarkdownString(
          `**${esc(n.agent.id)}** (${n.agent.kind})\n\nWorkspace: ${esc(n.agent.worktree)}` +
            (snap.syncNeeded.has(n.agent.id) ? "\n\nThe agent works on an older version of your text; it catches up when it calls `stet_sync`." : "") +
            (n.agent.state === "active"
              ? `\n\nNotifications: ${NOTIFY_PICKS.find((x) => x.mode === notify)!.label.toLowerCase()}` +
                (notifyTriggers(n.agent).length < NOTIFY_TRIGGERS.length
                  ? `, for ${notifyTriggers(n.agent).map((t) => NOTIFY_TRIGGER_TEXT[t].toLowerCase()).join(", ") || "nothing"}`
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
        const replies = nt.thread.length ? ` · ${nt.thread.length} repl${nt.thread.length === 1 ? "y" : "ies"}` : "";
        t.description = `${nt.file}${nt.deliveredAt ? "" : " · not delivered yet"}${replies}`;
        t.iconPath = new vscode.ThemeIcon("note");
        t.tooltip = new vscode.MarkdownString(
          `**${nt.id}** note for ${esc(nt.agent)} on ${esc(nt.file)}${nt.deliveredAt ? "" : " (the agent receives it at its next sync)"}\n\n${esc(nt.body)}\n\n${fence(nt.text, "latex")}` +
            nt.thread.slice(-3).map((r) => `\n\n> **${r.author === "user" ? "You" : esc(nt.agent)}:** ${esc(r.text)}`).join(""),
        );
        t.contextValue = "note.open";
        t.command = { command: "stet.showNote", title: "Go to note", arguments: [el] };
        return t;
      }
      case "changeset": {
        const cs = n.changeset;
        // Old rounds stay closed in History, so it reads as a list of rounds.
        const t = new vscode.TreeItem(roundLabel(cs), history ? vscode.TreeItemCollapsibleState.Collapsed : E);
        const live = model.liveCount((i) => i.changeset === cs.id);
        t.description = history ? model.outcome((i) => i.changeset === cs.id) : `${live} pending`;
        t.iconPath = new vscode.ThemeIcon("layers");
        t.tooltip = new vscode.MarkdownString(`**Round ${roundOf(cs.id)}** (${cs.id}) ${esc(cs.title)}\n\n${esc(cs.rationale)}\n\n*${new Date(cs.submittedAt).toLocaleString()}*`);
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
        t.contextValue = members.some(isLive) ? `group.live.${g.kind}` : `group.done.${g.kind}`;
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
        t.contextValue = members.some(isLive) ? "part.live" : "part.done";
        return t;
      }
      case "item": {
        const it = n.item;
        const t = new vscode.TreeItem(itemLabel(it, model.get), vscode.TreeItemCollapsibleState.None);
        const line = await this.lineOf(el.project, it);
        t.description = `${it.file}${it.kind === "modify" ? `:${line}` : ""}${it.status === "pending" ? "" : ` · ${STATUS_TEXT[it.status]}`}`;
        t.iconPath = itemIcon(it);
        const md = new vscode.MarkdownString(itemMarkdown(it, model));
        t.tooltip = md;
        // Undoable: a rejection, or an accept not committed yet.
        const undo = it.status === "rejected" || (it.status === "accepted" && !!it.resolution && !it.resolution.committed);
        t.contextValue = isLive(it) ? `item.live.${it.kind}` : `item.done.${it.kind}${undo ? ".undo" : ""}`;
        // Decided changes open as a diff of the change itself; open ones are shown in the file.
        t.command = history
          ? { command: "stet.showDiff", title: "Show diff", arguments: [el] }
          : { command: "stet.showItem", title: "Go to change", arguments: [el, true] };
        return t;
      }
    }
  }

  private async lineOf(p: Project, it: Item): Promise<number> {
    const key = `${p.mainPath}|${it.id}`;
    const hit = this.lines.get(key);
    if (hit !== undefined) return hit;
    const doc = vscode.workspace.textDocuments.find((d) => p.relPath(d.uri) === it.file);
    let line: number | undefined;
    if (doc) {
      const l = (await this.locator.locate(doc)).find((x) => x.item.id === it.id);
      if (l) line = l.range.start.line + 1;
    }
    line ??= (await p.stet.locateInWorkingCopy(it).catch(() => ({ line: 1 }))).line;
    this.lines.set(key, line);
    return line;
  }

  // -------------------------------------------------------------------------
  // Targets for commands (tree element, item id from CodeLens/hover, or tree selection / cursor)

  private findItem(id: string): { project: Project; item: Item } | undefined {
    const ed = vscode.window.activeTextEditor;
    const ps = this.allProjects();
    const first = ed ? this.projectFor(ed.document.uri) : undefined;
    for (const p of first ? [first, ...ps.filter((x) => x !== first)] : ps) {
      const item = this.model(p).item(id);
      if (item) return { project: p, item };
    }
    return undefined;
  }

  private async target(arg: unknown): Promise<El | undefined> {
    if (isRef(arg)) {
      // Resolve strictly within the given project.
      const p = this.projects.get(foldPath(arg.path));
      if (!p) return undefined;
      const model = this.model(p);
      const pid = parsePartId(arg.id);
      const owner = pid ? model.group(pid.group) : undefined;
      if (owner && pid && owner.parts?.[pid.index]) return { project: p, node: { type: "part", group: owner, index: pid.index } };
      const group = /^G\d+$/i.test(arg.id) ? model.group(arg.id) : undefined;
      if (group) return { project: p, node: { type: "group", group } };
      const item = model.item(arg.id);
      return item && { project: p, node: { type: "item", item, parent: "" } };
    }
    if (typeof arg === "string") {
      if (/^G\d+$/i.test(arg)) {
        for (const p of this.allProjects()) {
          const group = this.model(p).group(arg);
          if (group) return { project: p, node: { type: "group", group } };
        }
        return undefined;
      }
      const f = this.findItem(arg);
      return f && { project: f.project, node: { type: "item", item: f.item, parent: "" } };
    }
    if (arg && typeof arg === "object" && "project" in arg) return arg as El;
    const sel = this.tree.selection[0];
    if (sel && this.tree.visible) return sel;
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      const p = this.projectFor(ed.document.uri);
      const pos = ed.selection.active;
      const hit = (await this.locator.locate(ed.document)).find((l) => l.range.contains(pos) || l.range.start.line === pos.line);
      if (p && hit) return { project: p, node: { type: "item", item: hit.item, parent: "" } };
    }
    return undefined;
  }

  private async targetItem(arg: unknown): Promise<{ project: Project; item: Item } | undefined> {
    const t = await this.target(arg);
    if (t?.node?.type === "item") return { project: t.project, item: t.node.item };
    void vscode.window.showInformationMessage("Select a proposed change in the Stet panel, or put the cursor on one.");
    return undefined;
  }

  /** Save open, modified documents for `files` before Stet writes to disk. */
  private async saveFiles(p: Project, files: string[]): Promise<void> {
    for (const d of vscode.workspace.textDocuments) {
      const rel = p.relPath(d.uri);
      if (rel && files.includes(rel) && d.isDirty) await d.save();
    }
  }

  private async run<T>(p: Project | undefined, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e: any) {
      void vscode.window.showErrorMessage(e?.message ?? String(e));
      return undefined;
    } finally {
      await p?.refresh().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Review commands

  async accept(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    // Half a move is never decided alone: its other half comes along without asking.
    const own = this.model(p).withMove(item);
    const rest = this.model(p).linkedRest(own);
    let ids = own;
    let overrideLinked = false;
    if (rest.length) {
      const unit = this.unitName(p, item);
      const all = `Accept all ${rest.length + own.length} changes of ${unit}`;
      const only = `Accept only ${own.join(" + ")}`;
      const pick = await vscode.window.showQuickPick(
        [
          { label: all, detail: `${[...own, ...rest.map((i) => i.id)].join(", ")} belong together.` },
          { label: only, detail: "Breaks the linked group; the agent is asked to repair the document." },
        ],
        { title: `${item.id} is linked with ${rest.map((r) => r.id).join(", ")}` },
      );
      if (!pick) return;
      if (pick.label === all) ids = [...own, ...rest.map((r) => r.id)];
      else overrideLinked = true;
    }
    await this.decide(p, item.id, !isRef(arg), () => this.doAccept(p, ids, { overrideLinked }));
  }

  /** What an item must be decided with: "the linked group" or "part 2 “Section 3”". */
  private unitName(p: Project, item: Item): string {
    const part = this.model(p).partOf(item);
    return part ? `part ${part.index + 1} “${part.group.parts![part.index]!.title}”` : "the linked group";
  }

  private async doAccept(p: Project, ids: string[], opts: { overrideLinked?: boolean; edited?: Record<string, string> } = {}): Promise<void> {
    const files = ids.flatMap((id) => {
      const it = this.model(p).item(id);
      return it ? [it.file, ...(it.oldFile ? [it.oldFile] : [])] : [];
    });
    await this.run(p, async () => {
      await this.saveFiles(p, files);
      const r = await p.stet.accept(ids, opts);
      const msg = [`Accepted ${r.accepted.map((i) => i.id).join(", ")}${r.committed ? ` (committed ${r.committed.slice(0, 7)})` : ""}.`];
      if (r.stale.length) msg.push(`Now stale (overlapped): ${r.stale.map((i) => i.id).join(", ")}.`);
      msg.push(...r.warnings);
      if (r.warnings.length) void vscode.window.showWarningMessage(msg.join(" "));
      else vscode.window.setStatusBarMessage(`$(check) ${msg.join(" ")}`, 4000);
    });
  }

  /**
   * The pending changes a group, a changeset, or a change's group stands for (Accept all /
   * Reject all). Tells the user and returns undefined when there is nothing to act on.
   */
  private async scope(arg: unknown): Promise<{ project: Project; ids: string[]; what: string; changeset: boolean } | undefined> {
    const t = await this.target(arg);
    if (!t?.node) return undefined;
    const p = t.project;
    const model = this.model(p);
    let n = t.node;
    if (n.type === "item") {
      const it = n.item;
      const g = model.linkedGroup(it) ?? it.groups.map((x) => model.group(x)).find((x): x is Group => !!x && x.kind !== "atomic");
      if (!g) return void vscode.window.showInformationMessage(`${it.id} is not part of a group.`);
      n = { type: "group", group: g };
    }
    if (n.type === "part") {
      const g = n.group;
      const ids = model.partMembers(g, n.index).filter(isLive).map((i) => i.id);
      const what = `${partId(g.id, n.index)} “${g.parts?.[n.index]?.title ?? ""}”`;
      return ids.length ? { project: p, ids, what, changeset: false } : void vscode.window.showInformationMessage(`Nothing pending in ${what}.`);
    }
    if (n.type === "group") {
      const ids = model.members(n.group).filter(isLive).map((i) => i.id);
      return ids.length ? { project: p, ids, what: `${n.group.id} “${n.group.title}”`, changeset: false } : void vscode.window.showInformationMessage(`Nothing pending in ${n.group.id}.`);
    }
    if (n.type === "changeset") {
      const cs = n.changeset;
      const ids = p.snapshot.items.filter((i) => i.changeset === cs.id && isLive(i)).map((i) => i.id);
      return ids.length ? { project: p, ids, what: `${cs.id} “${cs.title}”`, changeset: true } : void vscode.window.showInformationMessage(`Nothing pending in ${cs.id}.`);
    }
    return undefined;
  }

  async acceptAll(arg: unknown): Promise<void> {
    const s = await this.scope(arg);
    if (!s) return;
    let ids = s.ids;
    if (s.changeset) {
      ids = [...ids, ...this.model(s.project).linkedRest(ids).map((i) => i.id)];
      const ok = await vscode.window.showWarningMessage(`Accept all ${ids.length} changes of ${s.what}?`, { modal: true }, "Accept all");
      if (ok !== "Accept all") return;
    }
    await this.decide(s.project, s.ids[0]!, !isRef(arg), () => this.doAccept(s.project, ids));
  }

  private async reason(prompt: string): Promise<string | undefined> {
    return vscode.window.showInputBox({ title: prompt, prompt: "Optional, but it helps the agent: why? (Enter to skip)", placeHolder: "e.g. keep the original formula" });
  }

  async reject(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const own = this.model(p).withMove(item);
    const rest = this.model(p).linkedRest(own);
    let mode: "all" | "revise-rest" | "only" | undefined;
    if (rest.length) {
      const picks = [
        { label: `Reject all ${rest.length + own.length} changes of ${this.unitName(p, item)}`, mode: "all" as const },
        { label: `Reject ${own.join(" + ")}, ask the agent to revise the rest`, mode: "revise-rest" as const },
        { label: `Reject only ${own.join(" + ")}`, mode: "only" as const, detail: "Breaks the linked group; the agent is asked to repair the document." },
      ];
      const pick = await vscode.window.showQuickPick(picks, { title: `${item.id} is linked with ${rest.map((r) => r.id).join(", ")}` });
      if (!pick) return;
      mode = pick.mode;
    }
    const reason = await this.reason(`Reject ${item.id}`);
    if (reason === undefined) return;
    await this.decide(p, item.id, !isRef(arg), () => this.run(p, async () => {
      const r = await p.stet.reject(own, { ...(reason ? { reason } : {}), ...(mode ? { mode } : {}) });
      vscode.window.setStatusBarMessage(`$(close) Rejected ${r.map((i) => i.id).join(", ")}`, 4000);
    }));
  }

  async rejectAll(arg: unknown): Promise<void> {
    const s = await this.scope(arg);
    if (!s) return;
    const reason = await this.reason(`Reject all ${s.ids.length} changes of ${s.what}`);
    if (reason === undefined) return;
    const p = s.project;
    await this.decide(p, s.ids[0]!, !isRef(arg), () => this.run(p, async () => {
      const r = await p.stet.reject(s.ids, { ...(reason ? { reason } : {}), mode: "all" });
      vscode.window.setStatusBarMessage(`$(close) Rejected ${r.map((i) => i.id).join(", ")}`, 4000);
    }));
  }

  async edit(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    if (item.kind !== "modify") return void vscode.window.showInformationMessage(`${item.id} changes a whole file; it can only be accepted or rejected.`);
    let text: string | undefined;
    if (!item.newText.includes("\n") && item.newText.length <= 400) {
      text = await vscode.window.showInputBox({
        title: `Edit ${item.id} before accepting`,
        prompt: item.oldText ? `Replaces: ${oneLine(item.oldText, 120)}` : "Inserted text",
        value: item.newText,
        valueSelection: [item.newText.length, item.newText.length],
      });
    } else {
      const doc = await vscode.workspace.openTextDocument({ content: item.newText, language: "latex" });
      await vscode.window.showTextDocument(doc, { preview: false });
      const ok = await vscode.window.showInformationMessage(`Edit the text of ${item.id} in this tab, then choose “Accept edited”.`, "Accept edited", "Cancel");
      text = ok === "Accept edited" ? doc.getText() : undefined;
      if (vscode.window.activeTextEditor?.document === doc) await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
    if (text === undefined) return;
    const rest = this.model(p).linkedRest([item.id]);
    await this.decide(p, item.id, !isRef(arg), () => this.doAccept(p, [item.id, ...rest.map((r) => r.id)], { edited: { [item.id]: toLf(text) } }));
  }

  async comment(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const text = await vscode.window.showInputBox({ title: `Comment on ${t.item.id}`, prompt: "The agent sees this with its feedback and can reply.", placeHolder: "Message to the agent…" });
    if (!text) return;
    await this.run(t.project, () => t.project.stet.comment(t.item.id, text, "user"));
  }

  async revise(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const text = await vscode.window.showInputBox({ title: `Request a revision of ${t.item.id}`, prompt: "What should the agent change?", placeHolder: "e.g. shorter, and keep the term “ansatz”" });
    if (!text) return;
    await this.decide(t.project, t.item.id, !isRef(arg), () => this.run(t.project, () => t.project.stet.requestRevision(t.item.id, text)).then(() => undefined));
  }

  // -------------------------------------------------------------------------
  // Reviewer notes (spec §7.8)

  /** An agent of `p` to address, asked for when there is more than one. */
  private async pickNoteAgent(p: Project): Promise<string | undefined> {
    const agents = p.snapshot.agents.filter((a) => a.state === "active");
    if (!agents.length) return void vscode.window.showInformationMessage("Notes go to an agent: create an agent workspace first (Stet: New agent workspace).");
    if (agents.length === 1) return agents[0]!.id;
    const pick = await vscode.window.showQuickPick(agents.map((a) => ({ label: a.id, description: a.kind })), { title: "Note for which agent?" });
    return pick?.label;
  }

  /** Leave a note for an agent on the selected passage (or the current line). */
  async noteForAgent(): Promise<void> {
    const ed = vscode.window.activeTextEditor;
    const p = ed && this.projectFor(ed.document.uri);
    const file = p && ed ? p.relPath(ed.document.uri) : null;
    if (!ed || !p || !file) return void vscode.window.showInformationMessage("Open a file of your Stet project and select the passage the note is about.");
    const agent = await this.pickNoteAgent(p);
    if (!agent) return;
    const body = await vscode.window.showInputBox({
      title: `Note for ${agent}`,
      prompt: "What should the agent do with this passage? It receives the note at its next sync.",
      placeHolder: "e.g. shorten this paragraph, and keep the citation",
    });
    if (!body) return;
    await this.addNote(p, file, ed.document, ed.selection.isEmpty ? new vscode.Range(ed.selection.active.line, 0, ed.selection.active.line, Number.MAX_SAFE_INTEGER) : ed.selection, agent, body);
  }

  /** Leave a note on `range` of `doc` (as shown, unsaved edits included). */
  private async addNote(p: Project, file: string, doc: vscode.TextDocument, range: vscode.Range, agent: string, body: string): Promise<void> {
    const text = toLf(doc.getText());
    const idx = new LineIndex(text);
    const r = doc.validateRange(range);
    const start = idx.offset(r.start.line, r.start.character);
    const end = idx.offset(r.end.line, r.end.character);
    await this.run(p, async () => {
      const n = await p.stet.addNote(agent, { file, start, end, text }, body);
      vscode.window.setStatusBarMessage(`$(note) ${n.id} for ${agent}: it arrives at the agent's next sync.`, 5000);
    });
  }

  /** The note a command is about: a tree element, a comment thread, or an id. */
  private noteTarget(arg: unknown): { project: Project; note: Note } | undefined {
    if (arg && typeof arg === "object" && "project" in arg && (arg as El).node?.type === "note") {
      const el = arg as El & { node: { type: "note"; note: Note } };
      return { project: el.project, note: el.node.note };
    }
    const id = typeof arg === "string" ? arg : (arg as vscode.CommentThread | undefined)?.contextValue;
    if (!id || !isNoteId(id)) return undefined;
    const uri = (arg as vscode.CommentThread | undefined)?.uri;
    const ps = uri && typeof arg !== "string" ? [this.projectFor(uri)].filter((x): x is Project => !!x) : this.allProjects();
    for (const project of ps) {
      const note = project.snapshot.notes.find((n) => n.id === id.toUpperCase());
      if (note) return { project, note };
    }
    return undefined;
  }

  async resolveNote(arg: unknown): Promise<void> {
    const t = this.noteTarget(arg);
    if (!t) return;
    await this.run(t.project, () => t.project.stet.resolveNote(t.note.id).then(() => undefined));
  }

  /** Reply in a note's thread (from the editor). */
  async replyNote(p: Project, note: Note, text: string): Promise<void> {
    await this.run(p, () => p.stet.replyNote(note.id, text, "user").then(() => undefined));
  }

  /** Create a note from a comment thread the user started on a line without a proposed change. */
  async noteFromThread(thread: vscode.CommentThread, text: string): Promise<boolean> {
    const p = this.projectFor(thread.uri);
    const file = p?.relPath(thread.uri);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === thread.uri.toString());
    if (!p || !file || !doc || !thread.range) return false;
    const agent = await this.pickNoteAgent(p);
    if (!agent) return false;
    const r = thread.range;
    await this.addNote(p, file, doc, new vscode.Range(r.start.line, 0, r.end.line, Number.MAX_SAFE_INTEGER), agent, text);
    return true;
  }

  async showNote(arg: unknown): Promise<void> {
    const t = this.noteTarget(arg);
    if (!t) return;
    const doc = await vscode.workspace.openTextDocument(t.project.fileUri(t.note.file));
    const text = toLf(doc.getText());
    const span = t.project.stet.locateNoteInText(t.note, text);
    const idx = new LineIndex(text);
    const range = span ? new vscode.Range(idx.position(span.start).line, idx.position(span.start).character, idx.position(span.end).line, idx.position(span.end).character) : new vscode.Range(0, 0, 0, 0);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
    ed.selection = new vscode.Selection(range.start, range.end);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!span) void vscode.window.showInformationMessage(`The passage of ${t.note.id} is no longer in ${t.note.file}.`);
  }

  async ungroup(arg: unknown): Promise<void> {
    const t = await this.target(arg);
    if (t?.node?.type !== "group") return;
    const g = t.node.group;
    await this.run(t.project, () => t.project.stet.ungroup(g.id));
  }

  async replyThread(reply: vscode.CommentReply, threads: Threads): Promise<void> {
    const note = threads.noteForThread(reply.thread);
    if (note) return this.replyNote(note.project, note.note, reply.text);
    const hit = await threads.itemForThread(reply.thread);
    if (!hit) {
      // A new thread away from proposed changes: a note for an agent on those lines.
      const own = threads.isOwn(reply.thread);
      const made = !own && (await this.noteFromThread(reply.thread, reply.text));
      if (!made && !own) void vscode.window.showWarningMessage("Comments go on a proposed change, or become a note for an agent: open a Stet project file.");
      if (!own) reply.thread.dispose();
      return;
    }
    if (!threads.isOwn(reply.thread)) reply.thread.dispose();
    await this.run(hit.project, () => hit.project.stet.comment(hit.item.id, reply.text, "user"));
  }

  // -------------------------------------------------------------------------
  // Navigation

  async showItem(arg: unknown, preserveFocus = false): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    if (item.kind !== "modify") return this.showDiff({ project: p, node: { type: "item", item, parent: "" } } satisfies El);
    const uri = p.fileUri(item.file);
    if (!(await pathExists(uri.fsPath))) return void vscode.window.showWarningMessage(`${item.file} does not exist in your project.`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const hit = (await this.locator.locate(doc)).find((l) => l.item.id === item.id);
    const line = hit ? 0 : (await this.lineOf(p, item)) - 1;
    const range = hit?.range ?? new vscode.Range(line, 0, line, 0);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus, preview: true });
    ed.selection = new vscode.Selection(range.start, range.end);
    this.preview.follow({ project: p, item });
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!hit && isLive(item)) vscode.window.setStatusBarMessage(`$(warning) ${item.id}: its text is no longer where it was; showing the last known line.`, 5000);
  }

  async showDiff(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const key = encodeURIComponent(p.mainPath);
    const mk = (side: string) => vscode.Uri.from({ scheme: "stet-diff", path: `/${item.file}`, query: `p=${key}&id=${item.id}&side=${side}` });
    await vscode.commands.executeCommand("vscode.diff", mk("before"), mk("after"), `${item.id} ${item.file} (current ↔ proposed)`, { preview: true });
  }

  /** Content of `stet-diff:` documents. */
  async diffSide(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const p = this.projects.get(foldPath(decodeURIComponent(q.get("p") ?? "")));
    const item = p && this.model(p).item(q.get("id") ?? "");
    if (!p || !item) return "";
    const after = q.get("side") === "after";
    if (item.kind === "binary") return `(binary file ${item.file})`;
    if (item.kind !== "modify") return after ? item.newText : item.oldText;
    if (!isLive(item)) {
      const { before, after: rest } = item.context;
      return before + (after ? (item.resolution?.appliedText ?? item.newText) : item.oldText) + rest;
    }
    const uri2 = p.fileUri(item.file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri2.toString()) ?? (await vscode.workspace.openTextDocument(uri2));
    const text = toLf(doc.getText());
    if (!after) return text;
    const span = await p.stet.locateInText(item, text);
    if (!span) return text + "\n% Stet: this change could not be located in the current text.\n";
    return text.slice(0, span.start) + item.newText + text.slice(span.end);
  }

  // -------------------------------------------------------------------------
  // Project and agent commands

  private async pickProject(): Promise<Project | undefined> {
    const ps = this.allProjects();
    if (ps.length <= 1) return ps[0];
    const pick = await vscode.window.showQuickPick(ps.map((p) => ({ label: p.name, description: p.mainPath, p })), { title: "Which project?" });
    return pick?.p;
  }

  async setup(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) return void vscode.window.showInformationMessage("Open the folder of your LaTeX project first.");
    const folder =
      folders.length === 1
        ? folders[0]!
        : (await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })), { title: "Set up Stet for which folder?" }))?.f;
    if (!folder) return;
    const dir = folder.uri.fsPath;
    try {
      const repo = new Repo(dir);
      if ((await repo.tryRun(["rev-parse", "--is-inside-work-tree"])) !== "true") {
        const ok = await vscode.window.showWarningMessage(
          `${folder.name} is not a git repository.`,
          { modal: true, detail: "Stet uses git to keep the agents' proposals apart from your files. Create a repository here and commit the current files as a starting point?" },
          "Create repository",
        );
        if (ok !== "Create repository") return;
        await repo.run(["init"]);
      }
      if (!(await repo.revParse("HEAD"))) {
        const ok = await vscode.window.showWarningMessage(
          "The repository has no commits yet.",
          { modal: true, detail: "Stet reviews changes against your last commit. Commit the current files now?" },
          "Commit files",
        );
        if (ok !== "Commit files") return;
        await repo.run(["add", "-A"]);
        await repo.run(["commit", "-m", "Initial commit"]);
      }
      const loc = await Stet.locate(dir);
      const storeRoot = join(loc.commonDir, "stet");
      let keepCli = false;
      try {
        const cfg = await (await Stet.open(dir)).config();
        keepCli = !!cfg.cli && !isManaged(cfg.cli, storeRoot) && (await pathExists(cfg.cli.command));
      } catch {
        /* first setup */
      }
      const opts: Parameters<typeof Stet.init>[1] = {};
      if (!keepCli) {
        const script = await installCli(this.ctx.asAbsolutePath("dist/stet.mjs"), storeRoot);
        opts.cli = await cliCommand(vscode.workspace.getConfiguration("stet").get<RuntimeMode>("runtime", "auto"), script);
      }
      const stet = await Stet.init(dir, opts);
      await this.discover();
      const cfg = await stet.config();
      const next = await vscode.window.showInformationMessage(
        `Stet is set up for ${folder.name} (main branch '${cfg.mainBranch}'). Next, create a workspace for an AI agent.`,
        "New agent workspace",
      );
      if (next) await this.newAgent();
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Stet setup failed: ${e?.message ?? e}`);
    }
  }

  async newAgent(): Promise<void> {
    const p = await this.pickProject();
    if (!p) return void vscode.window.showInformationMessage("Set up Stet for this project first.", "Set up project").then((c) => c && this.setup());
    const kinds: { label: string; detail: string; agentKind: AgentKind }[] = [
      { label: "Claude", detail: "Claude desktop app (Code tab) or Claude Code", agentKind: "claude-code" },
      { label: "Codex", detail: "Codex CLI, app or IDE extension", agentKind: "codex" },
      { label: "Other", detail: "Any agent that can edit files and run commands", agentKind: "other" },
    ];
    const k = await vscode.window.showQuickPick(kinds, { title: "Which AI agent will work in this workspace?" });
    if (!k) return;
    const existing = p.snapshot.agents.map((a) => a.id);
    const id = await vscode.window.showInputBox({
      title: "Name of the agent workspace",
      value: suggestAgentId(k.agentKind, existing),
      validateInput: (v) =>
        !AGENT_ID.test(v) ? "Use letters, digits, '.', '_' or '-'." : existing.includes(v) ? `'${v}' already exists.` : undefined,
    });
    if (!id) return;
    const agent = await this.run(p, async () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating workspace ${id}…` }, () => p.stet.newAgent(id, { kind: k.agentKind })),
    );
    if (agent) await this.agentActions(agent, true);
  }

  private async agentActions(agent: Agent, created = false): Promise<void> {
    const app = agent.kind === "codex" ? "Codex" : agent.kind === "claude-code" ? "the Claude desktop app (Code tab) or Claude Code" : "your agent";
    const actions = [
      { label: "$(copy) Copy folder path", id: "copy", detail: `Then open the folder in ${app}.` },
      { label: "$(folder-opened) Reveal in file manager", id: "reveal" },
      { label: "$(window) Open in new VS Code window", id: "window", detail: "For agents that run inside VS Code (e.g. the Codex or Claude Code extension)." },
    ];
    const pick = await vscode.window.showQuickPick(actions, {
      title: created ? `Workspace ${agent.id} is ready: ${agent.worktree}` : `Workspace ${agent.id}: ${agent.worktree}`,
      placeHolder: `Open this folder in ${app}; the agent's instructions and tools are already set up there.`,
    });
    if (!pick) return;
    const uri = vscode.Uri.file(agent.worktree);
    if (pick.id === "copy") {
      await copyPath(agent.worktree);
      vscode.window.setStatusBarMessage(`$(copy) Copied ${agent.worktree}`, 4000);
    } else if (pick.id === "reveal") await vscode.commands.executeCommand("revealFileInOS", uri);
    else await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
  }

  private async pickAgent(arg: unknown): Promise<{ project: Project; agent: Agent } | undefined> {
    if (arg && typeof arg === "object" && "node" in arg && (arg as El).node?.type === "agent") {
      const el = arg as El & { node: { type: "agent"; agent: Agent } };
      return { project: el.project, agent: el.node.agent };
    }
    const all = this.allProjects().flatMap((project) => project.snapshot.agents.filter((a) => a.state === "active").map((agent) => ({ project, agent })));
    if (!all.length) return void vscode.window.showInformationMessage("No agent workspaces yet.", "New agent workspace").then((c) => c && this.newAgent());
    const pick = await vscode.window.showQuickPick(
      all.map((x) => ({ label: x.agent.id, description: x.agent.kind, detail: x.agent.worktree, x })),
      { title: "Agent workspace" },
    );
    return pick?.x;
  }

  async openAgent(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (a) await this.agentActions(a.agent);
  }

  async copyAgentPath(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (a) await copyPath(a.agent.worktree);
  }

  /**
   * When and about what an agent waiting with `stet watch` is woken, in one checklist: the timing
   * (one of two) and the kinds of news. Nothing ticked below means off.
   */
  async agentNotify(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    type Item = vscode.QuickPickItem & { timing?: NotifyMode; news?: NotifyTrigger };
    const mode = notifyMode(a.agent);
    const timings: Item[] = NOTIFY_PICKS.filter((x) => x.mode !== "off").map((x) => ({ label: x.label, detail: x.detail, timing: x.mode }));
    const kinds: Item[] = NOTIFY_TRIGGERS.map((t) => ({ label: NOTIFY_TRIGGER_TEXT[t], news: t }));
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Notifications for ${a.agent.id}`;
    qp.placeholder = "Untick every kind of news to turn notifications off. The megaphone wakes the agent at once.";
    qp.canSelectMany = true;
    qp.items = [
      { label: "When", kind: vscode.QuickPickItemKind.Separator },
      ...timings,
      { label: "Wake it for", kind: vscode.QuickPickItemKind.Separator },
      ...kinds,
    ];
    let timing = timings.find((t) => t.timing === (mode === "off" ? "batched" : mode))!;
    const on = new Set(mode === "off" ? [] : notifyTriggers(a.agent));
    qp.selectedItems = [timing, ...kinds.filter((k) => on.has(k.news!))];
    // The two timings exclude each other, and one of them is always ticked.
    qp.onDidChangeSelection((sel) => {
      const picked = sel.filter((s) => s.timing);
      const next = picked.find((s) => s !== timing) ?? picked[0] ?? timing;
      if (picked.length !== 1 || next !== timing) {
        timing = next;
        qp.selectedItems = [timing, ...sel.filter((s) => s.news)];
      }
    });
    const chosen = await new Promise<Item[] | undefined>((resolve) => {
      qp.onDidAccept(() => resolve([...qp.selectedItems]));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!chosen) return;
    const kindsOn = chosen.filter((c) => c.news).map((c) => c.news!);
    await this.run(a.project, async () => {
      if (!kindsOn.length) return a.project.stet.setNotify(a.agent.id, "off");
      await a.project.stet.setNotifyOn(a.agent.id, kindsOn);
      return a.project.stet.setNotify(a.agent.id, timing.timing!);
    });
  }

  /** *Notify now*: wake a watching agent, whatever its settings, optionally with a message. */
  async agentPing(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    const message = await vscode.window.showInputBox({
      title: `Notify ${a.agent.id} now`,
      prompt: "Wakes the agent if it is waiting with stet watch. A message is optional.",
      placeHolder: "e.g. I've finished reviewing round 3",
    });
    if (message === undefined) return;
    const ok = await this.run(a.project, async () => (await a.project.stet.pingAgent(a.agent.id, message), true));
    if (ok) vscode.window.setStatusBarMessage(`$(megaphone) Asked ${a.agent.id} to check in`, 4000);
  }

  /** Undo a decision from the History: the change is pending again (an accept is taken out of your file). */
  async undo(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    if (item.status === "accepted") await this.saveFiles(p, [item.file, ...(item.oldFile ? [item.oldFile] : [])]);
    const r = await this.run(p, () => p.stet.undo(item.id));
    if (r) {
      const what = item.status === "accepted" ? "accept" : "rejection";
      vscode.window.setStatusBarMessage(
        `$(discard) Undid the ${what} of ${r.reopened.map((i) => i.id).join(", ")}` + (r.restored.length ? `; ${r.restored.map((i) => i.id).join(", ")} pending again too` : ""),
        5000,
      );
    }
  }

  /** Set one of Stet's settings from the panel's View options (where it is set already, or for the user). */
  async setOption(key: string, value: unknown): Promise<void> {
    const conf = vscode.workspace.getConfiguration("stet");
    const i = conf.inspect(key);
    const target =
      i?.workspaceValue !== undefined || (key === "shareEdits" && vscode.workspace.workspaceFolders?.length)
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await conf.update(key, value, target);
  }

  async archiveAgent(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    const pending = a.project.snapshot.items.filter((i) => i.agent === a.agent.id && isLive(i)).length;
    const del = "Archive and delete folder";
    const keep = "Archive, keep folder";
    const ok = await vscode.window.showWarningMessage(
      `Archive agent ${a.agent.id}?`,
      {
        modal: true,
        detail:
          (pending ? `Its ${pending} pending change${pending === 1 ? " is" : "s are"} withdrawn. ` : "") +
          `Deleting the folder also deletes the branch ${a.agent.branch} and anything the agent did not submit. Close the agent's session first.`,
      },
      del,
      keep,
    );
    if (!ok) return;
    const r = await this.run(a.project, () => a.project.stet.archiveAgent(a.agent.id, { removeWorktree: ok === del }));
    if (r) {
      void vscode.window.showInformationMessage(
        `Archived ${a.agent.id}.` +
          (r.withdrawn.length ? ` Withdrew ${r.withdrawn.length} pending change${r.withdrawn.length === 1 ? "" : "s"} (${r.withdrawn.join(", ")}).` : " It had no pending changes.") +
          (r.worktreeRemoved ? " Its folder and branch are deleted." : ` Its folder is kept: ${a.agent.worktree}.`) +
          " If its session is still open, the agent is told on its next action; you can close that session.",
      );
    }
  }

  async finishReview(): Promise<void> {
    const p = await this.pickProject();
    if (!p) return;
    const items = p.snapshot.uncommitted;
    if (!items.length) return void vscode.window.showInformationMessage("Nothing to commit: all accepted changes are committed.");
    const files = [...new Set(items.map((i) => i.file))];
    const ok = await vscode.window.showWarningMessage(
      `Commit ${items.length} accepted change${items.length === 1 ? "" : "s"}?`,
      {
        modal: true,
        detail: `Files: ${files.join(", ")}.\nThese files are committed as they are now, including your own edits in them.`,
      },
      "Commit",
    );
    if (ok !== "Commit") return;
    const { subject } = await p.stet.commitMessage(items);
    const edited = await vscode.window.showInputBox({
      title: "Commit message",
      value: subject,
      prompt: "Summary line. Stet adds the list of accepted changes below it.",
      validateInput: (v) => (v.trim() ? undefined : "Enter a summary line."),
    });
    if (edited === undefined) return;
    await this.run(p, async () => {
      await this.saveFiles(p, files);
      const r = await p.stet.commitAcceptedItems({ subject: edited });
      vscode.window.setStatusBarMessage(r.commit ? `$(git-commit) Committed ${r.items.map((i) => i.id).join(", ")}` : "Nothing to commit", 5000);
    });
  }

  /** *Share my edits*: save the project's open files and let agents see them at their next sync. */
  async shareEdits(): Promise<void> {
    const p = await this.pickProject();
    if (!p) return;
    await this.run(p, async () => {
      for (const d of vscode.workspace.textDocuments) if (d.isDirty && p.relPath(d.uri)) await d.save();
      const changed = await p.stet.shareEdits();
      vscode.window.setStatusBarMessage(
        changed ? "$(cloud-upload) Stet: shared your edits; agents pick them up at their next sync" : "$(check) Stet: agents already see your edits",
        5000,
      );
      await p.refresh();
      p.scheduleChecks(0);
    });
  }

  private colorCustomizations(): Record<string, unknown> {
    return { ...(vscode.workspace.getConfiguration("workbench").inspect<Record<string, unknown>>("colorCustomizations")?.globalValue ?? {}) };
  }

  async updateHighlightContext(): Promise<void> {
    const cc = this.colorCustomizations();
    await vscode.commands.executeCommand("setContext", "stet.highlighted", Object.entries(HIGHLIGHT).every(([k, v]) => cc[k] === v));
  }

  /** Panel button: green proposed text in word-wrapped editors, or back to the theme's colours. */
  async setHighlight(on: boolean): Promise<void> {
    const cc = this.colorCustomizations();
    if (on) {
      // Keep the user's own values for these keys, to restore them when switched off.
      const previous = Object.fromEntries(Object.keys(HIGHLIGHT).filter((k) => k in cc && cc[k] !== HIGHLIGHT[k]).map((k) => [k, cc[k]]));
      await this.ctx.globalState.update(HIGHLIGHT_PREVIOUS, previous);
      Object.assign(cc, HIGHLIGHT);
    } else {
      for (const k of Object.keys(HIGHLIGHT)) delete cc[k];
      Object.assign(cc, this.ctx.globalState.get<Record<string, unknown>>(HIGHLIGHT_PREVIOUS) ?? {});
      await this.ctx.globalState.update(HIGHLIGHT_PREVIOUS, undefined);
    }
    await vscode.workspace
      .getConfiguration("workbench")
      .update("colorCustomizations", Object.keys(cc).length ? cc : undefined, vscode.ConfigurationTarget.Global);
    await this.updateHighlightContext();
    if (on) {
      void vscode.window.showInformationMessage(
        "Stet: proposed text is now green in word-wrapped editors too (without word wrap it always is). " +
          "This colours parameter-name hints in your user settings; other extensions' parameter hints turn green as well. Click the button again to undo.",
      );
    }
  }

  async doctor(): Promise<void> {
    const folder = this.allProjects()[0]?.mainPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return;
    const checks = await doctor(folder);
    const icon = { ok: "✓", warn: "!", error: "✗", info: "·" };
    this.output.clear();
    this.output.appendLine(`Stet doctor — ${folder}\n`);
    for (const c of checks) this.output.appendLine(`${icon[c.status]} ${c.name}: ${c.message}${c.fix ? `\n    fix: ${c.fix}` : ""}`);
    this.output.show(true);
  }

  async refresh(): Promise<void> {
    await this.discover();
    await this.applyRuntime();
    await this.refreshWorkspaces();
    await Promise.all(this.allProjects().map((p) => p.refresh()));
  }

  /**
   * Rewrite the active agents' instructions, MCP config and guardrail files, e.g. after an update.
   * Agent sessions read them when they start; running sessions need a restart.
   */
  private async refreshWorkspaces(): Promise<void> {
    const done: string[] = [];
    const failed: string[] = [];
    for (const p of this.allProjects()) {
      const results = await p.stet.refreshWorkspaces().catch((e) => {
        failed.push(`${p.name}: ${e?.message ?? e}`);
        return [];
      });
      for (const r of results) {
        if (r.error) failed.push(`${r.agent}: ${r.error}`);
        else if (r.result) {
          done.push(r.agent);
          const skipped = r.result.skipped.map((s) => `${s.file} (${s.reason})`);
          this.output.appendLine(`Refreshed workspace of ${r.agent}: ${r.result.written.join(", ")}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`);
        }
      }
    }
    if (failed.length) {
      for (const f of failed) this.output.appendLine(`Could not refresh agent workspace ${f}`);
      void vscode.window.showWarningMessage(`Stet: could not refresh ${failed.length} agent workspace(s). See the Stet output for details.`);
    } else if (done.length) {
      vscode.window.setStatusBarMessage(`$(check) Stet: refreshed ${done.join(", ")}. Restart running agent sessions to load the new instructions.`, 6000);
    }
  }

  /** Re-check how agents run `stet` (after a Refresh or a change of `stet.runtime`). */
  async applyRuntime(): Promise<void> {
    for (const p of this.allProjects()) {
      await this.ensureRuntime(p).catch((e) => void vscode.window.showErrorMessage(`Stet: ${e?.message ?? e}`));
    }
  }

  dispose(): void {
    for (const p of this.projects.values()) p.dispose();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
    this.treeChanged.dispose();
  }
}

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
const NOTIFY_PICKS: { mode: NotifyMode; label: string; detail: string }[] = [
  { mode: "batched", label: "When I pause", detail: "Once you have stopped for half a minute, with all your decisions together. Not after every click." },
  { mode: "now", label: "Right away", detail: "At each decision, comment or note." },
  { mode: "off", label: "Off", detail: "Not woken: the agent hears about your decisions when it next checks. Switching back on delivers what arrived meanwhile." },
];

function itemIcon(it: Item): vscode.ThemeIcon {
  const c = (id: string) => new vscode.ThemeColor(id);
  switch (it.status) {
    case "pending":
      return new vscode.ThemeIcon(it.kind === "modify" ? "diff-modified" : it.kind === "add-file" ? "diff-added" : it.kind === "delete-file" ? "diff-removed" : "diff-renamed");
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

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const ext = new StetExtension(ctx);
  const editor = new EditorIntegration(ext, ext.locator);
  const threads = new Threads(ext, ext.locator, () => ext.allProjects());
  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  // Decisions and moves run one after another. Pressing `a` again before the panel has moved on
  // would otherwise act on the old selection, i.e. the change just accepted.
  let queue: Promise<unknown> = Promise.resolve();
  const inOrder =
    (fn: (...a: any[]) => Promise<unknown>) =>
    (...a: any[]) =>
      (queue = queue.then(
        () => fn(...a),
        () => fn(...a),
      ));
  ctx.subscriptions.push(ext, editor, threads, vscode.workspace.registerTextDocumentContentProvider("stet-diff", new DiffContent((u) => ext.diffSide(u))));
  reg("stet.setup", () => ext.setup());
  reg("stet.newAgent", () => ext.newAgent());
  reg("stet.openAgent", (a) => ext.openAgent(a));
  reg("stet.copyAgentPath", (a) => ext.copyAgentPath(a));
  reg("stet.archiveAgent", (a) => ext.archiveAgent(a));
  reg("stet.agentNotify", (a) => ext.agentNotify(a));
  reg("stet.agentNotifyOff", (a) => ext.agentNotify(a));
  reg("stet.agentPing", (a) => ext.agentPing(a));
  reg("stet.undo", inOrder((a) => ext.undo(a)));
  reg("stet.preview", (a) => ext.showPreview(a));
  reg("stet.previewSetup", () => ext.setupPreview());
  // View options: settings you may switch back and forth, from the panel.
  const toggle = (key: string) => () => ext.setOption(key, !vscode.workspace.getConfiguration("stet").get<boolean>(key, true));
  reg("stet.toggleInlineChanges", toggle("inlineChanges"));
  reg("stet.toggleCodeLens", toggle("codeLens"));
  reg("stet.toggleAutoAdvance", toggle("autoAdvance"));
  for (const v of ["expanded", "collapsed", "hover"]) reg(`stet.longChanges.${v}`, () => ext.setOption("longChanges", v));
  for (const v of ["manual", "saved", "committed"]) reg(`stet.shareEdits.${v}`, () => ext.setOption("shareEdits", v));
  reg("stet.refresh", () => ext.refresh());
  reg("stet.doctor", () => ext.doctor());
  reg("stet.finishReview", () => ext.finishReview());
  reg("stet.shareEdits", () => ext.shareEdits());
  reg("stet.highlightOn", () => ext.setHighlight(true));
  reg("stet.highlightOff", () => ext.setHighlight(false));
  reg("stet.accept", inOrder((a) => ext.accept(a)));
  reg("stet.reject", inOrder((a) => ext.reject(a)));
  reg("stet.edit", inOrder((a) => ext.edit(a)));
  reg("stet.comment", (a) => ext.comment(a));
  reg("stet.revise", inOrder((a) => ext.revise(a)));
  reg("stet.acceptGroup", inOrder((a) => ext.acceptAll(a)));
  reg("stet.rejectGroup", inOrder((a) => ext.rejectAll(a)));
  reg("stet.ungroup", (a) => ext.ungroup(a));
  reg("stet.showItem", (a, keepFocus) => ext.showItem(a, keepFocus === true));
  reg("stet.showDiff", (a) => ext.showDiff(a));
  reg("stet.next", inOrder(() => ext.step(1)));
  reg("stet.previous", inOrder(() => ext.step(-1)));
  reg("stet.replyThread", (r: vscode.CommentReply) => ext.replyThread(r, threads));
  reg("stet.noteForAgent", () => ext.noteForAgent());
  reg("stet.resolveNote", (a) => ext.resolveNote(a));
  reg("stet.showNote", (a) => ext.showNote(a));
  await ext.updateHighlightContext();
  await ext.discover();
}

export function deactivate(): void {}
