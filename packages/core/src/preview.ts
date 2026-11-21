/**
 * PDF previews of a change (spec §14): the region of the compiled paper where a change lands,
 * before and after. What compiles the document, and how a change is found on its pages, is the
 * language's typesetter (`Typesetter`, LaTeX's in `lang/latex-preview.ts`); this is the rest:
 * isolation, the build cache, pages, and the words on them.
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
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, sep } from "node:path";
import { diffArrays } from "diff";
import { filterOverrides, type Repo } from "./git.js";
import { inlineDiff } from "./inline.js";
import type { LanguageProfile, SourceBox, Typesetter } from "./lang/profile.js";
import { writeInside } from "./safefs.js";
import { type Eol, fromLf, lineOf } from "./text.js";
import type { Token } from "./tokenizer.js";

export const PREVIEW_ENGINES = ["auto", "pdflatex", "xelatex", "lualatex"] as const;
export const PREVIEW_ISOLATIONS = ["auto", "container", "process"] as const;
export const PREVIEW_TEX = ["auto", "host", "image"] as const;

export interface PreviewConfig {
  enabled: boolean;
  /** The document to compile, relative to the project; null: detected (`main.tex`, else the one top-level document). */
  rootFile: string | null;
  /** `auto`: from a `% !TEX program =` line, else LuaLaTeX with fontspec/unicode-math, else pdfLaTeX. */
  engine: (typeof PREVIEW_ENGINES)[number];
  /**
   * `container` (what `auto` means): builds in a Podman container. `process`: as a normal process,
   * where TeX can read every file you can; only on your explicit choice.
   */
  isolation: (typeof PREVIEW_ISOLATIONS)[number];
  /** The container image with Perl and the PDF tools, for the user's own TeX (`stet preview setup` builds it). */
  image: string;
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
  texExtras: false,
  texExtrasImage: "localhost/stet-preview-tex-extra:1",
  timeout: 120,
};

export type PreviewIsolation = "container" | "process";

export interface PreviewEnv {
  /** `ready`: previews can be built; `needs-setup`: the image must be built first; `unavailable`: something is missing. */
  status: "ready" | "needs-setup" | "unavailable";
  isolation: PreviewIsolation | null;
  /** What is missing or worth knowing, in a sentence. */
  message: string;
  /** How to fix it, if there is something to do. */
  fix?: string;
  /** The tools' folder (absolute, where they run: on this machine, or in the container): first on the PATH. */
  bin?: string;
  /** Folders mounted read-only into the container: [on this machine, in the container] (LaTeX: TeX Live, ~/texmf). */
  mounts?: [string, string][];
  /** Whether Podman can limit a container's memory here (needs the cgroup memory controller). */
  memoryLimit?: boolean;
  /** The Podman program, and the image builds run in; where the tools come from (the user's own, or the image's). */
  podman?: string;
  image?: string;
  toolSource?: "host" | "image";
  /** The image with its own TeX is the small one: the extra fonts can still be added. */
  extrasAvailable?: boolean;
}

