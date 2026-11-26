/**
 * PDF previews of Typst documents (spec §14): `typst compile` in a container with Typst and
 * Poppler (or the user's own Typst), Typst's own introspection to find a change on the page, and
 * its diagnostics for errors and missing packages. The generic part (isolation, pages, words) is
 * in `preview/`.
 *
 * Typst has no SyncTeX. To find source lines on the page, a scratch copy of the build gets
 * invisible markers at those lines, `#context[#metadata((n: …, pos: here().position()))<stet-at>];`,
 * and `typst eval` asks the laid-out document where they are. A marker is inline content that
 * takes no space, so the page is the same; it can only go where markup is (`scan`): at a line's
 * text (after a heading's `=`, a list's `-`), or right after a `[`. Lines in code, maths or raw
 * text are found by the markup just before what they are in (`#figure(`, `$`).
 */
import { existsSync } from "node:fs";
import { constants, copyFile, link, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve, win32 } from "node:path";
import { buildImage, containerRuntime, detectPreviewEnv, normWord, popplerMissing, runProgram, which } from "./kit.js";
import type { DoctorCheck, PreviewConfig, PreviewEnv, RunIsolated, SourceBox, Typesetter } from "./profile.js";

// ---------------------------------------------------------------------------
// Typst's own preview settings (`preview.*` in the config)

export interface TypstPreviewSettings {
  /** The container image with Typst and Poppler. */
  typstImage: string;
}

type TypstPreview = PreviewConfig & TypstPreviewSettings;

const TYPST_SETTINGS: TypstPreviewSettings = { typstImage: "localhost/stet-preview-typst:1" };

const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:@-]*$/i;

const checkSettings = (pv: PreviewConfig): string[] =>
  typeof pv.typstImage !== "string" || !IMAGE_NAME.test(pv.typstImage) ? [`preview.typstImage '${pv.typstImage}'`] : [];

// ---------------------------------------------------------------------------
// The tool chain

/** The Typst release in the image, and the checksums GitHub publishes for it. */
export const TYPST_VERSION = "0.15.1";
const TYPST_SHA256 = {
  amd64: ["x86_64", "a6d077d0a95eed5a2eba715b2dae06be954f624ccbf85758a03f389ded33118c"],
  arm64: ["aarch64", "5aa8d74a3d906e60ea12a66ac2f37f8eef1b14cbad7182a745e393a10c23dcee"],
} as const;

/** The image `stet preview setup` builds for Typst documents: Typst's release binary, checked, and Poppler. */
export const TYPST_CONTAINERFILE = `# Stet PDF previews of Typst documents: Typst (the release binary, checked against the checksum
# GitHub publishes for it) and Poppler to read and render PDFs.
FROM docker.io/library/debian:bookworm-slim AS typst
RUN apt-get update \\
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils
RUN set -eu; \\
    case "$(dpkg --print-architecture)" in \\
${Object.entries(TYPST_SHA256)
  .map(([arch, [t, sum]]) => `      ${arch}) t=${t}; sum=${sum} ;; \\`)
  .join("\n")}
      *) echo "No Typst release for this architecture" >&2; exit 1 ;; \\
    esac; \\
    curl -fsSL -o /tmp/typst.tar.xz "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-\${t}-unknown-linux-musl.tar.xz"; \\
    echo "\${sum}  /tmp/typst.tar.xz" | sha256sum -c -; \\
    tar -xJf /tmp/typst.tar.xz -C /tmp; \\
    install -m 755 "/tmp/typst-\${t}-unknown-linux-musl/typst" /usr/local/bin/typst

FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends poppler-utils \\
 && rm -rf /var/lib/apt/lists/*
COPY --from=typst /usr/local/bin/typst /usr/local/bin/typst
`;

