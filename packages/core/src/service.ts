/** Stet service layer (spec §7, §12.1). All frontends go through this class. */
import { createHash } from "node:crypto";
import { readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { anchorNear, type Neighbour, type Span } from "./anchor.js";
import type { FileChange, FileView, TextFile } from "./apply.js";
import { defaultConfig, type StetConfig } from "./config.js";
import { notFound, StetError } from "./errors.js";
import { gitRaw, Repo, untrustedWorktreeConfig } from "./git.js";
import { type HookStatus, hookStatus, installHooks, uninstallHooks } from "./hooks.js";
import { buildIgnores, detectLanguage, documentLanguages, type LanguageProfile, languageCounts, matchesAny, profileFor, profilesFor } from "./lang/index.js";
import { addToLibrary, type LibraryProfile, libraryModule, readLibrary } from "./lang/library.js";
import {
  type Accepted,
  type Agent,
  type Changeset,
  FEEDBACK_TYPES,
  type Group,
  type HistoryEntry,
  type Item,
  type ItemBrief,
  type ItemStatus,
  isAccepted,
  isLive,
  type Lookup,
  type MoveInfo,
  type StetEvent,
} from "./model.js";
import type { DeliveredNote } from "./notes.js";
import { pathExists, samePath } from "./paths.js";
import { inspect, prepare, readInside, replaceFile, type Target, UnsafePathError } from "./safefs.js";
import { Agents } from "./service/agents.js";
import { ReviewBase } from "./service/base.js";
import { now } from "./service/common.js";
import { Decisions } from "./service/decisions.js";
import { Drafts } from "./service/drafts.js";
import { GroupOps } from "./service/groups.js";
import { Notes } from "./service/notes.js";
import { Previews } from "./service/previews.js";
import { Submission } from "./service/submit.js";
import { Store, writeJsonAtomic } from "./store.js";
import { detectEol, fromLf, isBinary, isSafeRepoPath, lineOf, toLf } from "./text.js";
import type { CliCommand } from "./workspace.js";

export { BASE_REF } from "./service/base.js";
export { LARGE_SUBMIT } from "./service/submit.js";
export { StetError };

const hashOf = (b: Buffer | null) => (b === null ? null : createHash("sha256").update(b).digest("hex"));
export interface SubmitResult {
  changeset: Changeset | null;
  items: Item[];
  groups: Group[];
  ungrouped: string[];
  superseded: string[];
  withdrawn: string[];
  repeats: string[];

  /** Moved passages found in this round (§6.4.7). */
  moves: MoveInfo[];
  warnings: string[];
  sync: SyncResult | null;
}
export interface SyncResult {
  base: string;
  stale: Item[];
  kept: number;

  /** Reviewer notes delivered with this sync (§7.8). */
  notes: DeliveredNote[];
}
export interface AcceptResult {
  accepted: Item[];
  stale: Item[];
  committed: string | null;
  warnings: string[];
}
export interface AgentStatus {
  agent: Agent;
  mainBranch: string;
  base: string;
  syncNeeded: boolean;
  counts: Partial<Record<ItemStatus, number>>;
  unreadFeedback: number;

  /** Reviewer notes waiting for the agent's next sync (§7.8). */
  notesWaiting: number;

  /** Its accepted items that its copy lacks: the review base could not apply them (see `missingFromBase`). */
  missingAccepted: string[];
}
export interface UndoResult {
  /** The items whose decision was undone: pending again. */
  reopened: Item[];

  /** Items the undone accept had made stale: pending again too. */
  restored: Item[];
}
export interface ItemFilter {
  agent?: string;
  status?: ItemStatus | ItemStatus[];
  changeset?: string;
  file?: string;
}

// ---------------------------------------------------------------------------
/** Journal of an accept in progress (`.git/stet/txn.json`). */
interface AcceptJournal {
  items: { id: string; appliedText: string; edited: boolean }[];

  /** An undo of accepted items (`Stet.undo`): finishing it makes them pending again. */
  undo?: boolean;
  filesDone: boolean;

  /**
   * Every file the accept writes: original content (base64; null = did not exist) and content
   * hashes before and after Stet's write (null = absent). Undo restores a file only while it still
   * holds exactly what Stet wrote, so later edits by the user are never overwritten.
   */
  files: { path: string; original: string | null; before: string | null; after: string | null }[];
}
/** Text changes accepted from the same base as `item` in its file, from `all` items (see `anchorNear`). */
function neighboursIn(all: readonly Item[], item: Item): Neighbour[] {
  return all
    .filter(isAccepted)
    .filter((i) => i.id !== item.id && i.kind === "modify" && i.file === item.file && i.baseCommit === item.baseCommit)
    .map((i) => ({ range: { ...i.range }, oldText: i.oldText, text: i.resolution.appliedText }));
}

/**
 * The Stet service: the CLI, the MCP server and the VS Code extension all go through it. Stet
 * opens the project and holds the helpers its parts share; the operations live in the parts
 * (service/: review base, agents, submit, groups, decisions, previews, drafts, notes).
 */
/** The selectable languages of your profile library that `cfg` doesn't have yet. */
async function libraryLanguages(cfg: StetConfig): Promise<LibraryProfile[]> {
  const known = new Set(profilesFor(cfg).map((p) => p.id));
  return (await readLibrary()).filter((e) => e.selectable && !known.has(e.id));
}

/** How many of `paths` each library language has, by its default patterns; those without files left out. */
function libraryCounts(paths: string[], library: LibraryProfile[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of library) {
    const n = paths.filter((f) => matchesAny(f, e.defaultFiles)).length;
    if (n) out[e.id] = n;
  }
  return out;
}

/** What `importProfile` installed. */
export interface ProfileImport {
  id: string;
  name: string;
  /** The project's language now. */
  language: string;
  /** Whether it can be the project's language (it has examples for agents). */
  selectable: boolean;
  /** Its build files git doesn't ignore yet (`ignoreBuildFiles` adds them to .gitignore). */
  buildFiles: string[];
  /** Whether it is in your profile library, for your other projects. */
  library: boolean;
}

export class Stet {
  /**
   * The parts of the service, by area. Stet's own methods below forward to them, so callers
   * never need these; the parts reach each other and Stet's helpers through `stet`.
   */
  /** @internal The operations by area; front ends use the methods below, which forward to them. */
  readonly baseOps = new ReviewBase(this);
  /** @internal */
  readonly agentOps = new Agents(this);
  /** @internal */
  readonly submitOps = new Submission(this);
  /** @internal */
  readonly groupOps = new GroupOps(this);
  /** @internal */
  readonly decisionOps = new Decisions(this);
  /** @internal */
  readonly previewOps = new Previews(this);
  /** @internal */
  readonly draftOps = new Drafts(this);
  /** @internal */
  readonly noteOps = new Notes(this);

  private constructor(
    /** Path of the main worktree (the user's working copy). */
    readonly mainPath: string,
    /** @internal Git in the main worktree: for the core only. */
    readonly repo: Repo,
    /** @internal The records in `.git/stet/`: for the core only, which keeps their rules (the lock, validation). */
    readonly store: Store,
  ) {}

  /** The folder of Stet's records (`.git/stet`), for watching it. */
  get storeRoot(): string {
    return this.store.root;
  }

  // -------------------------------------------------------------------------
  // Opening / init

  /**
   * The repository around `cwd`. `agentWorkspace`: `cwd` is in an agent's workspace (another
   * worktree of the project), where the reviewer's commands and setup don't belong.
   */
  static async locate(cwd: string): Promise<{ repo: Repo; mainPath: string; commonDir: string; toplevel: string; agentWorkspace: boolean }> {
    const probe = new Repo(cwd);
    // One git call for both (each call costs a process start, the most of opening a repository).
    const out = await probe.tryRun(["rev-parse", "--show-toplevel", "--git-common-dir"]);
    const [top, dir] = out?.split("\n") ?? [];
    if (!top || !dir) throw new StetError(`Not inside a git repository: ${cwd}`);
    const common = isAbsolute(dir) ? dir : resolve(cwd, dir);
    // In the main folder of an ordinary repository (git dir `.git` right inside it) that folder is
    // the main worktree; elsewhere (an agent workspace, a submodule) git lists where it is.
    const inMain = basename(common) === ".git" && samePath(dirname(common), top);
    const main = inMain ? top : ((await probe.worktrees(common))[0]?.path ?? top);
    return { repo: new Repo(main), mainPath: main, commonDir: common, toplevel: top, agentWorkspace: !samePath(main, top) };
  }

  /**
   * What setting up `dir` would find, before it is done: whether Stet is set up there already,
   * and the document languages of its tracked files, most files first (when there are files of
   * several, the front ends say so or ask). Throws when `dir` is in no git repository.
   */
  static async inspectSetup(
    dir: string,
    located?: Awaited<ReturnType<typeof Stet.locate>>,
  ): Promise<{
    setUp: boolean;
    languages: [id: string, files: number][];
    /** The languages' names, by id. */
    names: Record<string, string>;
    /** Which of `languages` come from your profile library (setup installs the one picked). */
    fromLibrary: string[];
    located: Awaited<ReturnType<typeof Stet.locate>>;
  }> {
    const loc = located ?? (await Stet.locate(dir));
    const stet = await Stet.open(dir, loc).catch(() => null);
    const cfg = stet ? await stet.config() : defaultConfig("main");
    const tracked = ((await loc.repo.tryRun(["ls-files", "-z"])) ?? "").split("\0").filter(Boolean);
    const library = await libraryLanguages(cfg);
    const counts = { ...languageCounts(tracked, cfg.files, cfg), ...libraryCounts(tracked, library) };
    const languages = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const names = Object.fromEntries([...documentLanguages(cfg), ...library].map((p) => [p.id, p.name]));
    return { setUp: !!stet, languages, names, fromLibrary: library.map((e) => e.id).filter((id) => id in counts), located: loc };
  }

  /** Edits to tracked files not committed yet: agents start from the last commit and don't see them. */
  async uncommittedEdits(): Promise<boolean> {
    return !!(await this.repo.tryRun(["status", "--porcelain", "--untracked-files=no"]));
  }

  /** `located`: what `Stet.locate(cwd)` returned, when the caller has it already. */
  static async open(cwd: string, located?: Awaited<ReturnType<typeof Stet.locate>>): Promise<Stet> {
    const { mainPath, commonDir } = located ?? (await Stet.locate(cwd));
    const repo = new Repo(mainPath);
    const store = new Store(join(commonDir, "stet"));
    if (!(await store.exists())) throw new StetError("Stet is not set up in this repository. Run `stet init` in the project folder.");
    return new Stet(mainPath, repo, store);
  }

  /** `language`: the project's language when it is set up (else detected from its files). */
  static async init(cwd: string, opts: { mainBranch?: string; cli?: CliCommand; language?: string } = {}): Promise<Stet> {
    const { repo, mainPath, commonDir } = await Stet.locate(cwd);
    const branch = opts.mainBranch ?? (await repo.tryRun(["symbolic-ref", "--short", "HEAD"]));
    if (!branch) throw new StetError("Can't determine the main branch (detached HEAD?). Pass --main <branch>.");
    if (!(await repo.revParse(`refs/heads/${branch}`)))
      throw new StetError(`Branch '${branch}' has no commits yet. Commit your document first, then run \`stet init\`.`);
    const store = new Store(join(commonDir, "stet"));
    const fresh = !(await pathExists(join(store.root, "config.json")));
    await store.init(branch);
    const stet = new Stet(mainPath, repo, store);
    // A language of your profile library: installed from there once the store is set up.
    let fromLibrary: string | null = null;
    await store.withLock(async () => {
      let cfg = await store.config();
      const library = await libraryLanguages(cfg);
      // The project's language, from its files: once, when Stet is first set up here.
      if (opts.language !== undefined && !documentLanguages(cfg).some((p) => p.id === opts.language)) {
        if (!library.some((e) => e.id === opts.language))
          throw new StetError(
            `Unknown language '${opts.language}' (${[...documentLanguages(cfg), ...library]
              .map((p) => p.id)
              .join(" or ")}). For another language, import its profile: stet profile import <file.mjs>.`,
          );
        fromLibrary = opts.language;
      }
      if (fresh || opts.language) {
        const paths =
          fresh && !opts.language
            ? ((await repo.tryRun(["ls-tree", "-r", "-z", "--name-only", `refs/heads/${branch}`])) ?? "").split("\0").filter(Boolean)
            : [];
        const language = opts.language ?? detectLanguage(paths, cfg.files, cfg);
        if (!opts.language) {
          // A library language with more files than the built-in one found.
          const builtIn = languageCounts(paths, cfg.files, cfg)[language] ?? 0;
          const [best] = Object.entries(libraryCounts(paths, library)).sort((a, b) => b[1] - a[1]);
          if (best && best[1] > builtIn) fromLibrary = best[0];
        }
        if (!fromLibrary && language !== cfg.language) await store.saveConfig((cfg = { ...cfg, language }));
      }
      if (opts.cli) await store.saveConfig({ ...cfg, cli: opts.cli });
      if (cfg.guardHooks) await installHooks(repo, commonDir, cfg);
      await stet.ensureBase();
    });
    if (fromLibrary) await stet.useProfile(fromLibrary, { use: true });
    return stet;
  }

  /**
   * Install a trusted local language profile (`stet profile import`). `use`: make it the project's
   * language, and rewrite the active agents' instructions, which follow it. Says which of the
   * project's build files it would leave out of git (`ignoreBuildFiles`).
   */
  async importProfile(path: string, opts: { use?: boolean } = {}): Promise<ProfileImport> {
    if (!path.endsWith(".mjs")) throw new StetError("Pass a self-contained .mjs profile.");
    const source = await readFile(path);
    const r = await this.installProfile(source, path, opts);
    // Kept for your other projects too (`useProfile`).
    const library = await addToLibrary(source, this.installedProfile(await this.config(), r.id));
    return { ...r, library };
  }

  /**
   * Install a profile from your profile library (one you imported in another project): this
   * project gets its own copy, pinned by hash. `use` (default: when it can be): make it the
   * project's language.
   */
  async useProfile(id: string, opts: { use?: boolean } = {}): Promise<ProfileImport> {
    const { entry, source } = await libraryModule(id);
    return { ...(await this.installProfile(source, `${id} (from your profile library)`, { use: opts.use ?? entry.selectable })), library: true };
  }

  /** Your profile library, and which of its profiles this project has (`current`: the same version). */
  async profileLibrary(): Promise<(LibraryProfile & { installed: boolean; current: boolean })[]> {
    const cfg = await this.config();
    const ids = new Set(profilesFor(cfg).map((p) => p.id));
    return (await readLibrary()).map((e) => ({ ...e, installed: ids.has(e.id), current: (cfg.profileModules ?? []).includes(e.module) }));
  }

  private async installProfile(source: Buffer, label: string, opts: { use?: boolean }): Promise<Omit<ProfileImport, "library">> {
    const { id, languageChanged } = await this.store.installProfile(source, label, opts);
    if (languageChanged) await this.agentOps.refreshWorkspaces();
    const cfg = await this.config();
    const profile = this.installedProfile(cfg, id);
    return { id, name: profile.name, language: cfg.language, selectable: !!profile.agentTerms, buildFiles: await this.buildFilesToIgnore(id) };
  }

  /** Make `id` the project's language (a built-in or imported profile with examples for agents); the active agents' instructions follow it. */
  async setLanguage(id: string): Promise<void> {
    const changed = await this.store.withLock(async () => {
      const cfg = await this.config();
      const known = documentLanguages(cfg);
      if (!known.some((p) => p.id === id)) throw new StetError(`Unknown language '${id}' (${known.map((p) => p.id).join(" or ")}).`);
      if (cfg.language === id) return false;
      await this.store.saveConfig({ ...cfg, language: id });
      return true;
    });
    if (changed) await this.agentOps.refreshWorkspaces();
  }

  private installedProfile(cfg: StetConfig, id: string): LanguageProfile {
    const profile = profilesFor(cfg).find((p) => p.id === id);
    if (!profile) throw new StetError(`There is no language profile '${id}' in this project.`);
    return profile;
  }

  /**
   * The project's build files of a language (its `buildFiles` and the outputs of its sources),
   * for .gitignore: those git doesn't ignore yet.
   */
  async buildFilesToIgnore(profileId: string): Promise<string[]> {
    const cfg = await this.config();
    const profile = this.installedProfile(cfg, profileId);
    const patterns = (profile.files && cfg.files[profile.files]) || profile.defaultFiles || [];
    const paths = ((await this.repo.tryRun(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])) ?? "").split("\0").filter(Boolean);
    const out: string[] = [];
    for (const line of buildIgnores(paths, [{ ...profile, defaultFiles: patterns }])) {
      if (/[\r\n]/.test(line)) continue;
      // Already ignored: check-ignore names it.
      if (!(await this.repo.tryRun(["check-ignore", "--no-index", "--", line.replace(/^\//, "")]))) out.push(line);
    }
    return out;
  }

  /** Add a language's build files to the project's .gitignore (`buildFilesToIgnore`); returns the lines added. */
  async ignoreBuildFiles(profileId: string): Promise<string[]> {
    const lines = await this.buildFilesToIgnore(profileId);
    if (!lines.length) return [];
    const name = this.installedProfile(await this.config(), profileId).name.replace(/[\r\n]+/g, " ");
    const path = join(this.mainPath, ".gitignore");
    const old = await readFile(path, "utf8").catch((e) => {
      if (e?.code === "ENOENT") return "";
      throw e;
    });
    const sep = !old ? "" : old.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(path, `${old}${sep}# Build files of ${name} (written by Stet)\n${lines.join("\n")}\n`);
    return lines;
  }

  config(): Promise<StetConfig> {
    return this.store.config();
  }

  /**
   * Record how agents' tools invoke `stet` and rewrite the active agents' workspace files.
   * Returns false when nothing changed.
   */
  async setCli(cli: CliCommand): Promise<boolean> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      if (JSON.stringify(cfg.cli ?? null) === JSON.stringify(cli)) return false;
      await this.store.saveConfig({ ...cfg, cli });
      for (const a of await this.store.agents()) if (a.state === "active") await this.agentOps.refreshWorkspace(a);
      return true;
    });
  }

  /** The repository's shared git dir (where the store and hooks live). */
  get commonDir(): string {
    return dirname(this.store.root);
  }

  // -------------------------------------------------------------------------
  // Helpers

  async mainHead(cfg: StetConfig): Promise<string> {
    const head = await this.repo.revParse(`refs/heads/${cfg.mainBranch}`);
    if (!head) throw new StetError(`Main branch '${cfg.mainBranch}' not found.`);
    return head;
  }

  /**
   * The branch checked out in the project folder, or null if detached. Read from the main
   * worktree's HEAD file: accept and Finish review check it every time, and starting git for it
   * cost more than the rest of the check.
   */
  async projectBranch(): Promise<string | null> {
    const head = await readFile(join(this.commonDir, "HEAD"), "utf8").catch(() => null);
    if (head === null) return this.repo.tryRun(["symbolic-ref", "--short", "HEAD"]);
    return /^ref: refs\/heads\/(.+?)\s*$/.exec(head)?.[1] ?? null;
  }

  /** The language profile of a file (by the config's file patterns). */
  profile(cfg: StetConfig, path: string): LanguageProfile {
    return profileFor(path, cfg.files, cfg);
  }

  /** Is this change a whole key argument of its language (`\label{a}` → `\label{b}`)? */
  isKeyEdit(cfg: StetConfig, c: { file: string; oldText: string; newText: string }): boolean {
    return !!this.profile(cfg, c.file).syntax?.isKeyEdit(c.oldText, c.newText);
  }

  /** Cached reads of blobs at commits (by commit id: what they hold never changes). */
  private textCache = new Map<string, TextFile | null>();

  async textAt(rev: string, path: string): Promise<TextFile | null> {
    const key = rev + ":" + path;
    if (!this.textCache.has(key)) this.cacheText(key, await this.repo.readText(rev, path));
    return this.textCache.get(key)!;
  }

  cacheText(key: string, t: TextFile | null) {
    // A long-lived instance (the extension's) reads many commits: keep the recent ones.
    if (this.textCache.size >= 500) this.textCache.delete(this.textCache.keys().next().value!);
    this.textCache.set(key, t);
  }

  /** Changed paths between two commits, cached: submit asks for the same pair twice on an agent's first submit. */
  private namesCache = new Map<string, Awaited<ReturnType<Repo["diffNames"]>>>();

  async diffNames(a: string, b: string) {
    const key = a + ".." + b;
    let hit = this.namesCache.get(key);
    if (!hit) {
      hit = await this.repo.diffNames(a, b);
      if (this.namesCache.size >= 50) this.namesCache.delete(this.namesCache.keys().next().value!);
      this.namesCache.set(key, hit);
    }
    return hit;
  }

  treeView(rev: string): FileView {
    return {
      read: (p) => this.textAt(rev, p),
      blobId: (p) => this.repo.blobId(rev, p),
    };
  }

  workingView(): FileView {
    return {
      // Like git, never follow links in the working copy (they could lead outside the project).
      read: async (p) => {
        const buf = isSafeRepoPath(p) ? await readInside(this.mainPath, p) : null;
        if (!buf) return null;
        // Changed in words, it would be written back as UTF-8: every other character lost.
        if (isBinary(buf))
          throw new StetError(`${p} is not UTF-8 text (any more), so Stet can't change it without damaging it. Save it as UTF-8, then try again.`);
        const raw = buf.toString("utf8");
        return { text: toLf(raw), eol: detectEol(raw) };
      },
      blobId: async (p) => {
        if (!isSafeRepoPath(p) || !(await readInside(this.mainPath, p))) return null;
        return this.repo.run(["hash-object", "--", p]);
      },
    };
  }

  refText = async (item: Item) => (await this.textAt(item.baseCommit, item.oldFile ?? item.file))?.text;

  /** Text changes accepted from the same base as `item` in its file (see `anchorNear`). */
  neighbours = async (item: Item): Promise<Neighbour[]> => neighboursIn(await this.store.itemsReadOnly(), item);

  /**
   * `locateInWorkingCopy` for many items, or `locateInText` with `text` (items of one file): the
   * store and each file are read once. Item by item, every item read the whole store again:
   * listing 750 changes took 25 s.
   */
  async locateMany(items: Item[], text?: string, known?: readonly Item[]): Promise<Map<string, { line: number; span: Span | null }>> {
    // `known`: all items as the caller has them (the extension's snapshot). Reading them from the
    // store again on every keystroke took seconds while background checks ran.
    const all = known ?? (await this.store.items());
    const files = new Map<string, Promise<TextFile | null>>();
    const fileOf = (p: string) => {
      if (!files.has(p))
        files.set(
          p,
          this.workingView()
            .read(p)
            .catch(() => null),
        );
      return files.get(p)!;
    };
    const out = new Map<string, { line: number; span: Span | null }>();
    for (const item of items) {
      if (item.kind !== "modify") {
        out.set(item.id, { line: 1, span: null });
        continue;
      }
      const t = text ?? (await fileOf(item.file))?.text;
      const span = t !== undefined ? anchorNear(item, t, await this.refText(item), neighboursIn(all, item)) : null;
      out.set(item.id, { line: span && t !== undefined ? lineOf(t, span.start) : await this.itemLine(item), span });
    }
    return out;
  }

  /** Where `item` is in `text` (its file's current text somewhere). */
  async anchorItem(item: Item, text: string): Promise<Span | null> {
    return anchorNear(item, text, await this.refText(item), await this.neighbours(item));
  }

  async changesToCommitMap(changes: Map<string, FileChange>): Promise<Map<string, string | Buffer | null>> {
    const out = new Map<string, string | Buffer | null>();
    for (const [p, c] of changes) {
      if (c === null) out.set(p, null);
      else if ("blob" in c) out.set(p, await this.blobBytes(c.blob));
      else out.set(p, fromLf(c.text, c.eol));
    }
    return out;
  }

  private async blobBytes(blob: string): Promise<Buffer> {
    return (await gitRaw(["cat-file", "blob", blob], { cwd: this.mainPath })).stdout;
  }

  get journalPath(): string {
    return join(this.store.root, "txn.json");
  }

  /**
   * Write accepted changes to the working copy, all or nothing (spec §7.4). Every destination is
   * checked first (no links, nothing outside the project or in .git); the original contents are
   * journaled; any failure restores them. `recoverInterrupted` finishes or undoes an accept that
   * was cut off (crash, killed process). `undo`: this write takes an accept back.
   */
  async writeWorking(changes: Map<string, FileChange>, resolutions: AcceptJournal["items"], { undo = false } = {}): Promise<void> {
    // Items come from the store, which is plain files: re-check every path before touching disk.
    const bad = [...changes.keys()].filter((p) => !isSafeRepoPath(p));
    if (bad.length) throw new StetError(`Refusing to write outside the project or into its git directory: ${bad.join(", ")}`);
    const targets = new Map<string, Target>();
    for (const p of changes.keys()) {
      try {
        targets.set(p, await inspect(this.mainPath, p, { forbidden: [this.commonDir] }));
      } catch (e) {
        if (e instanceof UnsafePathError) throw new StetError(`Nothing was applied: ${e.message}.`);
        throw e;
      }
    }
    const data = new Map<string, Buffer | string | null>();
    for (const [p, c] of changes) data.set(p, c === null ? null : "blob" in c ? await this.blobBytes(c.blob) : fromLf(c.text, c.eol));

    await this.store.fence("writing your files");
    const journal: AcceptJournal = { items: resolutions, ...(undo ? { undo } : {}), filesDone: false, files: [] };
    for (const [p, t] of targets) {
      const orig = t.exists ? await readFile(t.path) : null;
      const d = data.get(p) ?? null;
      journal.files.push({ path: p, original: orig?.toString("base64") ?? null, before: hashOf(orig), after: hashOf(d === null ? null : Buffer.from(d)) });
    }
    await writeJsonAtomic(this.journalPath, journal);

    const createdDirs: string[] = [];
    try {
      for (const [p, d] of data) {
        const t = targets.get(p)!;
        if (d === null) {
          if (t.exists) await rm(t.path);
          continue;
        }
        createdDirs.push(...(await prepare(this.mainPath, t)));
        await replaceFile(t.path, d);
      }
    } catch (e: any) {
      const kept = await this.rollbackFiles(journal.files, createdDirs);
      await rm(this.journalPath, { force: true });
      throw new StetError(
        `Nothing was applied: writing ${e?.path ?? "a file"} failed (${e?.code ?? e?.message ?? e}). ` +
          (kept.length ? `Files restored, except ${kept.join(", ")} (changed meanwhile; left as it is).` : "All files were restored."),
      );
    }
    journal.filesDone = true;
    await writeJsonAtomic(this.journalPath, journal);
  }

  /**
   * Undo Stet's writes. A file is restored only if it still holds exactly what Stet wrote; if it
   * holds anything else (e.g. the user edited it after an interrupted accept), it is left alone.
   * Returns the files left alone.
   */
  private async rollbackFiles(files: AcceptJournal["files"], createdDirs: string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const f of files) {
      try {
        const now = hashOf(await readInside(this.mainPath, f.path));
        if (now === f.before) continue; // not written yet, or already back
        if (now !== f.after) {
          kept.push(f.path);
          continue;
        }
        const abs = join(this.mainPath, f.path);
        if (f.original === null) await rm(abs, { force: true });
        else await replaceFile(abs, Buffer.from(f.original, "base64"));
      } catch {
        kept.push(f.path); // keep restoring the others
      }
    }
    for (const d of createdDirs.reverse()) await rmdir(d).catch(() => undefined);
    return kept;
  }

  /** Finish (files all written) or undo (cut off while writing) an interrupted accept. */
  async recoverInterrupted(): Promise<void> {
    this.store.assertLocked("recovering an interrupted accept");
    let j: AcceptJournal;
    try {
      j = JSON.parse(await readFile(this.journalPath, "utf8"));
    } catch (e: any) {
      if (e.code === "ENOENT") return;
      // Skipped, it stayed in place and the accept it records was neither finished nor undone:
      // the files it wrote may hold part of it.
      throw new StetError(
        `An accept was interrupted, and Stet can't read its record (${this.journalPath}: ${e.message}), so it can't finish or undo it. ` +
          "Check your files with `git diff` (some may hold part of that accept), then delete that file.",
      );
    }
    if (j.filesDone && j.undo) {
      for (const r of j.items) {
        const it = await this.store.getItem(r.id);
        if (it?.status !== "accepted") continue;
        await this.decisionOps.reopen(it, "accept undone (completed after an interruption)", "accepted");
      }
    } else if (j.filesDone) {
      for (const r of j.items) {
        const it = await this.store.getItem(r.id);
        if (!it || !isLive(it.status)) continue;
        this.setStatus(it, "accepted", "user", "completed after an interruption");
        it.resolution = { appliedText: r.appliedText, edited: r.edited, committed: null };
        await this.store.putItem(it);
        await this.store.appendEvent({ type: "accepted", agent: it.agent, items: [it.id], data: { item: await this.describe(it) } });
      }
    } else await this.rollbackFiles(j.files, []);
    await rm(this.journalPath, { force: true });
  }

  setStatus(item: Item, status: ItemStatus, by: HistoryEntry["by"], note?: string, extra: Pick<HistoryEntry, "decision" | "staleBy"> = {}) {
    item.status = status;
    item.history.push({
      at: now(),
      status,
      by,
      ...(note ? { note } : {}),
      ...(extra.decision ? { decision: extra.decision } : {}),
      ...(extra.staleBy ? { staleBy: extra.staleBy } : {}),
    });
  }

  private async itemLine(item: Item): Promise<number> {
    const t = await this.refText(item);
    return t ? lineOf(t, item.range.start) : 1;
  }

  /** Compact description of an item for event payloads. */
  async describe(item: Item): Promise<ItemBrief> {
    return {
      id: item.id,
      file: item.file,
      line: await this.itemLine(item),
      kind: item.kind,
      oldText: item.oldText.length > 400 ? item.oldText.slice(0, 400) + "…" : item.oldText,
      newText: item.newText.length > 400 ? item.newText.slice(0, 400) + "…" : item.newText,
    };
  }

  /**
   * For an accepted whole-file item: is its effect in `view` ("done"), is the file still in its
   * state before the change ("open"), or is something else there ("other")?
   */
  async wholeFileState(it: Accepted, view: FileView): Promise<"done" | "open" | "other"> {
    const blob = await view.blobId(it.file);
    const text = async (p: string) => (await view.read(p))?.text ?? null;
    switch (it.kind) {
      case "binary": {
        if (!it.oldFile) return blob === (it.newBlob ?? null) ? "done" : blob === (it.oldBlob ?? null) ? "open" : "other";
        const src = await view.blobId(it.oldFile);
        if (src === null && blob === (it.newBlob ?? null)) return "done";
        return src === (it.oldBlob ?? null) && blob === null ? "open" : "other";
      }
      case "delete-file":
        return blob === null ? "done" : "open";
      case "add-file":
        return (await text(it.file)) === it.resolution.appliedText ? "done" : blob === null ? "open" : "other";
      case "rename-file": {
        const oldGone = (await view.blobId(it.oldFile!)) === null;
        if (oldGone && (await text(it.file)) === it.resolution.appliedText) return "done";
        return blob === null && !oldGone ? "open" : "other";
      }
      default:
        return "other";
    }
  }

  // -------------------------------------------------------------------------
  // Agents (§7.1)

  /** Git settings for calls inside agent worktrees (no hooks, no submodules). */
  get untrustedConfig(): string[] {
    return untrustedWorktreeConfig(join(this.store.root, "config.json"));
  }

  // -------------------------------------------------------------------------
  // Review operations (§7.3, §7.4)

  async listItems(filter: ItemFilter = {}): Promise<Item[]> {
    const st = filter.status === undefined ? null : Array.isArray(filter.status) ? filter.status : [filter.status];
    return (await this.store.items()).filter(
      (i) =>
        (!filter.agent || i.agent === filter.agent) &&
        (!st || st.includes(i.status)) &&
        (!filter.changeset || i.changeset === filter.changeset) &&
        (!filter.file || i.file === filter.file || i.oldFile === filter.file),
    );
  }

  getItem = (id: string) => this.store.getItem(id);
  getGroup = (id: string) => this.store.getGroup(id);
  getAgent = (id: string) => this.store.getAgent(id);

  /** The git hooks that keep agent branches from being merged or pushed past review. */
  hookStatus(): Promise<HookStatus> {
    return hookStatus(this.repo, this.commonDir);
  }

  async installHooks(opts: { force?: boolean } = {}): Promise<HookStatus> {
    return installHooks(this.repo, this.commonDir, await this.config(), opts);
  }

  uninstallHooks(): Promise<void> {
    return uninstallHooks(this.repo, this.commonDir);
  }
  listGroups = () => this.store.groups();
  listChangesets = () => this.store.changesets();

  /** Current 1-based line of an item in the working copy (or its base line if it can't be located). */
  async locateInWorkingCopy(item: Item): Promise<{ line: number; span: Span | null }> {
    if (item.kind !== "modify") return { line: 1, span: null };
    const f = await this.workingView()
      .read(item.file)
      .catch(() => null); // not UTF-8 any more: not located
    const span = f ? await this.anchorItem(item, f.text) : null;
    return { line: span && f ? lineOf(f.text, span.start) : await this.itemLine(item), span };
  }

  /** Where an item's old text sits in `text` (LF line endings), e.g. an editor buffer with unsaved edits. */
  async locateInText(item: Item, text: string): Promise<Span | null> {
    if (item.kind !== "modify") return null;
    return this.anchorItem(item, text);
  }

  async requireItems(ids: string[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const id of ids) {
      const it = await this.store.getItem(id.toUpperCase());
      if (!it) throw notFound(`Unknown item '${id}'.`);
      out.push(it);
    }
    return out;
  }

  /** The store's items and groups by id, for the rules in model.ts that take a `Lookup`. */
  async lookup(): Promise<Lookup> {
    const items = new Map((await this.store.itemsReadOnly()).map((i) => [i.id, i]));
    const groups = new Map((await this.store.groups()).map((g) => [g.id, g]));
    return { item: (id) => items.get(id), group: (id) => groups.get(id) };
  }

  // -------------------------------------------------------------------------
  // Feedback (§10)

  async feedback(agentId: string, opts: { ack?: boolean } = {}): Promise<StetEvent[]> {
    return this.store.withLock(async () => {
      const agent = await this.agentOps.requireAgent(agentId);
      const all = await this.store.events(agent.feedbackCursor);
      const notes = new Map((await this.store.notes()).map((n) => [n.id, n]));
      // Note events before the note was delivered are part of the delivery itself (§7.8).
      const early = (e: StetEvent) => {
        if (e.type !== "note_comment" && e.type !== "note_resolved" && e.type !== "note_reopened") return false;
        const n = notes.get(e.data.note);
        return !n?.deliveredAt || e.at <= n.deliveredAt;
      };
      const mine = all.filter((e) => e.agent === agentId && FEEDBACK_TYPES.includes(e.type) && !early(e));
      if (opts.ack !== false && all.length) {
        agent.feedbackCursor = all[all.length - 1]!.seq;
        await this.store.putAgent(agent);
      }
      return mine;
    });
  }

  events(since = 0) {
    return this.store.events(since);
  }

  // -------------------------------------------------------------------------
  // The parts' operations, as Stet's own

  /** {@link ReviewBase.ensureBase} */
  ensureBase(...a: Parameters<ReviewBase["ensureBase"]>): ReturnType<ReviewBase["ensureBase"]> {
    return this.baseOps.ensureBase(...a);
  }

  /** {@link ReviewBase.missingFromBase} */
  missingFromBase(...a: Parameters<ReviewBase["missingFromBase"]>): ReturnType<ReviewBase["missingFromBase"]> {
    return this.baseOps.missingFromBase(...a);
  }

  /** {@link ReviewBase.shareEdits} */
  shareEdits(...a: Parameters<ReviewBase["shareEdits"]>): ReturnType<ReviewBase["shareEdits"]> {
    return this.baseOps.shareEdits(...a);
  }

  /** {@link ReviewBase.shareStatus} */
  shareStatus(...a: Parameters<ReviewBase["shareStatus"]>): ReturnType<ReviewBase["shareStatus"]> {
    return this.baseOps.shareStatus(...a);
  }

  /** {@link ReviewBase.setShareEdits} */
  setShareEdits(...a: Parameters<ReviewBase["setShareEdits"]>): ReturnType<ReviewBase["setShareEdits"]> {
    return this.baseOps.setShareEdits(...a);
  }

  /** {@link Agents.listAgents} */
  listAgents(...a: Parameters<Agents["listAgents"]>): ReturnType<Agents["listAgents"]> {
    return this.agentOps.listAgents(...a);
  }

  /** {@link Agents.newAgent} */
  newAgent(...a: Parameters<Agents["newAgent"]>): ReturnType<Agents["newAgent"]> {
    return this.agentOps.newAgent(...a);
  }

  /** {@link Agents.refreshWorkspace} */
  refreshWorkspace(...a: Parameters<Agents["refreshWorkspace"]>): ReturnType<Agents["refreshWorkspace"]> {
    return this.agentOps.refreshWorkspace(...a);
  }

  /** {@link Agents.changedToolConfigs} */
  changedToolConfigs(...a: Parameters<Agents["changedToolConfigs"]>): ReturnType<Agents["changedToolConfigs"]> {
    return this.agentOps.changedToolConfigs(...a);
  }

  /** {@link Agents.refreshWorkspaces} */
  refreshWorkspaces(...a: Parameters<Agents["refreshWorkspaces"]>): ReturnType<Agents["refreshWorkspaces"]> {
    return this.agentOps.refreshWorkspaces(...a);
  }

  /** {@link Agents.agentForCwd} */
  agentForCwd(...a: Parameters<Agents["agentForCwd"]>): ReturnType<Agents["agentForCwd"]> {
    return this.agentOps.agentForCwd(...a);
  }

  /** {@link Agents.archiveAgent} */
  archiveAgent(...a: Parameters<Agents["archiveAgent"]>): ReturnType<Agents["archiveAgent"]> {
    return this.agentOps.archiveAgent(...a);
  }

  /** {@link Agents.agentByWorktree} */
  agentByWorktree(...a: Parameters<Agents["agentByWorktree"]>): ReturnType<Agents["agentByWorktree"]> {
    return this.agentOps.agentByWorktree(...a);
  }

  /** {@link Agents.agentFiles} */
  agentFiles(...a: Parameters<Agents["agentFiles"]>): ReturnType<Agents["agentFiles"]> {
    return this.agentOps.agentFiles(...a);
  }

  /** {@link Agents.unsubmittedFiles} */
  unsubmittedFiles(...a: Parameters<Agents["unsubmittedFiles"]>): ReturnType<Agents["unsubmittedFiles"]> {
    return this.agentOps.unsubmittedFiles(...a);
  }

  /** {@link Agents.agentStatus} */
  agentStatus(...a: Parameters<Agents["agentStatus"]>): ReturnType<Agents["agentStatus"]> {
    return this.agentOps.agentStatus(...a);
  }

  /** {@link Agents.agentStatuses} */
  agentStatuses(...a: Parameters<Agents["agentStatuses"]>): ReturnType<Agents["agentStatuses"]> {
    return this.agentOps.agentStatuses(...a);
  }

  /** {@link Submission.submit} */
  submit(...a: Parameters<Submission["submit"]>): ReturnType<Submission["submit"]> {
    return this.submitOps.submit(...a);
  }

  /** {@link Submission.sync} */
  sync(...a: Parameters<Submission["sync"]>): ReturnType<Submission["sync"]> {
    return this.submitOps.sync(...a);
  }

  /** {@link Decisions.uncommittedAccepted} */
  uncommittedAccepted(...a: Parameters<Decisions["uncommittedAccepted"]>): ReturnType<Decisions["uncommittedAccepted"]> {
    return this.decisionOps.uncommittedAccepted(...a);
  }

  /** {@link Decisions.commitPreview} */
  commitPreview(...a: Parameters<Decisions["commitPreview"]>): ReturnType<Decisions["commitPreview"]> {
    return this.decisionOps.commitPreview(...a);
  }

  /** {@link Decisions.commitAcceptedItems} */
  commitAcceptedItems(...a: Parameters<Decisions["commitAcceptedItems"]>): ReturnType<Decisions["commitAcceptedItems"]> {
    return this.decisionOps.commitAcceptedItems(...a);
  }

  /** {@link Decisions.partlyDecided} */
  partlyDecided(...a: Parameters<Decisions["partlyDecided"]>): ReturnType<Decisions["partlyDecided"]> {
    return this.decisionOps.partlyDecided(...a);
  }

  /** {@link Decisions.groupTarget} */
  groupTarget(...a: Parameters<Decisions["groupTarget"]>): ReturnType<Decisions["groupTarget"]> {
    return this.decisionOps.groupTarget(...a);
  }

  /** {@link Decisions.acceptGroup} */
  acceptGroup(...a: Parameters<Decisions["acceptGroup"]>): ReturnType<Decisions["acceptGroup"]> {
    return this.decisionOps.acceptGroup(...a);
  }

  /** {@link Decisions.checkAccept} */
  checkAccept(...a: Parameters<Decisions["checkAccept"]>): ReturnType<Decisions["checkAccept"]> {
    return this.decisionOps.checkAccept(...a);
  }

  /** {@link Decisions.accept} */
  accept(...a: Parameters<Decisions["accept"]>): ReturnType<Decisions["accept"]> {
    return this.decisionOps.accept(...a);
  }

  /** {@link Decisions.commitMessage} */
  commitMessage(...a: Parameters<Decisions["commitMessage"]>): ReturnType<Decisions["commitMessage"]> {
    return this.decisionOps.commitMessage(...a);
  }

  /** {@link Decisions.reject} */
  reject(...a: Parameters<Decisions["reject"]>): ReturnType<Decisions["reject"]> {
    return this.decisionOps.reject(...a);
  }

  /** {@link Decisions.undo} */
  undo(...a: Parameters<Decisions["undo"]>): ReturnType<Decisions["undo"]> {
    return this.decisionOps.undo(...a);
  }

  /** {@link Decisions.undoMany} */
  undoMany(...a: Parameters<Decisions["undoMany"]>): ReturnType<Decisions["undoMany"]> {
    return this.decisionOps.undoMany(...a);
  }

  /** {@link Previews.previewStatus} */
  previewStatus(...a: Parameters<Previews["previewStatus"]>): ReturnType<Previews["previewStatus"]> {
    return this.previewOps.previewStatus(...a);
  }

  /** {@link Previews.setupPreview} */
  setupPreview(...a: Parameters<Previews["setupPreview"]>): ReturnType<Previews["setupPreview"]> {
    return this.previewOps.setupPreview(...a);
  }

  /** {@link Previews.preview} */
  preview(...a: Parameters<Previews["preview"]>): ReturnType<Previews["preview"]> {
    return this.previewOps.preview(...a);
  }

  /** {@link Drafts.reviewOf} */
  reviewOf(...a: Parameters<Drafts["reviewOf"]>): ReturnType<Drafts["reviewOf"]> {
    return this.draftOps.reviewOf(...a);
  }

  /** {@link Drafts.saveReview} */
  saveReview(...a: Parameters<Drafts["saveReview"]>): ReturnType<Drafts["saveReview"]> {
    return this.draftOps.saveReview(...a);
  }

  /** {@link Drafts.setDraft} */
  setDraft(...a: Parameters<Drafts["setDraft"]>): ReturnType<Drafts["setDraft"]> {
    return this.draftOps.setDraft(...a);
  }

  /** {@link Drafts.clearDraft} */
  clearDraft(...a: Parameters<Drafts["clearDraft"]>): ReturnType<Drafts["clearDraft"]> {
    return this.draftOps.clearDraft(...a);
  }

  /** {@link Previews.previewPage} */
  previewPage(...a: Parameters<Previews["previewPage"]>): ReturnType<Previews["previewPage"]> {
    return this.previewOps.previewPage(...a);
  }

  /** {@link Agents.setNotifyOn} */
  setNotifyOn(...a: Parameters<Agents["setNotifyOn"]>): ReturnType<Agents["setNotifyOn"]> {
    return this.agentOps.setNotifyOn(...a);
  }

  /** {@link Agents.pingAgent} */
  pingAgent(...a: Parameters<Agents["pingAgent"]>): ReturnType<Agents["pingAgent"]> {
    return this.agentOps.pingAgent(...a);
  }

  /** {@link Agents.setNotify} */
  setNotify(...a: Parameters<Agents["setNotify"]>): ReturnType<Agents["setNotify"]> {
    return this.agentOps.setNotify(...a);
  }

  /** {@link Decisions.requestRevision} */
  requestRevision(...a: Parameters<Decisions["requestRevision"]>): ReturnType<Decisions["requestRevision"]> {
    return this.decisionOps.requestRevision(...a);
  }

  /** {@link Decisions.comment} */
  comment(...a: Parameters<Decisions["comment"]>): ReturnType<Decisions["comment"]> {
    return this.decisionOps.comment(...a);
  }

  /** {@link Decisions.withdraw} */
  withdraw(...a: Parameters<Decisions["withdraw"]>): ReturnType<Decisions["withdraw"]> {
    return this.decisionOps.withdraw(...a);
  }

  /** {@link GroupOps.group} */
  group(...a: Parameters<GroupOps["group"]>): ReturnType<GroupOps["group"]> {
    return this.groupOps.group(...a);
  }

  /** {@link GroupOps.ungroup} */
  ungroup(...a: Parameters<GroupOps["ungroup"]>): ReturnType<GroupOps["ungroup"]> {
    return this.groupOps.ungroup(...a);
  }

  /** {@link Notes.addNote} */
  addNote(...a: Parameters<Notes["addNote"]>): ReturnType<Notes["addNote"]> {
    return this.noteOps.addNote(...a);
  }

  /** {@link Notes.listNotes} */
  listNotes(...a: Parameters<Notes["listNotes"]>): ReturnType<Notes["listNotes"]> {
    return this.noteOps.listNotes(...a);
  }

  /** {@link Notes.getNote} */
  getNote(...a: Parameters<Notes["getNote"]>): ReturnType<Notes["getNote"]> {
    return this.noteOps.getNote(...a);
  }

  /** {@link Notes.locateNoteInText} */
  locateNoteInText(...a: Parameters<Notes["locateNoteInText"]>): ReturnType<Notes["locateNoteInText"]> {
    return this.noteOps.locateNoteInText(...a);
  }

  /** {@link Notes.replyNote} */
  replyNote(...a: Parameters<Notes["replyNote"]>): ReturnType<Notes["replyNote"]> {
    return this.noteOps.replyNote(...a);
  }

  /** {@link Notes.resolveNote} */
  resolveNote(...a: Parameters<Notes["resolveNote"]>): ReturnType<Notes["resolveNote"]> {
    return this.noteOps.resolveNote(...a);
  }

  /** {@link Notes.reopenNote} */
  reopenNote(...a: Parameters<Notes["reopenNote"]>): ReturnType<Notes["reopenNote"]> {
    return this.noteOps.reopenNote(...a);
  }
}
