/** Stet for VS Code (spec §12.2): review panel, in-editor review, threads and setup without a command line. */

import { closeSync, openSync, readSync } from "node:fs";
import {
  type CliCommand,
  doctor,
  foldPath,
  hasPreview,
  type Item,
  isLiveItem,
  parseId,
  pathExists,
  profileByName,
  SHARE_MODES,
  type ShareMode,
  Stet,
} from "@stet/core";
import * as vscode from "vscode";
import type { ChangeAction } from "./actions.js";
import { announce } from "./announce.js";
import { AgentCommands } from "./commands/agents.js";
import { Navigation } from "./commands/navigation.js";
import { NoteCommands } from "./commands/notes.js";
import { ReviewCommands } from "./commands/review.js";
import { ViewOptions } from "./commands/view.js";
import { Threads } from "./comments.js";
import type { El } from "./common.js";
import { DiffContent, EditorIntegration, esc, type Host, inlineProblems, Locator } from "./editor.js";
import { EDIT_SCHEME, EditFiles } from "./edits.js";
import {
  behindAgents,
  CANCELLED,
  changeAt,
  changesAt,
  chooseTarget,
  isRef,
  itemLabel,
  noLinks,
  oneLine,
  type PanelFilter,
  projectOfQuery,
  statusView,
  type TreeMode,
  TreeModel,
} from "./model.js";
import { inPreviewCache, PreviewPanel, previewPlace } from "./preview.js";
import { PreviewCommands } from "./previews.js";
import { Project } from "./project.js";
import { REVIEW_SCHEME, ReviewFiles, type ReviewHost } from "./review.js";
import { cliCommand, installCli, isManaged } from "./runtime.js";
import { LONG_MODES, NEW_TEXT_STYLES, PREVIEW_PLACES, setting, type Toggle } from "./settings.js";
import { SetupWizard } from "./setup.js";
import { ReviewTree } from "./tree.js";
import { UndoStack } from "./undo.js";
import { UnreadReplies } from "./unread.js";