/** Where Typst keeps downloaded packages (`@preview/…`) and local ones (`@local/…`), as the Typst CLI and Tinymist do. */
export function typstPackageDirs(platform = process.platform, env = process.env, home = homedir()): { cache: string; local: string } {
  // The given system's separators, not this one's (tests ask about every system on every system).
  const { join } = platform === "win32" ? win32 : posix;
  if (platform === "darwin")
    return { cache: join(home, "Library", "Caches", "typst", "packages"), local: join(home, "Library", "Application Support", "typst", "packages") };
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
    return { cache: join(local, "typst", "packages"), local: join(roaming, "typst", "packages") };
  }
  return {
    cache: join(env.XDG_CACHE_HOME || join(home, ".cache"), "typst", "packages"),
    local: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "typst", "packages"),
  };
}

/** The user's font folders: a document set in a font installed here looks the same in its preview. */
function fontDirs(platform = process.platform, home = homedir()): string[] {
  const { join } = platform === "win32" ? win32 : posix;
  const dirs =
    platform === "darwin"
      ? ["/System/Library/Fonts", "/Library/Fonts", join(home, "Library", "Fonts")]
      : platform === "win32"
        ? []
        : ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".local", "share", "fonts"), join(home, ".fonts")];
  return dirs.filter((d) => existsSync(d));
}

/** Where the packages and fonts are in the container. */
const PACKAGE_CACHE = "/typst-packages/cache";
const PACKAGE_LOCAL = "/typst-packages/local";
const FONTS = "/typst-fonts";

/**
 * What previews can use here. Never installs or downloads anything: when something is missing,
 * it says what and how to get it.
 */
async function detect(preview: PreviewConfig, opts: { podman?: string | null } = {}): Promise<PreviewEnv> {
  const cfg = preview as TypstPreview;
  if (cfg.isolation !== "process") {
    const rt = await containerRuntime(opts, "Typst");
    if ("status" in rt) return rt;
    const { podman, memoryLimit } = rt;
    // The user's packages and fonts, read-only; paths Podman would read wrongly (':' or ',') are left out.
    const plain = (p: string) => existsSync(p) && !/[:,]/.test(p);
    const pkgs = typstPackageDirs();
    const mounts: [string, string][] = [
      ...(plain(pkgs.cache) ? [[pkgs.cache, PACKAGE_CACHE] as [string, string]] : []),
      ...(plain(pkgs.local) ? [[pkgs.local, PACKAGE_LOCAL] as [string, string]] : []),
      ...fontDirs()
        .filter(plain)
        .map((d, k) => [d, `${FONTS}/${k}`] as [string, string]),
    ];
    const download = `Debian, Poppler and Typst ${TYPST_VERSION}, about 150 MB`;
    const base = {
      isolation: "container" as const,
      podman,
      toolSource: "image" as const,
      image: cfg.typstImage,
      download,
      bin: "/usr/local/bin",
      ...(mounts.length ? { mounts } : {}),
    };
    if ((await runProgram(podman, ["image", "exists", cfg.typstImage])).code !== 0) {
      return {
        status: "needs-setup",
        ...base,
        message: "PDF previews run in a container, whose image isn't built yet.",
        fix: `Build it once with \`stet preview setup\` or the Set up button (downloads ${download}).`,
      };
    }
    return { status: "ready", ...base, memoryLimit, message: "PDF previews run in an isolated container, with the Typst in its image." };
  }

  // A normal process: the user's explicit choice, with their own Typst and Poppler.
  const typst = await which("typst");
  if (!typst) {
    return {
      status: "unavailable",
      isolation: "process",
      message: "PDF previews need Typst, which isn't on the PATH.",
      fix: "Install Typst (typst.app/open-source), then try again (in VS Code: reload the window).",
    };
  }
  const poppler = await popplerMissing();
  if (poppler) return poppler;
  return {
    status: "ready",
    isolation: "process",
    bin: dirname(typst),
    message:
      'PDF previews run as a normal process (preview.isolation is "process"): Typst can read every file in the project, and download packages. Use this only for material you trust.',
  };
}