/** Run a program (not isolated: for Podman itself and the like), with an optional timeout. */
export const runProgram = (cmd: string, args: string[], opts: { input?: string; timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group (POSIX), so a timeout also stops what it started (latexmk → TeX).
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
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
export async function which(cmd: string): Promise<string | null> {
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

/** Podman: on the PATH, or where its installers put it (VS Code started from the Dock may lack those on its PATH). */
async function findPodman(): Promise<string | null> {
  if (process.platform === "win32") return null;
  const onPath = await which("podman");
  if (onPath) return onPath;
  for (const p of ["/opt/podman/bin/podman", "/opt/homebrew/bin/podman", "/usr/local/bin/podman", "/usr/bin/podman"]) if (existsSync(p)) return p;
  return null;
}

/** What previews can use here, by the document's typesetter. Never installs or downloads anything. */
export async function detectPreviewEnv(
  cfg: PreviewConfig,
  typesetter: Typesetter,
  /** `podman`: the Podman program to use, or null for none (tests: independent of what the machine has). */
  opts: { podman?: string | null } = {},
): Promise<PreviewEnv> {
  if (!cfg.enabled) return { status: "unavailable", isolation: null, message: "PDF previews are switched off (preview.enabled in .git/stet/config.json)." };
  return typesetter.detect(cfg, opts);
}

/** Build the image previews need here (the typesetter's). Downloads packages: only on the user's explicit request. */
export function setupPreviewImage(cfg: PreviewConfig, typesetter: Typesetter, opts: { extras?: boolean } = {}): Promise<{ ok: boolean; log: string }> {
  return typesetter.setupImage(cfg, opts);
}

/**
 * Podman, for builds in a container: the program and whether it can limit memory, or why it
 * can't be used. `program`: what the container keeps from the user's files ("TeX").
 */
export async function containerRuntime(opts: { podman?: string | null }, program: string): Promise<{ podman: string; memoryLimit: boolean } | PreviewEnv> {
  const trusted = `Or, for material you trust, set preview.isolation to "process" in .git/stet/config.json: ${program} can then read every file you can.`;
  const podman = opts.podman !== undefined ? opts.podman : await findPodman();
  if (!podman) {
    return {
      status: "unavailable",
      isolation: "container",
      message:
        process.platform === "win32"
          ? `PDF previews compile agents' text in a container, so ${program} can't read your files, and that isn't supported on Windows yet.`
          : `PDF previews compile agents' text in a container, so ${program} can't read your files, and Podman isn't installed.`,
      fix:
        (process.platform === "win32" ? "Use Stet in WSL2 for previews. " : "Install Podman (podman.io), then try again (in VS Code: reload the window). ") +
        trusted,
    };
  }
  // Podman answers only while its service runs: on macOS, its Linux machine.
  const info = await runProgram(podman, ["info", "--format", "{{.Host.CgroupControllers}}"], { timeout: 30_000 });
  if (info.code !== 0) {
    return {
      status: "unavailable",
      isolation: "container",
      message: `PDF previews run in a Podman container, but Podman doesn't answer${process.platform === "darwin" ? " (its machine isn't running)" : ""}.`,
      fix:
        process.platform === "darwin"
          ? "Start it with `podman machine start` (once: `podman machine init`), then try again (in VS Code: reload the window)."
          : `Check \`podman info\`: ${oneLineOf(info.stderr)}`,
    };
  }
  return { podman, memoryLimit: /\bmemory\b/.test(info.stdout) };
}

/** Builds as a normal process need Poppler's pdftoppm and pdfinfo on the PATH: why not, or null. */
export async function popplerMissing(): Promise<PreviewEnv | null> {
  if ((await which("pdftoppm")) && (await which("pdfinfo"))) return null;
  return {
    status: "unavailable",
    isolation: "process",
    message: "PDF previews need Poppler's pdftoppm and pdfinfo to show pages, and they aren't on the PATH.",
    fix: process.platform === "darwin" ? "Install Poppler (brew install poppler)." : "Install poppler-utils.",
  };
}

const oneLineOf = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Build a container image from a Containerfile, in an empty build context. */
export async function buildImage(podman: string, tag: string, containerfile: string): Promise<{ ok: boolean; log: string }> {
  // An empty build context with just the Containerfile (podman can't read it from a Node pipe).
  const dir = await mkdtemp(join(tmpdir(), "stet-preview-image-"));
  try {
    await writeFile(join(dir, "Containerfile"), containerfile);
    const r = await runProgram(podman, ["build", "--tag", tag, "--file", join(dir, "Containerfile"), dir], { timeout: 60 * 60_000 });
    return { ok: r.code === 0, log: (r.stdout + r.stderr).trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Arguments of `podman run` for one isolated command in `work`. Exported for tests. */
export function containerArgs(env: PreviewEnv, image: string, work: string, name: string, cmd: string[], extra: Record<string, string> = {}): string[] {
  const vars = { PATH: `${env.bin}:/usr/bin:/bin`, HOME: "/tmp", ...extra };
  return [
    "run",
    "--rm",
    "--name",
    name,
    // Only ever the image the user built: a missing one is an error, never a download.
    "--pull=never",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=256m",
    "--userns=keep-id",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    // A hostile document can loop, write or allocate until the timeout: bound what it can use.
    "--pids-limit=256",
    "--ulimit",
    "fsize=536870912:536870912",
    "--ulimit",
    "nofile=1024:1024",
    ...(env.memoryLimit ? ["--memory=2g", "--memory-swap=2g"] : []),
    ...(env.mounts ?? []).flatMap(([host, at]) => ["--volume", `${host}:${at}:ro`]),
    "--volume",
    `${work}:/work`,
    "--workdir",
    "/work",
    ...Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    image,
    ...cmd,
  ];
}

/** Run one command of a build, isolated as configured, in `work` (paths inside it are relative). */
async function runIsolated(
  env: PreviewEnv,
  cfg: PreviewConfig,
  typesetter: Typesetter,
  work: string,
  cmd: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeout = cfg.timeout * 1000;
  if (env.isolation === "container") {
    if (/[:,]/.test(work)) return { code: -1, stdout: "", stderr: `Can't mount ${work} into a container: its path contains ':' or ','.` };
    const name = `stet-preview-${randomBytes(6).toString("hex")}`;
    const podman = env.podman ?? "podman";
    const r = await runProgram(podman, containerArgs(env, env.image ?? cfg.image, work, name, cmd, typesetter.buildEnv(env, "/tmp", true)), { timeout });
    if (r.code !== 0) await runProgram(podman, ["rm", "--force", "--ignore", name]); // after a timeout
    return r;
  }
  // A normal process: the restrictions above, a private HOME, and nothing else from the environment.
  const home = join(work, "stet-home");
  await mkdir(home, { recursive: true });
  const path = [env.bin, ...(process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== env.bin)].join(delimiter);
  const vars: NodeJS.ProcessEnv = { PATH: path, HOME: home, USERPROFILE: home, ...typesetter.buildEnv(env, home, false) };
  for (const k of ["SystemRoot", "TEMP", "TMP", "LANG"]) if (process.env[k]) vars[k] = process.env[k];
  return runProgram(cmd[0]!, cmd.slice(1), { cwd: work, env: vars, timeout });
}

// ---------------------------------------------------------------------------
// The page region

/** Where text is on a page (the typesetter's `locate`, or words found on it). */
export type SyncBox = SourceBox;

/**
 * The region to show: the full page width (so lines read as on paper) and the lines of the
 * change with some context above and below, on the page of its first box.
 */
export function cropRegion(
  boxes: SyncBox[],
  page: { width: number; height: number },
  context = 36,
  minHeight = 110,
): { page: number; x: number; y: number; w: number; h: number } | null {
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
      /** The typesetter, for messages ("LaTeX log"). */
      typesetter?: string;
      /** The typesetter reported errors with the change that the document didn't have without it; the PDF came out anyway. */
      warning?: { message: string; log: string; count: number; missing?: Missing };
      /** Whole pages with the changed words marked, for a page viewer; other pages via `PreviewBuilder.page`. */
      pages?: PageView;
    }
  /** The change has no place on the page (preamble, macros, bibliography data, a file not in the document). */
  | { status: "no-spot"; message: string }
  /** No PDF: with the change (`change`), or already without it (`base`). */
  | { status: "failed"; message: string; log: string; cause?: "base" | "change"; missing?: Missing; typesetter?: string }
  | { status: "unavailable"; message: string; fix?: string };

/**
 * Files the build couldn't find (LaTeX: `dsfont.sty`), and whether installing the preview image's extra fonts
 * may bring them (only for the small image with its own TeX).
 */
export interface Missing {
  files: string[];
  extras: boolean;
}

/** A rectangle on a page, in PDF points from its top-left corner. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One version's page with the change: its image, size (points), the document's page count, and the marked words. */
export interface PageSide {
  page: number;
  count: number;
  width: number;
  height: number;
  file: string;
  marks: Box[];
}

/** The pages of a preview: where the build is (to render other pages), and the change's page in each version. */
export interface PageView {
  base: string;
  key: string;
  after: PageSide;
  before: PageSide | null;
}

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
const PAGE_RESOLUTION = 170; // dpi of whole pages in the page viewer
const KEEP_BASES = 3;

/** Builds previews for one project, with a cache under `root` (`<store>/previews`). */
export class PreviewBuilder {
  private readonly building = new Map<string, Promise<unknown>>();
  private readonly ts: Typesetter;
  private readonly tokenize: ((text: string) => Token[]) | undefined;

  /** `profile`: the document's language, which has the typesetter. */
  constructor(
    private readonly repo: Repo,
    private readonly root: string,
    private readonly cfg: PreviewConfig,
    private readonly env: PreviewEnv,
    profile: LanguageProfile,
  ) {
    if (!profile.typesetter) throw new Error(`${profile.name} has no PDF previews.`);
    this.ts = profile.typesetter;
    this.tokenize = profile.syntax?.tokenize;
  }

  /** Run one program of a build, isolated. */
  private run = (work: string, cmd: string[]) => runIsolated(this.env, this.cfg, this.ts, work, cmd);

  async preview(req: PreviewRequest): Promise<PreviewResult> {
    if (this.env.status !== "ready") return { status: "unavailable", message: this.env.message, ...(this.env.fix ? { fix: this.env.fix } : {}) };
    // Both name folders: a commit hash and an item id with a hash, nothing else.
    if (!/^[0-9a-f]{40,64}$/.test(req.base) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(req.key)) {
      return { status: "unavailable", message: "This change's record looks damaged; no preview." };
    }
    const baseDir = join(this.root, req.base);
    const itemDir = join(baseDir, "items", req.key);
    const cached = await readFile(join(itemDir, "result.json"), "utf8").then(
      (t) => JSON.parse(t) as PreviewResult,
      () => null,
    );
    // Only images in this change's own folder: a tampered record must not point anywhere else.
    const pagesOk = (r: PreviewResult) =>
      r.status !== "ready" || !r.pages || [r.pages.after.file, r.pages.before?.file].every((f) => f === undefined || insideTree(f, this.root));
    if (
      cached &&
      pagesOk(cached) &&
      (cached.status !== "ready" || (insideDir(cached.after?.file, itemDir) && (cached.before === null || insideDir(cached.before?.file, itemDir))))
    )
      return cached;
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
    const prior = await readFile(done, "utf8").then(
      (t) => JSON.parse(t),
      () => null,
    );
    if (prior) return { dir, ...prior };
    await mkdir(baseDir, { recursive: true });
    await this.prune(baseDir);
    const tmp = `${dir}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      await this.exportTree(base, join(tmp, "src"));
      const files = await this.sourceFiles(join(tmp, "src"));
      const root = this.ts.detectRoot(files, this.cfg);
      let pdf: string | null = null;
      let log = "";
      if (root) {
        const r = await this.ts.compile(this.run, join(tmp, "src"), root, this.cfg);
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
      return {
        status: "unavailable",
        message: "Stet couldn't tell which file is the document to compile.",
        fix: `Set preview.rootFile in .git/stet/config.json (e.g. "${this.ts.rootHint}").`,
      };
    }
    if (!base.pdf) return this.failure("base", "Your document doesn't compile without this change either.", base.log);
    const noSpot: PreviewResult = {
      status: "no-spot",
      message: "This change has no place of its own on the page (for example the preamble, a macro or bibliography data).",
    };
    const target = req.changes[req.target]!;
    if (this.ts.noSpot(target.baseText, target.range.start, target.file === base.root)) return noSpot;

    // The changes in the base's copy: reusing its build makes the second run quick.
    const work = join(itemDir, "build");
    await rm(work, { recursive: true, force: true });
    await mkdir(itemDir, { recursive: true });
    // Copy-on-write where the filesystem can (btrfs, XFS, APFS): figures aren't duplicated.
    await cp(join(base.dir, "src"), work, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    // The base's PDF must not pass for this build's if this one produces none.
    for (const out of this.ts.outputs(base.root)) await rm(join(work, out), { force: true });
    const applied = applyChanges(req.changes, req.target);
    if (!applied) return { status: "failed", cause: "change", message: "The changes to preview overlap; Stet can't apply them together.", log: "" };
    for (const [file, text] of applied.files) await writeInside(work, file, fromLf(text, req.changes.find((c) => c.file === file)!.eol));
    const built = await this.ts.compile(this.run, work, base.root, this.cfg);
    if (!built.pdf) return this.failure("change", "The document doesn't compile with this change.", built.log);

    const after = applied.files.get(target.file)!;
    const lines = (text: string, from: number, to: number) => [lineOf(text, from), lineOf(text, Math.max(from, to - 1))];
    // Every change shown in this file, in each version's own text: the one asked for first.
    const same = req.changes
      .map((c, k) => ({ c, k }))
      .filter((x) => x.c.file === target.file)
      .sort((a, b) => (a.k === req.target ? -1 : b.k === req.target ? 1 : 0));
    const whole = same.map(({ c }) => shownWhole(c.baseText.slice(c.range.start, c.range.end), c.newText, this.tokenize));
    const spansAfter = same.map(({ c, k }, n) => around(after, applied.starts[k]!, applied.starts[k]! + c.newText.length, whole[n]));
    const spansBefore = same.map(({ c }, n) => around(c.baseText, c.range.start, c.range.end, whole[n]));
    const afterAt = await this.region(
      work,
      built.pdf,
      target.file,
      lines(after, applied.start, applied.start + target.newText.length),
      join(itemDir, "after.png"),
      spansAfter,
    );
    if (!afterAt) return noSpot;
    const beforeAt = await this.region(
      join(base.dir, "src"),
      join(base.dir, "src", base.pdf),
      target.file,
      lines(target.baseText, target.range.start, target.range.end),
      join(itemDir, "before.png"),
      spansBefore,
    );
    const [afterImg, beforeImg] = [afterAt.img, beforeAt?.img ?? null];
    // Whole pages with the changed words marked (a word diff of the two versions, where the changes are).
    const pages = await this.pageView(
      built.pdf,
      afterImg.page,
      base,
      beforeImg?.page ?? null,
      req,
      itemDir,
      baseDir,
      afterAt.found,
      beforeAt?.found ?? [],
    ).catch(() => undefined);
    await rm(work, { recursive: true, force: true }); // keep the images and this version's PDF only
    await utimes(baseDir, new Date(), new Date()).catch(() => undefined);
    // Errors only this version has: the PDF is there, but the reviewer should know.
    const known = new Set(this.ts.errorsOf(base.log));
    const fresh = this.ts.errorsOf(built.log).filter((e) => !known.has(e));
    return {
      status: "ready",
      typesetter: this.ts.name,
      before: beforeImg,
      after: afterImg,
      ...(pages ? { pages } : {}),
      ...(fresh.length
        ? {
            warning: {
              message: `${this.ts.name} reported ${fresh.length === 1 ? "an error" : `${fresh.length} errors`} with this change that the document doesn't have without it.`,
              log: this.ts.excerpt(built.log),
              count: fresh.length,
              ...this.missingIn(built.log),
            },
          }
        : {}),
    };
  }

  /** Keep this version's PDF, and make the page view: the change's page in each version, with marks. */
  private async pageView(
    afterPdf: string,
    aPage: number,
    base: { dir: string; pdf: string | null },
    bPage: number | null,
    req: PreviewRequest,
    itemDir: string,
    baseDir: string,
    aFound: Located[],
    bFound: Located[],
  ): Promise<PageView | undefined> {
    await cp(afterPdf, join(itemDir, "after.pdf"), { mode: constants.COPYFILE_FICLONE });
    const bWork = join(base.dir, "src");
    const aInfo = await this.pdfInfo(itemDir, "after.pdf", aPage);
    const bInfo = bPage && base.pdf ? await this.pdfInfo(bWork, base.pdf, bPage) : null;
    if (!aInfo) return undefined;
    // Three pages on each side: text that moves to the next page isn't a change.
    const aWords = await this.pageWords(itemDir, "after.pdf", Math.max(1, aPage - 1), Math.min(aInfo.count, aPage + 1));
    const bWords = bInfo && base.pdf ? await this.pageWords(bWork, base.pdf, Math.max(1, bPage! - 1), Math.min(bInfo.count, bPage! + 1)) : [];
    const { inserted, removed } = wordDiff(bWords, aWords);
    const after: PageSide = {
      page: aPage,
      ...aInfo,
      file: await this.renderPage(itemDir, "after.pdf", aPage, join(itemDir, "pages", `after-${aPage}.png`)),
      marks: markRuns(changeMarks(aWords, inserted, aFound).filter((w) => w.page === aPage)),
    };
    const before: PageSide | null =
      bInfo && base.pdf
        ? {
            page: bPage!,
            ...bInfo,
            file: await this.renderPage(bWork, base.pdf, bPage!, join(baseDir, "pages", `${bPage}.png`)),
            marks: markRuns(changeMarks(bWords, removed, bFound).filter((w) => w.page === bPage)),
          }
        : null;
    return { base: req.base, key: req.key, after, before };
  }

  /**
   * Another page of a preview (the reviewer scrolled on): its image, rendered once and cached.
   * Null for a page that doesn't exist or a preview that isn't built.
   */
  async page(base: string, key: string, version: "after" | "before", n: number): Promise<{ file: string; width: number; height: number } | null> {
    if (this.env.status !== "ready" || !/^[0-9a-f]{40,64}$/.test(base) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || !Number.isInteger(n) || n < 1)
      return null;
    const baseDir = join(this.root, base);
    const itemDir = join(baseDir, "items", key);
    if (version === "after") {
      const info = existsSync(join(itemDir, "after.pdf")) ? await this.pdfInfo(itemDir, "after.pdf", n) : null;
      if (!info || n > info.count) return null;
      return { file: await this.renderPage(itemDir, "after.pdf", n, join(itemDir, "pages", `after-${n}.png`)), width: info.width, height: info.height };
    }
    const build = await readFile(join(baseDir, "base", "build.json"), "utf8").then(
      (t) => JSON.parse(t) as { pdf: string | null },
      () => null,
    );
    if (!build?.pdf || !/^stet-build\/[^/]+\.pdf$/.test(build.pdf.replace(/\\/g, "/"))) return null;
    const work = join(baseDir, "base", "src");
    const info = await this.pdfInfo(work, build.pdf, n);
    if (!info || n > info.count) return null;
    return { file: await this.renderPage(work, build.pdf, n, join(baseDir, "pages", `${n}.png`)), width: info.width, height: info.height };
  }

  private async pdfInfo(work: string, pdfRel: string, page: number): Promise<{ count: number; width: number; height: number } | null> {
    const r = await this.run(work, ["pdfinfo", "-f", String(page), "-l", String(page), pdfRel]);
    const count = Number(/^Pages:\s+(\d+)/m.exec(r.stdout)?.[1] ?? 0);
    const size = /Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(r.stdout);
    return count && size ? { count, width: Number(size[1]), height: Number(size[2]) } : null;
  }

  private async pageWords(work: string, pdfRel: string, first: number, last: number): Promise<PdfWord[]> {
    const r = await this.run(work, ["pdftotext", "-bbox-layout", "-f", String(first), "-l", String(last), pdfRel, "-"]);
    return r.code === 0 ? parseWords(r.stdout, first) : [];
  }

  /** A whole page as an image (once: it's cached at `out`). */
  private async renderPage(work: string, pdfRel: string, n: number, out: string): Promise<string> {
    if (existsSync(out)) return out;
    await mkdir(dirname(out), { recursive: true });
    const name = `.page-${randomBytes(4).toString("hex")}`;
    const r = await this.run(work, ["pdftoppm", "-f", String(n), "-l", String(n), "-r", String(PAGE_RESOLUTION), "-png", "-singlefile", pdfRel, name]);
    if (r.code !== 0) throw new Error(`pdftoppm failed: ${r.stderr.slice(0, 200)}`);
    await rename(join(work, `${name}.png`), out);
    return out;
  }

  /** A failed build, with what's missing if a file couldn't be found (a package not in the preview's TeX). */
  private failure(cause: "base" | "change", message: string, log: string): PreviewResult {
    const m = this.missingIn(log);
    const say = m.missing
      ? ` ${m.missing.files.join(", ")} ${m.missing.files.length === 1 ? "isn't" : "aren't"} in ${this.ts.installHint(this.env, m.missing.extras)}.`
      : "";
    return { status: "failed", cause, message: message + say, log: this.ts.excerpt(log), typesetter: this.ts.name, ...m };
  }

  private missingIn(log: string): { missing?: Missing } {
    const files = this.ts.missingFiles(log);
    return files.length ? { missing: { files, extras: !!this.env.extrasAvailable } } : {};
  }

  /**
   * Locate source lines in a PDF (the typesetter's `locate`) and render that region to `out`.
   * `found`: where the changes (`spans`) are on the page, for the page view's marks.
   */
  private async region(
    work: string,
    pdf: string,
    file: string,
    lines: number[],
    out: string,
    spans: Span3[] = [],
  ): Promise<{ img: PreviewImage; found: Located[] } | null> {
    const pdfRel = relTo(work, pdf);
    const boxes = await this.ts.locate(this.run, work, pdfRel, file, lines);
    if (!boxes?.length) return null;
    const page = boxes[0]!.page;

    // The words of the changes, on the pages found and the one after (a paragraph may go on).
    let shown = boxes;
    let at = page;
    let located: Located[] = [];
    if (spans.length) {
      const pages = boxes.map((b) => b.page);
      const first = Math.min(...pages),
        last = Math.max(...pages) + 1;
      const text = await this.run(work, ["pdftotext", "-bbox-layout", "-f", String(first), "-l", String(last), pdfRel, "-"]);
      const words = text.code === 0 ? parseWords(text.stdout, first) : [];
      const found = spans.map((s) => {
        const plain = (t: string) => this.ts.plainWords(t);
        const f = findWordsIn(words, plain(s.before).slice(-6), plain(s.text), plain(s.after).slice(0, 6), page);
        return f && { ...f, whole: s.whole };
      });
      located = found.filter((f): f is Located & { whole: boolean } => !!f);
      if (found[0]) {
        at = found[0].words[0]!.page;
        // The others shown with it, where they are on the same page.
        shown = located.filter((f) => f.words.some((w) => w.page === at)).flatMap((f) => wordBoxes(f.words.filter((w) => w.page === at)));
      }
    }
    const info = await this.run(work, ["pdfinfo", "-f", String(at), "-l", String(at), pdfRel]);
    const size = /Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(info.stdout) ?? /Page size:\s+([\d.]+)\s+x\s+([\d.]+)/.exec(info.stdout);
    if (!size) return null;
    const crop = cropRegion(shown, { width: Number(size[1]), height: Number(size[2]) });
    if (!crop) return null;
    const px = (pt: number) => String(Math.round((pt * RESOLUTION) / 72));
    const name = `.region-${randomBytes(4).toString("hex")}`;
    const r = await this.run(work, [
      "pdftoppm",
      "-f",
      String(crop.page),
      "-l",
      String(crop.page),
      "-r",
      String(RESOLUTION),
      "-x",
      px(crop.x),
      "-y",
      px(crop.y),
      "-W",
      px(crop.w),
      "-H",
      px(crop.h),
      "-png",
      "-singlefile",
      pdfRel,
      name,
    ]);
    if (r.code !== 0) return null;
    await rename(join(work, `${name}.png`), out);
    return { img: { file: out, page: crop.page }, found: located };
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

  /** The typesetter's source files below `dir` (relative paths, forward slashes) and their text. */
  private async sourceFiles(dir: string, rel = "", out = new Map<string, string>()): Promise<Map<string, string>> {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) await this.sourceFiles(dir, p, out);
      } else if (e.isFile() && this.ts.source.test(e.name) && (await stat(join(dir, p))).size < 4_000_000) {
        out.set(p, await readFile(join(dir, p), "utf8"));
      }
    }
    return out;
  }

  /** Keep the builds of the newest few base commits. */
  private async prune(current: string): Promise<void> {
    const dirs = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    const bases = await Promise.all(
      dirs
        .filter((d) => d.isDirectory() && join(this.root, d.name) !== current)
        .map(async (d) => ({ p: join(this.root, d.name), t: (await stat(join(this.root, d.name))).mtimeMs })),
    );
    bases.sort((a, b) => b.t - a.t);
    for (const b of bases.slice(KEEP_BASES - 1)) await rm(b.p, { recursive: true, force: true });
  }
}

