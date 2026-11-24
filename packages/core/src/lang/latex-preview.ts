/**
 * PDF previews of LaTeX documents (spec §14): latexmk in the user's TeX Live (mounted read-only
 * into a container) or in the image's own, SyncTeX to find a change on the page, TeX's log for
 * errors and missing packages. The generic part (isolation, pages, words) is in `preview.ts`.
 */
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { buildImage, containerRuntime, detectPreviewEnv, normWord, popplerMissing, runProgram, which } from "./kit.js";
import type { DoctorCheck, PreviewConfig, PreviewEnv, RunIsolated, SourceBox, Typesetter } from "./profile.js";

// ---------------------------------------------------------------------------
// LaTeX's own preview settings (`preview.*` in the config)

export const PREVIEW_TEX = ["auto", "host", "image"] as const;

export interface TexPreviewSettings {
  /** Where TeX comes from: `auto` (the user's standalone TeX Live on Linux, else the image's), `host` or `image`. */
  tex: (typeof PREVIEW_TEX)[number];
  /** The container image with its own TeX Live, for macOS and Linux without a standalone TeX Live. */
  texImage: string;
  /**
   * Use the image with its own TeX plus Debian's extra fonts (dsfont, bbm, bbold, …), about 2 GB
   * more. Off by default; switched on when the user agrees to install them after a missing file.
   */
  texExtras: boolean;
  texExtrasImage: string;
}

/** The preview settings with LaTeX's own, which `settings.check` has checked. */
type TexPreview = PreviewConfig & TexPreviewSettings;

const TEX_SETTINGS: TexPreviewSettings = {
  tex: "auto",
  texImage: "localhost/stet-preview-tex:1",
  texExtras: false,
  texExtrasImage: "localhost/stet-preview-tex-extra:1",
};

const IMAGE_NAME = /^[a-z0-9][a-z0-9._/:@-]*$/i;

function checkSettings(pv: PreviewConfig): string[] {
  const out: string[] = [];
  if (typeof pv.texImage !== "string" || !IMAGE_NAME.test(pv.texImage)) out.push(`preview.texImage '${pv.texImage}'`);
  if (!PREVIEW_TEX.includes(pv.tex as TexPreviewSettings["tex"])) out.push(`preview.tex '${pv.tex}' (${PREVIEW_TEX.join(", ")})`);
  if (typeof pv.texExtras !== "boolean") out.push("preview.texExtras (true or false)");
  if (typeof pv.texExtrasImage !== "string" || !IMAGE_NAME.test(pv.texExtrasImage)) out.push(`preview.texExtrasImage '${pv.texExtrasImage}'`);
  return out;
}

// ---------------------------------------------------------------------------
// The tool chain

/** The image `stet preview setup` builds: TeX comes from the user's own TeX Live, mounted read-only. */
export const PREVIEW_CONTAINERFILE = `# Stet PDF previews: Perl for latexmk, Poppler to read and render PDFs. TeX itself is the user's
# TeX Live, mounted read-only when a preview is built.
FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends perl poppler-utils \\
 && rm -rf /var/lib/apt/lists/*
`;

/** The extra fonts, as a layer on the image with its own TeX: only they are downloaded. */
export const previewExtrasContainerfile = (base: string) => `# Stet PDF previews with their own TeX, plus Debian's extra fonts (dsfont, bbm, bbold, …).
FROM ${base}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends texlive-fonts-extra \\
 && rm -rf /var/lib/apt/lists/*
`;

/** The image with its own TeX Live (Debian's), where the user's TeX can't be mounted: macOS, a distribution's TeX. */
export const PREVIEW_TEX_CONTAINERFILE = `# Stet PDF previews with their own TeX: Debian's TeX Live with the common packages, latexmk,
# Biber and Poppler. Used where the user's TeX can't run in a Linux container (macOS).
FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends perl poppler-utils latexmk biber \\
      texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended \\
      texlive-science texlive-bibtex-extra texlive-pictures texlive-publishers texlive-xetex texlive-luatex \\
      lmodern cm-super \\
 && rm -rf /var/lib/apt/lists/*
`;