/** Build the image previews need. Downloads packages: only on the user's explicit request. */
async function setupImage(preview: PreviewConfig, opts: { action?: string; extras?: boolean } = {}): Promise<{ ok: boolean; log: string }> {
  // Typst has no extras: its fonts and packages come with the document (core profile review db49f7d, 9).
  if (opts.action || opts.extras) return { ok: false, log: `Typst previews have nothing to set up as '${opts.action ?? "extras"}'.` };
  const env = await detectPreviewEnv(preview, TYPST_TYPESETTER);
  if (env.isolation !== "container" || !env.podman || !env.image) return { ok: false, log: `${env.message}${env.fix ? ` ${env.fix}` : ""}` };
  return buildImage(env.podman, env.image, TYPST_CONTAINERFILE);
}

/** The environment of a build: the user's packages and fonts. */
function buildEnv(env: PreviewEnv, home: string, container: boolean): Record<string, string> {
  if (!container) {
    // Its home folder is the build's own: Typst would look for packages there.
    const pkgs = typstPackageDirs();
    return { TYPST_PACKAGE_CACHE_PATH: pkgs.cache, TYPST_PACKAGE_PATH: pkgs.local };
  }
  const at = new Set((env.mounts ?? []).map(([, a]) => a));
  const fonts = [...at].filter((a) => a.startsWith(`${FONTS}/`));
  return {
    TYPST_PACKAGE_CACHE_PATH: at.has(PACKAGE_CACHE) ? PACKAGE_CACHE : `${home}/typst-packages`,
    TYPST_PACKAGE_PATH: at.has(PACKAGE_LOCAL) ? PACKAGE_LOCAL : `${home}/typst-local`,
    ...(fonts.length ? { TYPST_FONT_PATHS: fonts.join(":") } : {}),
  };
}

// ---------------------------------------------------------------------------
// The document

/** Files a Typst file includes or imports (`#include "ch1.typ"`, `#import "template.typ": *`). */
const READS = /#?\b(?:include|import)\s+"([^"@][^"]*)"/g;

/** The document to compile: `rootFile`, else `main.typ`, else the one top-level .typ file no other file reads in. Null if unclear. */
export function detectRoot(files: Map<string, string>, rootFile: string | null): string | null {
  if (rootFile) return files.has(rootFile) ? rootFile : null;
  if (files.has("main.typ")) return "main.typ";
  const read = new Set<string>();
  for (const [path, text] of files) {
    for (const m of text.replace(/(^|[^:])\/\/.*$/gm, "$1").matchAll(READS)) {
      const ref = m[1]!.trim();
      read.add(ref.startsWith("/") ? ref.slice(1) : posix.normalize(posix.join(posix.dirname(path), ref)));
    }
  }
  // A name starting with "-" would reach typst as an option, not a file: never taken.
  const top = [...files.keys()].filter((p) => !p.includes("/") && !p.startsWith("-") && /\.typ$/i.test(p) && !read.has(p));
  return top.length === 1 ? top[0]! : null;
}

const pdfOf = (root: string) => `stet-build/${posix.basename(root).replace(/\.typ$/i, "")}.pdf`;

/** Compile `root` in `work`; the PDF path, or null with Typst's diagnostics. */
async function compile(run: RunIsolated, work: string, root: string): Promise<{ pdf: string | null; log: string }> {
  await mkdir(join(work, "stet-build"), { recursive: true });
  const out = pdfOf(root);
  const r = await run(work, ["typst", "compile", "--root", ".", "--diagnostic-format", "short", root, out]);
  const pdf = join(work, out);
  const log = (r.stdout + r.stderr).trim();
  return r.code === 0 && existsSync(pdf) ? { pdf, log } : { pdf: null, log };
}

// ---------------------------------------------------------------------------
// Where markup is: the places a marker can go

interface Frame {
  mode: "markup" | "code" | "math" | "raw" | "string" | "comment";
  /** What closes it: a bracket, `$`, a raw fence, `"`, `*\/`; "\n" for a statement (`#if …`); null at the top. */
  close: string | null;
  /** The place in markup just before what this is in (`#figure(`, `$`), for its lines: null if it shows nothing. */
  anchor: number | null;
  /** Inside a definition (`#let`, `#set`, `#show`, `#import`, `#include`): nothing here has a place of its own. */
  hidden: boolean;
}