/**
 * Apply `changes` (several files, each change against its file's base text) and say where the
 * target change starts in its file's new text. Null if two changes in a file overlap.
 */
export function applyChanges(changes: PreviewChange[], target: number): { files: Map<string, string>; start: number; starts: number[] } | null {
  const files = new Map<string, string>();
  let start = -1;
  const starts: number[] = changes.map(() => -1);
  for (const file of new Set(changes.map((c) => c.file))) {
    const list = changes
      .map((c, k) => ({ c, k }))
      .filter((x) => x.c.file === file)
      .sort((a, b) => a.c.range.start - b.c.range.start || a.k - b.k);
    for (let i = 1; i < list.length; i++) if (list[i]!.c.range.start < list[i - 1]!.c.range.end) return null;
    let text = list[0]!.c.baseText;
    let shift = 0;
    for (const { c, k } of list) {
      starts[k] = c.range.start + shift;
      if (k === target) start = c.range.start + shift;
      shift += c.newText.length - (c.range.end - c.range.start);
    }
    for (const { c } of [...list].reverse()) text = text.slice(0, c.range.start) + c.newText + text.slice(c.range.end);
    files.set(file, text);
  }
  return start < 0 ? null : { files, start, starts };
}

// ---------------------------------------------------------------------------
// Finding a change's words on the page. A typesetter maps source *lines* to the page (SyncTeX),
// and a paragraph is often one source line: it returns the whole paragraph, starting on the page
// where the paragraph starts. The words themselves say where the change is.

