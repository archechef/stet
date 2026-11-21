/**
 * Review documents, the diffs of Review file and of Diff: the user's file against the same file
 * with its pending changes applied (Review file: all of them; Diff: one change, with what
 * accepting it takes along). The right side is editable: saving it turns the edits into the
 * user's wording for those changes (drafts), which stay pending until the user accepts each one,
 * here or anywhere else. Saving never accepts anything, and never writes the user's file.
 *
 * Each change has the same actions here as in the file (the row above it, its hover, Ctrl+.);
 * they save the review's unsaved edits first, so a decision uses the wording the user sees.
 */

import { foldPath, type Item, type ReviewDocument } from "@stet/core";
import * as vscode from "vscode";
import { acceptAction, type ChangeAction, changeActions, withIcon } from "./actions.js";
import { announce } from "./announce.js";
import { warn } from "./log.js";
import { projectOfQuery, projectQuery, type Ref, type TreeModel } from "./model.js";
import type { Project } from "./project.js";
import { positionIn, toLf } from "./text.js";

export const REVIEW_SCHEME = "stet-review";

type Cached = { project: Project; file: string; doc: ReviewDocument & { items: Item[] }; content: string };

/** What review documents need from the extension. */
export interface ReviewHost {
  project(key: string): Project | undefined;
  model(p: Project): TreeModel;
  previews(): boolean;
  /** A change's hover (as in the file), with its actions sent through `route`. */
  hover(p: Project, item: Item, route: (a: ChangeAction) => ChangeAction): vscode.MarkdownString | undefined;
}

/** An action run from a review document: its unsaved edits are saved first (`stet.reviewRun`). */
export const viaReview =
  (doc: vscode.Uri) =>
  (a: ChangeAction): ChangeAction => ({ ...a, command: "stet.reviewRun", args: [doc.toString(), a.command, a.args] });