export interface TypstScan {
  /** Offsets where a marker may go, in order, with their (0-based) lines. */
  points: { at: number; line: number }[];
  /**
   * For each line that doesn't start in markup, the place a marker for it may go: the markup
   * just before the code, maths or raw text it is in. Null: it has no place on the page.
   */
  anchors: Map<number, number | null>;
  /** Definitions (`#let …`, `#set …`, `#show …`, imports): [start, end) offsets. */
  hidden: [number, number][];
  /** Which characters are markup's text (not code, maths, labels or definitions). */
  text: Uint8Array;
}

/** Statements that define something rather than show it. */
const DEFINES = new Set(["let", "set", "show", "import", "include"]);
/** Statements whose content is shown where they are. */
const SHOWS = new Set(["if", "for", "while", "context", "return", "break", "continue"]);
const IDENT_START = /[\p{L}_]/u;
const IDENT = /[\p{L}\p{N}_-]/u;
const LABEL_AT = /^<[\p{L}\p{N}_][\p{L}\p{N}_:.-]*>/u;
/** A line's markup a marker goes after: a heading's `=`, a list's or an enumeration's marker, a term's `/`. */
const LINE_MARKUP = /^(?:=+|[-+/]|\d+\.)[ \t]+/;
/** Lines no marker starts: comments, closing brackets, labels, definitions. */
const NO_POINT = /^(?:\/\/|\/\*|[\])}]|<[\p{L}\p{N}_]|#(?:let|set|show|import|include)\b)/u;