export interface PdfWord {
  text: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The words of `pdftotext -bbox-layout` output, in reading order; a word hyphenated at a line end
 * is joined. Around maths pdftotext cuts a printed line into pieces in no stable order (a
 * superscript on a line of its own, the second half of a line before the first), so each block's
 * lines are rebuilt from where the words are: words of the block's usual size on one level make
 * a line, smaller ones (sub- and superscripts, operators) join the line their middle is in, and
 * every line is read left to right. Blocks stay as they are, so columns stay apart, and both
 * versions of a page read maths alike.
 */
export function parseWords(xhtml: string, firstPage: number): PdfWord[] {
  const blocks: PdfWord[][] = [];
  let page = firstPage - 1;
  let block: PdfWord[] | null = null;
  const re = /<page\b|<block\b|<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  for (let m = re.exec(xhtml); m; m = re.exec(xhtml)) {
    if (m[0] === "<page") {
      page++;
      block = null;
    } else if (m[0] === "<block") blocks.push((block = []));
    else
      (block ?? blocks[blocks.push((block = [])) - 1]!).push({
        text: decodeXml(m[5]!),
        page,
        x0: Number(m[1]),
        y0: Number(m[2]),
        x1: Number(m[3]),
        y1: Number(m[4]),
      });
  }
  const out: PdfWord[] = [];
  for (const words of blocks) {
    if (!words.length) continue;
    const h = (w: PdfWord) => w.y1 - w.y0;
    const mid = (w: PdfWord) => (w.y0 + w.y1) / 2;
    const usual = [...words].map(h).sort((a, b) => a - b)[Math.floor(words.length / 2)]!;
    // Lines: the usual-size words, by level.
    const rows: { mid: number; y0: number; y1: number; words: PdfWord[] }[] = [];
    for (const w of [...words].filter((w) => h(w) >= 0.85 * usual).sort((a, b) => mid(a) - mid(b))) {
      const row = rows.find((r) => Math.abs(r.mid - mid(w)) < 0.3 * usual);
      if (row) {
        row.words.push(w);
        row.y0 = Math.min(row.y0, w.y0);
        row.y1 = Math.max(row.y1, w.y1);
      } else rows.push({ mid: mid(w), y0: w.y0, y1: w.y1, words: [w] });
    }
    // The rest: into the line its middle is in, else the nearest.
    for (const w of words.filter((w) => h(w) < 0.85 * usual)) {
      const near = (r: (typeof rows)[number]) => (mid(w) >= r.y0 && mid(w) <= r.y1 ? 0 : Math.min(Math.abs(mid(w) - r.y0), Math.abs(mid(w) - r.y1)));
      const row = rows.reduce<(typeof rows)[number] | undefined>((best, r) => (!best || near(r) < near(best) ? r : best), undefined);
      if (row) row.words.push(w);
      else rows.push({ mid: mid(w), y0: w.y0, y1: w.y1, words: [w] });
    }
    for (const row of rows.sort((a, b) => a.mid - b.mid)) {
      const lineStart = out.length;
      for (const w of row.words.sort((a, b) => a.x0 - b.x0)) {
        const prev = out[out.length - 1];
        // "repre-" at the end of the line before, then "sentation": one word.
        if (prev && out.length === lineStart && prev.page === w.page && /[A-Za-z]-$/.test(prev.text)) {
          prev.text = prev.text.slice(0, -1) + w.text;
          continue;
        }
        out.push(w);
      }
    }
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** A word as it is compared on the page: letters and digits only, lower case, ligatures (ﬁ) taken apart. */
export const normWord = (w: string) =>
  w
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const norm = normWord;

/** The longest common subsequence of `a` and `b`, as pairs of indices. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length,
    m = b.length;
  const d: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i]![j] = a[i] === b[j] ? d[i + 1]![j + 1]! + 1 : Math.max(d[i + 1]![j]!, d[i]![j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (d[i + 1]![j]! >= d[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * Where `target` (with the words `before` and `after` it, which tell its place among the same
 * words elsewhere) is in `words`: the PDF words of the target, or for a deletion the two words
 * around it. Null if it can't be found with some confidence. `hint`: SyncTeX's page, preferred.
 */
export function findWords(words: PdfWord[], before: string[], target: string[], after: string[], hint?: number): PdfWord[] | null {
  return findWordsIn(words, before, target, after, hint)?.words ?? null;
}

/**
 * A change found on the page: its words, or (`around`) the two words around it. `before` and
 * `after`: the words of its context found right before and after it, which bound where it is
 * (its own words may typeset differently, as maths does: `k^2` is "k", "2").
 */
export interface Located {
  words: PdfWord[];
  around: boolean;
  before?: PdfWord;
  after?: PdfWord;
  /** Shown whole (mostly rewritten), as the editor shows it; set by the caller. */
  whole?: boolean;
}

/** `findWords`, saying whether it found the change's own words or only those around it. */
export function findWordsIn(words: PdfWord[], before: string[], target: string[], after: string[], hint?: number): Located | null {
  // Long changes: their beginning and end are enough to match...
  const t = target.length > 40 ? [...target.slice(0, 20), ...target.slice(-20)] : target;
  const seq = [...before, ...t, ...after];
  if (seq.length < 2) return null;
  const pdf = words.map((w) => norm(w.text));
  // ...in a stretch of the page as long as the whole change, and then some: maths typesets as more
  // words than the source shows (a long rewritten paragraph was found by its end only).
  const span = before.length + after.length + target.length + Math.max(6, Math.ceil(target.length * 1.5));
  let best: { score: number; pairs: [number, number][]; at: number } | null = null;
  for (let s = 0; s < pdf.length; s++) {
    if (!seq.slice(0, 4).includes(pdf[s]!) && !t.includes(pdf[s]!)) continue; // windows start at a likely word
    const pairs = lcs(seq, pdf.slice(s, s + span)).map(([i, j]) => [i, j + s] as [number, number]);
    // Matched words, a little less when far from SyncTeX's page.
    const score = pairs.length - (hint !== undefined && words[s]!.page !== hint ? 0.5 : 0);
    if (!best || score > best.score) best = { score, pairs, at: s };
  }
  if (!best || best.pairs.length < Math.max(2, Math.ceil(seq.length * 0.5))) return null;
  const inTarget = best.pairs.filter(([i]) => i >= before.length && i < before.length + t.length).map(([, j]) => words[j]!);
  const lastBefore = best.pairs.filter(([i]) => i < before.length).at(-1);
  const firstAfter = best.pairs.find(([i]) => i >= before.length + t.length);
  const bounds = { ...(lastBefore ? { before: words[lastBefore[1]]! } : {}), ...(firstAfter ? { after: words[firstAfter[1]]! } : {}) };
  if (inTarget.length) return { words: inTarget, around: false, ...bounds };
  // A deletion (or a change whose words didn't match): the words on either side of it.
  const around = [lastBefore, firstAfter].filter((x): x is [number, number] => !!x).map(([, j]) => words[j]!);
  return around.length ? { words: around, around: true, ...bounds } : null;
}

/**
 * The words that differ between two versions: those of `after` not in `before` (inserted), and
 * the other way round (removed). Compared as typeset, punctuation included (a comma added is a
 * change, and an equation number "(2)" is not the exponent 2), but without hyphens, which
 * reflowing a paragraph adds and removes.
 */
export function wordDiff(before: PdfWord[], after: PdfWord[]): { inserted: PdfWord[]; removed: PdfWord[] } {
  // Maths in pieces, letters apart from digits and each symbol: how pdftotext splits maths into
  // words depends on the spacing of the line ("p+i" in one version is "p + i" in the other). A
  // word differs if a piece of it does. Between two PDFs a change of case is a change.
  type Piece = { text: string; k: number };
  type Tok = { key: string; pieces: Piece[]; prose: boolean };
  const tokens = (ws: PdfWord[]): Tok[] => {
    const out: Tok[] = [];
    ws.forEach((w, k) => {
      const text = w.text.normalize("NFKC").replace(/[\s\-\u00ad\u2010\u2011]/g, "");
      if (!text) return;
      // A prose word, with the punctuation on it, compares whole ("document." is not "document"
      // and a full stop from elsewhere).
      if (/^[^\p{L}\p{M}\p{N}]*\p{L}[\p{L}\p{M}]+[^\p{L}\p{M}\p{N}]*$/u.test(text)) {
        out.push({ key: "", pieces: [{ text, k }], prose: true });
        return;
      }
      // Maths, numbers and punctuation between two prose words: one formula, compared by its pieces
      // in any order (sub- and superscripts are read in another order when lines break differently).
      const last = out[out.length - 1];
      const pieces = (text.match(/[\p{L}\p{M}]+|\p{N}+|[^\p{L}\p{M}\p{N}]/gu) ?? []).map((t) => ({ text: t, k }));
      if (last && !last.prose) last.pieces.push(...pieces);
      else out.push({ key: "", pieces, prose: false });
    });
    for (const t of out)
      t.key = t.prose
        ? t.pieces[0]!.text
        : "\u0001" +
          t.pieces
            .map((p) => p.text)
            .sort()
            .join("\u0001");
    return out;
  };
  const [bt, at] = [tokens(before), tokens(after)];
  // Replacements: what goes and what comes between two parts that stay the same.
  const hunks: { gone: Tok[]; come: Tok[] }[] = [];
  let open: { gone: Tok[]; come: Tok[] } | null = null;
  for (const ch of diffArrays(bt, at, { comparator: (x, y) => x.key === y.key })) {
    if (!ch.added && !ch.removed) {
      open = null;
      continue;
    }
    if (!open) hunks.push((open = { gone: [], come: [] }));
    (ch.removed ? open.gone : open.come).push(...ch.value);
  }
  // A formula that only moved (it stays, and the prose around it changed) is no change.
  const goneByKey = new Map<string, Tok[]>();
  for (const h of hunks) for (const t of h.gone) if (!t.prose) goneByKey.set(t.key, [...(goneByKey.get(t.key) ?? []), t]);
  const stayed = new Set<Tok>();
  for (const h of hunks) {
    for (const t of h.come) {
      const twin = t.prose ? undefined : goneByKey.get(t.key)?.shift();
      if (twin) stayed.add(t).add(twin);
    }
  }
  for (const h of hunks) [h.gone, h.come] = [h.gone.filter((t) => !stayed.has(t)), h.come.filter((t) => !stayed.has(t))];
  const removed = new Set<number>();
  const inserted = new Set<number>();
  for (const h of hunks) {
    for (const t of h.gone) if (t.prose) removed.add(t.pieces[0]!.k);
    for (const t of h.come) if (t.prose) inserted.add(t.pieces[0]!.k);
    // Formulas changed here: their pieces in order, so only the symbols that differ are marked
    // (`k` → `k^2` marks the exponent, not an equation number "(2)" next to it); a piece that
    // only moved within them is no change.
    const bs = h.gone.filter((t) => !t.prose).flatMap((t) => t.pieces);
    const as = h.come.filter((t) => !t.prose).flatMap((t) => t.pieces);
    const gone: Piece[] = [];
    const come: Piece[] = [];
    for (const ch of diffArrays(bs, as, { comparator: (x, y) => x.text === y.text })) (ch.removed ? gone : ch.added ? come : []).push(...ch.value);
    for (const x of gone) {
      const same = come.findIndex((y) => y.text === x.text);
      if (same >= 0) come.splice(same, 1);
      else removed.add(x.k);
    }
    for (const y of come) inserted.add(y.k);
  }
  return { inserted: after.filter((_, k) => inserted.has(k)), removed: before.filter((_, k) => removed.has(k)) };
}

/**
 * The marks of the changes shown: of the words that differ (`differ`, from `wordDiff`), those
 * where a change is on the page (`spans`, from `findWordsIn`, in `words`: the pages compared):
 * between the context found before and after it. Elsewhere a difference is a consequence (an
 * equation or a reference renumbered, a float moved), not the change. A change the editor shows
 * whole (mostly rewritten) is marked whole. Without spans (none could be found), every difference.
 */
export function changeMarks(words: PdfWord[], differ: PdfWord[], spans: Located[]): PdfWord[] {
  const key = (w: PdfWord) => `${w.page}:${w.x0}:${w.y0}:${w.x1}`;
  const index = new Map(words.map((w, i) => [key(w), i]));
  const marked = new Set(differ.map(key));
  const out = new Set<number>();
  let placed = 0;
  for (const s of spans) {
    const own = s.around ? [] : s.words.map((w) => index.get(key(w))).filter((i): i is number => i !== undefined);
    const b = s.before && index.get(key(s.before));
    const a = s.after && index.get(key(s.after));
    // From the context before it to the context after it; its own words where a side is missing.
    const lo = b !== undefined ? b + 1 : own.length ? Math.min(...own) : undefined;
    const hi = a !== undefined ? a - 1 : own.length ? Math.max(...own) : undefined;
    if (lo === undefined || hi === undefined) continue;
    placed++;
    // Whole: its own words, first to last (not, say, a section number between it and the context).
    const [first, last] = s.whole && own.length ? [Math.min(...own), Math.max(...own)] : [Infinity, -Infinity];
    // The context words too where they differ: punctuation added to one ("However" → "However,").
    for (let i = b ?? lo; i <= (a ?? hi); i++) if ((i >= first && i <= last) || marked.has(key(words[i]!))) out.add(i);
  }
  if (!placed) return differ;
  return [...out].sort((x, y) => x - y).map((i) => words[i]!);
}

/** Marked words as boxes, neighbours on one line joined into one. */
export function markRuns(words: PdfWord[]): Box[] {
  const out: Box[] = [];
  let last: (PdfWord & Box) | null = null;
  for (const w of words) {
    if (last && Math.abs(w.y0 - last.y0) < 2 && w.x0 - last.x1 < 12 && w.x0 >= last.x0) {
      last.x1 = Math.max(last.x1, w.x1);
      last.y1 = Math.max(last.y1, w.y1);
      continue;
    }
    last = { ...w };
    out.push(last);
  }
  return out.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/** The boxes of words (for `cropRegion`), on the page of the first. */
export function wordBoxes(found: PdfWord[]): SyncBox[] {
  const page = found[0]!.page;
  return found.filter((w) => w.page === page).map((w) => ({ page, h: w.x0, v: w.y1, W: w.x1 - w.x0, H: w.y1 - w.y0 }));
}

/** A change in one version's text: its text, and some text on either side. */
interface Span3 {
  before: string;
  text: string;
  after: string;
  /** The editor shows it whole: marked whole on the page too. */
  whole: boolean;
}
const around = (text: string, start: number, end: number, whole = false): Span3 => ({
  before: text.slice(Math.max(0, start - 300), start),
  text: text.slice(start, end),
  after: text.slice(end, end + 300),
  whole,
});

/** Does the editor show this change whole (mostly rewritten), rather than the words that differ? */
const shownWhole = (oldText: string, newText: string, tokenize?: (text: string) => Token[]): boolean => {
  const d = inlineDiff(oldText, newText, tokenize);
  return (
    d.removed.length <= 1 &&
    d.inserted.length <= 1 &&
    (d.removed[0]?.[1] ?? 0) - (d.removed[0]?.[0] ?? 0) === oldText.length &&
    (d.inserted[0]?.text ?? "") === newText
  );
};

/** Whether `file` is somewhere below `root` (no `..`). */
function insideTree(file: unknown, root: string): boolean {
  return typeof file === "string" && file.startsWith(root + sep) && !file.slice(root.length).split(/[\\/]/).includes("..");
}

/** Whether `file` is a file directly in `dir` (no other folder, no `..`). */
export function insideDir(file: unknown, dir: string): boolean {
  return typeof file === "string" && dirname(file) === dir && !basename(file).startsWith(".");
}

const relPdf = (pdf: string) => join("stet-build", basename(pdf));
const relTo = (work: string, p: string) => (p.startsWith(work) ? p.slice(work.length + 1) : p).replace(/\\/g, "/");
