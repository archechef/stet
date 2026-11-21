/**
 * The PDF preview panel: where a change lands on the compiled page, before and after.
 *
 * Changes show up in the panel and the editor at once; previews compile in the background (one
 * at a time, the selected change first, then the next few) and appear here when ready. Without
 * TeX or the container image, the panel says what is missing; nothing else depends on it.
 */
import { dirname, join, relative, sep } from "node:path";
import { changeSummary, type Item, type PageSide, type PreviewEnv, type PreviewResult } from "@stet/core";
import * as vscode from "vscode";
import type { Project } from "./project.js";

type Target = { project: Project; item: Item };

const keyOf = (t: Target) => `${t.project.mainPath}|${t.item.id}|${t.item.baseCommit}|${t.item.range.start}|${t.item.newText.length}`;
const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The zoom buttons, named for screen readers (not just − and +). */
const ZOOM_BUTTONS = `<button id="out" title="Zoom out" aria-label="Zoom out">−</button><button id="fit" title="Whole width" aria-label="Fit to the width">Fit</button><button id="in" title="Zoom in" aria-label="Zoom in">+</button>`;

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
    /** Install the extra fonts (asks first) / a preview found files missing that they may bring. */
    private readonly extras: (p: Project) => Promise<void>,
    private readonly onMissing: (p: Project, files: string[]) => void,
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
        if (m?.type === "page" && this.current) void this.sendPage(m.version, Number(m.n));
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
    const roots = r?.status === "ready" ? [vscode.Uri.file(r.pages ? previewCacheRoot(t.project) : dirname(r.after.file))] : [];
    w.options = { enableScripts: true, localResourceRoots: roots };
    // Which project, when the window has several: their ids are the same (test report v0.16.0, accessibility).
    const several = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    this.panel.title = `Preview ${t.item.id}${several ? ` (${t.project.name})` : ""}`;
    const img = (file: string) => `${w.asWebviewUri(vscode.Uri.file(file))}?v=${Date.now()}`;
    let body: string;
    let pageData: unknown = null;
    // What changed, for the pictures' alt text: where the changes are said nothing of what they are (test report v0.16.0).
    const [was, now] = changeSummary(t.item.oldText, t.item.newText, 60);
    const what = !t.item.oldText ? `“${now}” inserted` : !t.item.newText ? `“${was}” deleted` : `“${was}” replaced with “${now}”`;
    if (!r) body = `<p class="muted">Building the preview… The change is already in the editor; its page appears here when it's compiled.</p>`;
    else if (
      r.status === "ready" &&
      r.pages &&
      inPreviewCache(t.project, r.pages.after.file) &&
      (!r.pages.before || inPreviewCache(t.project, r.pages.before.file))
    ) {
      const side = (s: PageSide) => ({ page: s.page, count: s.count, width: s.width, height: s.height, src: img(s.file), marks: s.marks });
      pageData = { after: side(r.pages.after), before: r.pages.before ? side(r.pages.before) : null, what };
      body =
        (r.note ? `<p class="muted">${html(r.note)}</p>` : "") +
        (r.warning
          ? `<p class="warn">${html(r.warning.message)}</p>${extrasButton(r.warning.missing)}<details><summary>${html(r.typesetter ?? "Build")} log</summary><pre>${html(r.warning.log)}</pre></details>`
          : "") +
        `<div class="zoom">` +
        `<span class="seg" role="group" aria-label="Version"><button id="show-after" class="on" aria-pressed="true" title="With the change">After</button><button id="show-before" aria-pressed="false" title="Without it"${r.pages.before ? "" : " disabled"}>Before</button></span>` +
        `<button id="prev" title="Previous page" aria-label="Previous page">◀</button><span id="pageno" class="muted" aria-live="polite"></span><button id="next" title="Next page" aria-label="Next page">▶</button>` +
        ZOOM_BUTTONS +
        `<span id="level" class="muted" aria-live="polite"></span>` +
        `<span class="muted hint">changes marked · Ctrl/Cmd + wheel zooms, drag or arrow keys move · Page Up/Down turn pages, A/B after and before</span></div>` +
        `<div class="page tall" tabindex="0" role="region" aria-label="The page; arrow keys move it, + and − zoom, Page Up and Page Down turn pages, A and B show it after and before the change"><div class="sheet"><img alt="The page with the change" draggable="false"></div></div>`;
    } else if (r.status === "ready") {
      body =
        (r.note ? `<p class="muted">${html(r.note)}</p>` : "") +
        (r.warning
          ? `<p class="warn">${html(r.warning.message)}</p>${extrasButton(r.warning.missing)}<details><summary>${html(r.typesetter ?? "Build")} log</summary><pre>${html(r.warning.log)}</pre></details>`
          : "") +
        `<div class="zoom">` +
        ZOOM_BUTTONS +
        `<span id="level" class="muted" aria-live="polite"></span><span class="muted hint">Ctrl/Cmd + wheel zooms, drag or arrow keys move, double-click zooms in</span></div>` +
        `<h3>After <span class="muted">(page ${r.after.page})</span></h3><div class="page" tabindex="0" role="region" aria-label="After; arrow keys move it, + and − zoom"><img src="${img(r.after.file)}" alt="Page ${r.after.page} with the change: ${html(what)}" draggable="false"></div>` +
        (r.before
          ? `<h3>Before <span class="muted">(page ${r.before.page})</span></h3><div class="page" tabindex="0" role="region" aria-label="Before; arrow keys move it, + and − zoom"><img src="${img(r.before.file)}" alt="Page ${r.before.page} without the change" draggable="false"></div>`
          : "");
    } else if (r.status === "no-spot") body = `<p class="muted">${html(r.message)}</p>`;
    else if (r.status === "failed") body = `<p class="warn">${html(r.message)}</p>${extrasButton(r.missing)}<pre>${html(r.log)}</pre>`;
    else {
      const setup = /\bsetup\b/i.test(r.fix ?? "");
      body =
        `<p>${html(r.message)}</p>` + (r.fix ? `<p class="muted">${html(r.fix)}</p>` : "") + (setup ? `<button id="setup">Set up PDF previews</button>` : "");
    }
    const nonce = Math.random().toString(36).slice(2);
    w.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 12px; }