/** Where markup is in Typst source: where markers can go, and what each other line is found by. */
export function scan(text: string): TypstScan {
  const points: TypstScan["points"] = [];
  const anchors = new Map<number, number | null>();
  const hidden: [number, number][] = [];
  const shown = new Uint8Array(text.length);
  const stack: Frame[] = [{ mode: "markup", close: null, anchor: null, hidden: false }];
  const top = () => stack[stack.length - 1]!;
  let hiddenFrom = -1;
  let line = 0;
  let i = 0;

  const push = (f: Omit<Frame, "hidden"> & { hidden?: boolean }) => stack.push({ ...f, hidden: !!f.hidden || top().hidden });
  const pop = (to = stack.length - 1) => {
    const was = top().hidden;
    stack.length = Math.max(1, to);
    if (was && !top().hidden) hidden.push([hiddenFrom, i]);
  };
  /** A child's anchor: here, if this is markup; else this frame's own. */
  const anchorHere = () => (top().mode === "markup" ? i : top().anchor);
  /** A marker right after `[`, before text on the same line. */
  const afterBracket = (at: number) => {
    if (top().hidden) return;
    const rest = text.slice(at, at + 200);
    // After a heading's `=` or a list's `-` that starts the content (`[- item]`).
    const m = LINE_MARKUP.exec(rest);
    const after = m ? rest.slice(m[0].length) : rest;
    if (/^[^\s\]]/.test(after) && !NO_POINT.test(after)) points.push({ at: at + (m?.[0].length ?? 0), line });
  };
  /** At the start of a line: a marker at its text, if it is markup; else what finds it. */
  const lineStart = () => {
    const f = top();
    if (f.mode !== "markup") {
      anchors.set(line, f.hidden || f.mode === "comment" ? null : f.anchor);
      return;
    }
    if (f.hidden) {
      anchors.set(line, null);
      return;
    }
    let j = i;
    while (text[j] === " " || text[j] === "\t") j++;
    const rest = text.slice(j, j + 200);
    if (!rest || rest[0] === "\n" || rest[0] === "\r" || NO_POINT.test(rest)) return;
    const m = LINE_MARKUP.exec(rest);
    if (m) {
      j += m[0].length;
      if (/^[\r\n]|^$/.test(text.slice(j, j + 1)) || NO_POINT.test(text.slice(j, j + 200))) return;
    }
    points.push({ at: j, line });
  };
  /** A closing bracket closes its frame (and statements left open inside it). */
  const closes = (c: string): boolean => {
    const k = stack.findLastIndex((f) => f.close === c);
    if (k <= 0 || stack.slice(k + 1).some((f) => f.close !== "\n")) return false;
    i++;
    pop(k);
    return true;
  };
  const raw = () => {
    let n = 0;
    while (text[i + n] === "`") n++;
    if (n === 2) {
      i += 2; // empty raw text
      return;
    }
    const fence = "`".repeat(n);
    push({ mode: "raw", close: fence, anchor: anchorHere() });
    i += n;
  };
  const comment = (): boolean => {
    if (text.startsWith("//", i) && !(top().mode === "markup" && /[a-z]:$/i.test(text.slice(Math.max(0, i - 8), i)))) {
      while (i < text.length && text[i] !== "\n") i++;
      return true;
    }
    if (text.startsWith("/*", i)) {
      push({ mode: "comment", close: "*/", anchor: null });
      i += 2;
      return true;
    }
    return false;
  };
  /** `#…` in markup or maths: a statement, a call with its brackets, a block; else nothing to track. */
  const hash = () => {
    const from = i;
    const anchor = anchorHere();
    i++;
    const c = text[i];
    if (c && IDENT_START.test(c)) {
      const s = i;
      while (i < text.length && IDENT.test(text[i]!)) i++;
      const name = text.slice(s, i);
      if (DEFINES.has(name)) {
        if (!top().hidden) hiddenFrom = from;
        push({ mode: "code", close: "\n", anchor: null, hidden: true });
      } else if (SHOWS.has(name)) push({ mode: "code", close: "\n", anchor });
      else {
        while (text[i] === "." && text[i + 1] && IDENT_START.test(text[i + 1]!)) {
          i++;
          while (i < text.length && IDENT.test(text[i]!)) i++;
        }
        if (text[i] === "(") {
          i++;
          push({ mode: "code", close: ")", anchor });
        }
      }
    } else if (c === "(" || c === "{") {
      i++;
      push({ mode: "code", close: c === "(" ? ")" : "}", anchor });
    } else if (c === "[") {
      i++;
      push({ mode: "markup", close: "]", anchor });
      afterBracket(i);
    }
  };

  lineStart();
  while (i < text.length) {
    const f = top();
    const c = text[i]!;
    if (c === "\n") {
      i++;
      if (f.close === "\n") pop();
      line++;
      lineStart();
      continue;
    }
    switch (f.mode) {
      case "comment":
        if (text.startsWith("*/", i)) {
          i += 2;
          pop();
        } else if (text.startsWith("/*", i)) {
          push({ mode: "comment", close: "*/", anchor: null });
          i += 2;
        } else i++;
        continue;
      case "raw":
        if (text.startsWith(f.close!, i)) {
          i += f.close!.length;
          pop();
        } else {
          // Raw text is shown as it is (a fenced block's first word is its language).
          if (!f.hidden) shown[i] = 1;
          i++;
        }
        continue;
      case "string":
        if (c === "\\") i += 2;
        else {
          i++;
          if (c === '"') pop();
        }
        continue;
      case "math":
        if (c === "\\") i += 2;
        else if (c === "$") {
          i++;
          pop();
        } else if (c === '"') {
          push({ mode: "string", close: '"', anchor: f.anchor });
          i++;
        } else if (!comment()) i++;
        continue;
      case "code":
        if (comment()) continue;
        if ((c === ")" || c === "}" || c === "]") && closes(c)) continue;
        i++;
        if (c === "(") push({ mode: "code", close: ")", anchor: f.anchor });
        else if (c === "{") push({ mode: "code", close: "}", anchor: f.anchor });
        else if (c === "[") {
          push({ mode: "markup", close: "]", anchor: f.anchor });
          afterBracket(i);
        } else if (c === "$") push({ mode: "math", close: "$", anchor: f.anchor });
        else if (c === '"') push({ mode: "string", close: '"', anchor: f.anchor });
        else if (c === "`") {
          i--;
          raw();
        } else if (c === ";" && f.close === "\n") pop();
        continue;
      default: {
        // Markup.
        if (c === "\\") {
          if (text[i + 1] !== "\n" && !f.hidden) shown[i + 1] = 1;
          i += text[i + 1] === "\n" ? 1 : 2;
        } else if (comment()) continue;
        else if (c === "]" && closes("]")) continue;
        else if (c === "#") hash();
        else if (c === "$") {
          push({ mode: "math", close: "$", anchor: i });
          i++;
        } else if (c === "`") raw();
        else if (c === "[") {
          push({ mode: "markup", close: "]", anchor: i });
          i++;
          afterBracket(i);
        } else if (c === "<" && LABEL_AT.test(text.slice(i, i + 200))) i += LABEL_AT.exec(text.slice(i, i + 200))![0].length;
        else {
          if (!f.hidden) shown[i] = 1;
          i++;
        }
      }
    }
  }
  if (stack.some((f) => f.hidden)) hidden.push([hiddenFrom, text.length]);
  return { points, anchors, hidden, text: shown };
}

