/**
 * Building PDF previews: the build cache per version of the project, compiling a change before
 * and after, rendering the region where it lands, and whole pages for the page view. Isolation
 * and settings are in `env.ts`.
 */
import { randomBytes } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { filterOverrides, type Repo } from "../git.js";
import { inlineDiff } from "../inline.js";
import type { LanguageProfile, SetupAction, Typesetter } from "../lang/profile.js";
import { writeInside } from "../safefs.js";
import { type Eol, fromLf, isSafeRepoPath, lineOf } from "../text.js";
import type { Token } from "../tokenizer.js";
import { type PreviewConfig, type PreviewEnv, runIsolated } from "./env.js";
import { type Box, changeMarks, findWordsIn, type Located, markRuns, type PdfWord, parseWords, type SyncBox, wordBoxes, wordDiff } from "./words.js";

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
  /** The setup action that may bring them (`extras` is true then): its texts, for the offer. */
  action?: SetupAction;
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

/** A whole file as a change leaves it: added or renamed to (`text`), or deleted (null). */
export interface PreviewFile {
  file: string;
  text: string | null;
  eol: Eol;
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
  /** Files the changes shown with it add, delete or rename (an added chapter its \include needs). */
  files?: PreviewFile[];
}

const RESOLUTION = 200; // dpi of the rendered region: sharp enough to zoom in

const PAGE_RESOLUTION = 170; // dpi of whole pages in the page viewer

const KEEP_BASES = 3;

/** Builds previews for one project, with a cache under `root` (`<store>/previews`). */
export class PreviewBuilder {
  private readonly building = new Map<string, Promise<unknown>>();
  private readonly ts: Typesetter;
  private readonly tokenize: ((text: string) => Token[]) | undefined;

  /**
   * `profile`: the document's language, which has the typesetter. `identity`: what else makes a
   * build (the profile's version, the preview settings), a hash: builds are cached per base commit
   * and identity, so a build made with another profile, root or engine is never taken for this
   * one's (core profile review db49f7d, 2).
   */
  constructor(
    private readonly repo: Repo,
    private readonly root: string,
    private readonly cfg: PreviewConfig,
    private readonly env: PreviewEnv,
    profile: LanguageProfile,
    private readonly identity = "",
  ) {
    if (identity && !/^[0-9a-f]{1,64}$/.test(identity)) throw new Error("A preview build's identity is a hash.");
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
    const baseDir = this.baseDir(req.base);
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

  /** The folder of a base commit's builds, for this identity. */
  private baseDir(base: string): string {
    return join(this.root, this.identity ? `${base}-${this.identity}` : base);
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
        // Where the typesetter put it, relative to the tree (core profile review db49f7d, 3).
        pdf = r.pdf && pdfIn(join(tmp, "src"), r.pdf);
        log = r.log;
      }
      const info = { root, pdf, log };
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
    for (const f of req.files ?? []) {
      if (applied.files.has(f.file) || !isSafeRepoPath(f.file))
        return { status: "failed", cause: "change", message: "The changes to preview overlap; Stet can't apply them together.", log: "" };
      if (f.text === null) await rm(join(work, f.file), { force: true });
      else await writeInside(work, f.file, fromLf(f.text, f.eol));
    }
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
      base.root,
      spansAfter,
    );
    if (!afterAt) return noSpot;
    const beforeAt = await this.region(
      join(base.dir, "src"),
      join(base.dir, "src", base.pdf),
      target.file,
      lines(target.baseText, target.range.start, target.range.end),
      join(itemDir, "before.png"),
      base.root,
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
    const baseDir = this.baseDir(base);
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
    if (!build?.pdf || !safeRel(build.pdf)) return null;
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
    const action = this.env.extrasAvailable ? this.ts.setupActions?.find((a) => a.bringsMissing) : undefined;
    return files.length ? { missing: { files, extras: !!action, ...(action ? { action } : {}) } } : {};
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
    root: string,
    spans: Span3[] = [],
  ): Promise<{ img: PreviewImage; found: Located[] } | null> {
    const pdfRel = relTo(work, pdf);
    const boxes = await this.ts.locate(this.run, work, pdfRel, file, lines, root);
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
      } else if (e.isFile() && this.ts.source.test(p) && (await stat(join(dir, p))).size < 4_000_000) {
        // The path from the project's top, as everywhere else the source pattern is matched (core
        // profile review db49f7d, 4).
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

/** A PDF the typesetter made in `work`, relative to it (forward slashes); null if it is outside. */
export function pdfIn(work: string, pdf: string): string | null {
  const rel = relative(work, isAbsolute(pdf) ? pdf : join(work, pdf)).replace(/\\/g, "/");
  return safeRel(rel) ? rel : null;
}

/** A path in a build tree: relative, without `..`, and to a PDF. */
const safeRel = (p: string) => {
  const s = p.replace(/\\/g, "/");
  return !isAbsolute(s) && !/^[a-zA-Z]:/.test(s) && /\.pdf$/i.test(s) && !s.split("/").some((x) => x === ".." || x === "" || x === ".");
};

const relTo = (work: string, p: string) => (p.startsWith(work) ? p.slice(work.length + 1) : p).replace(/\\/g, "/");
