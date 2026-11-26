/**
 * The PDF preview page's script, run in the webview (the page itself is `previewPage.ts`). Built
 * to `dist/preview.js` for the browser and type-checked with the DOM's types
 * (`tsconfig.webview.json`). The page gives it its pages as JSON in `#stet-pages`.
 */
import { frameKey, pageAlt, viewerKey } from "./keys.js";
import { markChanges } from "./marks.js";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };

type Version = "after" | "before";
interface Mark {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** A page picture: its webview URI and size in pixels. */
interface Picture {
  src: string;
  width: number;
  height: number;
}
interface Side extends Picture {
  page: number;
  count: number;
  marks: Mark[];
}
interface Pages {
  after: Side;
  before: Side | null;
  what: string;
}
/** A page the extension rendered on request (`{ type: "page" }`). */
interface PageMessage extends Picture {
  type: "page";
  version: Version;
  n: number;
  error?: string;
}

const vscode = acquireVsCodeApi();
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const setupButton = byId("setup");
if (setupButton) setupButton.onclick = () => vscode.postMessage({ type: "setup" });
const extrasButton = byId("extras");
if (extrasButton) extrasButton.onclick = () => vscode.postMessage({ type: "extras" });
const PAGES = JSON.parse(byId("stet-pages")?.textContent || "null") as Pages | null;

// A rendered change: its marks become highlights; its links don't navigate the panel away.
for (const r of document.querySelectorAll(".rendered")) markChanges(r);
document.addEventListener("click", (e) => {
  if (e.target instanceof Element && e.target.closest(".rendered a")) e.preventDefault();
});

// Zoom and position like a PDF viewer: each image stays in its frame, zoom enlarges it inside,
// dragging moves it. Before and after share zoom and position, so they show the same spot. Both
// are kept in the webview's state while you move from change to change.
const frames = [...document.querySelectorAll<HTMLElement>(".page")];
const saved = (vscode.getState() || {}) as { zoom?: number; fx?: number; fy?: number };
let zoom = saved.zoom || 1;
let fx = saved.fx || 0; // position as a fraction of how far the image can move
let fy = saved.fy || 0;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const imageOf = (f: HTMLElement) => f.querySelector("img") as HTMLImageElement;
// What zoom enlarges: the page viewer's sheet (image and marks together), else the image.
const zoomed = (f: HTMLElement) => f.querySelector<HTMLElement>(".sheet") || imageOf(f);
const fit = () => {
  for (const f of frames) {
    if (f.classList.contains("tall")) continue; // the page viewer keeps the panel's height
    const im = imageOf(f);
    if (im.naturalWidth) f.style.height = Math.round((f.clientWidth * im.naturalHeight) / im.naturalWidth) + "px";
  }
};
const place = () => {
  for (const f of frames) {
    zoomed(f).style.width = zoom * 100 + "%";
    f.scrollLeft = fx * Math.max(0, f.scrollWidth - f.clientWidth);
    f.scrollTop = fy * Math.max(0, f.scrollHeight - f.clientHeight);
  }
  const l = byId("level");
  if (l) l.textContent = Math.round(zoom * 100) + "%";
  vscode.setState({ zoom, fx, fy });
};
// Take the position from one frame (after it moved), for all of them.
const from = (f: HTMLElement) => {
  const mx = f.scrollWidth - f.clientWidth;
  const my = f.scrollHeight - f.clientHeight;
  fx = mx > 0 ? clamp(f.scrollLeft / mx, 0, 1) : 0;
  fy = my > 0 ? clamp(f.scrollTop / my, 0, 1) : 0;
};
// Zoom by the factor k, keeping the point (px, py) of frame f where it is.
const zoomAt = (f: HTMLElement, k: number, px: number, py: number) => {
  const next = clamp(Math.round(zoom * k * 100) / 100, 1, 6);
  const r = next / zoom;
  const cx = f.scrollLeft + px;
  const cy = f.scrollTop + py;
  zoom = next;
  zoomed(f).style.width = zoom * 100 + "%";
  f.scrollLeft = cx * r - px;
  f.scrollTop = cy * r - py;
  from(f);
  place();
};
const fitWidth = () => {
  zoom = 1;
  fx = fy = 0;
  place();
};
const buttons: Record<string, (f: HTMLElement) => void> = {
  in: (f) => zoomAt(f, 1.25, f.clientWidth / 2, f.clientHeight / 2),
  out: (f) => zoomAt(f, 0.8, f.clientWidth / 2, f.clientHeight / 2),
  fit: fitWidth,
};
for (const [id, act] of Object.entries(buttons)) {
  const e = byId(id);
  const first = frames[0];
  if (e && first) e.onclick = () => act(first);
}
for (const f of frames) {
  f.addEventListener(
    "wheel",
    (e) => {
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
    },
    { passive: false },
  );
  let drag: { x: number; y: number; l: number; t: number } | null = null;
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
  const end = (e: PointerEvent) => {
    drag = null;
    f.classList.remove("dragging");
    try {
      f.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
  };
  f.addEventListener("pointerup", end);
  f.addEventListener("pointercancel", end);
  f.addEventListener("dblclick", (e) => {
    const box = f.getBoundingClientRect();
    if (zoom > 1) fitWidth();
    else zoomAt(f, 2.5, e.clientX - box.left, e.clientY - box.top);
  });
  imageOf(f).addEventListener("load", () => {
    fit();
    place();
  });
}
new ResizeObserver(() => {
  fit();
  place();
}).observe(document.body);
// The keyboard moves and zooms a page as the mouse does.
for (const f of frames) {
  f.addEventListener("keydown", (e) => {
    const k = frameKey(e.key);
    if (!k) return;
    if (k.move) {
      fx = clamp(fx + k.move[0], 0, 1);
      fy = clamp(fy + k.move[1], 0, 1);
      place();
    } else zoomAt(f, k.zoom, f.clientWidth / 2, f.clientHeight / 2);
    e.preventDefault();
  });
}

// The page viewer: one page of one version, the changed words marked, flip and turn pages.
const frame = frames[0];
if (PAGES && frame) viewer(PAGES, frame);

function viewer(pages: Pages, frame: HTMLElement): void {
  const sheet = frame.querySelector(".sheet") as HTMLElement;
  const im = imageOf(sheet);
  const pageNo = byId("pageno") as HTMLElement;
  const prev = byId<HTMLButtonElement>("prev") as HTMLButtonElement;
  const next = byId<HTMLButtonElement>("next") as HTMLButtonElement;
  const sideOf = (s: Version) => (s === "after" ? pages.after : (pages.before ?? pages.after));
  let side: Version = "after";
  const shown = { after: pages.after.page, before: pages.before ? pages.before.page : 0 };
  const cache: Record<string, Picture> = {};
  const show = (s: Version, n: number, data: Picture, first: boolean) => {
    side = s;
    shown[s] = n;
    for (const m of sheet.querySelectorAll(".mark")) m.remove();
    // The marks wait for their page: shown over the old image, they'd mark the wrong words.
    if (im.getAttribute("src") !== data.src) {
      sheet.classList.add("loading");
      im.addEventListener("load", () => sheet.classList.remove("loading"), { once: true });
      im.src = data.src;
    }
    const marks = n === sideOf(s).page ? sideOf(s).marks : [];
    for (const b of marks) {
      const d = document.createElement("div");
      d.className = "mark " + s;
      d.style.left = (100 * b.x0) / data.width + "%";
      d.style.top = (100 * b.y0) / data.height + "%";
      d.style.width = (100 * (b.x1 - b.x0)) / data.width + "%";
      d.style.height = (100 * (b.y1 - b.y0)) / data.height + "%";
      sheet.appendChild(d);
    }
    pageNo.textContent = "page " + n + " of " + sideOf(s).count;
    prev.disabled = n <= 1;
    next.disabled = n >= sideOf(s).count;
    for (const v of ["after", "before"] as const) {
      const btn = byId("show-" + v);
      btn?.classList.toggle("on", v === s);
      btn?.setAttribute("aria-pressed", String(v === s));
    }
    im.alt = pageAlt(n, s, pages.what, marks.length);
    const m = marks[0];
    if (first && m) {
      // Open at the change: its first mark in the middle of the frame.
      const go = () => {
        const h = sheet.clientHeight;
        const max = frame.scrollHeight - frame.clientHeight;
        if (max > 0) fy = clamp(((m.y0 / data.height) * h - frame.clientHeight / 2) / max, 0, 1);
        place();
      };
      if (im.complete) go();
      else im.onload = go;
    }
  };
  const goto = (s: Version, n: number) => {
    if (n === sideOf(s).page) return show(s, n, sideOf(s), false);
    const k = s + n;
    const known = cache[k];
    if (known) return show(s, n, known, false);
    pageNo.textContent = "page " + n + " …";
    vscode.postMessage({ type: "page", version: s, n });
  };
  window.addEventListener("message", (e: MessageEvent<PageMessage | null>) => {
    const m = e.data;
    if (m?.type !== "page") return;
    if (m.error) {
      pageNo.textContent = "page " + m.n + " couldn't be rendered";
      return;
    }
    cache[m.version + m.n] = m;
    if (m.version === side) show(m.version, m.n, m, false);
  });
  const after = byId("show-after");
  if (after) after.onclick = () => goto("after", shown.after);
  const before = byId("show-before");
  if (pages.before && before) before.onclick = () => goto("before", shown.before);
  prev.onclick = () => goto(side, shown[side] - 1);
  next.onclick = () => goto(side, shown[side] + 1);
  // Pages and versions from the keyboard too, not only with Tab and Enter.
  frame.addEventListener("keydown", (e) => {
    const to = viewerKey(e.key, { side, shown, count: sideOf(side).count, hasBefore: !!pages.before });
    if (!to) return;
    goto(to.side, to.page);
    e.preventDefault();
  });
  // A full page is taller than the frame: the wheel moves it at any zoom.
  frame.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey || zoom > 1) return;
      e.preventDefault();
      frame.scrollTop += e.deltaY;
      from(frame);
      place();
    },
    { passive: false },
  );
  show("after", pages.after.page, pages.after, true);
}
fit();
place();
