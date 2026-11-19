/**
 * PDF previews of a change (spec §14): the region of the compiled paper where a change lands,
 * before and after.
 *
 * Compiling a proposal runs TeX on text an agent wrote, and TeX is a programming language. TeX's
 * own restrictions stop shell escape and writing outside the build folder, but not reading:
 * `\input{/etc/passwd}` or `\input{../../.ssh/id_ed25519}` puts the file into the PDF whatever
 * `openin_any` says (tested with TeX Live 2026). So:
 * - every program that touches the build (latexmk, TeX, BibTeX/Biber, SyncTeX, the PDF tools)
 *   runs in a rootless Podman container: no network, read-only system, no privileges, and only
 *   the build folder (read-write), TeX Live and the user's ~/texmf (read-only) mounted. There is
 *   nothing of the user's to read;
 * - shell escape is off, writes are restricted (`openout_any=p`), and latexmk ignores every rc
 *   file (they are Perl code);
 * - the project is exported with symbolic links as plain files, so no link leads out of it;
 * - without a container, previews are off unless the user chooses `isolation: "process"`, and
 *   then Stet says that TeX can read every file the user can.
 *
 * Previews are optional: without TeX (or the image), `previewStatus` says what is missing and
 * everything else in Stet works as before.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, posix } from "node:path";
import { filterOverrides, Repo } from "./git.js";
import { writeInside } from "./safefs.js";
import { fromLf, lineOf, type Eol } from "./text.js";

export interface PreviewConfig {
  enabled: boolean;
  /** The document to compile, relative to the project; null: detected (`main.tex`, else the one top-level document). */
  rootFile: string | null;
  /** `auto`: from a `% !TEX program =` line, else LuaLaTeX with fontspec/unicode-math, else pdfLaTeX. */
  engine: "auto" | "pdflatex" | "xelatex" | "lualatex";
  /**
   * `container` (what `auto` means): builds in a Podman container. `process`: as a normal process,
   * where TeX can read every file you can; only on your explicit choice.
   */
  isolation: "auto" | "container" | "process";
  /** The container image with Perl and the PDF tools, for the user's own TeX (`stet preview setup` builds it). */
  image: string;
  /** Where TeX comes from: `auto` (the user's standalone TeX Live on Linux, else the image's), `host` or `image`. */
  tex: "auto" | "host" | "image";
  /** The container image with its own TeX Live, for macOS and Linux without a standalone TeX Live. */
  texImage: string;
  /** Seconds a build may take before it is stopped. */
  timeout: number;
}

export const DEFAULT_PREVIEW: PreviewConfig = {
  enabled: true,
  rootFile: null,
  engine: "auto",
  isolation: "auto",
  image: "localhost/stet-preview:1",
  tex: "auto",
  texImage: "localhost/stet-preview-tex:1",
  timeout: 120,
};