.page { overflow: hidden; position: relative; background: white; border: 1px solid var(--vscode-panel-border); cursor: grab; touch-action: none; user-select: none; }
.page.dragging { cursor: grabbing; }
.page img { display: block; width: 100%; max-width: none; }
.page.tall { height: calc(100vh - 150px); min-height: 240px; }
.sheet { position: relative; width: 100%; }
.sheet img { width: 100%; }
.mark { position: absolute; pointer-events: none; border-radius: 2px; }
.sheet.loading .mark { display: none; }
.mark.after { background: var(--vscode-diffEditor-insertedTextBackground, rgba(40, 180, 70, .28)); outline: 1px solid var(--vscode-diffEditor-insertedTextBorder, rgba(40, 160, 60, .7)); }
.mark.before { background: var(--vscode-diffEditor-removedTextBackground, rgba(220, 50, 50, .22)); outline: 1px solid var(--vscode-diffEditor-removedTextBorder, rgba(200, 40, 40, .7)); }
/* High contrast: marks drawn as thick outlines, so they don't rely on colour. */
body.vscode-high-contrast .mark, body.vscode-high-contrast-light .mark { outline: 2px dashed var(--vscode-contrastActiveBorder, currentColor); }
.page:focus-visible { outline: 1px solid var(--vscode-focusBorder); }
.seg button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.zoom button:disabled { opacity: .4; cursor: default; }
.zoom { position: sticky; top: 0; z-index: 1; padding: 4px 0; background: var(--vscode-editor-background); }
.zoom .hint { margin-left: 1em; font-size: .9em; }
#level { margin-left: .6em; }
.zoom button { min-width: 2.2em; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; padding: 2px 6px; cursor: pointer; }
h2 { font-size: 1.1em; } h3 { font-size: 1em; margin: 1em 0 .4em; }
.muted { color: var(--vscode-descriptionForeground); } .warn { color: var(--vscode-errorForeground); }
pre { white-space: pre-wrap; font-size: .9em; background: var(--vscode-textCodeBlock-background); padding: 8px; }
</style></head><body>
<h2>${html(t.item.id)} <span class="muted">${html(t.item.file)}</span></h2>
${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const b = document.getElementById("setup");
if (b) b.onclick = () => vscode.postMessage({ type: "setup" });
const x = document.getElementById("extras");
if (x) x.onclick = () => vscode.postMessage({ type: "extras" });
const PAGES = ${JSON.stringify(pageData).replace(/</g, "\\u003c")};
// Zoom and position like a PDF viewer: each image stays in its frame, zoom enlarges it inside,
// dragging moves it. Before and after share zoom and position, so they show the same spot. Both
// are kept in the webview's state while you move from change to change.
const frames = [...document.querySelectorAll(".page")];
const saved = vscode.getState() || {};
let zoom = saved.zoom || 1;
let fx = saved.fx || 0; // position as a fraction of how far the image can move
let fy = saved.fy || 0;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// What zoom enlarges: the page viewer's sheet (image and marks together), else the image.
const zoomed = (f) => f.querySelector(".sheet") || f.querySelector("img");
const fit = () => {
  for (const f of frames) {
    if (f.classList.contains("tall")) continue; // the page viewer keeps the panel's height
    const im = f.querySelector("img");
    if (im.naturalWidth) f.style.height = Math.round((f.clientWidth * im.naturalHeight) / im.naturalWidth) + "px";
  }
};
const place = () => {
  for (const f of frames) {
    zoomed(f).style.width = zoom * 100 + "%";
    f.scrollLeft = fx * Math.max(0, f.scrollWidth - f.clientWidth);
    f.scrollTop = fy * Math.max(0, f.scrollHeight - f.clientHeight);
  }
  const l = document.getElementById("level");
  if (l) l.textContent = Math.round(zoom * 100) + "%";
  vscode.setState({ zoom, fx, fy });
};
// Take the position from one frame (after it moved), for all of them.
const from = (f) => {
  const mx = f.scrollWidth - f.clientWidth, my = f.scrollHeight - f.clientHeight;
  fx = mx > 0 ? clamp(f.scrollLeft / mx, 0, 1) : 0;
  fy = my > 0 ? clamp(f.scrollTop / my, 0, 1) : 0;
};
// Zoom by the factor k, keeping the point (px, py) of frame f where it is.
const zoomAt = (f, k, px, py) => {
  const next = clamp(Math.round(zoom * k * 100) / 100, 1, 6);
  const r = next / zoom;
  const cx = f.scrollLeft + px, cy = f.scrollTop + py;
  zoom = next;
  zoomed(f).style.width = zoom * 100 + "%";
  f.scrollLeft = cx * r - px;
  f.scrollTop = cy * r - py;
  from(f);
  place();
};
const centre = (f) => [f.clientWidth / 2, f.clientHeight / 2];
const buttons = { in: (f) => zoomAt(f, 1.25, ...centre(f)), out: (f) => zoomAt(f, 0.8, ...centre(f)), fit: () => { zoom = 1; fx = fy = 0; place(); } };
for (const [id, act] of Object.entries(buttons)) {
  const e = document.getElementById(id);
  if (e && frames[0]) e.onclick = () => act(frames[0]);
}
for (const f of frames) {
  f.addEventListener("wheel", (e) => {
    const box = f.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoomAt(f, e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - box.left, e.clientY - box.top);
    } else if (zoom > 1) {
      // Zoomed in: the wheel moves the page in its frame (like a PDF viewer), not the panel.
      e.preventDefault();
      f.scrollLeft += e.deltaX;
      f.scrollTop += e.deltaY;
      from(f);
      place();
    }
  }, { passive: false });
  let drag = null;
  f.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, l: f.scrollLeft, t: f.scrollTop };
    f.setPointerCapture(e.pointerId);
    f.classList.add("dragging");
  });
  f.addEventListener("pointermove", (e) => {
    if (!drag) return;
    f.scrollLeft = drag.l - (e.clientX - drag.x);
    f.scrollTop = drag.t - (e.clientY - drag.y);
    from(f);
    place();
  });
  const end = (e) => {
    drag = null;
    f.classList.remove("dragging");
    try { f.releasePointerCapture(e.pointerId); } catch {}
  };
  f.addEventListener("pointerup", end);
  f.addEventListener("pointercancel", end);
  f.addEventListener("dblclick", (e) => {
    const box = f.getBoundingClientRect();
    if (zoom > 1) buttons.fit();
    else zoomAt(f, 2.5, e.clientX - box.left, e.clientY - box.top);
  });
  f.querySelector("img").addEventListener("load", () => { fit(); place(); });
}
new ResizeObserver(() => { fit(); place(); }).observe(document.body);
// The keyboard moves and zooms a page as the mouse does (test report 2026-11-20, accessibility).
for (const f of frames) {
  f.addEventListener("keydown", (e) => {
    const step = 0.1;
    const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (keys[e.key]) {
      fx = clamp(fx + keys[e.key][0], 0, 1);
      fy = clamp(fy + keys[e.key][1], 0, 1);
      place();
    } else if (e.key === "+" || e.key === "=") zoomAt(f, 1.25, f.clientWidth / 2, f.clientHeight / 2);
    else if (e.key === "-") zoomAt(f, 0.8, f.clientWidth / 2, f.clientHeight / 2);
    else return;
    e.preventDefault();
  });
}

