/**
 * The PDF preview panel: where a change lands on the compiled page, before and after.
 *
 * Changes show up in the panel and the editor at once; previews compile in the background (one
 * at a time, the selected change first, then the next few) and appear here when ready. Without
 * TeX or the container image, the panel says what is missing; nothing else depends on it.
 */
import { dirname, join, relative, sep } from "node:path";
import * as vscode from "vscode";
import type { Item, PreviewEnv, PreviewResult } from "@stet/core";
import type { Project } from "./project.js";

type Target = { project: Project; item: Item };

const keyOf = (t: Target) => `${t.project.mainPath}|${t.item.id}|${t.item.baseCommit}|${t.item.range.start}|${t.item.newText.length}`;
const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export class PreviewPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: Target | undefined;
  private readonly results = new Map<string, PreviewResult>();
  private readonly queue: Target[] = [];
  private running = false;
  private readonly ready = new vscode.EventEmitter<string>();

  constructor(
    private readonly setup: (p: Project) => Promise<void>,
    /** The live changes after `t` in review order, for building ahead. */
    private readonly next: (t: Target, n: number) => Target[],
  ) {}

  get visible(): boolean {
    return !!this.panel;
  }

  /** Open the panel on a change (or move it there). */
  show(t: Target): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("stet.preview", "Stet: PDF preview", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
        enableScripts: true,
        localResourceRoots: [],
      });
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.current = undefined;
        this.queue.length = 0; // nothing to build ahead for while it's closed
      });
      this.panel.webview.onDidReceiveMessage((m) => {
        if (m?.type === "setup" && this.current) void this.setup(this.current.project).then(() => this.refresh());
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
        if (this.current && keyOf(this.current) === keyOf(t)) this.render();
      }
    } finally {
      this.running = false;
    }
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
    const roots = r?.status === "ready" ? [vscode.Uri.file(dirname(r.after.file))] : [];
    w.options = { enableScripts: true, localResourceRoots: roots };
    this.panel.title = `Preview ${t.item.id}`;
    const img = (file: string) => `${w.asWebviewUri(vscode.Uri.file(file))}?v=${Date.now()}`;
    let body: string;
    if (!r) body = `<p class="muted">Building the preview… The change is already in the editor; its page appears here when it's compiled.</p>`;
    else if (r.status === "ready") {
      body =
        (r.note ? `<p class="muted">${html(r.note)}</p>` : "") +
        (r.warning ? `<p class="warn">${html(r.warning.message)}</p><details><summary>LaTeX log</summary><pre>${html(r.warning.log)}</pre></details>` : "") +
        `<h3>After <span class="muted">(page ${r.after.page})</span></h3><img src="${img(r.after.file)}" alt="after">` +
        (r.before ? `<h3>Before <span class="muted">(page ${r.before.page})</span></h3><img src="${img(r.before.file)}" alt="before">` : "");
    } else if (r.status === "no-spot") body = `<p class="muted">${html(r.message)}</p>`;
    else if (r.status === "failed") body = `<p class="warn">${html(r.message)}</p><pre>${html(r.log)}</pre>`;
    else {
      const setup = /\bsetup\b/i.test(r.fix ?? "");
      body =
        `<p>${html(r.message)}</p>` +
        (r.fix ? `<p class="muted">${html(r.fix)}</p>` : "") +
        (setup ? `<button id="setup">Set up PDF previews</button>` : "");
    }
    const nonce = Math.random().toString(36).slice(2);
    w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px; }
img { max-width: 100%; background: white; border: 1px solid var(--vscode-panel-border); }
h2 { font-size: 1.1em; } h3 { font-size: 1em; margin: 1em 0 .4em; }
.muted { color: var(--vscode-descriptionForeground); } .warn { color: var(--vscode-errorForeground); }
pre { white-space: pre-wrap; font-size: .9em; background: var(--vscode-textCodeBlock-background); padding: 8px; }
</style></head><body>
<h2>${html(t.item.id)} <span class="muted">${html(t.item.file)}</span></h2>
${body}
<script nonce="${nonce}">const b = document.getElementById("setup"); if (b) b.onclick = () => acquireVsCodeApi().postMessage({ type: "setup" });</script>
</body></html>`;
  }

  dispose(): void {
    this.panel?.dispose();
    this.ready.dispose();
  }
}

/**
 * Tell the user once per state what PDF previews need, without nagging: nothing when they work
 * in a container, a one-time note otherwise. Returns true when the user asked to set them up.
 */
export async function previewNotice(env: PreviewEnv, memo: vscode.Memento, projectName: string): Promise<boolean> {
  if (env.status === "ready" && env.isolation === "container") return false;
  const key = `stet.previewNotice:${env.status}:${env.isolation ?? ""}`;
  if (memo.get<boolean>(key)) return false;
  const never = "Don't show again";
  if (env.status === "needs-setup") {
    const setup = "Set up";
    const pick = await vscode.window.showInformationMessage(
      `Stet can show PDF previews of changes in ${projectName}. They compile in an isolated container, whose image is built once (downloads Debian, Perl and Poppler, roughly 100 MB).`,
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
export type PreviewPlace = "both" | "hover" | "panel" | "off";
export const previewPlace = (): PreviewPlace => vscode.workspace.getConfiguration("stet").get<PreviewPlace>("pdfPreviews", "both");