/** The image `stet preview setup` builds: TeX comes from the user's own TeX Live, mounted read-only. */
export const PREVIEW_CONTAINERFILE = `# Stet PDF previews: Perl for latexmk, Poppler to read and render PDFs. TeX itself is the user's
# TeX Live, mounted read-only when a preview is built.
FROM docker.io/library/debian:bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends perl poppler-utils \\
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

export type PreviewIsolation = "container" | "process";

export interface PreviewEnv {
  /** `ready`: previews can be built; `needs-setup`: the image must be built first; `unavailable`: something is missing. */
  status: "ready" | "needs-setup" | "unavailable";
  isolation: PreviewIsolation | null;
  /** What is missing or worth knowing, in a sentence. */
  message: string;
  /** How to fix it, if there is something to do. */
  fix?: string;
  /** TeX Live's bin folder (absolute, on this machine). */
  texBin?: string;
  /** Folder mounted read-only into the container: the TeX Live installation, with `texmf-local`. */
  texMount?: string;
  /** The user's own TeX packages (~/texmf), mounted read-only if there are any. */
  texmfHome?: string;
  /** Whether Podman can limit a container's memory here (needs the cgroup memory controller). */
  memoryLimit?: boolean;
  /** The Podman program, and the image builds run in; where TeX comes from. */
  podman?: string;
  image?: string;
  texSource?: "host" | "image";
}

const run = (cmd: string, args: string[], opts: { input?: string; timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      // Its own process group (POSIX), so a timeout also stops what it started (latexmk → TeX).
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (e: any) {
      return resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
    }
    const kill = () => {
      try {
        if (process.platform !== "win32" && child!.pid) process.kill(-child!.pid, "SIGKILL");
        else child!.kill("SIGKILL");
      } catch {
        child!.kill("SIGKILL");
      }
    };
    const timer = opts.timeout ? setTimeout(kill, opts.timeout) : undefined;
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });

/** Absolute path of `cmd` on the PATH, or null. */
async function which(cmd: string): Promise<string | null> {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      if (existsSync(p)) return p;
      if (ext && existsSync(join(dir, cmd + ext))) return join(dir, cmd + ext);
    }
  }
  return null;
}

/**
 * What previews can use here. Never installs or downloads anything: when something is missing,
 * it says what and how to get it.
 */
/** Podman: on the PATH, or where its installers put it (VS Code started from the Dock may lack those on its PATH). */
async function findPodman(): Promise<string | null> {
  if (process.platform === "win32") return null;
  const onPath = await which("podman");
  if (onPath) return onPath;
  for (const p of ["/opt/podman/bin/podman", "/opt/homebrew/bin/podman", "/usr/local/bin/podman", "/usr/bin/podman"]) if (existsSync(p)) return p;
  return null;
}

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
export async function detectPreviewEnv(cfg: PreviewConfig): Promise<PreviewEnv> {
  if (!cfg.enabled) return { status: "unavailable", isolation: null, message: "PDF previews are switched off (preview.enabled in .git/stet/config.json)." };
  const trusted = "Or, for material you trust, set preview.isolation to \"process\" in .git/stet/config.json: TeX can then read every file you can.";

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
    if (process.platform === "linux" && existsSync(join(texRoot, "texmf-dist"))) texMount = existsSync(join(dirname(texRoot), "texmf-local")) ? dirname(texRoot) : texRoot;
  }
  const texmfHome = userTexmf();

  if (cfg.isolation !== "process") {
    const podman = await findPodman();
    if (!podman) {
      return {
        status: "unavailable",
        isolation: "container",
        message:
          process.platform === "win32"
            ? "PDF previews compile agents' text in a container, so TeX can't read your files, and that isn't supported on Windows yet."
            : "PDF previews compile agents' text in a container, so TeX can't read your files, and Podman isn't installed.",
        fix: (process.platform === "win32" ? "Use Stet in WSL2 for previews. " : "Install Podman (podman.io), then reload. ") + trusted,
      };
    }
    // Podman answers only while its service runs: on macOS, its Linux machine.
    const info = await run(podman, ["info", "--format", "{{.Host.CgroupControllers}}"], { timeout: 30_000 });
    if (info.code !== 0) {
      return {
        status: "unavailable",
        isolation: "container",
        message: `PDF previews run in a Podman container, but Podman doesn't answer${process.platform === "darwin" ? " (its machine isn't running)" : ""}.`,
        fix: process.platform === "darwin" ? "Start it with `podman machine start` (once: `podman machine init`), then reload." : `Check \`podman info\`: ${oneLineOf(info.stderr)}`,
      };
    }
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
      return { status: "unavailable", isolation: "container", message: `PDF previews can't mount ${odd} into a container: its path contains ':' or ','.`, fix: "Move it to a path without those characters." };
    }
    const image = source === "host" ? cfg.image : cfg.texImage;
    const base = {
      isolation: "container" as const,
      podman,
      texSource: source,
      image,
      texBin: source === "host" ? texBin! : "/usr/bin",
      ...(source === "host" ? { texMount: texMount! } : {}),
      ...(texmfHome ? { texmfHome } : {}),
    };
    if ((await run(podman, ["image", "exists", image])).code !== 0) {
      return {
        status: "needs-setup",
        ...base,
        message: "PDF previews run in a container, whose image isn't built yet.",
        fix:
          source === "host"
            ? "Build it once with `stet preview setup` or the Set up button (downloads Debian, Perl and Poppler, about 150 MB; TeX is yours)."
            : "Build it once with `stet preview setup` or the Set up button (downloads Debian with TeX Live, Perl and Poppler, about 1.5 GB).",
      };
    }
    const memoryLimit = /\bmemory\b/.test(info.stdout);
    return {
      status: "ready",
      ...base,
      memoryLimit,
      message: `PDF previews run in an isolated container${source === "image" ? ", with the TeX in its image" : ""}.`,
    };
  }

  // A normal process: the user's explicit choice, with their own TeX and Poppler.
  if (!latexmk) {
    return { status: "unavailable", isolation: "process", message: "PDF previews need a TeX distribution with latexmk, which isn't on the PATH.", fix: "Install TeX Live (tug.org/texlive) or MiKTeX, then reload." };
  }
  const pdftoppm = await which("pdftoppm");
  if (!pdftoppm || !(await which("pdfinfo"))) {
    return {
      status: "unavailable",
      isolation: "process",
      message: "PDF previews need Poppler's pdftoppm and pdfinfo to show pages, and they aren't on the PATH.",
      fix: process.platform === "darwin" ? "Install Poppler (brew install poppler)." : "Install poppler-utils.",
    };
  }
  return {
    status: "ready",
    isolation: "process",
    texBin: texBin!,
    message:
      "PDF previews run as a normal process (preview.isolation is \"process\"): TeX can read every file you can, so a proposal could copy one into its preview. Use this only for material you trust.",
  };
}

