/** Stet for VS Code (spec §12.2): review panel, in-editor review, threads and setup without a command line. */

import { closeSync, openSync, readSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Agent,
  type AgentKind,
  buildIgnores,
  type CliCommand,
  DOCUMENT_LANGUAGES,
  doctor,
  documentProfile,
  foldPath,
  type Group,
  gitIdentity,
  hasPreview,
  type Item,
  isLiveItem,
  isNoteId,
  itemEffect,
  matchesAny,
  NOTIFY_TRIGGER_TEXT,
  NOTIFY_TRIGGERS,
  type Note,
  type NotifyMode,
  type NotifyTrigger,
  notifyMode,
  notifyTriggers,
  parseId,
  parsePartId,
  partId,
  pathExists,
  pendingInRound,
  profileByName,
  Repo,
  roundOf,
  type ShareMode,
  Stet,
} from "@stet/core";
import * as vscode from "vscode";
import { acceptAction, acceptQuestion, type ChangeAction, changeActions, withIcon } from "./actions.js";
import { announce } from "./announce.js";
import { inProject, Threads } from "./comments.js";
import { DiffContent, EditorIntegration, esc, type Host, inlineProblems, itemMarkdown, Locator, usesHints } from "./editor.js";
import { EDIT_SCHEME, EditFiles } from "./edits.js";
import {
  AGENT_ID,
  actionsTitle,
  archiveChoices,
  behindAgents,
  bulkQuestion,
  CANCELLED,
  changeAt,
  changesAt,
  chooseTarget,
  dissolveQuestion,
  documentOrder,
  editedPart,
  editFrame,
  FINISH_SAVE,
  failedAcceptActions,
  fence,
  filterIsEmpty,
  filterText,
  finishQuestion,
  fitLabel,
  fromPanel,
  groupDescription,
  groupLabel,
  isRef,
  itemLabel,
  itemRow,
  LineIndex,
  LOST_NEXT,
  LOST_TEXT,
  manyQuestion,
  type Node,
  nextItemIndex,
  noLinks,
  offerContrastStyle,
  oneLine,
  type PanelFilter,
  partLabel,
  projectOfQuery,
  projectQuery,
  type Ref,
  roundLabel,
  spokenRow,
  statusView,
  suggestAgentId,
  type TreeMode,
  TreeModel,
  toLf,
  unreadReplies,
} from "./model.js";
import { inPreviewCache, PreviewPanel, previewNotice, previewPlace } from "./preview.js";
import { Project } from "./project.js";
import { REVIEW_SCHEME, ReviewFiles, type ReviewHost } from "./review.js";
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

const HOVER_WIDTH = 520;
/** Longest change (one line) edited in an input box; that box shows about this many characters. */
const SHORT_EDIT = 80;
/** How many decisions *Undo* can go back. */
const UNDO_DEPTH = 50;
type Decision = "accept" | "rejection" | "revision request";
/** How long *Undo* stays in the status bar after a decision. */
const UNDO_SHOWN_MS = 15_000;
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