/** The user's own TeX packages: ~/texmf, or MacTeX's ~/Library/texmf. */
function userTexmf(): string | undefined {
  const home = process.env.HOME;
  if (!home) return undefined;
  return [join(home, "texmf"), join(home, "Library", "texmf")].find((p) => existsSync(p));
}

/**
 * What previews can use here. Never installs or downloads anything: when something is missing,
 * it says what and how to get it.
 */
async function detect(preview: PreviewConfig, opts: { podman?: string | null } = {}): Promise<PreviewEnv> {
  const cfg = preview as TexPreview;
  // The host's TeX, if any. A standalone TeX Live on Linux (<root>/bin/<arch>, texmf-dist) can be
  // mounted into the container; MacTeX's programs are macOS ones and can't run there.
  const latexmk = await which("latexmk");
  let texBin: string | undefined;
  let texMount: string | undefined;
  if (latexmk) {
    // Where the TeX program really is: latexmk is a link to a Perl script inside texmf-dist.
    const tex = (await which("pdftex")) ?? (await which("tex")) ?? latexmk;
    texBin = dirname(await realpath(tex));
    const texRoot = dirname(dirname(texBin));
    if (process.platform === "linux" && existsSync(join(texRoot, "texmf-dist")))
      texMount = existsSync(join(dirname(texRoot), "texmf-local")) ? dirname(texRoot) : texRoot;
  }
  const texmfHome = userTexmf();

  if (cfg.isolation !== "process") {
    const rt = await containerRuntime(opts, "TeX");
    if ("status" in rt) return rt;
    const { podman, memoryLimit } = rt;
    // Where TeX comes from: the user's (mounted read-only) or the image's own.
    const source: "host" | "image" = cfg.tex === "image" || (cfg.tex === "auto" && !texMount) ? "image" : "host";
    if (source === "host" && !texMount) {
      return {
        status: "unavailable",
        isolation: "container",
        message: `preview.tex is "host", but ${latexmk ? `${texBin} isn't a standalone TeX Live for Linux` : "no TeX (latexmk) is on the PATH"}, which the container could use.`,
        fix: 'Set preview.tex to "auto" (the image then brings its own TeX), or install TeX Live from tug.org.',
      };
    }
    // Podman's mount syntax separates with ':' and ','; such paths would be read wrongly.
    const odd = [source === "host" ? texMount : undefined, texmfHome].find((p) => p && /[:,]/.test(p));
    if (odd) {
      return {
        status: "unavailable",
        isolation: "container",
        message: `PDF previews can't mount ${odd} into a container: its path contains ':' or ','.`,
        fix: "Move it to a path without those characters.",
      };
    }
    const image = source === "host" ? cfg.image : cfg.texExtras ? cfg.texExtrasImage : cfg.texImage;
    const mounts: [string, string][] = [
      ...(source === "host" ? [[texMount!, texMount!] as [string, string]] : []),
      ...(texmfHome ? [[texmfHome, TEXMF_HOME] as [string, string]] : []),
    ];
    const base = {
      isolation: "container" as const,
      podman,
      toolSource: source,
      image,
      extrasAvailable: source === "image" && !cfg.texExtras,
      bin: source === "host" ? texBin! : "/usr/bin",
      ...(mounts.length ? { mounts } : {}),
    };
    if ((await runProgram(podman, ["image", "exists", image])).code !== 0) {
      return {
        status: "needs-setup",
        ...base,
        message: "PDF previews run in a container, whose image isn't built yet.",
        fix:
          source === "host"
            ? "Build it once with `stet preview setup` or the Set up button (downloads Debian, Perl and Poppler, about 150 MB; TeX is yours)."
            : cfg.texExtras
              ? "Build it once with `stet preview setup --extras` or the Set up button (Debian with TeX Live and its extra fonts, about 3 GB)."
              : "Build it once with `stet preview setup` or the Set up button (downloads Debian with TeX Live, Perl and Poppler, about 1 GB).",
      };
    }
    return {
      status: "ready",
      ...base,
      memoryLimit,
      message: `PDF previews run in an isolated container${source === "image" ? ", with the TeX in its image" : ""}.`,
    };
  }

  // A normal process: the user's explicit choice, with their own TeX and Poppler.
  if (!latexmk) {
    return {
      status: "unavailable",
      isolation: "process",
      message: "PDF previews need a TeX distribution with latexmk, which isn't on the PATH.",
      fix: "Install TeX Live (tug.org/texlive) or MiKTeX, then try again (in VS Code: reload the window).",
    };
  }
  const poppler = await popplerMissing();
  if (poppler) return poppler;
  return {
    status: "ready",
    isolation: "process",
    bin: texBin!,
    message:
      'PDF previews run as a normal process (preview.isolation is "process"): TeX can read every file you can, so a proposal could copy one into its preview. Use this only for material you trust.',
  };
}