const oneLineOf = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Build the image previews need here: with the user's TeX mounted (Debian, Perl and Poppler), or
 * with its own TeX Live. Downloads packages: only on the user's explicit request.
 */
export async function setupPreviewImage(cfg: PreviewConfig): Promise<{ ok: boolean; log: string }> {
  const env = await detectPreviewEnv(cfg);
  if (env.isolation !== "container" || !env.podman || !env.image) return { ok: false, log: `${env.message}${env.fix ? ` ${env.fix}` : ""}` };
  // An empty build context with just the Containerfile (podman can't read it from a Node pipe).
  const dir = await mkdtemp(join(tmpdir(), "stet-preview-image-"));
  try {
    await writeFile(join(dir, "Containerfile"), env.texSource === "image" ? PREVIEW_TEX_CONTAINERFILE : PREVIEW_CONTAINERFILE);
    const r = await run(env.podman, ["build", "--tag", env.image, "--file", join(dir, "Containerfile"), dir], { timeout: 60 * 60_000 });
    return { ok: r.code === 0, log: (r.stdout + r.stderr).trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** TeX's own restrictions, in every build (kpathsea reads these from the environment). They stop shell escape and writes, not reads. */
const TEX_ENV = { openin_any: "p", openout_any: "p", shell_escape: "f" };

/** Arguments of `podman run` for one isolated command in `work`. Exported for tests. */
export function containerArgs(env: PreviewEnv, image: string, work: string, name: string, cmd: string[]): string[] {
  const vars = { PATH: `${env.texBin}:/usr/bin:/bin`, HOME: "/tmp", TEXMFVAR: "/tmp/texmf-var", ...(env.texmfHome ? { TEXMFHOME: "/texmf-home" } : {}), ...TEX_ENV };
  return [
    "run", "--rm", "--name", name,
    // Only ever the image the user built: a missing one is an error, never a download.
    "--pull=never",
    "--network=none",
    "--read-only", "--tmpfs", "/tmp:rw,size=256m",
    "--userns=keep-id",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    // A hostile document can loop, write or allocate until the timeout: bound what it can use.
    "--pids-limit=256",
    "--ulimit", "fsize=536870912:536870912",
    "--ulimit", "nofile=1024:1024",
    ...(env.memoryLimit ? ["--memory=2g", "--memory-swap=2g"] : []),
    ...(env.texMount ? ["--volume", `${env.texMount}:${env.texMount}:ro`] : []),
    ...(env.texmfHome ? ["--volume", `${env.texmfHome}:/texmf-home:ro`] : []),
    "--volume", `${work}:/work`,
    "--workdir", "/work",
    ...Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    image, ...cmd,
  ];
}

/** Run one command of a build, isolated as configured, in `work` (paths inside it are relative). */
async function runIsolated(env: PreviewEnv, cfg: PreviewConfig, work: string, cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeout = cfg.timeout * 1000;
  if (env.isolation === "container") {
    if (/[:,]/.test(work)) return { code: -1, stdout: "", stderr: `Can't mount ${work} into a container: its path contains ':' or ','.` };
    const name = `stet-preview-${randomBytes(6).toString("hex")}`;
    const podman = env.podman ?? "podman";
    const r = await run(podman, containerArgs(env, env.image ?? cfg.image, work, name, cmd), { timeout });
    if (r.code !== 0) await run(podman, ["rm", "--force", "--ignore", name]); // after a timeout
    return r;
  }
  // A normal process: the restrictions above, a private HOME, and nothing else from the environment.
  const home = join(work, "stet-home");
  await mkdir(home, { recursive: true });
  const path = [env.texBin, ...(process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== env.texBin)].join(delimiter);
  const vars: NodeJS.ProcessEnv = { PATH: path, HOME: home, USERPROFILE: home, TEXMFVAR: join(home, "texmf-var"), ...TEX_ENV };
  for (const k of ["SystemRoot", "TEMP", "TMP", "LANG"]) if (process.env[k]) vars[k] = process.env[k];
  return run(cmd[0]!, cmd.slice(1), { cwd: work, env: vars, timeout });
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
  const top = [...files].filter(([p, t]) => !p.includes("/") && p.endsWith(".tex") && isDocument(t)).map(([p]) => p);
  return top.length === 1 ? top[0]! : null;
}

// ---------------------------------------------------------------------------
// SyncTeX and the page region

export interface SyncBox {
  page: number;
  /** In PDF points from the top-left corner: the box spans h..h+W and v-H..v (v is the baseline). */
  h: number;
  v: number;
  W: number;
  H: number;
}

/** Parse `synctex view` output into boxes. */
export function parseSynctex(out: string): SyncBox[] {
  const boxes: SyncBox[] = [];
  let cur: Partial<SyncBox> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^(Page|h|v|W|H):(-?[\d.]+)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1] === "Page" ? "page" : (m[1] as "h" | "v" | "W" | "H");
    if (key === "page" && cur.page !== undefined) cur = {};
    cur[key] = Number(m[2]);
    if (cur.page !== undefined && cur.h !== undefined && cur.v !== undefined && cur.W !== undefined && cur.H !== undefined) {
      boxes.push(cur as SyncBox);
      cur = {};
    }
  }
  return boxes;
}

/**
 * The region to show: the full page width (so lines read as on paper) and the lines of the
 * change with some context above and below, on the page of its first box.
 */
export function cropRegion(boxes: SyncBox[], page: { width: number; height: number }, context = 36, minHeight = 110): { page: number; x: number; y: number; w: number; h: number } | null {
  if (!boxes.length) return null;
  const p = boxes[0]!.page;
  const on = boxes.filter((b) => b.page === p);
  let top = Math.min(...on.map((b) => b.v - Math.max(b.H, 8))) - context;
  let bottom = Math.max(...on.map((b) => b.v + 3)) + context;
  if (bottom - top < minHeight) {
    const grow = (minHeight - (bottom - top)) / 2;
    top -= grow;
    bottom += grow;
  }
  // At a page edge, shift the region inwards instead of cutting it.
  if (top < 0) [top, bottom] = [0, bottom - top];
  if (bottom > page.height) [top, bottom] = [Math.max(0, top - (bottom - page.height)), page.height];
  return { page: p, x: 0, y: top, w: page.width, h: Math.max(1, bottom - top) };
}

// ---------------------------------------------------------------------------
// Building

export interface PreviewImage {
  /** Absolute path of a PNG. */
  file: string;
  page: number;
}

export type PreviewResult =
  | {
      status: "ready";
      before: PreviewImage | null;
      after: PreviewImage;
      /** Which other changes the preview includes, and why. */
      note?: string;
      /** LaTeX reported errors with the change that the document didn't have without it; the PDF came out anyway. */
      warning?: { message: string; log: string; count: number };
    }
  /** The change has no place on the page (preamble, macros, bibliography data, a file not in the document). */
  | { status: "no-spot"; message: string }
  /** No PDF: with the change (`change`), or already without it (`base`). */
  | { status: "failed"; message: string; log: string; cause?: "base" | "change" }
  | { status: "unavailable"; message: string; fix?: string };

/** One change applied for a preview: a file's text at the base (LF), its line endings, and the edit. */
export interface PreviewChange {
  file: string;
  baseText: string;
  eol: Eol;
  range: { start: number; end: number };
  newText: string;
}

export interface PreviewRequest {
  /** The commit the changes were proposed against. */
  base: string;
  /** Key of this preview in the cache (item id + a hash of everything applied). */
  key: string;
  /**
   * What is applied: the change shown (`target`) and those it can only be accepted with (the rest
   * of its move or linked part), or a whole round when the change doesn't compile alone.
   */
  changes: PreviewChange[];
  target: number;
}

const RESOLUTION = 200; // dpi of the rendered region: sharp enough to zoom in
const KEEP_BASES = 3;

/** Builds previews for one project, with a cache under `root` (`<store>/previews`). */
export class PreviewBuilder {
  private readonly building = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repo: Repo,
    private readonly root: string,
    private readonly cfg: PreviewConfig,
    private readonly env: PreviewEnv,
  ) {}

  async preview(req: PreviewRequest): Promise<PreviewResult> {
    if (this.env.status !== "ready") return { status: "unavailable", message: this.env.message, ...(this.env.fix ? { fix: this.env.fix } : {}) };
    // Both name folders: a commit hash and an item id with a hash, nothing else.
    if (!/^[0-9a-f]{40,64}$/.test(req.base) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(req.key)) {
      return { status: "unavailable", message: "This change's record looks damaged; no preview." };
    }
    const baseDir = join(this.root, req.base);
    const itemDir = join(baseDir, "items", req.key);
    const cached = await readFile(join(itemDir, "result.json"), "utf8").then((t) => JSON.parse(t) as PreviewResult, () => null);
    // Only images in this change's own folder: a tampered record must not point anywhere else.
    if (cached && (cached.status !== "ready" || (insideDir(cached.after?.file, itemDir) && (cached.before === null || insideDir(cached.before?.file, itemDir))))) return cached;
    return this.once(itemDir, async () => {
      const base = await this.once(join(baseDir, "base"), () => this.buildBase(req.base, baseDir));
      const result = await this.buildItem(req, base, baseDir, itemDir);
      await mkdir(itemDir, { recursive: true });
      await writeFile(join(itemDir, "result.json"), JSON.stringify(result));
      return result;
    });
  }

  /** Run `fn` once per key at a time in this process; later callers share the result. */
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.building.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn().finally(() => this.building.delete(key));
      this.building.set(key, p);
    }
    return p;
  }

  /** Export and compile the base once per base commit. */
  private async buildBase(base: string, baseDir: string): Promise<{ dir: string; root: string | null; pdf: string | null; log: string }> {
    const dir = join(baseDir, "base");
    const done = join(dir, "build.json");
    const prior = await readFile(done, "utf8").then((t) => JSON.parse(t), () => null);
    if (prior) return { dir, ...prior };
    await mkdir(baseDir, { recursive: true });
    await this.prune(baseDir);
    const tmp = `${dir}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      await this.exportTree(base, join(tmp, "src"));
      const files = await this.texFiles(join(tmp, "src"));
      const root = detectRoot(files, this.cfg.rootFile);
      let pdf: string | null = null;
      let log = "";
      if (root) {
        const engine = this.cfg.engine === "auto" ? detectEngine(files.get(root) ?? "") : this.cfg.engine;
        const r = await this.compile(join(tmp, "src"), root, engine);
        pdf = r.pdf;
        log = r.log;
      }
      const info = { root, pdf: pdf && relPdf(pdf), log };
      await writeFile(join(tmp, "build.json"), JSON.stringify(info));
      await rename(tmp, dir).catch(async () => rm(tmp, { recursive: true, force: true })); // someone else was first
      const now = JSON.parse(await readFile(done, "utf8"));
      return { dir, ...now };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  private async buildItem(
    req: PreviewRequest,
    base: { dir: string; root: string | null; pdf: string | null; log: string },
    baseDir: string,
    itemDir: string,
  ): Promise<PreviewResult> {
    if (!base.root) {
      return { status: "unavailable", message: "Stet couldn't tell which file is the document to compile.", fix: "Set preview.rootFile in .git/stet/config.json (e.g. \"main.tex\")." };
    }
    if (!base.pdf) return { status: "failed", cause: "base", message: "Your document doesn't compile without this change either.", log: excerpt(base.log) };
    const noSpot: PreviewResult = { status: "no-spot", message: "This change has no place of its own on the page (for example the preamble, a macro or bibliography data)." };
    const target = req.changes[req.target]!;
    // The main file's preamble: SyncTeX would point at the first text instead.
    const begin = /\\begin\s*\{document\}/.exec(target.baseText)?.index ?? -1;
    if (target.file === base.root && begin >= 0 && target.range.start < begin) return noSpot;

    // The changes in the base's copy: reusing its build makes the second run quick.
    const work = join(itemDir, "build");
    await rm(work, { recursive: true, force: true });
    await mkdir(itemDir, { recursive: true });
    // Copy-on-write where the filesystem can (btrfs, XFS, APFS): figures aren't duplicated.
    await cp(join(base.dir, "src"), work, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    // The base's PDF must not pass for this build's if this one produces none.
    const stem = posix.basename(base.root).replace(/\.tex$/i, "");
    for (const ext of ["pdf", "synctex.gz"]) await rm(join(work, "stet-build", `${stem}.${ext}`), { force: true });
    const applied = applyChanges(req.changes, req.target);
    if (!applied) return { status: "failed", cause: "change", message: "The changes to preview overlap; Stet can't apply them together.", log: "" };
    for (const [file, text] of applied.files) await writeInside(work, file, fromLf(text, req.changes.find((c) => c.file === file)!.eol));
    const engine = this.cfg.engine === "auto" ? detectEngine((await readFile(join(work, base.root), "utf8").catch(() => "")) || "") : this.cfg.engine;
    const built = await this.compile(work, base.root, engine);
    if (!built.pdf) return { status: "failed", cause: "change", message: "The document doesn't compile with this change.", log: excerpt(built.log) };

    const after = applied.files.get(target.file)!;
    const lines = (text: string, from: number, to: number) => [lineOf(text, from), lineOf(text, Math.max(from, to - 1))];
    const afterImg = await this.region(work, built.pdf, target.file, lines(after, applied.start, applied.start + target.newText.length), join(itemDir, "after.png"));
    if (!afterImg) return noSpot;
    const beforeImg = await this.region(join(base.dir, "src"), join(base.dir, "src", base.pdf), target.file, lines(target.baseText, target.range.start, target.range.end), join(itemDir, "before.png"));
    await rm(work, { recursive: true, force: true }); // keep the images only
    await utimes(baseDir, new Date(), new Date()).catch(() => undefined);
    // Errors only this version has: the PDF is there, but the reviewer should know.
    const known = new Set(errorsOf(base.log));
    const fresh = errorsOf(built.log).filter((e) => !known.has(e));
    return {
      status: "ready",
      before: beforeImg,
      after: afterImg,
      ...(fresh.length
        ? { warning: { message: `LaTeX reported ${fresh.length === 1 ? "an error" : `${fresh.length} errors`} with this change that the document doesn't have without it.`, log: excerpt(built.log), count: fresh.length } }
        : {}),
    };
  }

  /** Locate source lines in a PDF with SyncTeX and render that region to `out`. */
  private async region(work: string, pdf: string, file: string, lines: number[], out: string): Promise<PreviewImage | null> {
    const pdfRel = relTo(work, pdf);
    const boxes: SyncBox[] = [];
    for (const line of [...new Set(lines)]) {
      const r = await runIsolated(this.env, this.cfg, work, ["synctex", "view", "-i", `${line}:0:${file}`, "-o", pdfRel]);
      if (r.code === 0) boxes.push(...parseSynctex(r.stdout));
    }
    if (!boxes.length) return null;
    const page = boxes[0]!.page;
    // SyncTeX falls back to the nearest text for lines that typeset nothing (definitions in an
    // included file). Ask back which file is at that spot: another one means there's no spot.
    const b = boxes[0]!;
    const back = await runIsolated(this.env, this.cfg, work, ["synctex", "edit", "-o", `${page}:${(b.h + b.W / 2).toFixed(1)}:${(b.v - b.H / 2).toFixed(1)}:${pdfRel}`]);
    const input = /^Input:(.*)$/m.exec(back.stdout)?.[1]?.trim();
    if (input && !sameSource(input, file)) return null;
    const info = await runIsolated(this.env, this.cfg, work, ["pdfinfo", "-f", String(page), "-l", String(page), pdfRel]);
    const size = /Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(info.stdout) ?? /Page size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(info.stdout);
    if (!size) return null;
    const crop = cropRegion(boxes, { width: Number(size[1]), height: Number(size[2]) });
    if (!crop) return null;
    const px = (pt: number) => String(Math.round((pt * RESOLUTION) / 72));
    const name = `.region-${randomBytes(4).toString("hex")}`;
    const r = await runIsolated(this.env, this.cfg, work, [
      "pdftoppm", "-f", String(crop.page), "-l", String(crop.page), "-r", String(RESOLUTION),
      "-x", px(crop.x), "-y", px(crop.y), "-W", px(crop.w), "-H", px(crop.h), "-png", "-singlefile", pdfRel, name,
    ]);
    if (r.code !== 0) return null;
    await rename(join(work, `${name}.png`), out);
    return { file: out, page: crop.page };
  }

  /** Compile `root` in `work` with latexmk; the PDF path, or null with the log. */
  private async compile(work: string, root: string, engine: "pdflatex" | "xelatex" | "lualatex"): Promise<{ pdf: string | null; log: string }> {
    const flag = engine === "xelatex" ? "-xelatex" : engine === "lualatex" ? "-lualatex" : "-pdf";
    const r = await runIsolated(this.env, this.cfg, work, [
      // -f, and no -halt-on-error: a paper with a small error somewhere still gets its PDF (as
      // when the author compiles it), and so its previews. Errors are reported next to them.
      "latexmk", "-norc", flag, "-f", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", "-outdir=stet-build", root,
    ]);
    const stem = posix.basename(root).replace(/\.tex$/i, "");
    const pdf = join(work, "stet-build", `${stem}.pdf`);
    const log = await readFile(join(work, "stet-build", `${stem}.log`), "utf8").catch(() => r.stdout + r.stderr);
    return existsSync(pdf) ? { pdf, log } : { pdf: null, log: log || r.stdout + r.stderr };
  }

  /** Check out `rev` into `dir`, with symbolic links as plain files (none may lead out of the build). */
  private async exportTree(rev: string, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    const index = join(dirname(dir), "index");
    const env = { GIT_INDEX_FILE: index };
    await this.repo.run(["read-tree", rev], { env });
    // Configured filter programs stay off (as everywhere Stet handles files), and links come out as files.
    const filters = (await filterOverrides(this.repo)).flatMap((c) => ["-c", c]);
    await this.repo.run([...filters, "-c", "core.symlinks=false", "checkout-index", "--all", "--force", `--prefix=${dir.replace(/\\/g, "/")}/`], { env });
    await rm(index, { force: true });
  }

  /** The .tex files below `dir` (relative paths, forward slashes) and their text. */
  private async texFiles(dir: string, rel = "", out = new Map<string, string>()): Promise<Map<string, string>> {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await this.texFiles(dir, p, out);
      } else if (e.isFile() && /\.tex$/i.test(e.name) && (await stat(join(dir, p))).size < 4_000_000) {
        out.set(p, await readFile(join(dir, p), "utf8"));
      }
    }
    return out;
  }

  /** Keep the builds of the newest few base commits. */
  private async prune(current: string): Promise<void> {
    const dirs = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const bases = await Promise.all(
      dirs.filter((d) => d.isDirectory() && join(this.root, d.name) !== current).map(async (d) => ({ p: join(this.root, d.name), t: (await stat(join(this.root, d.name))).mtimeMs })),
    );
    bases.sort((a, b) => b.t - a.t);
    for (const b of bases.slice(KEEP_BASES - 1)) await rm(b.p, { recursive: true, force: true });
  }
}

