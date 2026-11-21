/**
 * The PDF preview panel: where a change lands on the compiled page, before and after.
 *
 * Changes show up in the panel and the editor at once; previews compile in the background (one
 * at a time, the selected change first, then the next few) and appear here when ready. Without
 * TeX or the container image, the panel says what is missing; nothing else depends on it.
 */

import { randomBytes } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import type { Item, PreviewEnv, PreviewResult } from "@stet/core";
import * as vscode from "vscode";
import { previewPage } from "./previewPage.js";
import type { Project } from "./project.js";
import { type Settings, setting } from "./settings.js";

type Target = { project: Project; item: Item };

const keyOf = (t: Target) => `${t.project.mainPath}|${t.item.id}|${t.item.baseCommit}|${t.item.range.start}|${t.item.newText.length}`;

export class PreviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: Target | undefined;
  private readonly results = new Map<string, PreviewResult>();
  private readonly queue: Target[] = [];
  private running = false;

  constructor(
    private readonly setup: (p: Project) => Promise<void>,
    /** The live changes after `t` in review order, for building ahead. */
    private readonly next: (t: Target, n: number) => Target[],
    /** Install the extra fonts (asks first) / a preview found files missing that they may bring. */
    private readonly extras: (p: Project) => Promise<void>,
    private readonly onMissing: (p: Project, files: string[]) => void,
    /** The extension's folder: the page's script and style are in it. */
    private readonly extensionUri: vscode.Uri,
  ) {}

  get visible(): boolean {
    return !!this.panel;
  }

  /** Open the panel on a change (or move it there). */
  show(t: Target): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        "stet.preview",
        "Stet: PDF preview",
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        {
          enableScripts: true,
          localResourceRoots: [],
        },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.current = undefined;
        this.queue.length = 0; // nothing to build ahead for while it's closed
      });
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === "setup" && this.current) void this.setup(this.current.project).then(() => this.refresh());
        if (m?.type === "extras" && this.current) void this.extras(this.current.project).then(() => this.refresh());
        if (m?.type === "page" && this.current && Number.isInteger(m.n) && m.n >= 1) void this.sendPage(m.version, m.n);
      });
    }
    this.follow(t);
  }

  /** The result for `t` if it is built (nothing is started). */
  peek(t: Target): PreviewResult | undefined {
    return this.results.get(keyOf(t));
  }

  /** Build `t` in the background (for the hover), unless it is built or queued. */
  prefetch(t: Target): void {
    this.request(t, true);
  }

  /** Show `t` if the panel is open (the selection moved). */
  follow(t: Target): void {
    if (!this.panel) return;
    // The cursor moving within the same change: nothing to redraw or build.
    if (this.current && keyOf(this.current) === keyOf(t)) return;
    this.current = t;
    this.render();
    this.request(t, true);
    for (const n of this.next(t, 2)) this.request(n, false);
  }

  /** Forget results (after setting previews up, or when the project changed under them). */
  refresh(): void {
    this.results.clear();
    const t = this.current;
    this.current = undefined;
    if (t) this.follow(t);
  }

  private request(t: Target, first: boolean): void {
    if (this.results.has(keyOf(t)) || this.queue.some((q) => keyOf(q) === keyOf(t))) return;
    if (first) this.queue.unshift(t);
    else this.queue.push(t);
    void this.pump();
  }

  /** Build queued previews one after another. */
  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let t = this.queue.shift(); t; t = this.queue.shift()) {
        let r: PreviewResult;
        try {
          r = await t.project.stet.preview(t.item.id);
        } catch (e: any) {
          r = { status: "failed", message: "Stet couldn't build the preview.", log: String(e?.message ?? e) };
        }
        this.results.set(keyOf(t), r);
        const missing = r.status === "failed" ? r.missing : r.status === "ready" ? r.warning?.missing : undefined;
        if (missing?.extras) this.onMissing(t.project, missing.files);
        if (this.current && keyOf(this.current) === keyOf(t)) this.render();
      }
    } finally {
      this.running = false;
    }
  }

  /** Another page for the page viewer: rendered in the container, then handed to the webview. */
  private async sendPage(version: unknown, n: number): Promise<void> {
    const t = this.current;
    const r = t && this.results.get(keyOf(t));
    if (!t || !this.panel || r?.status !== "ready" || !r.pages || (version !== "after" && version !== "before")) return;
    const got = await t.project.stet.previewPage(r.pages.base, r.pages.key, version, n).catch(() => null);
    if (!this.panel || this.current !== t) return;
    if (!got || !inPreviewCache(t.project, got.file)) return void this.panel.webview.postMessage({ type: "page", version, n, error: true });
    const src = `${this.panel.webview.asWebviewUri(vscode.Uri.file(got.file))}`;
    void this.panel.webview.postMessage({ type: "page", version, n, src, width: got.width, height: got.height });
  }

  private render(): void {
    const t = this.current;
    if (!this.panel || !t) return;
    let r = this.results.get(keyOf(t));
    const w = this.panel.webview;
    // Images only from this project's preview cache.
    const inCache = (f: string | undefined) => inPreviewCache(t.project, f);
    if (r?.status === "ready" && (!inCache(r.after.file) || (r.before && !inCache(r.before.file)))) {
      r = { status: "unavailable", message: "This preview's files aren't in Stet's preview cache; not shown." };
    }
    const own = (...p: string[]) => vscode.Uri.joinPath(this.extensionUri, ...p);
    const pictures = r?.status === "ready" ? [vscode.Uri.file(r.pages ? previewCacheRoot(t.project) : dirname(r.after.file))] : [];
    w.options = { enableScripts: true, localResourceRoots: [own("dist"), own("media"), ...pictures] };
    // Which project, when the window has several: their ids are the same.
    const several = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    this.panel.title = `Preview ${t.item.id}${several ? ` (${t.project.name})` : ""}`;
    const img = (file: string) => `${w.asWebviewUri(vscode.Uri.file(file))}?v=${Date.now()}`;
    w.html = previewPage({
      item: t.item,
      result: r,
      img,
      inCache,
      cspSource: w.cspSource,
      nonce: randomBytes(16).toString("hex"),
      script: `${w.asWebviewUri(own("dist", "preview.js"))}`,
      style: `${w.asWebviewUri(own("media", "preview.css"))}`,
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

/**
 * Tell the user once per state what PDF previews need, without nagging: nothing when they work
 * in a container, a one-time note otherwise. Returns true when the user asked to set them up.
 */
export async function previewNotice(env: PreviewEnv, memo: vscode.Memento, projectName: string, projectKey: string): Promise<boolean> {
  if (env.status === "ready" && env.isolation === "container") return false;
  // Per project and reason: one "Don't show again" silenced every project.
  const key = `stet.previewNotice:${projectKey}:${env.status}:${env.isolation ?? ""}:${env.message}`;
  if (memo.get<boolean>(key)) return false;
  const never = "Don't show again";
  if (env.status === "needs-setup") {
    const setup = "Set up";
    const pick = await vscode.window.showInformationMessage(
      `Stet can show PDF previews of changes in ${projectName}. They compile in an isolated container, whose image is built once (${env.toolSource === "image" ? "downloads Debian with TeX Live, about 1 GB" : "downloads Debian, Perl and Poppler, about 150 MB"}).`,
      setup,
      "Not now",
      never,
    );
    if (pick === never) await memo.update(key, true);
    return pick === setup;
  }
  const pick = await (env.status === "ready" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(
    `Stet PDF previews: ${env.message}${env.fix ? ` ${env.fix}` : ""} Everything else works as usual.`,
    never,
  );
  if (pick === never) await memo.update(key, true);
  return false;
}

export const previewCacheRoot = (p: Project) => join(p.storeRoot, "previews");

/** Whether `file` is in the project's preview cache (images are shown from nowhere else). */
export function inPreviewCache(p: Project, file: string | undefined): boolean {
  const cache = previewCacheRoot(p);
  return !!file && file.startsWith(cache + sep) && !relative(cache, file).split(sep).includes("..");
}

/** Where PDF previews are shown (setting stet.pdfPreviews). */
export type PreviewPlace = Settings["pdfPreviews"];
export const previewPlace = (): PreviewPlace => setting("pdfPreviews");