class StetExtension implements Host, vscode.TreeDataProvider<El>, vscode.Disposable {
  private projects = new Map<string, Project>();
  private models = new Map<string, TreeModel>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly treeChanged = new vscode.EventEmitter<El | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private lines = new Map<string, { line: number; found: boolean }>();
  private readonly tree: vscode.TreeView<El>;
  /** Decided changes, by round (the Review panel shows only open ones). */
  private readonly history: vscode.TreeView<El>;
  private readonly historyChanged = new vscode.EventEmitter<El | undefined>();
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  /** *Undo* for a few seconds after each decision (test report 2026-11-20). */
  private readonly undoButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  /** Decisions made in this window, latest last, for *Undo* (`u`): one per press, back to the oldest. */
  private decisions: { project: Project; ids: string[]; what: Decision }[] = [];
  private undoTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly output = vscode.window.createOutputChannel("Stet");
  readonly locator: Locator;
  /** PDF previews: built in the background, shown when ready. */
  readonly preview: PreviewPanel;
  /** Review documents: a file with all its pending changes, editable (see review.ts). */
  readonly review: ReviewFiles;
  /** Editors for one change's wording (see edits.ts). */
  readonly edits: EditFiles;
  /** The read-only documents of the plain diffs (`stet-diff:`), told when what they show changes. */
  readonly diffContent = new DiffContent((u) => this.diffSide(u));
  private previewFollow: NodeJS.Timeout | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private ctx: vscode.ExtensionContext) {
    this.seen = { ...(ctx.workspaceState.get<Record<string, number>>(StetExtension.SEEN) ?? {}) };
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
      (p) => this.setupPreview(p),
      (t, n) => {
        const live = this.itemsInOrder().filter((e) => e.project === t.project && e.node?.type === "item" && isLiveItem(e.node.item));
        const i = live.findIndex((e) => e.node?.type === "item" && e.node.item.id === t.item.id);
        return live.slice(i + 1, i + 1 + n).map((e) => ({ project: e.project, item: (e.node as { item: Item }).item }));
      },
      (p) => this.installExtras(p),
      (p, files) => void this.offerExtras(p, files),
    );
    // Several changes can be selected (Ctrl/Shift+click) and accepted or rejected together.
    this.tree = vscode.window.createTreeView("stet.review", { treeDataProvider: this, showCollapseAll: true, canSelectMany: true });
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
      this.undoButton,
      this.output,
      this.tree.onDidChangeSelection((e) => {
        const el = e.selection[0];
        if (e.selection.length === 1 && el?.node?.type === "item" && isLiveItem(el.node.item)) void this.showItem(el, true);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("stet.runtime")) void this.applyRuntime();
        if (e.affectsConfiguration("workbench.colorCustomizations")) void this.updateHighlightContext();
        // Only the projects whose setting changed: in a multi-root workspace each folder has its own (test report v0.16.0, B8).
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
            this.currentOf(d.uri)?.toString() === e.document.uri.toString()
          )
            this.diffContent.fire(d.uri);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) void this.checkInline(ed.document);
        if (ed) void this.offerContrastStyle(ed.document.uri);
        void this.updateFileContext();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        const uri = vscode.window.activeTextEditor?.document.uri;
        if (uri) void this.offerContrastStyle(uri);
      }),
      // Which the user chose last, a change in the panel or a place in a file: commands from the
      // palette act on that one (test report 2026-11-20, B8).
      this.tree.onDidChangeSelection((e) => {
        this.lastPick = "panel";
        if (e.selection[0]) this.lastSelected = e.selection[0];
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
        // says so, rather than "not set up" (test report 2026-11-20, B9).
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
      void this.checkPreviews(p);
    }
    await this.onProjectChanged();
  }

  /** Settings that cut or hide inline proposals in a project file: say so once, with a fix for that language. */
  private async checkInline(doc: vscode.TextDocument): Promise<void> {
    if (!this.projectFor(doc.uri) || !vscode.workspace.getConfiguration("stet").get<boolean>("inlineChanges", true)) return;
    for (const p of inlineProblems(doc)) {
      const memo = `stet.inlineNotice:${p.key}:${doc.languageId}`;
      if (this.ctx.globalState.get<boolean>(memo)) continue;
      await this.ctx.globalState.update(memo, true);
      // A document file VS Code knows no language for (a .typ file without a Typst extension) is
      // "plaintext": a fix there would change every plain-text file (test report 5e4c6af, UX).
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

  /** Say once what PDF previews need here (nothing when they work). Never sets anything up unasked. */
  private async checkPreviews(p: Project): Promise<void> {
    try {
      // A language without previews (Typst): nothing to tell at startup, and no preview entries
      // (test report 5e4c6af, B3, B8 and accessibility).
      const doc = documentProfile(await p.stet.config());
      if (!doc.typesetter) {
        if (!this.noPreviews.has(foldPath(p.mainPath)))
          this.output.appendLine(`PDF previews in ${p.name}: Stet has no PDF previews for ${doc.name} projects yet.`);
        this.noPreviews.add(foldPath(p.mainPath));
        void this.onProjectChanged();
        return;
      }
      this.noPreviews.delete(foldPath(p.mainPath));
    } catch {
      /* the checks below say what is wrong */
    }
    if (previewPlace() === "off") return;
    try {
      const env = await p.stet.previewStatus();
      this.output.appendLine(`PDF previews in ${p.name}: ${env.status}. ${env.message}`);
      if (await previewNotice(env, this.ctx.globalState, p.name, foldPath(p.mainPath))) await this.setupPreview(p);
    } catch (e: any) {
      this.output.appendLine(`PDF previews in ${p.name}: ${e?.message ?? e}`);
    }
  }

  /** Projects in a language Stet has no PDF previews for (Typst), by key. */
  private noPreviews = new Set<string>();

  /** Build the preview image: downloads packages, so only on the user's click. */
  async setupPreview(p?: Project): Promise<void> {
    p ??= await this.pickProject();
    if (!p) return;
    const project = p;
    // Said at once, without a progress note about downloads (test report 5e4c6af, B3).
    const doc = documentProfile(await project.stet.config());
    if (!doc.typesetter)
      return void vscode.window.showInformationMessage(
        `Stet has no PDF previews for ${doc.name} projects yet, so there is nothing to set up in ${project.name}.`,
      );
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          (await project.stet.previewStatus(true)).toolSource === "image"
            ? "Stet: building the PDF preview image with its own TeX Live (about 1 GB, this takes a while)…"
            : "Stet: building the PDF preview image (downloads Debian, Perl and Poppler)…",
      },
      () => project.stet.setupPreview().catch((e: any) => ({ ok: false, log: String(e?.message ?? e), status: undefined })),
    );
    if (r.ok) void vscode.window.showInformationMessage(`Stet: ${r.status?.message ?? "PDF previews are set up."}`);
    else {
      this.output.appendLine(r.log);
      void vscode.window
        .showErrorMessage("Stet: building the PDF preview image failed. Details are in the Stet output.", "Show output")
        .then((c) => c && this.output.show());
    }
    this.preview.refresh();
  }

  /** Whether the active file has pending changes (the editor title's Review button). */
  private async updateFileContext(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const p = uri && this.projectFor(uri);
    const rel = p?.relPath(uri!);
    const has = !!rel && p!.snapshot.items.some((i) => i.file === rel && i.kind === "modify" && isLiveItem(i));
    await vscode.commands.executeCommand("setContext", "stet.fileHasChanges", has);
  }

  /** Open the review of a file: the file now ↔ the file with all its pending changes, editable. */
  async reviewFile(arg: unknown): Promise<void> {
    let p: Project | undefined;
    let file: string | null | undefined;
    if (arg instanceof vscode.Uri) {
      p = this.projectFor(arg);
      file = p?.relPath(arg);
    } else if (arg !== undefined) {
      const t = await this.targetItem(arg);
      if (t) [p, file] = [t.project, t.item.file];
    } else {
      const uri = vscode.window.activeTextEditor?.document.uri;
      p = uri && this.projectFor(uri);
      file = p && uri ? p.relPath(uri) : undefined;
    }
    if (!p || !file) return void vscode.window.showInformationMessage("Open a file of a Stet project, or select one of its changes in the Stet panel.");
    const live = p.snapshot.items.filter((i) => i.file === file && i.kind === "modify" && isLiveItem(i)).length;
    if (!live) return void vscode.window.showInformationMessage(`${file} has no pending changes.`);
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.diffLeft(p, file),
      ReviewFiles.uriFor(p, file),
      `${file}${inProject(p)}: yours ↔ ${live} proposed change${live === 1 ? "" : "s"} (editable)`,
      { preview: false, viewColumn: this.columnFor(ReviewFiles.uriFor(p, file)) },
    );
  }

  /** A change's hover as in the file (set once the editor integration exists). */
  hoverFor?: (p: Project, item: Item, route: (a: ChangeAction) => ChangeAction) => vscode.MarkdownString;

  /** An action from a review document: its unsaved edits first, so a decision uses what the user sees. */
  async reviewRun(uri: string, command: string, args: unknown[] = []): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (doc?.isDirty && !(await doc.save())) return; // the save failed (and said why)
    await vscode.commands.executeCommand(command, ...args);
  }

  /** ✓ Accept in a review document: its unsaved edits first, so the accept uses what the user sees. */
  async reviewAccept(uri: vscode.Uri, ref: unknown): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc?.isDirty && !(await doc.save())) return; // the save failed (and said why)
    await this.accept(ref);
  }

  /** Drop the user's wording for a change: the agent's text again. */
  async clearDraft(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (t) await this.run(t.project, () => t.project.stet.clearDraft(t.item.id));
  }

  /** Projects asked about the extra fonts in this session (asked once each). */
  private askedExtras = new Set<string>();

  /** A preview misses files the extra fonts may bring: ask once whether to install them. */
  private async offerExtras(p: Project, files: string[]): Promise<void> {
    if (this.askedExtras.has(p.mainPath)) return;
    this.askedExtras.add(p.mainPath);
    const install = "Install (about 2 GB)";
    const pick = await vscode.window.showInformationMessage(
      `Stet: a PDF preview in ${p.name} needs ${files.join(", ")}, which the preview's TeX doesn't have. Its extra fonts may (dsfont, bbm, bbold and many more). Install them?`,
      install,
      "Not now",
    );
    if (pick === install) await this.runExtras(p);
  }

  /** The panel's button: ask before downloading, then install. */
  async installExtras(p: Project): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      "Install TeX's extra fonts for PDF previews?",
      { modal: true, detail: "Podman downloads Debian's texlive-fonts-extra (about 2 GB) into a second preview image. Previews then use that image." },
      "Install",
    );
    if (ok === "Install") await this.runExtras(p);
  }

  private async runExtras(p: Project): Promise<void> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Stet: adding TeX's extra fonts to the PDF preview image (about 2 GB, this takes a while)…" },
      () => p.stet.setupPreview({ extras: true }).catch((e: any) => ({ ok: false, log: String(e?.message ?? e), status: undefined })),
    );
    if (r.ok) void vscode.window.showInformationMessage("Stet: extra fonts installed; previews are built again with them.");
    else {
      this.output.appendLine(r.log);
      void vscode.window
        .showErrorMessage("Stet: adding the extra fonts failed. Details are in the Stet output.", "Show output")
        .then((c) => c && this.output.show());
    }
    this.preview.refresh();
  }

  /** Open the PDF preview of a change. */
  async showPreview(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    // `p` on a Typst change opened an empty preview panel (test report 5e4c6af, B8).
    if (t.item.kind !== "modify" || !hasPreview(t.item.file))
      return void vscode.window.showInformationMessage(
        `Stet has no PDF preview for ${t.item.id}: ${t.item.kind !== "modify" ? "it is not a text change" : `there are no PDF previews for ${profileByName(t.item.file).name} files yet`}.`,
      );
    if (previewPlace() === "off")
      return void vscode.window.showInformationMessage("PDF previews are off (setting stet.pdfPreviews, or View options in the Stet panel).");
    this.preview.show(t);
  }

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
  private async bundledCli(current: CliCommand | undefined, storeRoot: string): Promise<{ cli: CliCommand; script: string } | null> {
    const present = !!current && (await pathExists(current.command)) && (await Promise.all(current.args.slice(0, 1).map(pathExists))).every(Boolean);
    if (current && present && !isManaged(current, storeRoot)) return null;
    const script = await installCli(this.ctx.asAbsolutePath("dist/stet.mjs"), storeRoot);
    return { cli: await cliCommand(vscode.workspace.getConfiguration("stet").get<RuntimeMode>("runtime", "auto"), script), script };
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

  // --- Replies you haven't seen (test report v0.16.0) -----------------------

  /** How many entries of each thread you have seen, by `project|id`; `project|*` marks a project counted from. */
  private seen: Record<string, number> = {};
  private static readonly SEEN = "stet.seenThreads";

  private seenKey = (p: Project, id: string) => `${p.mainPath}|${id}`;

  /** Agent replies on a change or note you haven't seen. */
  unread(p: Project, x: { id: string; thread: readonly { author: string }[] }): number {
    return unreadReplies(x.thread, this.seen[this.seenKey(p, x.id)] ?? 0);
  }

  /** Unread replies on the changes and notes of `p` that match `pred`. */
  private unreadOf(p: Project, pred: (x: { agent: string }) => boolean): number {
    const s = p.snapshot;
    return [...s.items.filter((i) => isLiveItem(i) || i.thread.length), ...s.notes].filter(pred).reduce((n, x) => n + this.unread(p, x), 0);
  }

  /**
   * " in paper-typst" when the window has several projects: ids repeat across projects, and with
   * a screen reader these results are all the feedback there is (test report 5e4c6af, multi-root).
   */
  private inWhich(p: Project): string {
    return this.projects.size > 1 ? ` in ${p.name}` : "";
  }

  /** You saw the thread of a change or note (went to it, replied). */
  markRead(p: Project, x: { id: string; thread: readonly unknown[] }): void {
    const k = this.seenKey(p, x.id);
    if ((this.seen[k] ?? 0) >= x.thread.length) return;
    this.seen[k] = x.thread.length;
    void this.ctx.workspaceState.update(StetExtension.SEEN, this.seen);
    void this.onProjectChanged();
  }

  /** The first time a project is seen here, its replies so far count as read: no flood of old ones. */
  private baselineSeen(): void {
    let changed = false;
    for (const p of this.projects.values()) {
      const mark = this.seenKey(p, "*");
      if (this.seen[mark]) continue;
      for (const x of [...p.snapshot.items, ...p.snapshot.notes]) if (x.thread.length) this.seen[this.seenKey(p, x.id)] = x.thread.length;
      if (!p.snapshot.items.length && !p.snapshot.notes.length && !p.snapshot.agents.length) continue; // not loaded yet
      this.seen[mark] = 1;
      changed = true;
    }
    if (changed) void this.ctx.workspaceState.update(StetExtension.SEEN, this.seen);
  }

  private async onProjectChanged(): Promise<void> {
    this.baselineSeen();
    this.models.clear();
    this.lines.clear();
    this.lineBatches.clear();
    const all = [...this.projects.values()];
    const snaps = all.map((p) => p.snapshot);
    // Yours to review: changes waiting for the agent's revision don't count (test report UX).
    const pending = snaps.reduce((n, s) => n + s.items.filter((i) => i.status === "pending").length, 0);
    const uncommitted = snaps.reduce((n, s) => n + s.uncommitted.length, 0);
    const sync = snaps.flatMap(behindAgents);
    const unshared = all.filter((p) => p.snapshot.unshared).map((p) => p.name);
    const missing = all.flatMap((p) => p.snapshot.missing.map((m) => ({ ...m, project: p.name })));
    // Shown only when something is wrong: accepted changes agents would never see.
    this.missingMessage = missing.length
      ? `⚠ Agents don't get accepted ${missing.map((m) => m.id).join(", ")} (${missing[0]!.reason}${missing.length > 1 ? ", …" : ""}). ` +
        "Finish the review, or share your edits, to pass them on."
      : undefined;
    this.showPanelMessage();
    // Redraw first: selecting the next change waits for the tree, not for the context keys.
    this.treeChanged.fire(undefined);
    void this.review.refresh();
    void this.edits.refresh();
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === "stet-diff") this.diffContent.fire(d.uri);
    void this.updateFileContext();
    this.historyChanged.fire(undefined);
    this.changed.fire();
    this.tree.badge = pending ? { value: pending, tooltip: `${pending} proposed change${pending === 1 ? "" : "s"} to review` } : undefined;
    if (all.length) {
      const fresh = all.reduce((n, p) => n + this.unreadOf(p, () => true), 0);
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
      ["stet.previews", [...this.projects.values()].some((p) => !this.noPreviews.has(foldPath(p.mainPath)))],
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
    if (!m) this.models.set(key, (m = new TreeModel(p.snapshot, mode, mode === "review" ? this.filter : null)));
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
      if (ps.length === 1)
        return this.model(ps[0]!, mode)
          .children()
          .map((node) => ({ project: ps[0]!, node }));
      return ps.map((project) => ({ project }));
    }
    return this.model(el.project, mode)
      .children(el.node)
      .map((node) => ({ project: el.project, node }));
  }

  private async treeItemOf(el: El, mode: TreeMode): Promise<vscode.TreeItem> {
    const t = await this.buildTreeItem(el, mode);
    t.id = elId(el);
    // Every row read out in words: only change rows were, and the others' "💬 3 (1 new)", "⚠" and
    // "·" were left to the screen reader (test report 5e4c6af, accessibility).
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
  private lastSelected: El | undefined;
  private panelSelection(): El | undefined {
    const sel = this.tree.selection[0];
    if (sel) return sel;
    const last = this.lastSelected;
    if (last?.node?.type !== "item") return last && this.projects.get(foldPath(last.project.mainPath)) === last.project ? last : undefined;
    const item = this.model(last.project).item(last.node.item.id);
    return item ? { project: last.project, node: { ...last.node, item } } : undefined;
  }

  /** Select the next (or previous) change in the panel and show it in the editor (`j` / `k`). */
  async step(dir: 1 | -1): Promise<void> {
    const rows = this.rowsInOrder();
    const cur = this.panelSelection();
    // From a round or group row too: the change after (or before) it, not the panel's first or last (test report v0.16.0, B4).
    const i = nextItemIndex(
      rows.map((e) => e.node?.type === "item"),
      cur ? rows.findIndex((e) => elId(e) === elId(cur)) : -1,
      dir,
    );
    if (i < 0) return;
    let next = rows[i]!;
    // Or by file and line, if you'd rather go through the document (stet.navigationOrder).
    if (vscode.workspace.getConfiguration("stet").get<string>("navigationOrder", "panel") === "document" && cur?.node?.type === "item") {
      const items = rows.filter((e) => e.node?.type === "item");
      // Projects in the panel's order, not by path: they were crossed the other way round (test report 5e4c6af).
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
    const before = this.itemsInOrder()
      .filter((e) => e.project === p)
      .map(idOf);
    const status = this.model(p).item(anchor)?.status;
    await action();
    if (!vscode.workspace.getConfiguration("stet").get<boolean>("autoAdvance", true)) return;
    if (this.model(p).item(anchor)?.status === status) return;
    const live = new Map(
      this.itemsInOrder()
        .filter((e) => e.project === p && e.node?.type === "item" && isLiveItem(e.node.item))
        .map((e) => [idOf(e), e]),
    );
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
      // Each project's own counts: the status bar adds them up (test report v0.16.0).
      const model = this.model(el.project, mode);
      const done = el.project.snapshot.uncommitted.length;
      t.description = mode === "history" ? model.outcome(() => true) : [model.openText(() => true), ...(done ? [`${done} to commit`] : [])].join(" · ");
      return t;
    }
    const n = el.node;
    const model = this.model(el.project, mode);
    const history = mode === "history";
    const snap = el.project.snapshot;
    switch (n.type) {
      case "agent": {
        // An agent that hasn't proposed anything yet says what to do, not "0 pending" (test report v0.16.0).
        const fresh = !history && n.agent.state === "active" && !snap.changesets.some((c) => c.agent === n.agent.id);
        const t = new vscode.TreeItem(fitLabel(n.agent.id, 28), fresh && !model.children(n).length ? vscode.TreeItemCollapsibleState.None : E);
        const parts = [history ? model.outcome((i) => i.agent === n.agent.id) : fresh ? "no proposals yet" : model.openText((i) => i.agent === n.agent.id)];
        const behind = behindAgents(snap).includes(n.agent.id);
        if (behind) parts.push("behind your text");
        if (n.agent.state === "archived") parts.push("archived");
        const replies = this.unreadOf(el.project, (x) => x.agent === n.agent.id);
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
        const fresh = this.unread(el.project, nt);
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
        const unread = this.unread(el.project, it);
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

  private async lineOf(p: Project, it: Item): Promise<number> {
    return (await this.placeOf(p, it)).line;
  }

  /**
   * Where a change is in your file (the editor's text if open, else the file on disk), and
   * whether it is there at all: you may have edited the words around it since (test report v0.16.0).
   */
  private async placeOf(p: Project, it: Item): Promise<{ line: number; found: boolean }> {
    const key = `${p.mainPath}|${it.id}`;
    const hit = this.lines.get(key);
    if (hit !== undefined) return hit;
    const doc = vscode.workspace.textDocuments.find((d) => p.relPath(d.uri) === it.file);
    let place: { line: number; found: boolean } | undefined;
    if (doc && isLiveItem(it)) {
      const l = (await this.locator.locate(doc)).find((x) => x.item.id === it.id);
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
   * refresh: row by row, a panel of 424 changes took 6.5 s to redraw (test report v0.16.0, B2).
   */
  private lineBatches = new Map<string, Promise<Map<string, { line: number; span: unknown }>>>();
  private workingLines(p: Project): Promise<Map<string, { line: number; span: unknown }>> {
    let b = this.lineBatches.get(p.mainPath);
    if (!b) {
      const live = p.snapshot.items.filter((i) => isLiveItem(i) && i.kind === "modify");
      b = p.stet.locateMany(live, undefined, p.snapshot.items).catch(() => new Map<string, { line: number; span: unknown }>());
      this.lineBatches.set(p.mainPath, b);
    }
    return b;
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
    if (arg === "panel") return this.panelSelection();
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
    const sel = this.tree.visible ? this.panelSelection() : undefined;
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
        // The full id: the label's number is the change's within its round, so 2.1 showed as "1" (test report 5e4c6af).
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

  // --- Filter and search (test report 2026-11-20) ----------------------------

  private filter: PanelFilter | null = null;
  private missingMessage: string | undefined;

  private showPanelMessage(): void {
    const f = this.filter && !filterIsEmpty(this.filter) ? `Showing only: ${filterText(this.filter)} (✕ in the title clears it)` : undefined;
    this.tree.message = [f, this.missingMessage].filter(Boolean).join("\n") || undefined;
  }

  /** Show only the changes matching `f` in the Review panel (null: all of them). */
  async setFilter(f: PanelFilter | null): Promise<void> {
    this.filter = filterIsEmpty(f) ? null : f;
    for (const [key, m] of this.models) if (key.startsWith("review|")) m.filter = this.filter;
    await vscode.commands.executeCommand("setContext", "stet.filtered", !!this.filter);
    this.showPanelMessage();
    this.treeChanged.fire(undefined);
  }

  /** *Filter…*: by agent, file or status, or words in the changes; picks add to the filter. */
  async pickFilter(): Promise<void> {
    const ps = this.allProjects();
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

  /** Remember a decision for *Undo* (`u` in the panel), and offer the button for a few seconds. */
  private noteDecision(p: Project, ids: string[], what: Decision): void {
    if (!ids.length) return;
    this.decisions.push({ project: p, ids, what });
    if (this.decisions.length > UNDO_DEPTH) this.decisions.shift();
    this.showUndo();
  }

  private showUndo(): void {
    // The panel's title has Undo while there is something to undo: mouse users had only the
    // status-bar button for 15 seconds (test report v0.16.0).
    void vscode.commands.executeCommand("setContext", "stet.canUndo", this.decisions.length > 0);
    const d = this.decisions.at(-1);
    if (!d) return void this.undoButton.hide();
    const label = `Undo the ${d.what} of ${d.ids.length > 3 ? `${d.ids.length} changes` : d.ids.join(", ")}`;
    this.undoButton.text = `$(discard) Undo`;
    this.undoButton.tooltip = `${label} (u in the Stet panel)`;
    this.undoButton.accessibilityInformation = { label, role: "button" };
    this.undoButton.command = "stet.undoLast";
    this.undoButton.show();
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.undoButton.hide(), UNDO_SHOWN_MS);
  }

  /** Finish review committed `p`'s accepts: they can't be undone here any more. */
  private forgetAccepts(p: Project): void {
    this.decisions = this.decisions.filter((d) => !(d.project === p && d.what === "accept"));
    this.showUndo();
    this.undoButton.hide();
  }

  /**
   * Undo the latest decision made here that isn't undone yet (all the changes it decided); each
   * press goes one further back. Says so when it was decided again since or committed.
   */
  async undoLast(): Promise<void> {
    const d = this.decisions.pop();
    void vscode.commands.executeCommand("setContext", "stet.canUndo", this.decisions.length > 0);
    this.undoButton.hide();
    if (!d)
      return void vscode.window.showInformationMessage(
        "Nothing more to undo: every decision made in this window is undone, committed, or older than this session.",
      );
    const state: Record<Decision, string> = { accept: "accepted", rejection: "rejected", "revision request": "needs_revision" };
    const undone: string[] = [];
    await this.run(d.project, async () => {
      const files = d.ids.flatMap((id) => {
        const it = this.model(d.project).item(id);
        return it ? [it.file, ...(it.oldFile ? [it.oldFile] : [])] : [];
      });
      await this.saveFiles(d.project, files);
      const todo: string[] = [];
      for (const id of d.ids) {
        const it = await d.project.stet.getItem(id);
        // Decided again since.
        if (!it || it.status !== state[d.what]) continue;
        if (it.resolution?.committed) throw new Error(`The accept of ${it.id} is committed already, so Stet can't take it back.`);
        todo.push(id);
      }
      if (!todo.length) return;
      // All at once, with progress when it takes a moment: one by one, 400 changes took 16 s
      // without a word (test report 5e4c6af, B5).
      const r = await vscode.window.withProgress(
        {
          location: todo.length > 20 ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: `Stet: undoing the ${d.what} of ${todo.length} change${todo.length === 1 ? "" : "s"}…`,
        },
        () => d.project.stet.undoMany(todo),
      );
      undone.push(...r.reopened.map((i) => i.id));
    });
    if (undone.length) announce(`$(discard) Undid the ${d.what} of ${[...new Set(undone)].join(", ")}${this.inWhich(d.project)}`, 5000);
    else announce(`$(info) The ${d.what} of ${d.ids.join(", ")} was already undone or decided again`, 5000);
  }

  /**
   * In a High Contrast theme, proposed text drawn as an inlay hint (the wrapping style) has no
   * border and no colour, and screen readers skip it: offer once to use the highlighted style,
   * which has the border (test report v0.16.0, accessibility).
   */
  private async offerContrastStyle(uri: vscode.Uri): Promise<void> {
    const memo = "stet.askedContrastStyle";
    const kind = vscode.window.activeColorTheme.kind;
    const highContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
    const ask = offerContrastStyle({
      highContrast,
      inProject: !!this.projectFor(uri),
      wrapsWithLine: usesHints(uri),
      askedBefore: !!this.ctx.globalState.get<boolean>(memo),
    });
    if (!ask) return;
    await this.ctx.globalState.update(memo, true);
    const use = "Use the highlighted style";
    const pick = await vscode.window.showInformationMessage(
      // Neither style is read by screen readers (decorations aren't): said so, not implied (test report 5e4c6af).
      "In High Contrast themes, proposed text that wraps with the line has no border or colour of its own. Use the highlighted style instead, which has a border? (It doesn't wrap with the line.) Screen readers read neither style; the Stet panel and each change's hover say what it proposes.",
      use,
      "Keep wrapping",
    );
    if (pick === use) await this.setOption("newTextStyle", "highlighted");
  }

  /** Whether the user last picked a change in the panel or moved in a file (see `target`). */
  private lastPick: "panel" | "editor" = "panel";

  private async targetItem(arg: unknown): Promise<{ project: Project; item: Item } | undefined> {
    this.pickCancelled = false;
    let t = await this.target(arg);
    if (this.pickCancelled) return undefined;
    // From the palette or a key binding, with a round or group selected in the panel: the change
    // under the cursor (test report v0.16.0, B7).
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
  private unsavedTexts(p: Project, files: string[]): Record<string, string> {
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
  private async saveWording(p: Project, ids: string[], files: string[]): Promise<boolean> {
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
      void vscode.window.showErrorMessage(noLinks(e?.message ?? String(e)));
      return undefined;
    } finally {
      await p?.refresh().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Review commands

  async accept(arg: unknown, all?: unknown): Promise<void> {
    const many = this.selectedMany(arg, all);
    if (many) return this.acceptMany(many.project, many.items, fromPanel(arg));
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const c = await this.acceptWhat(p, item);
    if (c) await this.decide(p, item.id, fromPanel(arg), () => this.doAccept(p, c.ids, { overrideLinked: c.overrideLinked }));
  }

  /**
   * What to accept with `item`: itself (with the other half of its move), or, if it is linked with
   * other pending changes, what the user picks (`acceptQuestion`). Undefined if they cancelled.
   */
  private async acceptWhat(p: Project, item: Item): Promise<{ ids: string[]; overrideLinked: boolean } | undefined> {
    const q = acceptQuestion(this.model(p), item);
    if (!q) return { ids: this.model(p).withMove(item), overrideLinked: false };
    const pick = await vscode.window.showQuickPick(
      q.choices.map((c) => ({ label: c.label, detail: c.detail, c })),
      { title: q.title },
    );
    return pick?.c;
  }

  /**
   * The pending changes selected in the panel, when there are several: a menu or button of a row
   * passes the selection as its second argument, a key in the panel uses the panel's selection.
   * Undefined for one change, so the usual one-change path runs.
   */
  /**
   * With several changes selected, an action that takes one says which one it took: Revise,
   * Comment, Edit and Diff acted on one without a word (test report 5e4c6af, multi-select).
   */
  private onlyOne(action: string, item: Item, arg: unknown, all: unknown): void {
    const els: El[] = Array.isArray(all) ? (all as El[]) : arg === "panel" ? [...this.tree.selection] : [];
    const n = els.filter((e) => e?.node?.type === "item").length;
    if (n > 1) announce(`$(info) ${action} takes one change at a time: ${item.id}, not the other ${n - 1} selected.`, 6000);
  }

  private selectedMany(arg: unknown, all: unknown): { project: Project; items: Item[] } | undefined {
    const els: El[] = Array.isArray(all) ? (all as El[]) : arg === "panel" ? [...this.tree.selection] : [];
    const items = els.filter((e) => e?.node?.type === "item" && isLiveItem((e.node as { item: Item }).item));
    if (items.length < 2) return undefined;
    const project = items[0]!.project;
    if (items.some((e) => e.project !== project)) {
      void vscode.window.showInformationMessage("Select changes of one project at a time.");
      return { project, items: [] };
    }
    return { project, items: items.map((e) => this.model(project).item((e.node as { item: Item }).item.id)).filter((i): i is Item => !!i && isLiveItem(i)) };
  }

  /** Accept several selected changes; asks whether to take along what they are linked with. */
  private async acceptMany(p: Project, items: Item[], panel: boolean): Promise<void> {
    if (!items.length) return;
    const ids = [...new Set(items.flatMap((i) => this.model(p).withMove(i)))];
    const rest = this.model(p).linkedRest(ids);
    // Other parts of their groups too, as a single Accept asks: a label's part was accepted
    // without its references, unasked (test report 5e4c6af, D2).
    const others = this.model(p).otherParts(ids);
    let take = ids;
    let overrideLinked = false;
    if (rest.length || others.length) {
      const q = manyQuestion(
        "Accept",
        ids.length,
        rest.map((r) => r.id),
        others.map((o) => o.id),
      );
      const pick = await vscode.window.showQuickPick(q.choices, { title: q.title });
      if (!pick) return;
      if (pick.withRest) take = [...ids, ...rest.map((r) => r.id), ...(pick.withGroups ? others.map((o) => o.id) : [])];
      else overrideLinked = true;
    }
    await this.decide(p, ids[0]!, panel, () => this.doAccept(p, take, { overrideLinked }));
  }

  /** Reject several selected changes with one reason; asks about what they are linked with. */
  private async rejectMany(p: Project, items: Item[], panel: boolean): Promise<void> {
    if (!items.length) return;
    const ids = [...new Set(items.flatMap((i) => this.model(p).withMove(i)))];
    const rest = this.model(p).linkedRest(ids);
    let mode: "all" | "only" | undefined;
    if (rest.length) {
      const q = manyQuestion(
        "Reject",
        ids.length,
        rest.map((r) => r.id),
      );
      const pick = await vscode.window.showQuickPick(q.choices, { title: q.title });
      if (!pick) return;
      mode = pick.withRest ? "all" : "only";
    }
    const reason = await this.reason(`Reject ${ids.length} changes`);
    if (reason === undefined) return;
    await this.decide(p, ids[0]!, panel, () =>
      this.run(p, async () => {
        const r = await p.stet.reject(ids, { ...(reason ? { reason } : {}), ...(mode ? { mode } : {}) });
        const warnings = await p.stet.partlyDecided(r);
        this.noteDecision(
          p,
          r.map((i) => i.id),
          "rejection",
        );
        if (warnings.length) void vscode.window.showWarningMessage([`Rejected ${r.map((i) => i.id).join(", ")}${this.inWhich(p)}.`, ...warnings].join(" "));
        else announce(`$(close) Rejected ${r.map((i) => i.id).join(", ")}${this.inWhich(p)}`, 4000);
      }),
    );
  }

  /** Accept only this change of a linked group (breaks it; the agent is asked to repair it). */
  async acceptOnly(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const own = this.model(p).withMove(item);
    const rest = this.model(p).linkedRest(own);
    await this.decide(p, item.id, fromPanel(arg), () => this.doAccept(p, own, { overrideLinked: rest.length > 0 }));
  }

  /** More…: every action on a change, the same list as in its hover and under Ctrl+. in the editor. */
  async changeActions(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const actions = changeActions(this.model(p), p.mainPath, item, { previews: previewPlace() !== "off", lost: !(await this.placeOf(p, item)).found });
    type Pick = vscode.QuickPickItem & { action?: (typeof actions)[number] };
    const items: Pick[] = [];
    actions.forEach((a, i) => {
      if (i > 0 && actions[i - 1]!.tier !== a.tier) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: withIcon(a),
        description: a.key ? `${a.key === a.key.toUpperCase() ? "Shift+" : ""}${a.key.toUpperCase()} in the panel` : undefined,
        detail: a.detail,
        action: a,
      });
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: actionsTitle(item, this.model(p).get),
      placeHolder: "What to do with this change",
      matchOnDetail: true,
    });
    if (pick?.action) await vscode.commands.executeCommand(pick.action.command, ...pick.action.args);
  }

  /** What an item must be decided with: "the linked group" or "part 2 “Section 3”". */
  private unitName(p: Project, item: Item): string {
    const part = this.model(p).partOf(item);
    return part ? `part ${part.index + 1} “${part.group.parts![part.index]!.title}”` : "the linked group";
  }

  private async doAccept(
    p: Project,
    ids: string[],
    opts: { overrideLinked?: boolean; edited?: Record<string, string>; confirmEffects?: boolean } = {},
  ): Promise<void> {
    // Files that take effect once accepted (a latexmkrc, .gitattributes, AGENTS.md…): asked
    // explicitly, with what they set off (security report 5e4c6af, S12).
    const effects = ids.map((id) => this.model(p).item(id)).filter((it): it is Item => !!it && !!itemEffect(it));
    if (effects.length) {
      const ok = `Accept ${effects.length > 1 ? "them" : "it"}`;
      const pick = await vscode.window.showWarningMessage(
        `${effects.map((i) => i.id).join(", ")} ${effects.length > 1 ? "change files that take" : "changes a file that takes"} effect once accepted.`,
        { modal: true, detail: effects.map((i) => `${i.id} ${i.file}: ${itemEffect(i)}.`).join("\n") + "\n\nLook at the content first (Diff, or the hover)." },
        ok,
      );
      if (pick !== ok) return;
      opts = { ...opts, confirmEffects: true };
    }
    const files = ids.flatMap((id) => {
      const it = this.model(p).item(id);
      return it ? [it.file, ...(it.oldFile ? [it.oldFile] : [])] : [];
    });
    // Your wording typed in a Review-file or change tab and not saved yet: saved first, so the
    // accept uses it (test report v0.16.0, D4). A save it refuses stops the accept.
    if (!(await this.saveWording(p, ids, files))) return;
    await this.run(p, async () => {
      // Your unsaved edits of these files are saved only for an accept that will work (D7).
      try {
        await p.stet.checkAccept(ids, { ...opts, unsaved: this.unsavedTexts(p, files) });
      } catch (e) {
        if (this.offerInstead(p, ids, e)) return;
        throw e;
      }
      await this.saveFiles(p, files);
      const r = await p.stet.accept(ids, opts);
      this.noteDecision(
        p,
        r.accepted.map((i) => i.id),
        "accept",
      );
      const msg = [`Accepted ${r.accepted.map((i) => i.id).join(", ")}${this.inWhich(p)}${r.committed ? ` (committed ${r.committed.slice(0, 7)})` : ""}.`];
      if (r.stale.length) msg.push(`Now stale (overlapped): ${r.stale.map((i) => i.id).join(", ")}.`);
      msg.push(...r.warnings);
      if (r.warnings.length) void vscode.window.showWarningMessage(noLinks(msg.join(" ")));
      else announce(`$(check) ${msg.join(" ")}`, 4000);
    });
  }

  /**
   * A change that can't be found in your file any more: the failed accept offers Reject… and
   * Revise…, as its More… list does (test report 5e4c6af). False for other failures.
   */
  private offerInstead(p: Project, ids: string[], e: unknown): boolean {
    const instead = failedAcceptActions(ids, e);
    if (!instead.length) return false;
    const ref: Ref = { path: p.mainPath, id: ids[0]! };
    void vscode.window.showErrorMessage(noLinks((e as Error).message), ...instead).then((pick) => {
      if (pick) void vscode.commands.executeCommand(pick === "Reject…" ? "stet.reject" : "stet.revise", ref);
    });
    return true;
  }

  /**
   * The pending changes a group, a changeset, or a change's group stands for (Accept all /
   * Reject all). Tells the user and returns undefined when there is nothing to act on.
   */
  private async scope(arg: unknown): Promise<{ project: Project; ids: string[]; what: string; changeset: boolean; linked: boolean } | undefined> {
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
      const ids = model
        .partMembers(g, n.index)
        .filter(isLiveItem)
        .map((i) => i.id);
      const what = `${partId(g.id, n.index)} “${g.parts?.[n.index]?.title ?? ""}”`;
      return ids.length ? { project: p, ids, what, changeset: false, linked: true } : void vscode.window.showInformationMessage(`Nothing pending in ${what}.`);
    }
    if (n.type === "group") {
      const ids = model
        .members(n.group)
        .filter(isLiveItem)
        .map((i) => i.id);
      return ids.length
        ? { project: p, ids, what: `${n.group.id} “${n.group.title}”`, changeset: false, linked: n.group.kind === "linked" }
        : void vscode.window.showInformationMessage(`Nothing pending in ${n.group.id}.`);
    }
    if (n.type === "changeset") {
      const cs = n.changeset;
      const ids = pendingInRound(p.snapshot.items, cs.id).map((i) => i.id);
      return ids.length
        ? { project: p, ids, what: `round ${roundOf(cs.id)} “${cs.title}”`, changeset: true, linked: false }
        : void vscode.window.showInformationMessage(`Nothing pending in round ${roundOf(cs.id)}.`);
    }
    return undefined;
  }

  async acceptAll(arg: unknown): Promise<void> {
    const s = await this.scope(arg);
    if (!s) return;
    let ids = s.ids;
    if (s.changeset)
      ids = [
        ...ids,
        ...this.model(s.project)
          .linkedRest(ids)
          .map((i) => i.id),
      ];
    const ask = bulkQuestion("Accept", { ...s, count: ids.length });
    if (ask && (await vscode.window.showWarningMessage(ask, { modal: true }, "Accept all")) !== "Accept all") return;
    await this.decide(s.project, s.ids[0]!, fromPanel(arg), () => this.doAccept(s.project, ids));
  }

  private async reason(prompt: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: prompt,
      prompt: "Optional, but it helps the agent: why? (Enter to skip)",
      placeHolder: "e.g. keep the original formula",
    });
  }

  async reject(arg: unknown, all?: unknown): Promise<void> {
    const many = this.selectedMany(arg, all);
    if (many) return this.rejectMany(many.project, many.items, fromPanel(arg));
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
    await this.decide(p, item.id, fromPanel(arg), () =>
      this.run(p, async () => {
        const r = await p.stet.reject(own, { ...(reason ? { reason } : {}), ...(mode ? { mode } : {}) });
        const warnings = await p.stet.partlyDecided(r);
        this.noteDecision(
          p,
          r.map((i) => i.id),
          "rejection",
        );
        if (warnings.length) void vscode.window.showWarningMessage([`Rejected ${r.map((i) => i.id).join(", ")}${this.inWhich(p)}.`, ...warnings].join(" "));
        else announce(`$(close) Rejected ${r.map((i) => i.id).join(", ")}${this.inWhich(p)}`, 4000);
      }),
    );
  }

  async rejectAll(arg: unknown): Promise<void> {
    const s = await this.scope(arg);
    if (!s) return;
    const ask = bulkQuestion("Reject", { ...s, count: s.ids.length });
    if (ask && (await vscode.window.showWarningMessage(ask, { modal: true }, "Reject all")) !== "Reject all") return;
    const reason = await this.reason(`Reject all ${s.ids.length} changes of ${s.what}`);
    if (reason === undefined) return;
    const p = s.project;
    await this.decide(p, s.ids[0]!, fromPanel(arg), () =>
      this.run(p, async () => {
        const r = await p.stet.reject(s.ids, { ...(reason ? { reason } : {}), mode: "all" });
        this.noteDecision(
          p,
          r.map((i) => i.id),
          "rejection",
        );
        announce(`$(close) Rejected ${r.map((i) => i.id).join(", ")}${this.inWhich(p)}`, 4000);
      }),
    );
  }

  async edit(arg: unknown, all?: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    this.onlyOne("Edit & accept", t.item, arg, all);
    const { project: p, item } = t;
    if (item.kind !== "modify") return void vscode.window.showInformationMessage(`${item.id} changes a whole file; it can only be accepted or rejected.`);
    // Your wording, if you have one (from a review document).
    let start = item.draft ?? item.newText;
    // The input box shows one line of about 80 characters: anything longer is edited in a tab,
    // and the box can hand over to one (keeping what was typed).
    if (!start.includes("\n") && start.length <= SHORT_EDIT) {
      const r = await this.editInBox(item, start);
      if (r === undefined) return;
      if (typeof r !== "string" && "save" in r) {
        // Your wording, kept for later; the change stays pending.
        await this.run(p, async () => {
          if (await p.stet.setDraft(item.id, r.save)) announce(`$(edit) Your wording for ${item.id} is saved; still pending: accept when ready`, 6000);
        });
        return;
      }
      if (typeof r !== "string") start = r.inTab;
      else {
        const text = r;
        // Linked with other changes: ask what to take along, as Accept does (test report v0.16.0, D5).
        const c = await this.acceptWhat(p, item);
        if (!c) return;
        return this.decide(p, item.id, fromPanel(arg), () => this.doAccept(p, c.ids, { overrideLinked: c.overrideLinked, edited: { [item.id]: toLf(text) } }));
      }
    }
    await this.editInTab(p, item, start);
  }

  /** Save the wording in a change's editor (it stays pending). */
  async editSave(uri: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (!doc) return;
    if (doc.isDirty) await doc.save();
    else announce("$(edit) Nothing changed since the last save", 3000);
  }

  /** Back to the agent's text in a change's editor (and drop your wording). */
  async editReset(arg: unknown): Promise<void> {
    const uri = typeof arg === "string" ? vscode.Uri.parse(arg) : arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== EDIT_SCHEME) return;
    const { project: p, item } = this.edits.target(uri);
    if (!item) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const e = new vscode.WorkspaceEdit();
    e.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), item.newText);
    await vscode.workspace.applyEdit(e);
    await doc.save();
    await p.refresh();
  }

  /** Accept the change of the active change editor, with its wording (the title bar's ✓). */
  async editAccept(arg: unknown): Promise<void> {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== EDIT_SCHEME) return;
    const { project: p, item } = this.edits.target(uri);
    if (!item) return;
    const a = acceptAction(this.model(p), p.mainPath, item);
    await this.reviewRun(uri.toString(), a.command, a.args);
  }

  /**
   * Edit a short change in an input box: the text to accept it with, `{ save }` to keep it as your
   * wording, `{ inTab }` to continue in a tab, or undefined if cancelled. The box holds the change
   * in the words around it on its line, with the change selected: only that part can be edited.
   */
  private editInBox(item: Item, text: string): Promise<string | { inTab: string } | { save: string } | undefined> {
    const frame = editFrame(item);
    const box = vscode.window.createInputBox();
    box.title = `Edit ${item.id} before accepting`;
    box.prompt = `${item.oldText ? `Replaces “${oneLine(item.oldText, 200)}”. ` : ""}The selected part is the change; the words around it stay as they are. Enter accepts.`;
    box.value = frame.pre + text + frame.post;
    box.valueSelection = [frame.pre.length, frame.pre.length + text.length];
    box.placeholder = "Enter accepts with this wording";
    const outside = "Only the change can be edited here, not the words around it: edit your file for those.";
    const save: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("save"), tooltip: "Save wording without accepting (the change stays pending)" };
    const toTab: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("go-to-file"), tooltip: "Edit in a tab (for longer text)" };
    box.buttons = [save, toTab];
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: string | { inTab: string } | { save: string } | undefined) => {
        if (done) return;
        done = true;
        resolve(r);
        box.dispose();
      };
      const part = () => editedPart(frame, box.value);
      box.onDidChangeValue(() => (box.validationMessage = part() === null ? outside : undefined));
      box.onDidAccept(() => {
        const t = part();
        if (t !== null) finish(t);
      });
      box.onDidTriggerButton((b) => {
        const t = part();
        if (t === null) return;
        finish(b === save ? { save: t } : { inTab: t });
      });
      box.onDidHide(() => finish(undefined));
      box.show();
    });
  }

  /**
   * Edit a change's wording in an editor of its own (edits.ts): Ctrl+S keeps it, the change stays
   * pending; Accept above the text or in the title bar accepts it with it. `text`: what to start
   * from, if not the saved wording (typed in the input box first).
   */
  private async editInTab(p: Project, item: Item, text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(EditFiles.uriFor(p, item));
    const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: this.columnFor(doc.uri) });
    if (toLf(doc.getText()) !== text) await ed.edit((e) => e.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
  }

  async comment(arg: unknown, all?: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    this.onlyOne("Comment", t.item, arg, all);
    const text = await vscode.window.showInputBox({
      title: `Comment on ${t.item.id}`,
      prompt: "The agent sees this with its feedback and can reply.",
      placeHolder: "Message to the agent…",
    });
    if (!text) return;
    const ok = await this.run(t.project, async () => {
      await t.project.stet.comment(t.item.id, text, "user");
      return true;
    });
    if (ok) announce(`$(comment) Comment on ${t.item.id} sent: the agent gets it with its feedback, and can reply.`);
  }

  async revise(arg: unknown, all?: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    this.onlyOne("Revise", t.item, arg, all);
    const text = await vscode.window.showInputBox({
      title: `Request a revision of ${t.item.id}`,
      prompt: "What should the agent change?",
      placeHolder: "e.g. shorter, and keep the term “ansatz”",
    });
    if (!text) return;
    await this.decide(t.project, t.item.id, fromPanel(arg), () =>
      this.run(t.project, async () => {
        await t.project.stet.requestRevision(t.item.id, text);
        // Undoable like the other decisions: `u` after `v` undid an older accept (test report v0.16.0, B5).
        this.noteDecision(t.project, [t.item.id], "revision request");
        announce(`$(sync) Revision of ${t.item.id}${this.inWhich(t.project)} requested: it waits for the agent's new version.`);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Reviewer notes (spec §7.8)

  /** An agent of `p` to address, asked for when there is more than one. */
  private async pickNoteAgent(p: Project): Promise<string | undefined> {
    const agents = p.snapshot.agents.filter((a) => a.state === "active");
    if (!agents.length) return void vscode.window.showInformationMessage("Notes go to an agent: create an agent workspace first (Stet: New agent workspace).");
    if (agents.length === 1) return agents[0]!.id;
    const pick = await vscode.window.showQuickPick(
      agents.map((a) => ({ label: a.id, description: a.kind })),
      { title: "Note for which agent?" },
    );
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
    await this.addNote(
      p,
      file,
      ed.document,
      ed.selection.isEmpty ? new vscode.Range(ed.selection.active.line, 0, ed.selection.active.line, Number.MAX_SAFE_INTEGER) : ed.selection,
      agent,
      body,
    );
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
      announce(`$(note) ${n.id} for ${agent}: it arrives at the agent's next sync.`, 5000);
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

  async reopenNote(arg: unknown): Promise<void> {
    const t = this.noteTarget(arg);
    if (!t) return;
    const ok = await this.run(t.project, async () => {
      await t.project.stet.reopenNote(t.note.id);
      return true;
    });
    if (ok) announce(`$(note) Note ${t.note.id} is open again; the agent is told.`);
  }

  async resolveNote(arg: unknown): Promise<void> {
    const t = this.noteTarget(arg);
    if (!t) return;
    const ok = await this.run(t.project, async () => {
      await t.project.stet.resolveNote(t.note.id);
      return true;
    });
    if (ok) announce(`$(check) Note ${t.note.id} resolved.`);
  }

  /** Reply in a note's thread (from the editor). */
  async replyNote(p: Project, note: Note, text: string): Promise<void> {
    const ok = await this.run(p, async () => {
      await p.stet.replyNote(note.id, text, "user");
      return true;
    });
    if (ok) {
      this.markRead(p, note);
      announce(`$(comment) Reply on note ${note.id} sent.`);
    }
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
    this.markRead(t.project, t.note);
    const doc = await vscode.workspace.openTextDocument(t.project.fileUri(t.note.file));
    const text = toLf(doc.getText());
    const span = t.project.stet.locateNoteInText(t.note, text);
    const idx = new LineIndex(text);
    const range = span
      ? new vscode.Range(idx.position(span.start).line, idx.position(span.start).character, idx.position(span.end).line, idx.position(span.end).character)
      : new vscode.Range(0, 0, 0, 0);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true, viewColumn: this.columnFor(doc.uri) });
    ed.selection = new vscode.Selection(range.start, range.end);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!span) void vscode.window.showInformationMessage(`The passage of ${t.note.id} is no longer in ${t.note.file}.`);
  }

  async ungroup(arg: unknown): Promise<void> {
    const t = await this.target(arg);
    if (t?.node?.type !== "group") return;
    const g = t.node.group;
    const ask = dissolveQuestion(g);
    if (ask && (await vscode.window.showWarningMessage(ask, { modal: true }, "Dissolve")) !== "Dissolve") return;
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
    const ok = await this.run(hit.project, async () => {
      await hit.project.stet.comment(hit.item.id, reply.text, "user");
      return true;
    });
    if (ok) {
      this.markRead(hit.project, hit.item);
      announce(`$(comment) Reply on ${hit.item.id} sent.`);
    }
  }

  // -------------------------------------------------------------------------
  // Navigation

  async showItem(arg: unknown, preserveFocus = false): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    this.markRead(p, item);
    if (item.kind !== "modify") return this.showDiff({ project: p, node: { type: "item", item, parent: "" } } satisfies El);
    const uri = p.fileUri(item.file);
    if (!(await pathExists(uri.fsPath))) return void vscode.window.showWarningMessage(`${item.file} does not exist in your project.`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const hit = (await this.locator.locate(doc)).find((l) => l.item.id === item.id);
    const line = hit ? 0 : (await this.lineOf(p, item)) - 1;
    const range = hit?.range ?? new vscode.Range(line, 0, line, 0);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus, preview: true, viewColumn: this.columnFor(uri) });
    ed.selection = new vscode.Selection(range.start, range.end);
    this.preview.follow({ project: p, item });
    // Ready by the time the pointer reaches it.
    if (["hover", "both"].includes(previewPlace()) && item.kind === "modify") this.preview.prefetch({ project: p, item });
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!hit && isLiveItem(item)) announce(`$(warning) ${item.id}: its text is no longer where it was; showing the last known line.`, 5000);
  }

  /**
   * Where to show a file (or a diff, by its right side): the editor group that has it open
   * already (the active one first);
   * else the active group, unless that shows the PDF preview or another non-text view, which a
   * file shouldn't cover: then a group showing text, or a new one beside.
   */
  columnFor(uri: vscode.Uri): vscode.ViewColumn {
    const groups = vscode.window.tabGroups;
    const shows = (t: vscode.Tab) =>
      (t.input instanceof vscode.TabInputText ? t.input.uri : t.input instanceof vscode.TabInputTextDiff ? t.input.modified : undefined)?.toString() ===
      uri.toString();
    const has = (g: vscode.TabGroup) => g.tabs.some(shows);
    const open = has(groups.activeTabGroup) ? groups.activeTabGroup : groups.all.find(has);
    if (open) return open.viewColumn;
    const text = (g: vscode.TabGroup) =>
      !g.activeTab || g.activeTab.input instanceof vscode.TabInputText || g.activeTab.input instanceof vscode.TabInputTextDiff;
    if (text(groups.activeTabGroup)) return groups.activeTabGroup.viewColumn;
    return groups.all.find(text)?.viewColumn ?? vscode.ViewColumn.Beside;
  }

  async showDiff(arg: unknown, all?: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    this.onlyOne("Diff", t.item, arg, all);
    const { project: p, item } = t;
    // Opening a change from History is how its replies are read there: they stayed "new" for
    // good (test report 5e4c6af, B4).
    if (item.thread.length) this.markRead(p, item);
    // A pending change: the file's review with just this change, and what accepting it takes
    // along (its linked group, a move's other half) in the same file. Editable, with the same
    // actions as in the file. Decided ones, whole-file ones and changes that can't be located
    // get the plain diff.
    const text = item.kind === "modify" && isLiveItem(item) ? await this.currentText(p, item.file) : undefined;
    if (text !== undefined && (await p.stet.locateInText(item, text))) {
      const rest = this.model(p)
        .linkedRest([item.id])
        .filter((r) => r.file === item.file && r.kind === "modify");
      const ids = [item.id, ...rest.map((r) => r.id)];
      const others = this.model(p).linkedRest([item.id]).length - rest.length;
      const title = `${ids.join(" + ")} ${item.file}${inProject(p)}: yours ↔ proposed${others ? ` (${others} linked in other files)` : ""} (editable)`;
      const right = ReviewFiles.uriFor(p, item.file, ids);
      return void (await vscode.commands.executeCommand("vscode.diff", this.diffLeft(p, item.file), right, title, {
        preview: true,
        viewColumn: this.columnFor(right),
      }));
    }
    const key = projectQuery(p.mainPath);
    const mk = (side: string) => vscode.Uri.from({ scheme: "stet-diff", path: `/${item.file}`, query: `${key}&id=${item.id}&side=${side}` });
    await vscode.commands.executeCommand("vscode.diff", mk("before"), mk("after"), `${item.id} ${item.file}${inProject(p)} (current ↔ proposed)`, {
      preview: true,
      viewColumn: this.columnFor(mk("after")),
    });
  }

  /**
   * The left side of a review diff: your text as it is, read-only, so the diff marks what goes in
   * red; or, with `stet.diffShowsProposals`, your file itself (editable, with the proposals shown in it).
   */
  private diffLeft(p: Project, file: string): vscode.Uri {
    if (vscode.workspace.getConfiguration("stet").get<boolean>("diffShowsProposals", false)) return p.fileUri(file);
    return vscode.Uri.from({ scheme: "stet-diff", path: `/${file}`, query: `${projectQuery(p.mainPath)}&side=current` });
  }

  /** The file a `stet-diff:` document of your current text shows. */
  private currentOf(uri: vscode.Uri): vscode.Uri | undefined {
    const p = this.projects.get(foldPath(projectOfQuery(uri.query)));
    return p?.fileUri(uri.path.replace(/^\//, ""));
  }

  /** The user's text of a file as the editor has it (unsaved edits included), LF. */
  private async currentText(p: Project, file: string): Promise<string> {
    const uri = p.fileUri(file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? (await vscode.workspace.openTextDocument(uri));
    return toLf(doc.getText());
  }

  /** Content of `stet-diff:` documents. */
  async diffSide(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const p = this.projects.get(foldPath(projectOfQuery(uri.query)));
    if (p && q.get("side") === "current") return this.currentText(p, uri.path.replace(/^\//, ""));
    const item = p && this.model(p).item(q.get("id") ?? "");
    if (!p || !item) return "";
    const after = q.get("side") === "after";
    if (item.kind === "binary") return `(binary file ${item.file})`;
    if (item.kind !== "modify") return after ? item.newText : item.oldText;
    if (!isLiveItem(item)) {
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
    const pick = await vscode.window.showQuickPick(
      ps.map((p) => ({ label: p.name, description: p.mainPath, p })),
      { title: "Which project?" },
    );
    return pick?.p;
  }

  async setup(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length)
      return void vscode.window.showInformationMessage(`Open the folder of your ${DOCUMENT_LANGUAGES.map((p) => p.name).join(" or ")} project first.`);
    const folder =
      folders.length === 1
        ? folders[0]!
        : (
            await vscode.window.showQuickPick(
              folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })),
              { title: "Set up Stet for which folder?" },
            )
          )?.f;
    if (!folder) return;
    const dir = folder.uri.fsPath;
    // An agent's workspace is set up already, as part of its project: setting it up again made it
    // a project of its own (test report v0.16.0, B10).
    const loc = await Stet.locate(dir).catch(() => null);
    if (loc?.agentWorkspace) {
      const open = await vscode.window.showInformationMessage(
        `${folder.name} is a workspace of the project ${loc.mainPath}, not a project of its own. Review and create agents in the project's window.`,
        "Open the project",
      );
      if (open) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(loc.mainPath), { forceNewWindow: true });
      return;
    }
    try {
      const repo = new Repo(dir);
      // Git must know who commits before anything is created: else the first commit failed with
      // git's own message, and left a repository with no commit and staged files (test report v0.16.0, B1).
      let identity: { name: string; email: string } | null = null;
      if (!(await gitIdentity(dir))) {
        identity = await this.askIdentity();
        if (!identity) return;
      }
      const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), "**/{.git,node_modules}/**", 5000)).map((u) =>
        vscode.workspace.asRelativePath(u, false),
      );
      // A folder without any document file is likely the wrong one (test report v0.16.0).
      const names = DOCUMENT_LANGUAGES.map((p) => p.name).join(" or ");
      if (!files.some((f) => DOCUMENT_LANGUAGES.some((p) => matchesAny(f, p.defaultFiles ?? [])))) {
        const go = await vscode.window.showWarningMessage(
          `${folder.name} has no ${names} files.`,
          { modal: true, detail: `Stet reviews changes to a ${names} project. Set it up for this folder anyway?` },
          "Set up anyway",
        );
        if (go !== "Set up anyway") return;
      }
      const isRepo = (await repo.tryRun(["rev-parse", "--is-inside-work-tree"])) === "true";
      if (!isRepo || !(await repo.revParse("HEAD"))) {
        // One question for a new repository and its first commit (it was two in a row), with the
        // build files left out if you like: they went into that commit (test report v0.16.0).
        const ignores = files.includes(".gitignore") ? [] : buildIgnores(files);
        const commit = "Commit files";
        const ignoring = "Commit, ignoring build files";
        const ok = await vscode.window.showWarningMessage(
          isRepo ? "The repository has no commits yet." : `${folder.name} is not a git repository yet.`,
          {
            modal: true,
            detail:
              (isRepo
                ? "Stet reviews changes against your last commit. Commit the current files now?"
                : "Stet uses git to keep the agents' proposals apart from your files. Create a repository here and commit the current files as a starting point?") +
              (ignores.length
                ? `\n\n“${ignoring}” first writes a .gitignore for the build files (${ignores.slice(0, 4).join(", ")}${ignores.length > 4 ? ", …" : ""}), so it isn't committed.`
                : ""),
          },
          ...(ignores.length ? [ignoring, commit] : [commit]),
        );
        if (!ok) return;
        if (!isRepo) await repo.run(["init"]);
        if (identity) await this.setIdentity(repo, identity);
        if (ok === ignoring) await writeFile(join(dir, ".gitignore"), `# Build files (written by Stet's setup)\n${ignores.join("\n")}\n`, { flag: "wx" });
        await repo.run(["add", "-A"]);
        try {
          await repo.run(["commit", "-m", "Initial commit"]);
        } catch (e) {
          await repo.tryRun(["reset", "-q"]); // nothing left staged
          throw e;
        }
      } else if (identity) await this.setIdentity(repo, identity);
      const loc = await Stet.locate(dir);
      const current = await Stet.open(dir, loc)
        .then((st) => st.config())
        .then((c) => c.cli)
        .catch(() => undefined); // first setup
      const bundled = await this.bundledCli(current, join(loc.commonDir, "stet"));
      const opts: Parameters<typeof Stet.init>[1] = bundled ? { cli: bundled.cli } : {};
      const { setUp: already, languages: counts } = await Stet.inspectSetup(dir, loc);
      // Files of both languages: asked, not guessed (a Typst thesis with one old .tex file was
      // set up as LaTeX without a word: test report 5e4c6af).
      if (!already) {
        if (counts.length > 1) {
          const name = (id: string) => DOCUMENT_LANGUAGES.find((l) => l.id === id)?.name ?? id;
          const pick = await vscode.window.showQuickPick(
            counts.map(([id, n], k) => ({ label: name(id), description: `${n} file${n === 1 ? "" : "s"}${k === 0 ? " (most)" : ""}`, id })),
            {
              title: `${folder.name} has ${counts.map(([id, n]) => `${n} ${name(id)}`).join(" and ")} files: which language is the project written in?`,
              placeHolder: "Agents' instructions and examples follow it",
            },
          );
          if (!pick) return;
          opts.language = pick.id;
        }
      }
      const stet = await Stet.init(dir, opts);
      await this.discover();
      // Agents start from the last commit: edits not committed yet are not theirs to see (as `stet init` says).
      const dirty = await stet.uncommittedEdits();
      const edits = dirty ? " You have uncommitted edits: agents start from your last commit, so commit them first, or use Share my edits." : "";
      const hasAgents = (await stet.listAgents()).some((a) => a.state === "active");
      // A second run refreshes the setup; it says so, instead of the first-time message (test report v0.16.0).
      // Which language was detected: agents' instructions follow it (test report 5e4c6af, UX).
      const lang = ` It is a ${documentProfile(await stet.config()).name} project for Stet (setting "language" in .git/stet/config.json).`;
      if (already) return void vscode.window.showInformationMessage(`Stet was already set up for ${folder.name}; its setup is refreshed.${lang}${edits}`);
      const next = await vscode.window.showInformationMessage(
        `Stet is set up for ${folder.name}.${lang}${edits} Next, create a workspace for an AI agent.`,
        ...(hasAgents ? [] : ["New agent workspace"]),
      );
      if (next) await this.newAgent();
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Stet setup failed: ${e?.message ?? e}`);
    }
  }

  private async setIdentity(repo: Repo, id: { name: string; email: string }): Promise<void> {
    await repo.run(["config", "user.name", id.name]);
    await repo.run(["config", "user.email", id.email]);
  }

  /** Name and email for git's commits in this repository, asked when git has none; null if cancelled. */
  private async askIdentity(): Promise<{ name: string; email: string } | null> {
    const why = "Git records who made each commit, and has no name for you yet. It is saved for this project only.";
    const name = await vscode.window.showInputBox({
      title: "Your name for commits (1/2)",
      prompt: why,
      placeHolder: "e.g. Ada Lovelace",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter a name."),
    });
    if (!name) return null;
    const email = await vscode.window.showInputBox({
      title: "Your email for commits (2/2)",
      prompt: why,
      placeHolder: "e.g. ada@example.org",
      ignoreFocusOut: true,
      validateInput: (v) => (/^\S+@\S+$/.test(v.trim()) ? undefined : "Enter an email address."),
    });
    if (!email) return null;
    return { name: name.trim(), email: email.trim() };
  }

  async newAgent(): Promise<void> {
    const p = await this.pickProject();
    if (!p && this.agentOf) {
      const open = await vscode.window.showInformationMessage(
        "This window is an agent's workspace: create agents in the window of your project.",
        "Open the project",
      );
      return void (open && (await this.openAgentProject()));
    }
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
      validateInput: (v) => (!AGENT_ID.test(v) ? "Use letters, digits, '.', '_' or '-'." : existing.includes(v) ? `'${v}' already exists.` : undefined),
    });
    if (!id) return;
    const agent = await this.run(p, async () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating workspace ${id}…` }, () =>
        p.stet.newAgent(id, { kind: k.agentKind }),
      ),
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
      announce(`$(copy) Copied ${agent.worktree}`, 4000);
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
      // With several projects, the same agent name can be in both: say whose (test report v0.16.0).
      all.map((x) => ({
        label: x.agent.id,
        description: this.allProjects().length > 1 ? `${x.project.name} · ${x.agent.kind}` : x.agent.kind,
        detail: x.agent.worktree,
        x,
      })),
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
    qp.placeholder = "Untick every kind of news to turn notifications off. The megaphone above wakes the agent at once.";
    qp.canSelectMany = true;
    const notifyNow: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("megaphone"), tooltip: "Notify now…: wake the agent at once" };
    qp.buttons = [notifyNow];
    qp.onDidTriggerButton((b) => {
      if (b !== notifyNow) return;
      qp.hide();
      void this.agentPing({ project: a.project, node: { type: "agent", agent: a.agent } } as El);
    });
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
    const ok = await this.run(a.project, async () => {
      await a.project.stet.pingAgent(a.agent.id, message);
      return true;
    });
    if (ok) announce(`$(megaphone) Asked ${a.agent.id} to check in`, 4000);
  }

  /** Undo a decision from the History: the change is pending again (an accept is taken out of your file). */
  async undo(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    if (item.status === "accepted") await this.saveFiles(p, [item.file, ...(item.oldFile ? [item.oldFile] : [])]);
    const r = await this.run(p, () => p.stet.undo(item.id));
    if (r) {
      const what = item.status === "accepted" ? "accept" : item.status === "needs_revision" ? "revision request" : "rejection";
      announce(
        `$(discard) Undid the ${what} of ${r.reopened.map((i) => i.id).join(", ")}` +
          (r.restored.length ? `; ${r.restored.map((i) => i.id).join(", ")} pending again too` : ""),
        5000,
      );
    }
  }

  /** Set one of Stet's settings from the panel's View options (where it is set already, or for the user). */
  async setOption(key: string, value: unknown): Promise<void> {
    if (key === "shareEdits") return this.setShareOption(value);
    const conf = vscode.workspace.getConfiguration("stet");
    const i = conf.inspect(key);
    const target =
      i?.workspaceValue !== undefined || (key === "shareEdits" && vscode.workspace.workspaceFolders?.length)
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await conf.update(key, value, target);
  }

  /**
   * Share my edits, set from View options: for one project, which is asked for when the window has
   * several; set on its workspace folder, so another paper's agents don't see this one's drafts
   * (test report v0.16.0, B8). The project's own config follows (`applyShareMode`).
   */
  private async setShareOption(value: unknown): Promise<void> {
    const p = await this.pickProject();
    if (!p) return;
    const uri = vscode.Uri.file(p.mainPath);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const conf = vscode.workspace.getConfiguration("stet", uri);
    const target =
      folders.length > 1 && folder
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : folders.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await conf.update("shareEdits", value, target);
    if (folders.length > 1) announce(`$(check) Share my edits: ${String(value)}, for ${p.name} only`, 4000);
  }

  async archiveAgent(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    const pending = a.project.snapshot.items.filter((i) => i.agent === a.agent.id && isLiveItem(i)).length;
    const unsubmitted = await a.project.stet.unsubmittedFiles(a.agent).catch(() => [] as string[]);
    // Keeping the folder comes first, so Enter never deletes anything (test report D5).
    const { del, order } = archiveChoices(unsubmitted.length);
    const ok = await vscode.window.showWarningMessage(
      `Archive agent ${a.agent.id}?`,
      {
        modal: true,
        detail:
          (pending
            ? `Its ${pending} pending change${pending === 1 ? " is" : "s are"} withdrawn: closed without being applied (History keeps ${pending === 1 ? "it" : "them"}). `
            : "") +
          (unsubmitted.length ? `It changed files it did not submit: ${unsubmitted.slice(0, 5).join(", ")}${unsubmitted.length > 5 ? ", …" : ""}. ` : "") +
          `Deleting the folder also deletes the branch ${a.agent.branch} and anything the agent did not submit, for good. Close the agent's session first.`,
      },
      ...order,
    );
    if (!ok) return;
    const r = await this.run(a.project, () => a.project.stet.archiveAgent(a.agent.id, { removeWorktree: ok === del, discardUnsubmitted: ok === del }));
    if (r) {
      void vscode.window.showInformationMessage(
        `Archived ${a.agent.id}.` +
          (r.withdrawn.length
            ? ` Withdrew ${r.withdrawn.length} pending change${r.withdrawn.length === 1 ? "" : "s"} (${r.withdrawn.join(", ")}).`
            : " It had no pending changes.") +
          (r.worktreeRemoved ? " Its folder and branch are deleted." : ` Its folder is kept: ${a.agent.worktree}.`) +
          " If its session is still open, the agent is told on its next action; you can close that session.",
      );
    }
  }

  async finishReview(): Promise<void> {
    // Only projects with something to commit: asking "Which project?" for one was a needless step (test report v0.16.0).
    const ps = this.allProjects().filter((x) => x.snapshot.uncommitted.length);
    if (!ps.length) return void vscode.window.showInformationMessage("Nothing to commit: all accepted changes are committed.");
    const p =
      ps.length === 1
        ? ps[0]!
        : (
            await vscode.window.showQuickPick(
              ps.map((x) => ({ label: x.name, description: `${x.snapshot.uncommitted.length} accepted, not committed`, detail: x.mainPath, x })),
              { title: "Finish the review of which project?" },
            )
          )?.x;
    if (!p) return;
    const items = p.snapshot.uncommitted;
    const files = [...new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]))];
    const preview = await this.run(p, () => p.stet.commitPreview());
    if (!preview) return;
    // What the commit takes, said before it happens: your own edits in these files, and that undo
    // ends here. Unsaved text is not committed unless you choose to save it (test report v0.16.0, D6).
    const unsaved = Object.keys(this.unsavedTexts(p, files));
    const q = finishQuestion(preview.items.length, files, preview.yourEdits, unsaved, this.inWhich(p).replace(/^ in /, ""));
    const ok = await vscode.window.showWarningMessage(q.message, { modal: true, detail: q.detail }, ...q.buttons);
    if (!ok) return;
    const { subject } = await p.stet.commitMessage(items);
    const edited = await vscode.window.showInputBox({
      title: "Commit message",
      value: subject,
      prompt: "Summary line. Stet adds the list of accepted changes below it.",
      validateInput: (v) => (v.trim() ? undefined : "Enter a summary line."),
    });
    if (edited === undefined) return;
    await this.run(p, async () => {
      if (ok === FINISH_SAVE) await this.saveFiles(p, files);
      const r = await p.stet.commitAcceptedItems({ subject: edited });
      if (r.commit) this.forgetAccepts(p);
      announce(r.commit ? `$(git-commit) Committed ${r.items.map((i) => i.id).join(", ")}` : "Nothing to commit", 5000);
    });
  }

  /** *Share my edits*: save the project's open files and let agents see them at their next sync. */
  async shareEdits(): Promise<void> {
    const p = await this.pickProject();
    if (!p) return;
    await this.run(p, async () => {
      for (const d of vscode.workspace.textDocuments) if (d.isDirty && p.relPath(d.uri)) await d.save();
      const changed = await p.stet.shareEdits();
      announce(
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

  /** Whether proposed text is green in word-wrapped editors too (Stet's colours are set). */
  highlighted(): boolean {
    const cc = this.colorCustomizations();
    return Object.entries(HIGHLIGHT).every(([k, v]) => cc[k] === v);
  }

  async updateHighlightContext(): Promise<void> {
    await vscode.commands.executeCommand("setContext", "stet.highlighted", this.highlighted());
  }

  /** View options: green proposed text in word-wrapped editors, or back to the theme's colours. */
  async setHighlight(on: boolean): Promise<void> {
    const cc = this.colorCustomizations();
    if (on) {
      // Keep the user's own values for these keys, to restore them when switched off.
      const previous = Object.fromEntries(
        Object.keys(HIGHLIGHT)
          .filter((k) => k in cc && cc[k] !== HIGHLIGHT[k])
          .map((k) => [k, cc[k]]),
      );
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
          "This colours parameter-name hints in your user settings; other extensions' parameter hints turn green as well. Untick it in View options to undo.",
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
  {
    mode: "off",
    label: "Off",
    detail: "Not woken: the agent hears about your decisions when it next checks. Switching back on delivers what arrived meanwhile.",
  },
];

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

/** Returned by `activate`, for the integration test (VS Code's commands don't resolve inlay hints). */
export interface TestApi {
  editor: EditorIntegration;
}

/** "Which one?" was cancelled: nothing to act on, not "no change here". */

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
  reg("stet.setup", () => ext.setup());
  reg("stet.newAgent", () => ext.newAgent());
  reg("stet.openAgent", (a) => ext.openAgent(a));
  reg("stet.copyAgentPath", (a) => ext.copyAgentPath(a));
  reg("stet.archiveAgent", (a) => ext.archiveAgent(a));
  reg("stet.agentNotify", (a) => ext.agentNotify(a));
  reg("stet.agentNotifyOff", (a) => ext.agentNotify(a));
  reg("stet.agentPing", (a) => ext.agentPing(a));
  reg(
    "stet.undo",
    inOrder((a) => ext.undo(a)),
  );
  reg("stet.preview", (a) => ext.showPreview(a));
  reg("stet.openAgentProject", () => ext.openAgentProject());
  reg(
    "stet.undoLast",
    inOrder(() => ext.undoLast()),
  );
  reg("stet.filter", (f?: PanelFilter | null) => (f !== undefined ? ext.setFilter(f) : ext.pickFilter()));
  reg("stet.clearFilter", () => ext.setFilter(null));
  reg("stet.reviewFile", (a) => ext.reviewFile(a));
  reg(
    "stet.reviewAccept",
    inOrder((u, a) => ext.reviewAccept(u, a)),
  );
  // Not in order itself: the command it runs is (it would wait for itself).
  reg("stet.reviewRun", (u, c, a) => ext.reviewRun(u, c, a));
  reg("stet.editSave", (u) => ext.editSave(u));
  reg("stet.editReset", (u) => ext.editReset(u));
  reg("stet.editAccept", (u) => ext.editAccept(u));
  ext.hoverFor = (p, item, route) => editor.hoverMarkdown(p, item, route);
  reg("stet.clearDraft", (a) => ext.clearDraft(a));
  reg("stet.previewSetup", () => ext.setupPreview());
  // View options: settings you may switch back and forth, from the panel.
  const toggle = (key: string) => () => ext.setOption(key, !vscode.workspace.getConfiguration("stet").get<boolean>(key, true));
  const toggleOff = (key: string) => () => ext.setOption(key, !vscode.workspace.getConfiguration("stet").get<boolean>(key, false));
  reg("stet.toggleDiffProposals", toggleOff("diffShowsProposals"));
  reg("stet.toggleInlineChanges", toggle("inlineChanges"));
  reg("stet.toggleCodeLens", toggle("codeLens"));
  reg("stet.toggleAutoAdvance", toggle("autoAdvance"));
  for (const v of ["expanded", "collapsed", "hover"]) reg(`stet.longChanges.${v}`, () => ext.setOption("longChanges", v));
  for (const v of ["manual", "saved", "committed"]) reg(`stet.shareEdits.${v}`, () => ext.setOption("shareEdits", v));
  for (const v of ["both", "hover", "panel", "off"]) reg(`stet.pdfPreviews.${v}`, () => ext.setOption("pdfPreviews", v));
  for (const v of ["auto", "highlighted", "wrapping"]) reg(`stet.newTextStyle.${v}`, () => ext.setOption("newTextStyle", v));
  reg("stet.refresh", () => ext.refresh());
  reg("stet.doctor", () => ext.doctor());
  reg("stet.finishReview", () => ext.finishReview());
  reg("stet.shareEdits", () => ext.shareEdits());
  reg("stet.toggleHighlight", () => ext.setHighlight(!ext.highlighted()));
  reg("stet.highlightOn", () => ext.setHighlight(true));
  reg("stet.highlightOff", () => ext.setHighlight(false));
  reg(
    "stet.accept",
    inOrder((a, all) => ext.accept(a, all)),
  );
  reg(
    "stet.acceptOnly",
    inOrder((a) => ext.acceptOnly(a)),
  );
  reg("stet.changeActions", (a) => ext.changeActions(a));
  reg(
    "stet.reject",
    inOrder((a, all) => ext.reject(a, all)),
  );
  reg(
    "stet.edit",
    inOrder((a, all) => ext.edit(a, all)),
  );
  reg("stet.comment", (a, all) => ext.comment(a, all));
  reg(
    "stet.revise",
    inOrder((a, all) => ext.revise(a, all)),
  );
  reg(
    "stet.acceptGroup",
    inOrder((a) => ext.acceptAll(a)),
  );
  reg(
    "stet.rejectGroup",
    inOrder((a) => ext.rejectAll(a)),
  );
  reg("stet.ungroup", (a) => ext.ungroup(a));
  reg("stet.showItem", (a, keepFocus) => ext.showItem(a, keepFocus === true));
  reg("stet.showDiff", (a, all) => ext.showDiff(a, all));
  reg(
    "stet.next",
    inOrder(() => ext.step(1)),
  );
  reg(
    "stet.previous",
    inOrder(() => ext.step(-1)),
  );
  reg("stet.replyThread", (r: vscode.CommentReply) => ext.replyThread(r, threads));
  reg("stet.noteForAgent", () => ext.noteForAgent());
  reg("stet.resolveNote", (a) => ext.resolveNote(a));
  reg("stet.reopenNote", (a) => ext.reopenNote(a));
  reg("stet.showNote", (a) => ext.showNote(a));
  await ext.updateHighlightContext();
  await ext.discover();
  return { editor };
}

export function deactivate(): void {}