/**
 * Apply `changes` (several files, each change against its file's base text) and say where the
 * target change starts in its file's new text. Null if two changes in a file overlap.
 */
export function applyChanges(changes: PreviewChange[], target: number): { files: Map<string, string>; start: number } | null {
  const files = new Map<string, string>();
  let start = -1;
  for (const file of new Set(changes.map((c) => c.file))) {
    const list = changes.map((c, k) => ({ c, k })).filter((x) => x.c.file === file).sort((a, b) => a.c.range.start - b.c.range.start || a.k - b.k);
    for (let i = 1; i < list.length; i++) if (list[i]!.c.range.start < list[i - 1]!.c.range.end) return null;
    let text = list[0]!.c.baseText;
    let shift = 0;
    for (const { c, k } of list) {
      if (k === target) start = c.range.start + shift;
      shift += c.newText.length - (c.range.end - c.range.start);
    }
    for (const { c } of [...list].reverse()) text = text.slice(0, c.range.start) + c.newText + text.slice(c.range.end);
    files.set(file, text);
  }
  return start < 0 ? null : { files, start };
}

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

/** The part of a LaTeX log that says what went wrong. */
export function excerpt(log: string, max = 40): string {
  const lines = log.split(/\r?\n/);
  const i = lines.findIndex((l) => /^!|^\S.*:\d+: /.test(l));
  return (i >= 0 ? lines.slice(i, i + max) : lines.slice(-max)).join("\n").trim();
}

/** Whether SyncTeX's `Input:` name is the repository file `file` (it may be `./file`, or absolute in the build folder). */
export function sameSource(input: string, file: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/(\.\/)+/g, "/");
  const a = norm(input);
  const f = norm(file);
  return a === f || a.endsWith("/" + f) || a === f.replace(/\.tex$/i, "") || a.endsWith("/" + f.replace(/\.tex$/i, ""));
}

/** Whether `file` is a file directly in `dir` (no other folder, no `..`). */
export function insideDir(file: unknown, dir: string): boolean {
  return typeof file === "string" && dirname(file) === dir && !basename(file).startsWith(".");
}

const relPdf = (pdf: string) => join("stet-build", basename(pdf));
const relTo = (work: string, p: string) => (p.startsWith(work) ? p.slice(work.length + 1) : p).replace(/\\/g, "/");