export class ReviewFiles implements vscode.FileSystemProvider, vscode.CodeLensProvider, vscode.HoverProvider, vscode.CodeActionProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly cache = new Map<string, Cached>();
  private readonly mtimes = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly host: ReviewHost) {
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(REVIEW_SCHEME, this, { isCaseSensitive: true }),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this),
      vscode.languages.registerHoverProvider({ scheme: REVIEW_SCHEME }, this),
      vscode.languages.registerCodeActionsProvider({ scheme: REVIEW_SCHEME }, this, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
      this.changed,
      this.lensChanged,
    );
  }

  /** The review document's URI for a file of a project; `ids`: only these changes (else all pending ones). */
  static uriFor(p: Project, file: string, ids?: string[]): vscode.Uri {
    return vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${file}`, query: `${projectQuery(p.mainPath)}${ids ? `&ids=${ids.join(",")}` : ""}` });
  }

  private target(uri: vscode.Uri): { project: Project; file: string; ids?: string[] } {
    const q = new URLSearchParams(uri.query);
    const project = this.host.project(foldPath(projectOfQuery(uri.query)));
    const file = uri.path.replace(/^\//, "");
    if (!project) throw vscode.FileSystemError.FileNotFound(uri);
    const ids = q.get("ids");
    return { project, file, ...(ids ? { ids: ids.split(",") } : {}) };
  }

  /** The user's current text of the file (the editor's, with unsaved edits), LF, and its line endings. */
  private async current(p: Project, file: string): Promise<{ text: string; crlf: boolean }> {
    const real = p.fileUri(file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === real.toString()) ?? (await vscode.workspace.openTextDocument(real));
    const raw = doc.getText();
    return { text: toLf(raw), crlf: doc.eol === vscode.EndOfLine.CRLF };
  }

  private async build(uri: vscode.Uri): Promise<Cached & { crlf: boolean }> {
    const { project, file, ids } = this.target(uri);
    const { text, crlf } = await this.current(project, file);
    const doc = await project.stet.reviewOf(file, text, ids);
    const c = { project, file, doc, content: doc.content };
    this.cache.set(uri.toString(), c);
    return { ...c, crlf };
  }

  // --- FileSystemProvider -------------------------------------------------

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    // Fixed until the content changes: VS Code refuses to save a file that looks newer than
    // the one it read.
    const key = uri.toString();
    if (!this.mtimes.has(key)) this.mtimes.set(key, Date.now());
    const mtime = this.mtimes.get(key)!;
    return { type: vscode.FileType.File, ctime: 0, mtime, size: this.cache.get(uri.toString())?.content.length ?? 0 };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const c = await this.build(uri);
    this.lensChanged.fire();
    return Buffer.from(c.crlf ? c.content.replace(/\n/g, "\r\n") : c.content, "utf8");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const c = this.cache.get(uri.toString()) ?? (await this.build(uri));
    const r = await c.project.stet.saveReview(c.doc, Buffer.from(content).toString("utf8"));
    // VS Code shows this with the failed save; the user's edits stay in the editor.
    if ("error" in r) throw vscode.FileSystemError.NoPermissions(r.error);
    this.mtimes.set(uri.toString(), Date.now());
    if (r.changed.length) {
      announce(`$(edit) Your wording for ${r.changed.join(", ")} is saved; still pending: accept when ready`, 6000);
    }
    await c.project.refresh();
    await this.build(uri);
    this.lensChanged.fire();
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }
  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  /** The project changed (a decision, a new proposal): reload open review documents whose text changed. */
  async refresh(): Promise<void> {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme !== REVIEW_SCHEME || doc.isDirty) continue;
      const before = this.cache.get(doc.uri.toString())?.content;
      let after: string;
      try {
        after = (await this.build(doc.uri)).content;
      } catch (e) {
        warn(`Updating ${doc.uri.path}`, e);
        continue;
      }
      if (after !== before) {
        this.mtimes.set(doc.uri.toString(), Date.now());
        this.changed.fire([{ type: vscode.FileChangeType.Changed, uri: doc.uri }]);
      }
    }
    this.lensChanged.fire();
  }

  // --- CodeLens: decide each change right in the review ---------------------

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const c = this.cache.get(doc.uri.toString());
    if (!c) return [];
    const lenses: vscode.CodeLens[] = [];
    const lf = c.content;
    if (c.doc.skipped.length) {
      lenses.push(
        new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
          title: `Not shown here: ${c.doc.skipped.join(", ")} (they overlap other changes, or can't be located): review them in the Stet panel`,
          command: "",
        }),
      );
    }
    const model = this.host.model(c.project);
    const route = viaReview(doc.uri);
    const lens = (at: vscode.Range, a: ChangeAction, title = withIcon(a)) =>
      new vscode.CodeLens(at, { title, tooltip: a.detail, command: "stet.reviewRun", arguments: route(a).args });
    for (const r of c.doc.regions) {
      const item = c.doc.items.find((i) => i.id === r.id);
      if (!item) continue;
      const p = positionIn({ line: 0, character: 0 }, lf, r.start);
      const at = new vscode.Range(p.line, p.character, p.line, p.character);
      const ref: Ref = { path: c.project.mainPath, id: item.id };
      // As in the file (Accept as the change must be decided, Reject…, More…), plus the way back
      // to the agent's wording once you have your own.
      const accept = acceptAction(model, c.project.mainPath, item);
      const yours = item.draft !== undefined;
      const tag = item.status === "needs_revision" ? " (revision requested)" : "";
      lenses.push(
        lens(at, accept, `${item.id}${tag}: ${withIcon(accept)}${yours ? " (your wording)" : ""}`),
        lens(at, {
          label: item.move ? "Reject move…" : "Reject…",
          icon: "close",
          command: "stet.reject",
          args: [ref],
          tier: "decide",
          detail: `Reject ${item.id}, with an optional reason for the agent`,
        }),
        ...(yours ? [lens(at, { label: "Use agent's wording", icon: "discard", command: "stet.clearDraft", args: [ref], tier: "decide" })] : []),
        lens(at, {
          label: "More…",
          icon: "ellipsis",
          command: "stet.changeActions",
          args: [ref],
          tier: "other",
          detail: "Every action on this change (also Ctrl+. in the change)",
        }),
      );
    }
    return lenses;
  }

  /** The changes at `pos` in a review document: over one, or on the line of an empty one (a deletion). */
  private changesAt(doc: vscode.TextDocument, pos: vscode.Position): { c: Cached; item: Item; range: vscode.Range }[] {
    const c = this.cache.get(doc.uri.toString());
    if (!c) return [];
    const out: { c: Cached; item: Item; range: vscode.Range }[] = [];
    for (const r of c.doc.regions) {
      const item = c.doc.items.find((i) => i.id === r.id);
      if (!item) continue;
      const a = positionIn({ line: 0, character: 0 }, c.content, r.start);
      const b = positionIn({ line: 0, character: 0 }, c.content, r.end);
      const range = new vscode.Range(a.line, a.character, b.line, b.character);
      if (range.contains(pos) || (range.isEmpty && range.start.line === pos.line))
        out.push({ c, item, range: range.isEmpty ? doc.lineAt(pos.line).range : range });
    }
    return out;
  }

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const hits = this.changesAt(doc, pos);
    const md = hits.flatMap(({ c, item }) => this.host.hover(c.project, item, viaReview(doc.uri)) ?? []);
    return md.length
      ? new vscode.Hover(
          md,
          hits.map((h) => h.range).reduce((x, y) => x.union(y)),
        )
      : undefined;
  }

  provideCodeActions(doc: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
    return this.changesAt(doc, range.start).flatMap(({ c, item }) =>
      changeActions(this.host.model(c.project), c.project.mainPath, item, { previews: this.host.previews() })
        .map(viaReview(doc.uri))
        .map((a) => {
          const ca = new vscode.CodeAction(`Stet ${item.id}: ${a.label}`, vscode.CodeActionKind.QuickFix);
          ca.command = { title: a.label, command: a.command, arguments: a.args };
          return ca;
        }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
