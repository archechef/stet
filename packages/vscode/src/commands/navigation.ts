/** Showing a change: in its file, and as a plain diff (`stet-diff:` documents). */
import { foldPath, isLiveItem, pathExists } from "@stet/core";
import * as vscode from "vscode";
import { announce } from "../announce.js";
import { inProject } from "../comments.js";
import type { El } from "../common.js";
import type { StetExtension } from "../extension.js";
import { projectOfQuery, projectQuery } from "../model.js";
import { previewPlace } from "../preview.js";
import type { Project } from "../project.js";
import { ReviewFiles } from "../review.js";
import { setting } from "../settings.js";
import { toLf } from "../text.js";

/** The URI scheme of the plain diffs' read-only documents. */
export const DIFF_SCHEME = "stet-diff";

export class Navigation {
  constructor(private readonly ext: StetExtension) {}

  async showItem(arg: unknown, preserveFocus = false): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    this.ext.replies.markRead(p, item);
    if (item.kind !== "modify") return this.showDiff({ project: p, node: { type: "item", item, parent: "" } } satisfies El);
    const uri = p.fileUri(item.file);
    if (!(await pathExists(uri.fsPath))) return void vscode.window.showWarningMessage(`${item.file} does not exist in your project.`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const hit = (await this.ext.locator.locate(doc)).find((l) => l.item.id === item.id);
    const line = hit ? 0 : (await this.ext.panel.lineOf(p, item)) - 1;
    const range = hit?.range ?? new vscode.Range(line, 0, line, 0);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus, preview: true, viewColumn: this.columnFor(uri) });
    ed.selection = new vscode.Selection(range.start, range.end);
    this.ext.preview.follow({ project: p, item });
    // Ready by the time the pointer reaches it.
    if (["hover", "both"].includes(previewPlace()) && item.kind === "modify") this.ext.preview.prefetch({ project: p, item });
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
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    this.ext.reviewing.onlyOne("Diff", t.item, arg, all);
    const { project: p, item } = t;
    // Opening a change from History is how its replies are read there: they stayed "new" for
    // good.
    if (item.thread.length) this.ext.replies.markRead(p, item);
    // A pending change: the file's review with just this change, and what accepting it takes
    // along (its linked group, a move's other half) in the same file. Editable, with the same
    // actions as in the file. Decided ones, whole-file ones and changes that can't be located
    // get the plain diff.
    const text = item.kind === "modify" && isLiveItem(item) ? await this.currentText(p, item.file) : undefined;
    if (text !== undefined && (await p.stet.locateInText(item, text))) {
      const rest = this.ext
        .model(p)
        .linkedRest([item.id])
        .filter((r) => r.file === item.file && r.kind === "modify");
      const ids = [item.id, ...rest.map((r) => r.id)];
      const others = this.ext.model(p).linkedRest([item.id]).length - rest.length;
      const title = `${ids.join(" + ")} ${item.file}${inProject(p)}: yours ↔ proposed${others ? ` (${others} linked in other files)` : ""} (editable)`;
      const right = ReviewFiles.uriFor(p, item.file, ids);
      return void (await vscode.commands.executeCommand("vscode.diff", this.diffLeft(p, item.file), right, title, {
        preview: true,
        viewColumn: this.columnFor(right),
      }));
    }
    const key = projectQuery(p.mainPath);
    const mk = (side: string) => vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${item.file}`, query: `${key}&id=${item.id}&side=${side}` });
    await vscode.commands.executeCommand("vscode.diff", mk("before"), mk("after"), `${item.id} ${item.file}${inProject(p)} (current ↔ proposed)`, {
      preview: true,
      viewColumn: this.columnFor(mk("after")),
    });
  }

  /**
   * The left side of a review diff: your text as it is, read-only, so the diff marks what goes in
   * red; or, with `stet.diffShowsProposals`, your file itself (editable, with the proposals shown in it).
   */
  diffLeft(p: Project, file: string): vscode.Uri {
    if (setting("diffShowsProposals")) return p.fileUri(file);
    return vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${file}`, query: `${projectQuery(p.mainPath)}&side=current` });
  }

  /** The file a `stet-diff:` document of your current text shows. */
  currentOf(uri: vscode.Uri): vscode.Uri | undefined {
    const p = this.ext.projects.get(foldPath(projectOfQuery(uri.query)));
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
    const p = this.ext.projects.get(foldPath(projectOfQuery(uri.query)));
    if (p && q.get("side") === "current") return this.currentText(p, uri.path.replace(/^\//, ""));
    const item = p && this.ext.model(p).item(q.get("id") ?? "");
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
}