const HOVER_WIDTH = 520;
const pngSizes = new Map<string, { width: number; height: number }>();
/** The hover size of a preview image: its width fixed, its height from the PNG's header. */
function hoverSize(file: string): string {
  if (!pngSizes.has(file)) {
    let size: { width: number; height: number } | null = null;
    try {
      const fd = openSync(file, "r");
      try {
        const b = Buffer.alloc(24);
        // PNG: an 8-byte signature, then the IHDR chunk, whose data start with width and height.
        if (readSync(fd, b, 0, 24, 0) === 24 && b.toString("latin1", 12, 16) === "IHDR") size = { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
      } finally {
        closeSync(fd);
      }
    } catch {
      // Not there (yet): the width alone, as before.
    }
    if (pngSizes.size > 500) pngSizes.clear();
    if (size) pngSizes.set(file, size); // not there yet: looked at again next time
  }

  const s = pngSizes.get(file);
  return s && s.width > 0 ? `width=${HOVER_WIDTH},height=${Math.round((HOVER_WIDTH * s.height) / s.width)}` : `width=${HOVER_WIDTH}`;
}

/**
 * The extension's hub: its projects, views and the helpers every part uses (which change a
 * command acts on, running an operation and refreshing). The parts (the panel, undo, previews,
 * setup and the commands) are its fields.
 */
export class StetExtension implements Host, vscode.Disposable {
  readonly panel = new ReviewTree(this);
  readonly replies = new UnreadReplies(this);
  readonly undos = new UndoStack(this);
  readonly previews = new PreviewCommands(this);
  readonly setupWizard = new SetupWizard(this);
  readonly reviewing = new ReviewCommands(this);
  readonly notes = new NoteCommands(this);
  readonly navigation = new Navigation(this);
  readonly agents = new AgentCommands(this);
  readonly view = new ViewOptions(this);

  projects = new Map<string, Project>();
  models = new Map<string, TreeModel>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly tree: vscode.TreeView<El>;

  /** Decided changes, by round (the Review panel shows only open ones). */
  private readonly history: vscode.TreeView<El>;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  readonly output = vscode.window.createOutputChannel("Stet");
  readonly locator: Locator;

  /** PDF previews: built in the background, shown when ready. */
  readonly preview: PreviewPanel;

  /** Review documents: a file with all its pending changes, editable (see review.ts). */
  readonly review: ReviewFiles;

  /** Editors for one change's wording (see edits.ts). */
  readonly edits: EditFiles;

  /** The read-only documents of the plain diffs (`stet-diff:`), told when what they show changes. */
  readonly diffContent = new DiffContent((u) => this.navigation.diffSide(u));
  private previewFollow: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(readonly ctx: vscode.ExtensionContext) {
    this.replies.seen = { ...(ctx.workspaceState.get<Record<string, number>>(UnreadReplies.SEEN) ?? {}) };
    this.locator = new Locator(this);
    const host: ReviewHost = {
      project: (key) => this.projects.get(key),
      model: (p) => this.model(p),
      previews: () => previewPlace() !== "off",
      hover: (p, item, route) => this.hoverFor?.(p, item, route),
    };
    this.review = new ReviewFiles(host);
    this.edits = new EditFiles(host);
    this.preview = new PreviewPanel(
      (p) => this.previews.setupPreview(p),
      (t, n) => {
        const live = this.panel.itemsInOrder().filter((e) => e.project === t.project && e.node?.type === "item" && isLiveItem(e.node.item));
        const i = live.findIndex((e) => e.node?.type === "item" && e.node.item.id === t.item.id);
        return live.slice(i + 1, i + 1 + n).map((e) => ({ project: e.project, item: (e.node as { item: Item }).item }));
      },
      (p) => this.previews.installExtras(p),
      (p, files) => void this.previews.offerExtras(p, files),
    );
    // Several changes can be selected (Ctrl/Shift+click) and accepted or rejected together.
    this.tree = vscode.window.createTreeView("stet.review", { treeDataProvider: this.panel, showCollapseAll: true, canSelectMany: true });
    this.history = vscode.window.createTreeView("stet.history", {
      showCollapseAll: true,
      treeDataProvider: {
        onDidChangeTreeData: this.panel.historyChanged.event,
        getChildren: (el?: El) => this.panel.childrenOf(el, "history"),
        getTreeItem: (el: El) => this.panel.treeItemOf(el, "history"),
        getParent: (el: El) => this.panel.getParent(el),
      },
    });
    this.status.command = "stet.review.focus";
    this.disposables.push(
      this.tree,
      this.history,
      this.panel.historyChanged,
      this.status,
      this.undos.undoButton,
      this.output,
      this.tree.onDidChangeSelection((e) => {
        const el = e.selection[0];
        if (e.selection.length === 1 && el?.node?.type === "item" && isLiveItem(el.node.item)) void this.navigation.showItem(el, true);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("stet.runtime")) void this.applyRuntime();
        if (e.affectsConfiguration("workbench.colorCustomizations")) void this.view.updateHighlightContext();
        // Only the projects whose setting changed: in a multi-root workspace each folder has its own.
        for (const p of this.projects.values()) if (e.affectsConfiguration("stet.shareEdits", vscode.Uri.file(p.mainPath))) void this.applyShareMode(p, true);
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) for (const p of this.projects.values()) p.scheduleRefresh(0);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.locator.forget(d)),
      this.preview,
      this.review,
      this.edits,
      vscode.workspace.registerTextDocumentContentProvider("stet-diff", this.diffContent),
      // The diff's left side (your text, read-only) follows your edits.
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== "file" || !e.contentChanges.length) return;
        for (const d of vscode.workspace.textDocuments) {
          if (
            d.uri.scheme === "stet-diff" &&
            new URLSearchParams(d.uri.query).get("side") === "current" &&
            this.navigation.currentOf(d.uri)?.toString() === e.document.uri.toString()
          )
            this.diffContent.fire(d.uri);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) void this.checkInline(ed.document);
        if (ed) void this.view.offerContrastStyle(ed.document.uri);
        void this.reviewing.updateFileContext();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (uri) void this.view.offerContrastStyle(uri);
      }),
      // Which the user chose last, a change in the panel or a place in a file: commands from the
      // palette act on that one.
      this.tree.onDidChangeSelection((e) => {
        this.lastPick = "panel";
        if (e.selection[0]) this.panel.lastSelected = e.selection[0];
      }),
      // The preview follows the change under the cursor while it is open.
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.scheme !== "output") this.lastPick = "editor";
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
    this.agentOf = null;
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      try {
        const loc = await Stet.locate(f.uri.fsPath);
        // Agent workspaces are for the agent; review happens in the project window. The panel
        // says so, rather than "not set up".
        if (loc.agentWorkspace) {
          this.agentOf ??= loc.mainPath;
          continue;
        }
        const stet = await Stet.open(f.uri.fsPath, loc);
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
      void this.previews.checkPreviews(p);
    }
    await this.onProjectChanged();
  }

  /** Settings that cut or hide inline proposals in a project file: say so once, with a fix for that language. */
  private async checkInline(doc: vscode.TextDocument): Promise<void> {
    if (!this.projectFor(doc.uri) || !setting("inlineChanges")) return;
    for (const p of inlineProblems(doc)) {
      const memo = `stet.inlineNotice:${p.key}:${doc.languageId}`;
      if (this.ctx.globalState.get<boolean>(memo)) continue;
      await this.ctx.globalState.update(memo, true);
      // A document file VS Code knows no language for (a .typ file without a Typst extension) is
      // "plaintext": a fix there would change every plain-text file.
      const lang = profileByName(doc.uri.fsPath);
      if (doc.languageId === "plaintext" && lang.document) {
        void vscode.window.showInformationMessage(
          `Stet: ${p.message} VS Code opens ${lang.name} files as plain text here; with a ${lang.name} extension installed, Stet's own default for ${lang.name} files fixes this.`,
        );
        continue;
      }
      const fix = `Fix for ${doc.languageId} files`;
      const pick = await vscode.window.showInformationMessage(`Stet: ${p.message}`, fix, "Leave it");
      if (pick === fix) {
        // In the user's settings, for this language only.
        await vscode.workspace.getConfiguration("editor", { languageId: doc.languageId }).update(p.setting, p.value, vscode.ConfigurationTarget.Global, true);
      }
    }
  }

  /** A change's hover as in the file (set once the editor integration exists). */
  hoverFor?: (p: Project, item: Item, route: (a: ChangeAction) => ChangeAction) => vscode.MarkdownString;

  /** The PDF preview for a change's hover: the image once built, else a note while it builds. */
  previewHover(p: Project, item: Item): string | undefined {
    const place = previewPlace();
    if ((place !== "hover" && place !== "both") || item.kind !== "modify" || !hasPreview(item.file)) return undefined;
    const t = { project: p, item };
    const r = this.preview.peek(t);
    if (!r) {
      this.preview.prefetch(t);
      return "*PDF preview: building… hover again in a moment.*";
    }
    if (r.status === "ready") {
      if (!inPreviewCache(p, r.after.file)) return undefined;
      return [
        `**PDF**, page ${r.after.page}${r.note ? ` · *${esc(r.note)}*` : ""}`,
        ...(r.warning ? [`⚠ ${esc(r.warning.message)}`] : []),
        // A fixed size: the image is rendered sharp enough to zoom in the panel, far wider than a
        // hover; and with its height known up front, the hover doesn't change size when it loads.
        `![PDF preview of ${esc(item.id)}](${vscode.Uri.file(r.after.file).toString()}|${hoverSize(r.after.file)})`,
      ].join("\n\n");
    }
    if (r.status === "failed")
      return `⚠ *${esc(r.message)}* The ${esc(r.typesetter ?? "build")} error is in *Preview in PDF*${r.missing?.extras ? ", with the offer to install the extra fonts" : ""}.`;
    return undefined; // no spot on the page, or previews unavailable (said once, elsewhere)
  }

  /** Point agents' tools at the CLI bundled with this extension, unless another `stet` is configured and present. */
  private async ensureRuntime(p: Project): Promise<void> {
    const bundled = await this.bundledCli((await p.stet.config()).cli, p.storeRoot);
    if (!bundled) return;
    const { cli, script } = bundled;
    if (await p.stet.setCli(cli)) {
      const runner = cli.env?.ELECTRON_RUN_AS_NODE ? "VS Code's runtime" : "Node.js";
      this.output.appendLine(`Agent workspaces of ${p.name} now run ${script} with ${runner} (${cli.command}).`);
      announce(`$(check) Stet: agents of ${p.name} now use ${runner}`, 5000);
    }
  }

  /**
   * This extension's CLI, installed in the store, for agents' tools to run; null to keep the one
   * configured: another `stet` the user set up, which is present.
   */
  async bundledCli(current: CliCommand | undefined, storeRoot: string): Promise<{ cli: CliCommand; script: string } | null> {
    const present = !!current && (await pathExists(current.command)) && (await Promise.all(current.args.slice(0, 1).map(pathExists))).every(Boolean);
    if (current && present && !isManaged(current, storeRoot)) return null;
    const script = await installCli(this.ctx.asAbsolutePath("dist/stet.mjs"), storeRoot);
    return { cli: await cliCommand(setting("runtime"), script), script };
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
      if (await p.stet.setShareEdits(setting("shareEdits", vscode.Uri.file(p.mainPath)))) p.scheduleRefresh(0);
    });
  }

  async onProjectChanged(): Promise<void> {
    this.replies.baselineSeen();
    this.models.clear();
    this.panel.lines.clear();
    this.panel.lineBatches.clear();
    const all = [...this.projects.values()];
    const snaps = all.map((p) => p.snapshot);
    // Yours to review: changes waiting for the agent's revision don't count.
    const pending = snaps.reduce((n, s) => n + s.items.filter((i) => i.status === "pending").length, 0);
    const uncommitted = snaps.reduce((n, s) => n + s.uncommitted.length, 0);
    const sync = snaps.flatMap(behindAgents);
    const unshared = all.filter((p) => p.snapshot.unshared).map((p) => p.name);
    const missing = all.flatMap((p) => p.snapshot.missing.map((m) => ({ ...m, project: p.name })));
    // Shown only when something is wrong: accepted changes agents would never see.
    this.panel.missingMessage = missing.length
      ? `⚠ Agents don't get accepted ${missing.map((m) => m.id).join(", ")} (${missing[0]!.reason}${missing.length > 1 ? ", …" : ""}). ` +
        "Finish the review, or share your edits, to pass them on."
      : undefined;
    this.panel.showPanelMessage();
    // Redraw first: selecting the next change waits for the tree, not for the context keys.
    this.panel.treeChanged.fire(undefined);
    void this.review.refresh();
    void this.edits.refresh();
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "stet-diff") this.diffContent.fire(d.uri);
    void this.reviewing.updateFileContext();
    this.panel.historyChanged.fire(undefined);
    this.changed.fire();
    this.tree.badge = pending ? { value: pending, tooltip: `${pending} proposed change${pending === 1 ? "" : "s"} to review` } : undefined;
    if (all.length) {
      const fresh = all.reduce((n, p) => n + this.replies.unreadOf(p, () => true), 0);
      const view = statusView({
        pending,
        unread: fresh,
        uncommitted,
        behind: sync,
        unshared,
        missing,
        projects: all.map((p) => ({
          name: p.name,
          pending: p.snapshot.items.filter((i) => i.status === "pending").length,
          uncommitted: p.snapshot.uncommitted.length,
        })),
      });
      this.status.text = view.text;
      this.status.tooltip = view.tooltip;
      this.status.accessibilityInformation = { label: view.spoken, role: "button" };
      this.status.show();
    } else this.status.hide();
    const context: [string, boolean][] = [
      ["stet.active", all.length > 0],
      ["stet.previews", [...this.projects.values()].some((p) => !this.previews.noPreviews.has(foldPath(p.mainPath)))],
      ["stet.agentWorkspace", !all.length && !!this.agentOf],
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
    if (!m) this.models.set(key, (m = new TreeModel(p.snapshot, mode, mode === "review" ? this.panel.filter : null)));
    return m;
  }

  allProjects(): Project[] {
    return [...this.projects.values()];
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

  async target(arg: unknown): Promise<El | undefined> {
    if (isRef(arg)) {
      // Resolve strictly within the given project.
      const p = this.projects.get(foldPath(arg.path));
      if (!p) return undefined;
      const model = this.model(p);
      const ref = parseId(arg.id);
      if (ref.kind === "part") {
        const owner = model.group(ref.group);
        return owner?.parts?.[ref.index] ? { project: p, node: { type: "part", group: owner, index: ref.index } } : undefined;
      }
      if (ref.kind === "group") {
        const group = model.group(ref.id);
        return group && { project: p, node: { type: "group", group } };
      }
      const item = model.item(arg.id);
      return item && { project: p, node: { type: "item", item, parent: "" } };
    }
    // A key pressed in the panel or in History: that view's selection, whatever else was picked last.
    if (arg === "panel") return this.panel.panelSelection();
    if (arg === "history") return this.history.selection[0];
    if (typeof arg === "string") {
      const ref = parseId(arg);
      if (ref.kind === "group") {
        for (const p of this.allProjects()) {
          const group = this.model(p).group(ref.id);
          if (group) return { project: p, node: { type: "group", group } };
        }
        return undefined;
      }
      const f = this.findItem(arg);
      return f && { project: f.project, node: { type: "item", item: f.item, parent: "" } };
    }
    if (arg && typeof arg === "object" && "project" in arg) return arg as El;
    const sel = this.tree.visible ? this.panel.panelSelection() : undefined;
    const { target, cancelled } = await chooseTarget(sel, this.lastPick, () => this.atCursor());
    this.pickCancelled = cancelled;
    return target;
  }

  /** The last `target` call ended in a cancelled "which one?": nothing more to ask or say. */
  private pickCancelled = false;

  /** The change under the cursor of the active editor. */
  private async atCursor(): Promise<El | typeof CANCELLED | undefined> {
    const ed = vscode.window.activeTextEditor;
    const p = ed && this.projectFor(ed.document.uri);
    if (!ed || !p) return undefined;
    const located = await this.locator.locate(ed.document);
    const several = changesAt(located, ed.selection.active);
    if (several.length) {
      const pick = await vscode.window.showQuickPick(
        // The full id: the label's number is the change's within its round, so 2.1 showed as "1".
        several.map((l) => ({
          label: `${l.item.id}: ${itemLabel(l.item, this.model(p).get).replace(/^\S+\s+/, "")}`,
          description: l.item.agent,
          detail: `${l.item.id}: “${oneLine(l.item.oldText, 50)}” → “${oneLine(l.item.newText, 50)}”`,
          item: l.item,
        })),
        { title: "The cursor is in several proposed changes: which one?" },
      );
      return pick ? { project: p, node: { type: "item", item: pick.item, parent: "" } } : CANCELLED;
    }
    const hit = changeAt(located, ed.selection.active);
    return hit && { project: p, node: { type: "item", item: hit.item, parent: "" } };
  }

  /** The project folder, when this window's folder is an agent's workspace of it (and no project is open). */
  agentOf: string | null = null;

  /** Open the project an agent workspace belongs to, in a new window. */
  async openAgentProject(): Promise<void> {
    if (!this.agentOf) return void vscode.window.showInformationMessage("This window has no agent workspace of a Stet project.");
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(this.agentOf), { forceNewWindow: true });
  }

  /** Whether the user last picked a change in the panel or moved in a file (see `target`). */
  private lastPick: "panel" | "editor" = "panel";

  async targetItem(arg: unknown): Promise<{ project: Project; item: Item } | undefined> {
    this.pickCancelled = false;
    let t = await this.target(arg);
    if (this.pickCancelled) return undefined;
    // From the palette or a key binding, with a round or group selected in the panel: the change
    // under the cursor.
    if (t?.node?.type !== "item" && arg === undefined) {
      const here = await this.atCursor();
      if (here === CANCELLED) return undefined;
      t = here ?? t;
    }
    if (t?.node?.type === "item") return { project: t.project, item: t.node.item };
    void vscode.window.showInformationMessage("Select a proposed change in the Stet panel, or put the cursor on one.");
    return undefined;
  }

  /** The unsaved text of open, modified documents for `files`, by file. */
  unsavedTexts(p: Project, files: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const d of vscode.workspace.textDocuments) {
      const rel = p.relPath(d.uri);
      if (rel && files.includes(rel) && d.isDirty) out[rel] = d.getText();
    }
    return out;
  }

  /**
   * Save unsaved wording for `ids` (their change tabs) and `files` (their Review-file tabs): it
   * becomes the changes' wording, as a save would. False if a save failed (it said why).
   */
  async saveWording(p: Project, ids: string[], files: string[]): Promise<boolean> {
    const of = (uri: vscode.Uri) => this.projects.get(foldPath(projectOfQuery(uri.query)));
    for (const d of vscode.workspace.textDocuments) {
      if (!d.isDirty || of(d.uri) !== p) continue;
      const mine =
        (d.uri.scheme === REVIEW_SCHEME && files.includes(d.uri.path.replace(/^\//, ""))) ||
        (d.uri.scheme === EDIT_SCHEME && ids.some((id) => id.toUpperCase() === (d.uri.path.split("/")[1] ?? "").toUpperCase()));
      if (mine && !(await d.save())) return false;
    }
    return true;
  }

  /** Save open, modified documents for `files` before Stet writes to disk. */
  async saveFiles(p: Project, files: string[]): Promise<void> {
    for (const d of vscode.workspace.textDocuments) {
      const rel = p.relPath(d.uri);
      if (rel && files.includes(rel) && d.isDirty) await d.save();
    }
  }

  async run<T>(p: Project | undefined, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e: any) {
      void vscode.window.showErrorMessage(noLinks(e?.message ?? String(e)));
      return undefined;
    } finally {
      await p?.refresh().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // The project's checks and settings

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
      announce(`$(check) Stet: refreshed ${done.join(", ")}. Restart running agent sessions to load the new instructions.`, 6000);
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
    this.panel.treeChanged.dispose();
  }
}

/** Returned by `activate`, for the integration test (VS Code's commands don't resolve inlay hints). */
export interface TestApi {
  editor: EditorIntegration;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<TestApi> {
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
  ctx.subscriptions.push(ext, editor, threads);
  reg("stet.setup", () => ext.setupWizard.setup());
  reg("stet.newAgent", () => ext.agents.newAgent());
  reg("stet.openAgent", (a) => ext.agents.openAgent(a));
  reg("stet.copyAgentPath", (a) => ext.agents.copyAgentPath(a));
  reg("stet.archiveAgent", (a) => ext.agents.archiveAgent(a));
  reg("stet.agentNotify", (a) => ext.agents.agentNotify(a));
  reg("stet.agentNotifyOff", (a) => ext.agents.agentNotify(a));
  reg("stet.agentPing", (a) => ext.agents.agentPing(a));
  reg(
    "stet.undo",
    inOrder((a) => ext.undos.undo(a)),
  );
  reg("stet.preview", (a) => ext.previews.showPreview(a));
  reg("stet.openAgentProject", () => ext.openAgentProject());
  reg(
    "stet.undoLast",
    inOrder(() => ext.undos.undoLast()),
  );
  reg("stet.filter", (f?: PanelFilter | null) => (f !== undefined ? ext.panel.setFilter(f) : ext.panel.pickFilter()));
  reg("stet.clearFilter", () => ext.panel.setFilter(null));
  reg("stet.reviewFile", (a) => ext.reviewing.reviewFile(a));
  reg(
    "stet.reviewAccept",
    inOrder((u, a) => ext.reviewing.reviewAccept(u, a)),
  );
  // Not in order itself: the command it runs is (it would wait for itself).
  reg("stet.reviewRun", (u, c, a) => ext.reviewing.reviewRun(u, c, a));
  reg("stet.editSave", (u) => ext.reviewing.editSave(u));
  reg("stet.editReset", (u) => ext.reviewing.editReset(u));
  reg("stet.editAccept", (u) => ext.reviewing.editAccept(u));
  ext.hoverFor = (p, item, route) => editor.hoverMarkdown(p, item, route);
  reg("stet.clearDraft", (a) => ext.reviewing.clearDraft(a));
  reg("stet.previewSetup", () => ext.previews.setupPreview());
  // View options: settings you may switch back and forth, from the panel.
  const toggle = (key: Toggle) => () => ext.view.setOption(key, !setting(key));
  reg("stet.toggleDiffProposals", toggle("diffShowsProposals"));
  reg("stet.toggleInlineChanges", toggle("inlineChanges"));
  reg("stet.toggleCodeLens", toggle("codeLens"));
  reg("stet.toggleAutoAdvance", toggle("autoAdvance"));
  for (const v of LONG_MODES) reg(`stet.longChanges.${v}`, () => ext.view.setOption("longChanges", v));
  for (const v of SHARE_MODES) reg(`stet.shareEdits.${v}`, () => ext.view.setOption("shareEdits", v));
  for (const v of PREVIEW_PLACES) reg(`stet.pdfPreviews.${v}`, () => ext.view.setOption("pdfPreviews", v));
  for (const v of NEW_TEXT_STYLES) reg(`stet.newTextStyle.${v}`, () => ext.view.setOption("newTextStyle", v));
  reg("stet.refresh", () => ext.refresh());
  reg("stet.doctor", () => ext.doctor());
  reg("stet.finishReview", () => ext.reviewing.finishReview());
  reg("stet.shareEdits", () => ext.reviewing.shareEdits());
  reg("stet.toggleHighlight", () => ext.view.setHighlight(!ext.view.highlighted()));
  reg("stet.highlightOn", () => ext.view.setHighlight(true));
  reg("stet.highlightOff", () => ext.view.setHighlight(false));
  reg(
    "stet.accept",
    inOrder((a, all) => ext.reviewing.accept(a, all)),
  );
  reg(
    "stet.acceptOnly",
    inOrder((a) => ext.reviewing.acceptOnly(a)),
  );
  reg("stet.changeActions", (a) => ext.reviewing.changeActions(a));
  reg(
    "stet.reject",
    inOrder((a, all) => ext.reviewing.reject(a, all)),
  );
  reg(
    "stet.edit",
    inOrder((a, all) => ext.reviewing.edit(a, all)),
  );
  reg("stet.comment", (a, all) => ext.reviewing.comment(a, all));
  reg(
    "stet.revise",
    inOrder((a, all) => ext.reviewing.revise(a, all)),
  );
  reg(
    "stet.acceptGroup",
    inOrder((a) => ext.reviewing.acceptAll(a)),
  );
  reg(
    "stet.rejectGroup",
    inOrder((a) => ext.reviewing.rejectAll(a)),
  );
  reg("stet.ungroup", (a) => ext.reviewing.ungroup(a));
  reg("stet.showItem", (a, keepFocus) => ext.navigation.showItem(a, keepFocus === true));
  reg("stet.showDiff", (a, all) => ext.navigation.showDiff(a, all));
  reg(
    "stet.next",
    inOrder(() => ext.panel.step(1)),
  );
  reg(
    "stet.previous",
    inOrder(() => ext.panel.step(-1)),
  );
  reg("stet.replyThread", (r: vscode.CommentReply) => ext.notes.replyThread(r, threads));
  reg("stet.noteForAgent", () => ext.notes.noteForAgent());
  reg("stet.resolveNote", (a) => ext.notes.resolveNote(a));
  reg("stet.reopenNote", (a) => ext.notes.reopenNote(a));
  reg("stet.showNote", (a) => ext.notes.showNote(a));
  await ext.view.updateHighlightContext();
  await ext.discover();
  return { editor };
}

export function deactivate(): void {}