/**
 * Build the image previews need here: with the user's TeX mounted (Debian, Perl and Poppler), or
 * with its own TeX Live. Downloads packages: only on the user's explicit request.
 */
async function setupImage(preview: PreviewConfig, opts: { extras?: boolean } = {}): Promise<{ ok: boolean; log: string; settings?: Record<string, unknown> }> {
  const r = await buildImages(preview as TexPreview, opts);
  // From now on the image with the extra fonts.
  return r.ok && opts.extras ? { ...r, settings: { texExtras: true } } : r;
}

async function buildImages(cfg: TexPreview, opts: { extras?: boolean }): Promise<{ ok: boolean; log: string }> {
  const env = await detectPreviewEnv(opts.extras ? { ...cfg, texExtras: true } : cfg, LATEX_TYPESETTER);
  if (env.isolation !== "container" || !env.podman || !env.image) return { ok: false, log: `${env.message}${env.fix ? ` ${env.fix}` : ""}` };
  if (opts.extras && env.toolSource !== "image")
    return { ok: false, log: "Previews use your own TeX here: install missing packages there (e.g. `tlmgr install <package>`)." };
  const build = (tag: string, containerfile: string) => buildImage(env.podman!, tag, containerfile);
  if (env.toolSource !== "image") return build(env.image, PREVIEW_CONTAINERFILE);
  // The extra fonts are a layer on the image with its own TeX: build that first if it's missing.
  if (!opts.extras && !cfg.texExtras) return build(cfg.texImage, PREVIEW_TEX_CONTAINERFILE);
  if ((await runProgram(env.podman, ["image", "exists", cfg.texImage])).code !== 0) {
    const first = await build(cfg.texImage, PREVIEW_TEX_CONTAINERFILE);
    if (!first.ok) return first;
  }
  return build(cfg.texExtrasImage, previewExtrasContainerfile(cfg.texImage));
}

/** TeX's own restrictions, in every build (kpathsea reads these from the environment). They stop shell escape and writes, not reads. */
const TEX_ENV = { openin_any: "p", openout_any: "p", shell_escape: "f" };

/** Where the user's own TeX packages are in the container. */
const TEXMF_HOME = "/texmf-home";

/** The environment of a build: TeX's cache in its home folder, the user's packages, TeX's restrictions. */
function buildEnv(env: PreviewEnv, home: string, container: boolean): Record<string, string> {
  if (!container) return { TEXMFVAR: join(home, "texmf-var"), ...TEX_ENV };
  return { TEXMFVAR: `${home}/texmf-var`, ...(env.mounts?.some(([, at]) => at === TEXMF_HOME) ? { TEXMFHOME: TEXMF_HOME } : {}), ...TEX_ENV };
}

// ---------------------------------------------------------------------------
// The document

/** Which TeX engine a document wants. */
export function detectEngine(rootText: string): "pdflatex" | "xelatex" | "lualatex" {
  const magic = /^%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(rootText)?.[1]?.toLowerCase();
  if (magic === "xelatex" || magic === "lualatex" || magic === "pdflatex") return magic;
  if (/\\usepackage(?:\[[^\]]*\])?\{[^}]*\b(?:fontspec|unicode-math)\b/.test(rootText)) return "lualatex";
  return "pdflatex";
}

const isDocument = (t: string) => /\\documentclass/.test(t) && /\\begin\s*\{document\}/.test(t);

