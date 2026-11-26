/**
 * The PDF preview's page (its HTML) for one change. No `vscode` import, so it is tested on its own;
 * the panel (preview.ts) gives it the result and the webview's URIs. Its script is
 * `webview/preview.ts` (built to `dist/preview.js`), its style `media/preview.css`.
 */
import { changeSummary, type Item, type Missing, type PageSide, type PreviewResult } from "@stet/core";

export const html = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The zoom buttons, named for screen readers (not just − and +). */
const ZOOM_BUTTONS = `<button id="out" title="Zoom out" aria-label="Zoom out">−</button><button id="fit" title="Whole width" aria-label="Fit to the width">Fit</button><button id="in" title="Zoom in" aria-label="Zoom in">+</button>`;

/** The offer of the typesetter's setup action (LaTeX: the extra fonts), where it may bring a missing file. */
const extrasButton = (m: Missing | undefined) =>
  m?.action
    ? `<p><button id="extras">Install ${html(m.action.label)} for previews (${html(m.action.download)})</button> <span class="muted">may bring ${html(m.files.join(", "))}</span></p>`
    : "";

/**
 * A change shown rendered by VS Code itself (Markdown): the block around it, before and after, as
 * HTML with the changed text between marks (`markdownPreview.ts`), its images already local.
 */
export interface RenderedResult {
  status: "rendered";
  before: string;
  after: string;
}

/** What the preview panel shows: a PDF preview, or a rendered one. */
export type PanelResult = PreviewResult | RenderedResult;

export interface PageInput {
  item: Pick<Item, "id" | "file" | "oldText" | "newText">;
  /** The preview, or undefined while it builds. Only files in the preview cache are shown. */
  result: PanelResult | undefined;
  /** It is a rendered preview (Markdown), not a PDF one. */
  rendered?: boolean;
  /** A picture's URI in the webview. */
  img: (file: string) => string;
  inCache: (file: string | undefined) => boolean;
  /** The webview's source for the content security policy. */
  cspSource: string;
  /** A fresh random value for each page: only the page's own script runs. */
  nonce: string;
  /** The webview URIs of the page's script (`dist/preview.js`) and style (`media/preview.css`). */
  script: string;
  style: string;
}

export function previewPage({ item, result: r, rendered, img, inCache, cspSource, nonce, script, style }: PageInput): string {
  let body: string;
  let pageData: unknown = null;
  // What changed, for the pictures' alt text: where the changes are said nothing of what they are.
  const [was, now] = changeSummary(item.oldText, item.newText, 60);
  const what = !item.oldText ? `“${now}” inserted` : !item.newText ? `“${was}” deleted` : `“${was}” replaced with “${now}”`;
  if (!r)
    body = rendered
      ? `<p class="muted">Rendering the change…</p>`
      : `<p class="muted">Building the preview… The change is already in the editor; its page appears here when it's compiled.</p>`;
  else if (r.status === "rendered") {
    // The renderer's HTML: scripts can't run (the policy allows the page's own script only), and images are the project's.
    body =
      `<p class="muted">As VS Code's Markdown preview shows it, the change marked.</p>` +
      `<h3>After</h3><div class="rendered after" role="region" aria-label="After the change: ${html(what)}">${r.after}</div>` +
      `<h3>Before</h3><div class="rendered before" role="region" aria-label="Before the change">${r.before}</div>`;
  } else if (r.status === "ready" && r.pages && inCache(r.pages.after.file) && (!r.pages.before || inCache(r.pages.before.file))) {
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${html(style)}"></head><body>
<h2>${html(item.id)} <span class="muted">${html(item.file)}</span></h2>
${body}
<script type="application/json" id="stet-pages">${JSON.stringify(pageData).replace(/</g, "\\u003c")}</script>
<script nonce="${nonce}" src="${html(script)}"></script>
</body></html>`;
}
