/**
 * The editor for one change's wording (Edit & accept… on a longer change): a document of its own,
 * `stet-edit:/<change>/<file name>?p=<project>`, holding your wording if you have one, else the
 * agent's. Saving (Ctrl+S) keeps it as your wording; the change stays pending. Above the text,
 * and in the editor's title bar: Accept (with this wording), Agent's wording, More….
 */
import { basename } from "node:path";
import { foldPath, type Item, isLiveItem } from "@stet/core";
import * as vscode from "vscode";
import { acceptAction, type ChangeAction, withIcon } from "./actions.js";
import { announce } from "./announce.js";
import { projectOfQuery, projectQuery, type Ref } from "./model.js";
import type { Project } from "./project.js";
import { type ReviewHost, viaReview } from "./review.js";

export const EDIT_SCHEME = "stet-edit";

export class EditFiles implements vscode.FileSystemProvider, vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly mtimes = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly host: ReviewHost) {
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(EDIT_SCHEME, this, { isCaseSensitive: true }),
      vscode.languages.registerCodeLensProvider({ scheme: EDIT_SCHEME }, this),
      this.changed,
      this.lensChanged,
    );
  }

  /** The editor document for a change's wording (its file's name, so it gets the file's language). */
  static uriFor(p: Project, item: Item): vscode.Uri {
    return vscode.Uri.from({ scheme: EDIT_SCHEME, path: `/${item.id}/${basename(item.file)}`, query: projectQuery(p.mainPath) });
  }

  /** The project and change of an edit document. */
  target(uri: vscode.Uri): { project: Project; id: string; item: Item | undefined } {
    const project = this.host.project(foldPath(projectOfQuery(uri.query)));
    const id = uri.path.split("/")[1] ?? "";
    if (!project) throw vscode.FileSystemError.FileNotFound(uri);
    return { project, id, item: this.host.model(project).item(id) };
  }

  // --- FileSystemProvider -------------------------------------------------

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    // Fixed until it's saved: VS Code refuses to save a file that looks newer than the one it read.
    const key = uri.toString();
    if (!this.mtimes.has(key)) this.mtimes.set(key, Date.now());
    return { type: vscode.FileType.File, ctime: 0, mtime: this.mtimes.get(key)!, size: 0 };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { project, id } = this.target(uri);
    const item = await project.stet.getItem(id);
    if (!item) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(item.draft ?? item.newText, "utf8");
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const { project, id } = this.target(uri);
    try {
      const changed = await project.stet.setDraft(id, Buffer.from(content).toString("utf8"));
      if (changed) announce(`$(edit) Your wording for ${id} is saved; still pending: accept when ready`, 6000);
    } catch (e: any) {
      // VS Code shows this with the failed save; the edits stay in the editor.
      throw vscode.FileSystemError.NoPermissions(e?.message ?? String(e));
    }
    this.mtimes.set(uri.toString(), Date.now());
    await project.refresh();
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

  /** The project changed: decided changes' editors close (unless they hold unsaved text); the rest update. */
  async refresh(): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText) || tab.input.uri.scheme !== EDIT_SCHEME || tab.isDirty) continue;
        let item: Item | undefined;
        try {
          item = this.target(tab.input.uri).item;
        } catch {
          continue;
        }
        if (item && !isLiveItem(item)) await vscode.window.tabGroups.close(tab).then(undefined, () => undefined);
      }
    }
    this.lensChanged.fire();
  }

  // --- Above the text: the decisions ---------------------------------------

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    let t: ReturnType<EditFiles["target"]>;
    try {
      t = this.target(doc.uri);
    } catch {
      return [];
    }
    const at = new vscode.Range(0, 0, 0, 0);
    const { project: p, id, item } = t;
    if (!item || !isLiveItem(item))
      return [new vscode.CodeLens(at, { title: `${id} is ${item?.status ?? "gone"}: there is no wording to change`, command: "" })];
    const route = viaReview(doc.uri);
    const ref: Ref = { path: p.mainPath, id };
    const lens = (a: ChangeAction, title = withIcon(a)) =>
      new vscode.CodeLens(at, { title, tooltip: a.detail, command: "stet.reviewRun", arguments: route(a).args });
    const accept = acceptAction(this.host.model(p), p.mainPath, item);
    return [
      lens(accept, `${id}: ${withIcon(accept)} with this wording`),
      new vscode.CodeLens(at, {
        title: "$(save) Save wording",
        tooltip: "Keep this wording for the change; it stays pending (Ctrl+S)",
        command: "stet.editSave",
        arguments: [doc.uri.toString()],
      }),
      new vscode.CodeLens(at, {
        title: "$(discard) Agent's wording",
        tooltip: "Back to the agent's text",
        command: "stet.editReset",
        arguments: [doc.uri.toString()],
      }),
      lens({ label: "More…", icon: "ellipsis", command: "stet.changeActions", args: [ref], tier: "other", detail: "Every action on this change" }),
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