/** The document to compile: `rootFile`, else `main.tex`, else the one top-level document. Null if unclear. */
export function detectRoot(files: Map<string, string>, rootFile: string | null): string | null {
  if (rootFile) return files.has(rootFile) ? rootFile : null;
  const main = files.get("main.tex");
  if (main !== undefined && isDocument(main)) return "main.tex";
  // A name starting with "-" would reach latexmk as an option, not a file: never taken (security
  // report 5e4c6af, S18; the configured rootFile refuses such names too).
  const top = [...files].filter(([p, t]) => !p.includes("/") && !p.startsWith("-") && p.endsWith(".tex") && isDocument(t)).map(([p]) => p);
  return top.length === 1 ? top[0]! : null;
}

/** Compile `root` in `work` with latexmk; the PDF path, or null with the log. */
async function compile(run: RunIsolated, work: string, root: string, cfg: PreviewConfig): Promise<{ pdf: string | null; log: string }> {
  const engine = cfg.engine === "auto" ? detectEngine((await readFile(join(work, root), "utf8").catch(() => "")) || "") : cfg.engine;
  const flag = engine === "xelatex" ? "-xelatex" : engine === "lualatex" ? "-lualatex" : "-pdf";
  const r = await run(work, [
    // -f, and no -halt-on-error: a paper with a small error somewhere still gets its PDF (as
    // when the author compiles it), and so its previews. Errors are reported next to them.
    "latexmk",
    "-norc",
    flag,
    "-f",
    "-interaction=nonstopmode",
    "-file-line-error",
    "-synctex=1",
    "-outdir=stet-build",
    root,
  ]);
  const stem = posix.basename(root).replace(/\.tex$/i, "");
  const pdf = join(work, "stet-build", `${stem}.pdf`);
  const log = await readFile(join(work, "stet-build", `${stem}.log`), "utf8").catch(() => r.stdout + r.stderr);
  return existsSync(pdf) ? { pdf, log } : { pdf: null, log: log || r.stdout + r.stderr };
}

// ---------------------------------------------------------------------------
// SyncTeX: where source lines are on the page

/** Parse `synctex view` output into boxes. */
export function parseSynctex(out: string): SourceBox[] {
  const boxes: SourceBox[] = [];
  let cur: Partial<SourceBox> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(Page|h|v|W|H):(-?[\d.]+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1] === "Page" ? "page" : (m[1] as "h" | "v" | "W" | "H");
    if (key === "page" && cur.page !== undefined) cur = {};
    cur[key] = Number(m[2]);
    if (cur.page !== undefined && cur.h !== undefined && cur.v !== undefined && cur.W !== undefined && cur.H !== undefined) {
      boxes.push(cur as SourceBox);
      cur = {};
    }
  }
  return boxes;
}

/** Whether SyncTeX's `Input:` name is the repository file `file` (it may be `./file`, or absolute in the build folder). */
export function sameSource(input: string, file: string): boolean {
  const norm = (p: string) =>
    p
      .replace(/\\/g, "/")
      .replace(/^(\.\/)+/, "")
      .replace(/\/(\.\/)+/g, "/");
  const a = norm(input);
  const f = norm(file);
  return a === f || a.endsWith("/" + f) || a === f.replace(/\.tex$/i, "") || a.endsWith("/" + f.replace(/\.tex$/i, ""));
}

/**
 * Where source lines of `file` are on the page, by SyncTeX. Null if they typeset nothing there:
 * SyncTeX falls back to the nearest text for lines that typeset nothing (definitions in an
 * included file), so it is asked back which file is at that spot; another one means no spot.
 */
async function locate(run: RunIsolated, work: string, pdfRel: string, file: string, lines: number[]): Promise<SourceBox[] | null> {
  const boxes: SourceBox[] = [];
  for (const line of [...new Set(lines)]) {
    const r = await run(work, ["synctex", "view", "-i", `${line}:0:${file}`, "-o", pdfRel]);
    if (r.code === 0) boxes.push(...parseSynctex(r.stdout));
  }
  if (!boxes.length) return null;
  const b = boxes[0]!;
  const back = await run(work, ["synctex", "edit", "-o", `${b.page}:${(b.h + b.W / 2).toFixed(1)}:${(b.v - b.H / 2).toFixed(1)}:${pdfRel}`]);
  const input = /^Input:(.*)$/m.exec(back.stdout)?.[1]?.trim();
  if (input && !sameSource(input, file)) return null;
  return boxes;
}