/** Whether `offset` is in a definition: a `#let`, a `#set` or `#show` rule, an import. */
export const inDefinition = (text: string, offset: number) => scan(text).hidden.some(([a, b]) => offset >= a && offset < b);

/**
 * The marker offsets for (0-based) lines `first`..`last`: the markup points on them; else the
 * places that find their code or maths; none if they show nothing (a definition, a comment).
 */
export function markerSpots(text: string, first: number, last: number, max = 60): number[] {
  const s = scan(text);
  const at = s.points.filter((p) => p.line >= first && p.line <= last).map((p) => p.at);
  if (at.length) return [...new Set(at)].slice(0, max);
  const anchors: number[] = [];
  for (let l = first; l <= last; l++) {
    const a = s.anchors.get(l);
    if (typeof a === "number") anchors.push(a);
  }
  return [...new Set(anchors)].sort((a, b) => a - b).slice(0, max);
}

/** The marker numbered `n`: invisible, and `;` ends it, so `(`, `[` or `.` after it stay text. */
export const marker = (n: number) => `#context[#metadata((n: ${n}, pos: here().position()))<stet-at>];`;

/** `text` with markers at `spots` (numbered in order). */
export function withMarkers(text: string, spots: number[]): string {
  let out = text;
  for (const [n, at] of [...spots.entries()].sort((a, b) => b[1] - a[1])) out = out.slice(0, at) + marker(n) + out.slice(at);
  return out;
}

/** The answer of `typst eval` for the markers: where each is, in points from the page's top-left corner. */
export function parsePositions(out: string): { n: number; page: number; x: number; y: number }[] {
  let data: unknown;
  try {
    data = JSON.parse(out);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data.flatMap((d) => {
    const pos = d?.pos;
    const x = Number.parseFloat(pos?.x);
    const y = Number.parseFloat(pos?.y);
    return Number.isInteger(d?.n) && Number.isInteger(pos?.page) && Number.isFinite(x) && Number.isFinite(y)
      ? [{ n: d.n as number, page: pos.page as number, x, y }]
      : [];
  });
}

/**
 * A copy of the build folder `from` at `to` with hard links (the files aren't duplicated; nothing
 * in it is written to but the file that is replaced). Leaves out builds' outputs and scratch.
 */
async function mirror(from: string, to: string, top = true): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (top && (e.name === "stet-build" || e.name === "stet-home" || e.name.startsWith(".stet-locate-") || e.name.startsWith(".region-"))) continue;
    const a = join(from, e.name);
    const b = join(to, e.name);
    if (e.isDirectory()) await mirror(a, b, false);
    else if (e.isFile()) await link(a, b).catch(() => copyFile(a, b, constants.COPYFILE_FICLONE));
  }
}

/**
 * Where (1-based) source lines of `file` are on the page: markers at those lines, in a scratch
 * copy of the build, and `typst eval` asked where they ended up. Null if they show nothing.
 */
