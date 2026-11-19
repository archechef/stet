/**
 * "Review all changes in this file": a diff of the user's file against the same file with every
 * pending change applied. The right side is editable: saving it turns the edits into the user's
 * wording for those changes (drafts), which stay pending until the user accepts each one, here
 * (✓ Accept above each change) or anywhere else. Saving never accepts anything, and never writes
 * the user's file.
 */
import * as vscode from "vscode";
import { foldPath, type Item, type ReviewDocument } from "@stet/core";
import { positionIn, toLf } from "./model.js";
import type { Project } from "./project.js";

export const REVIEW_SCHEME = "stet-review";

type Cached = { project: Project; file: string; doc: ReviewDocument & { items: Item[] }; content: string };

export class ReviewFiles implements vscode.FileSystemProvider, vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly cache = new Map<string, Cached>();
  private readonly mtimes = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly projectByKey: (key: string) => Project | undefined) {
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(REVIEW_SCHEME, this, { isCaseSensitive: true }),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this),
      this.changed,
      this.lensChanged,
    );
  }

  /** The review document's URI for a file of a project. */
  static uriFor(p: Project, file: string): vscode.Uri {
    return vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${file}`, query: `p=${encodeURIComponent(p.mainPath)}` });
  }

  private target(uri: vscode.Uri): { project: Project; file: string } {
    const key = decodeURIComponent(new URLSearchParams(uri.query).get("p") ?? "");
    const project = this.projectByKey(foldPath(key));
    const file = uri.path.replace(/^\//, "");
    if (!project) throw vscode.FileSystemError.FileNotFound(uri);
    return { project, file };
  }

  /** The user's current text of the file (the editor's, with unsaved edits), LF, and its line endings. */
  private async current(p: Project, file: string): Promise<{ text: string; crlf: boolean }> {
    const real = p.fileUri(file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === real.toString()) ?? (await vscode.workspace.openTextDocument(real));
    const raw = doc.getText();
    return { text: toLf(raw), crlf: doc.eol === vscode.EndOfLine.CRLF };
  }

  private async build(uri: vscode.Uri): Promise<Cached & { crlf: boolean }> {
    const { project, file } = this.target(uri);
    const { text, crlf } = await this.current(project, file);
    const doc = await project.stet.reviewOf(file, text);
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
      vscode.window.setStatusBarMessage(`$(edit) Your wording for ${r.changed.join(", ")} is saved; still pending: accept when ready`, 6000);
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
      } catch {
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
    for (const r of c.doc.regions) {
      const item = c.doc.items.find((i) => i.id === r.id);
      if (!item) continue;
      const p = positionIn({ line: 0, character: 0 }, lf, r.start);
      const at = new vscode.Range(p.line, p.character, p.line, p.character);
      const ref = { path: c.project.mainPath, id: item.id };
      const yours = item.draft !== undefined;
      lenses.push(
        new vscode.CodeLens(at, { title: `${item.id}: ✓ Accept${yours ? " your wording" : ""}`, command: "stet.reviewAccept", arguments: [doc.uri, ref] }),
        new vscode.CodeLens(at, { title: "✗ Reject", command: "stet.reject", arguments: [ref] }),
        ...(yours ? [new vscode.CodeLens(at, { title: "↺ Agent's wording", command: "stet.clearDraft", arguments: [ref] })] : []),
      );
    }
    return lenses;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