// ---------------------------------------------------------------------------
// The log, and the words on the page

/**
 * The errors in a LaTeX log, without line numbers (which a change shifts): each message with the
 * text TeX was at (its `l.<n> …` line), so "Undefined control sequence" at two places differs.
 */
export function errorsOf(log: string): string[] {
  const out: string[] = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^!\s*(.*)$/.exec(lines[i]!) ?? /^\S.*?:\d+:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let at = "";
    for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
      if (/^!|^\S.*?:\d+:/.test(lines[j]!)) break; // the next error: this one has no context
      const l = /^l\.\d+\s?(.*)$/.exec(lines[j]!);
      if (l) {
        at = l[1]!.trim().slice(-60);
        break;
      }
    }
    out.push(`${m[1]!.replace(/\d+/g, "#").trim()}${at ? ` @ ${at}` : ""}`);
  }
  return out;
}

/** Files LaTeX looked for and didn't find (`File \`dsfont.sty' not found`, `I can't find file`). */
export function missingFiles(log: string): string[] {
  const out = new Set<string>();
  for (const m of log.matchAll(/File [`'‘]([^'’\s]+)['’] not found/g)) out.add(m[1]!);
  for (const m of log.matchAll(/I can't find file [`'‘]([^'’\s]+)['’]/g)) out.add(m[1]!);
  return [...out];
}

/** The part of a LaTeX log that says what went wrong. */
export function excerpt(log: string, max = 40): string {
  const lines = log.split(/\r?\n/);
  const i = lines.findIndex((l) => /^!|^\S.*:\d+: /.test(l));
  return (i >= 0 ? lines.slice(i, i + max) : lines.slice(-max)).join("\n").trim();
}

/** The words LaTeX source typesets, roughly: no comments, commands, braces or maths. */
export function plainWords(latex: string): string[] {
  const t = latex
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\(?:label|ref|eqref|cref|Cref|cite\w*|begin|end|includegraphics|input|include)\*?(?:\[[^\]]*\])?\{[^}]*\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}~]/g, " ");
  return t
    .split(/\s+/)
    .map(normWord)
    .filter((w) => w.length >= 2);
}

export const LATEX_TYPESETTER: Typesetter = {
  name: "LaTeX",
  program: "TeX",
  source: /\.tex$/i,
  sourceName: ".tex files",
  rootHint: "main.tex",
  engines: ["pdflatex", "xelatex", "lualatex"],
  settings: { defaults: { ...TEX_SETTINGS }, check: checkSettings },
  detect,
  setupImage,
  doctor: async (whichVersion) => {
    const latexmk = await whichVersion("latexmk", ["-v"]);
    const check: DoctorCheck = latexmk
      ? {
          name: "latexmk",
          status: "ok",
          message:
            latexmk
              .split("\n")
              .find((l) => /latexmk/i.test(l))
              ?.trim() ?? "found",
        }
      : { name: "latexmk", status: "info", message: "not found (only needed for PDF previews)" };
    return [check];
  },
  buildEnv,
  detectRoot: (files, cfg) => detectRoot(files, cfg.rootFile),
  compile,
  outputs: (root) => {
    const stem = posix.basename(root).replace(/\.tex$/i, "");
    return ["pdf", "synctex.gz"].map((ext) => `stet-build/${stem}.${ext}`);
  },
  // The main file's preamble: SyncTeX would point at the first text instead.
  noSpot: (text, offset, isRoot) => {
    const begin = /\\begin\s*\{document\}/.exec(text)?.index ?? -1;
    return isRoot && begin >= 0 && offset < begin;
  },
  locate,
  errorsOf,
  missingFiles,
  excerpt,
  plainWords,
  installHint: (env, extras) =>
    env.toolSource === "image" ? `the preview's TeX${extras ? " (its extra fonts may have it)" : ""}` : "your TeX installation (tlmgr install …)",
};