async function locate(run: RunIsolated, work: string, _pdfRel: string, file: string, lines: number[], root?: string): Promise<SourceBox[] | null> {
  if (!root || !lines.length) return null;
  const path = resolve(work, file);
  if (relative(work, path).startsWith("..")) return null;
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  const spots = markerSpots(text, Math.min(...lines) - 1, Math.max(...lines) - 1);
  if (!spots.length) return null;
  const scratch = join(work, `.stet-locate-${Math.random().toString(36).slice(2, 10)}`);
  try {
    await mirror(work, scratch);
    // The marked file replaces its link: the build's own stays as it is.
    const marked = join(scratch, file);
    await rm(marked, { force: true });
    await writeFile(marked, withMarkers(text, spots));
    const r = await run(scratch, ["typst", "eval", "query(<stet-at>).map(it => it.value)", "--in", root, "--root", "."]);
    if (r.code !== 0) return null;
    // In the markers' order (the source's), each where it shows: content shown twice (a heading in the outline) has two.
    const at = parsePositions(r.stdout).sort((a, b) => a.n - b.n);
    if (!at.length) return null;
    return at.map((p) => ({ page: p.page, h: p.x, v: p.y + 10, W: 1, H: 12 }));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Diagnostics, and the words on the page

const DIAGNOSTIC = /^(?:(.+?):\d+:\d+: )?error: (.*)$/;

/** The errors in Typst's diagnostics (short format), without line numbers (which a change shifts). */
export function errorsOf(log: string): string[] {
  return log.split(/\r?\n/).flatMap((l) => {
    const m = DIAGNOSTIC.exec(l.trim());
    return m ? [`${m[1] ? `${m[1]}: ` : ""}${m[2]!.replace(/\d+/g, "#").trim()}`] : [];
  });
}

/** Packages Typst couldn't find or download (`@preview/cetz:0.3.1`). */
export function missingFiles(log: string): string[] {
  const out = new Set<string>();
  for (const m of log.matchAll(/failed to download package \([^)\s]*\/([\w-]+)\/([\w-]+)-(\d+\.\d+\.\d+)\.tar\.gz/g)) out.add(`@${m[1]}/${m[2]}:${m[3]}`);
  for (const m of log.matchAll(/package not found \(searched for (@[^)\s]+)\)/g)) out.add(m[1]!);
  return [...out];
}

/** The part of Typst's diagnostics that says what went wrong: errors first. */
export function excerpt(log: string, max = 40): string {
  const lines = log.split(/\r?\n/);
  const i = lines.findIndex((l) => DIAGNOSTIC.test(l.trim()));
  return (i >= 0 ? lines.slice(i, i + max) : lines.slice(-max)).join("\n").trim();
}

/** The words Typst source typesets, roughly: markup's text, without references and markup's own signs. */
export function plainWords(typst: string): string[] {
  const shown = scan(typst).text;
  const t = typst
    .split("")
    .map((c, k) => (shown[k] || c === "\n" ? c : " "))
    .join("")
    .replace(/@[\p{L}\p{N}_][\p{L}\p{N}_:.-]*/gu, " ")
    .replace(/^[ \t]*(?:=+|[-+/]|\d+\.)[ \t]/gm, " ")
    .replace(/[[\]*_~]/g, " ");
  return t
    .split(/\s+/)
    .map(normWord)
    .filter((w) => w.length >= 2);
}

export const TYPST_TYPESETTER: Typesetter = {
  name: "Typst",
  program: "Typst",
  source: /\.typ$/i,
  sourceName: ".typ files",
  rootHint: "main.typ",
  engines: [],
  settings: { defaults: { ...TYPST_SETTINGS }, check: checkSettings },
  detect,
  setupImage,
  doctor: async (whichVersion) => {
    const v = await whichVersion("typst", ["--version"]);
    const check: DoctorCheck = v
      ? { name: "typst", status: "ok", message: v.split("\n")[0]!.trim() }
      : { name: "typst", status: "info", message: "not found (PDF previews use the one in their container)" };
    return [check];
  },
  buildEnv,
  detectRoot: (files, cfg) => detectRoot(files, cfg.rootFile),
  compile: (run, work, root) => compile(run, work, root),
  outputs: (root) => [pdfOf(root)],
  noSpot: (text, offset) => inDefinition(text, offset),
  locate,
  errorsOf,
  missingFiles,
  excerpt,
  plainWords,
  installHint: () => "your Typst package cache (compiling the document once with Typst or Tinymist downloads it)",
};