// The page viewer: one page of one version, the changed words marked, flip and turn pages.
if (PAGES) {
  const frame = frames[0];
  const sheet = frame.querySelector(".sheet");
  const im = sheet.querySelector("img");
  let side = "after";
  const shown = { after: PAGES.after.page, before: PAGES.before ? PAGES.before.page : 0 };
  const cache = {};
  const show = (s, n, data, first) => {
    side = s;
    shown[s] = n;
    for (const m of sheet.querySelectorAll(".mark")) m.remove();
    // The marks wait for their page: shown over the old image, they'd mark the wrong words.
    if (im.getAttribute("src") !== data.src) {
      sheet.classList.add("loading");
      im.addEventListener("load", () => sheet.classList.remove("loading"), { once: true });
      im.src = data.src;
    }
    const marks = n === PAGES[s].page ? PAGES[s].marks : [];
    for (const b of marks) {
      const d = document.createElement("div");
      d.className = "mark " + s;
      d.style.left = (100 * b.x0) / data.width + "%";
      d.style.top = (100 * b.y0) / data.height + "%";
      d.style.width = (100 * (b.x1 - b.x0)) / data.width + "%";
      d.style.height = (100 * (b.y1 - b.y0)) / data.height + "%";
      sheet.appendChild(d);
    }
    document.getElementById("pageno").textContent = "page " + n + " of " + PAGES[s].count;
    document.getElementById("prev").disabled = n <= 1;
    document.getElementById("next").disabled = n >= PAGES[s].count;
    for (const v of ["after", "before"]) {
      const btn = document.getElementById("show-" + v);
      btn.classList.toggle("on", v === s);
      btn.setAttribute("aria-pressed", String(v === s));
    }
    im.alt = "Page " + n + (s === "after" ? " with the change: " + PAGES.what : " without the change: " + PAGES.what) + (marks.length ? ", " + marks.length + " changed place" + (marks.length > 1 ? "s" : "") + " marked" : "");
    if (first && marks.length) {
      // Open at the change: its first mark in the middle of the frame.
      const m = marks[0];
      const go = () => {
        const h = sheet.clientHeight, max = frame.scrollHeight - frame.clientHeight;
        if (max > 0) fy = clamp(((m.y0 / data.height) * h - frame.clientHeight / 2) / max, 0, 1);
        place();
      };
      if (im.complete) go(); else im.onload = go;
    }
  };
  const goto = (s, n) => {
    if (n === PAGES[s].page) return show(s, n, PAGES[s], false);
    const k = s + n;
    if (cache[k]) return show(s, n, cache[k], false);
    document.getElementById("pageno").textContent = "page " + n + " …";
    vscode.postMessage({ type: "page", version: s, n });
  };
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.type !== "page") return;
    if (m.error) { document.getElementById("pageno").textContent = "page " + m.n + " couldn't be rendered"; return; }
    cache[m.version + m.n] = m;
    if (m.version === side) show(m.version, m.n, m, false);
  });
  document.getElementById("show-after").onclick = () => goto("after", shown.after);
  if (PAGES.before) document.getElementById("show-before").onclick = () => goto("before", shown.before);
  document.getElementById("prev").onclick = () => goto(side, shown[side] - 1);
  document.getElementById("next").onclick = () => goto(side, shown[side] + 1);
  // Pages and versions from the keyboard too, not only with Tab and Enter (test report v0.16.0).
  frame.addEventListener("keydown", (e) => {
    if (e.key === "PageDown" && shown[side] < PAGES[side].count) goto(side, shown[side] + 1);
    else if (e.key === "PageUp" && shown[side] > 1) goto(side, shown[side] - 1);
    else if (e.key === "a" || e.key === "A") goto("after", shown.after);
    else if ((e.key === "b" || e.key === "B") && PAGES.before) goto("before", shown.before);
    else return;
    e.preventDefault();
  });
  // A full page is taller than the frame: the wheel moves it at any zoom.
  frame.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey || zoom > 1) return;
    e.preventDefault();
    frame.scrollTop += e.deltaY;
    from(frame);
    place();
  }, { passive: false });
  show("after", PAGES.after.page, PAGES.after, true);
}
fit();
place();
</script>
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
export async function previewNotice(env: PreviewEnv, memo: vscode.Memento, projectName: string, projectKey: string): Promise<boolean> {
  if (env.status === "ready" && env.isolation === "container") return false;
  // Per project and reason: one "Don't show again" silenced every project (test report 5e4c6af, B8).
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

/** The offer to add the extra fonts, where they may bring a missing file. */
const extrasButton = (m: { files: string[]; extras: boolean } | undefined) =>
  m?.extras
    ? `<p><button id="extras">Install extra fonts for previews (about 2 GB)</button> <span class="muted">may bring ${html(m.files.join(", "))}</span></p>`
    : "";

/** Whether `file` is in the project's preview cache (images are shown from nowhere else). */
export function inPreviewCache(p: Project, file: string | undefined): boolean {
  const cache = previewCacheRoot(p);
  return !!file && file.startsWith(cache + sep) && !relative(cache, file).split(sep).includes("..");
}

/** Where PDF previews are shown (setting stet.pdfPreviews). */
export type PreviewPlace = "both" | "hover" | "panel" | "off";
export const previewPlace = (): PreviewPlace => vscode.workspace.getConfiguration("stet").get<PreviewPlace>("pdfPreviews", "both");
