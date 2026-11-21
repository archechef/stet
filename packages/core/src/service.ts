/** Stet service layer (spec §7, §12.1). All frontends go through this class. */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { applyItems, conflicts, locate, overlaps, type FileChange, type FileView, type TextFile } from "./apply.js";
import { anchor, anchorNear, captureContext, chainInsertions, type Neighbour, type Span } from "./anchor.js";
import { validateConfig, type StetConfig } from "./config.js";
import { gitRaw, Repo, untrustedWorktreeConfig } from "./git.js";
import {
  autoGroups,
  joinTitles,
  normalizeGroups,
  parseWhere,
  unitMatches,
  type GroupDraft,
  type GroupHint,
  type HintUnit,
  type NoteHint,
} from "./grouping.js";
import {
  compareItemIds,
  FEEDBACK_TYPES,
  itemId,
  linkedUnit,
  numberInRound,
  isLive,
  moveFrom,
  moveOthers,
  moveTo,
  NOTIFY_MODES,
  NOTIFY_TRIGGERS,
  notifyMode,
  notifyTriggers,
  type NotifyTrigger,
  parsePartId,
  partId,
  type NotifyMode,
  type Agent,
  type AgentKind,
  type Changeset,
  type Group,
  type GroupKind,
  type GroupPart,
  type Item,
  type ItemStatus,
  type MoveInfo,
  type Note,
  type StetEvent,
} from "./model.js";
import { detectMoves, detectRewritten, separateMoved } from "./moves.js";
import { describeNote, type DeliveredNote } from "./notes.js";
import { combineParts, imbalance, settleParts, type PartDraft, type ProfileOf } from "./parts.js";
import { splitText, type Edit } from "./split.js";
import { detectLanguage, DOCUMENT_LANGUAGES, documentProfile, profileFor, type LanguageProfile } from "./lang/index.js";
import { Store, writeJsonAtomic } from "./store.js";
import { inspect, prepare, readInside, replaceFile, UnsafePathError, writeInside, type Target } from "./safefs.js";
import { detectPreviewEnv, PreviewBuilder, setupPreviewImage, type PreviewChange, type PreviewEnv, type PreviewRequest, type PreviewResult } from "./preview.js";
import { mapReviewEdits, reviewDocument, type ReviewChange, type ReviewDocument } from "./review.js";
import { pingInbox } from "./inbox.js";
import { archivedMessage, STET_MARKER } from "./instructions.js";
import { installHooks } from "./hooks.js";
import { itemEffect } from "./effects.js";
import { changedToolConfigs, isWorkspaceFile, writeWorkspaceFiles, type CliCommand, type WorkspaceResult } from "./workspace.js";
import { isInside, pathExists, samePath } from "./paths.js";
import { StetError } from "./errors.js";
import { AgentFiles } from "./agentfiles.js";
import { verifyAgentWorktree } from "./worktree.js";
import { detectEol, fromLf, isBinary, isSafeRepoPath, lineOf, lineRange, normalizeWs, oneLine, sha256, textWithBadBytes, toLf } from "./text.js";

export { StetError };

export const BASE_REF = "refs/stet/base";
/**
 * The fewest changes of `pool` (same file, nearest first) that close what `item` opens, or open
 * what it closes (braces, environments, math). Empty if it is balanced or none complete it.
 */
function completing(item: Item, pool: Item[], profileOf: ProfileOf): Item[] {
  const parity = profileOf(item.file).parts?.parity ?? [];
  let acc = imbalance(item, profileOf);
  const norm = (v: number[]) => v.reduce((n, x, k) => n + (parity.includes(k) ? x % 2 : Math.abs(x)), 0);
  if (!norm(acc)) return [];
  const out: Item[] = [];
  const near = pool.filter((p) => p.file === item.file).sort((a, b) => Math.abs(a.range.start - item.range.start) - Math.abs(b.range.start - item.range.start));
  for (const p of near) {
    const next = acc.map((x, k) => x + imbalance(p, profileOf)[k]!);
    if (norm(next) >= norm(acc)) continue;
    out.push(p);
    acc = next;
    if (!norm(acc)) return out;
  }
  return [];
}

/** Changes of a simulated accept, as neighbours of `it` (same file and base). */
function appliedAsNeighbours(applied: { item: Item; text: string }[], it: Item): Neighbour[] {
  return applied
    .filter((a) => a.item.kind === "modify" && a.item.file === it.file && a.item.baseCommit === it.baseCommit && a.item.id !== it.id)
    .map((a) => ({ range: a.item.range, oldText: a.item.oldText, text: a.text }));
}

/** Text between two changes that ends a sentence or a paragraph. */
const SENTENCE_BREAK = /[.!?]["')\]}]*\s|\n[ \t]*\n/;

const now = () => new Date().toISOString();
const hashOf = (b: Buffer | null) => (b === null ? null : createHash("sha256").update(b).digest("hex"));
/** When the user (last) accepted an item; "" if unknown. */
const acceptedAt = (it: Item) => [...it.history].reverse().find((h) => h.status === "accepted")?.at ?? "";

// ---------------------------------------------------------------------------
// Result types

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

interface Candidate extends Edit {
  file: string;
  oldFile?: string;
  kind: Item["kind"];
  oldBlob?: string | null;
  newBlob?: string | null;
  shownText?: Item["shownText"];
}

/** Submit: an agent's linked group made related, and what stayed linked. */
function unlinkedWarning(title: string, linked: string[][]): string {
  return (
    `Group '${title}' is a related group now: Stet saw no dependency between all of its changes, so the reviewer can decide them one by one` +
    (linked.length ? `. Still linked, because they need each other: ${linked.map((c) => c.join(" + ")).join("; ")}` : "") +
    `. Link only changes where accepting some alone breaks the document. If that is the case here in a way Stet can't see, ` +
    `group them again with stet_group, kind "linked", and a "reason" saying why (the reviewer sees it).`
  );
}

/** stet_group: a linked group Stet sees no dependency in. */
function unlinkedRefusal(comps: string[][]): string {
  const linked = comps.filter((c) => c.length > 1);
  const free = comps.filter((c) => c.length === 1).map((c) => c[0]!);
  return (
    `Not linked: Stet sees no dependency between all of these changes` +
    (linked.length ? ` (${linked.map((c) => c.join(" + ")).join("; ")} need each other` + (free.length ? `; ${free.join(", ")} don't depend on them)` : ")") : ")") +
    `. Group them as "related" and link only the changes that need each other, or pass a "reason" if accepting only some really breaks the document (the reviewer sees it).`
  );
}

/** Text changes accepted from the same base as `item` in its file, from `all` items (see `anchorNear`). */
function neighboursIn(all: readonly Item[], item: Item): Neighbour[] {
  return all
    .filter((i) => i.id !== item.id && i.status === "accepted" && i.resolution && i.kind === "modify" && i.file === item.file && i.baseCommit === item.baseCommit)
    .map((i) => ({ range: { ...i.range }, oldText: i.oldText, text: i.resolution!.appliedText }));
}

/** Why a project in this language has no PDF previews. */
function noPreviews(doc: LanguageProfile): string {
  return doc.id === "typst"
    ? "Stet has no PDF previews for Typst projects yet. Everything else works as usual."
    : `Stet has no PDF previews for ${doc.name}.`;
}

/** Above these, a submit is said to be very large (not refused). */
export const LARGE_SUBMIT = { items: 1000, files: 200 };

export class Stet {
  private constructor(
    /** Path of the main worktree (the user's working copy). */
    readonly mainPath: string,
    readonly repo: Repo,
    readonly store: Store,
  ) {}

  // -------------------------------------------------------------------------
  // Opening / init

  /** Locate the repository containing `cwd` (main worktree or any agent worktree). */
  static async locate(cwd: string): Promise<{ repo: Repo; mainPath: string; commonDir: string; toplevel: string }> {
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
    return { repo: new Repo(main), mainPath: main, commonDir: common, toplevel: top };
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
    await store.withLock(async () => {
      let cfg = await store.config();
      // The project's language, from its files: once, when Stet is first set up here.
      if (opts.language !== undefined && !DOCUMENT_LANGUAGES.some((p) => p.id === opts.language))
        throw new StetError(`Unknown language '${opts.language}' (${DOCUMENT_LANGUAGES.map((p) => p.id).join(" or ")}).`);
      if (fresh || opts.language) {
        const paths = fresh && !opts.language ? ((await repo.tryRun(["ls-tree", "-r", "-z", "--name-only", `refs/heads/${branch}`])) ?? "").split("\0").filter(Boolean) : [];
        const language = opts.language ?? detectLanguage(paths, cfg.files);
        if (language !== cfg.language) await store.saveConfig((cfg = { ...cfg, language }));
      }
      if (opts.cli) await store.saveConfig({ ...cfg, cli: opts.cli });
      if (cfg.guardHooks) await installHooks(repo, commonDir, cfg);
      await stet.ensureBase();
    });
    return stet;
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
      for (const a of await this.store.agents()) if (a.state === "active") await this.refreshWorkspace(a);
      return true;
    });
  }

  /** The repository's shared git dir (where the store and hooks live). */
  get commonDir(): string {
    return dirname(this.store.root);
  }

  // -------------------------------------------------------------------------
  // Helpers

  private async mainHead(cfg: StetConfig): Promise<string> {
    const head = await this.repo.revParse(`refs/heads/${cfg.mainBranch}`);
    if (!head) throw new StetError(`Main branch '${cfg.mainBranch}' not found.`);
    return head;
  }

  /**
   * The branch checked out in the project folder, or null if detached. Read from the main
   * worktree's HEAD file: accept and Finish review check it every time, and starting git for it
   * cost more than the rest of the check.
   */
  private async projectBranch(): Promise<string | null> {
    const head = await readFile(join(this.commonDir, "HEAD"), "utf8").catch(() => null);
    if (head === null) return this.repo.tryRun(["symbolic-ref", "--short", "HEAD"]);
    return /^ref: refs\/heads\/(.+?)\s*$/.exec(head)?.[1] ?? null;
  }

  /** The language profile of a file (by the config's file patterns). */
  private profile(cfg: StetConfig, path: string): LanguageProfile {
    return profileFor(path, cfg.files);
  }

  /** Is this change a whole key argument of its language (`\label{a}` → `\label{b}`)? */
  private isKeyEdit(cfg: StetConfig, c: { file: string; oldText: string; newText: string }): boolean {
    return !!this.profile(cfg, c.file).syntax?.isKeyEdit(c.oldText, c.newText);
  }

  /** Cached reads of blobs at commits (by commit id: what they hold never changes). */
  private textCache = new Map<string, TextFile | null>();
  private async textAt(rev: string, path: string): Promise<TextFile | null> {
    const key = rev + ":" + path;
    if (!this.textCache.has(key)) this.cacheText(key, await this.repo.readText(rev, path));
    return this.textCache.get(key)!;
  }
  private cacheText(key: string, t: TextFile | null) {
    // A long-lived instance (the extension's) reads many commits: keep the recent ones.
    if (this.textCache.size >= 500) this.textCache.delete(this.textCache.keys().next().value!);
    this.textCache.set(key, t);
  }

  /** Changed paths between two commits, cached: submit asks for the same pair twice on an agent's first submit. */
  private namesCache = new Map<string, Awaited<ReturnType<Repo["diffNames"]>>>();
  private async diffNames(a: string, b: string) {
    const key = a + ".." + b;
    let hit = this.namesCache.get(key);
    if (!hit) {
      hit = await this.repo.diffNames(a, b);
      if (this.namesCache.size >= 50) this.namesCache.delete(this.namesCache.keys().next().value!);
      this.namesCache.set(key, hit);
    }
    return hit;
  }

  private treeView(rev: string): FileView {
    return {
      read: (p) => this.textAt(rev, p),
      blobId: (p) => this.repo.blobId(rev, p),
    };
  }

  private workingView(): FileView {
    return {
      // Like git, never follow links in the working copy (they could lead outside the project).
      read: async (p) => {
        const buf = isSafeRepoPath(p) ? await readInside(this.mainPath, p) : null;
        if (!buf) return null;
        // Changed in words, it would be written back as UTF-8: every other character lost.
        if (isBinary(buf)) throw new StetError(`${p} is not UTF-8 text (any more), so Stet can't change it without damaging it. Save it as UTF-8, then try again.`);
        const raw = buf.toString("utf8");
        return { text: toLf(raw), eol: detectEol(raw) };
      },
      blobId: async (p) => {
        if (!isSafeRepoPath(p) || !(await readInside(this.mainPath, p))) return null;
        return this.repo.run(["hash-object", "--", p]);
      },
    };
  }

  private refText = async (item: Item) => (await this.textAt(item.baseCommit, item.oldFile ?? item.file))?.text;

  /** Text changes accepted from the same base as `item` in its file (see `anchorNear`). */
  private neighbours = async (item: Item): Promise<Neighbour[]> => neighboursIn(await this.store.itemsReadOnly(), item);

  /**
   * `locateInWorkingCopy` for many items, or `locateInText` with `text` (items of one file): the
   * store and each file are read once. Item by item, every item read the whole store again:
   * listing 750 changes took 25 s (test report 2026-11-20, B3).
   */
  async locateMany(items: Item[], text?: string, known?: readonly Item[]): Promise<Map<string, { line: number; span: Span | null }>> {
    // `known`: all items as the caller has them (the extension's snapshot). Reading them from the
    // store again on every keystroke took seconds while background checks ran (test report v0.16.0).
    const all = known ?? (await this.store.items());
    const files = new Map<string, Promise<TextFile | null>>();
    const fileOf = (p: string) => {
      if (!files.has(p)) files.set(p, this.workingView().read(p).catch(() => null));
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
  private async anchorItem(item: Item, text: string): Promise<Span | null> {
    return anchorNear(item, text, await this.refText(item), await this.neighbours(item));
  }

  private async changesToCommitMap(changes: Map<string, FileChange>): Promise<Map<string, string | Buffer | null>> {
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

  private get journalPath(): string {
    return join(this.store.root, "txn.json");
  }

  /**
   * Write accepted changes to the working copy, all or nothing (spec §7.4). Every destination is
   * checked first (no links, nothing outside the project or in .git); the original contents are
   * journaled; any failure restores them. `recoverInterrupted` finishes or undoes an accept that
   * was cut off (crash, killed process).
   */
  private async writeWorking(changes: Map<string, FileChange>, resolutions: AcceptJournal["items"], undo = false): Promise<void> {
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

    await this.store.fence(); // never write the user's files without holding the lock
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

  /** Finish (files all written) or undo (cut off while writing) an interrupted accept. Call under lock. */
  private async recoverInterrupted(): Promise<void> {
    let j: AcceptJournal;
    try {
      j = JSON.parse(await readFile(this.journalPath, "utf8"));
    } catch {
      return;
    }
    if (j.filesDone && j.undo) {
      for (const r of j.items) {
        const it = await this.store.getItem(r.id);
        if (it?.status !== "accepted") continue;
        await this.reopen(it, "accept undone (completed after an interruption)", "accepted");
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

  private setStatus(item: Item, status: ItemStatus, by: "user" | "agent" | "stet", note?: string, decision?: string) {
    item.status = status;
    item.history.push({ at: now(), status, by, ...(note ? { note } : {}), ...(decision ? { decision } : {}) });
  }

  private async itemLine(item: Item): Promise<number> {
    const t = await this.refText(item);
    return t ? lineOf(t, item.range.start) : 1;
  }

  /** Compact description of an item for event payloads. */
  private async describe(item: Item) {
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
  private async wholeFileState(it: Item, view: FileView): Promise<"done" | "open" | "other"> {
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
        return (await text(it.file)) === it.resolution!.appliedText ? "done" : blob === null ? "open" : "other";
      case "rename-file": {
        const oldGone = (await view.blobId(it.oldFile!)) === null;
        if (oldGone && (await text(it.file)) === it.resolution!.appliedText) return "done";
        return blob === null && !oldGone ? "open" : "other";
      }
      default:
        return "other";
    }
  }

  // -------------------------------------------------------------------------
  // Review base (§7.3)

  /** Make sure refs/stet/base = main HEAD + accepted-but-uncommitted items. Call under lock. */
  async ensureBase(): Promise<string> {
    await this.recoverInterrupted();
    const cfg = await this.config();
    const head = await this.mainHead(cfg);
    await this.checkDroppedCommits(cfg, head);
    const pending = (await this.store.items()).filter((i) => i.status === "accepted" && i.resolution && !i.resolution.committed);
    const view = this.treeView(head);
    const stillOpen: Item[] = [];
    const headBlobs = new Map<string, string | null>();
    for (const it of pending) {
      const applied = it.resolution!.appliedText;
      if (it.kind !== "modify") {
        // Compare content, not just existence: a replaced binary exists before and after.
        const state = await this.wholeFileState(it, view);
        if (state === "open") stillOpen.push(it);
        else {
          it.resolution!.committed = state === "done" ? head : `external:${head}`;
          await this.store.putItem(it);
        }
        continue;
      }
      // Still open while HEAD's file is what it was at the accept: the change went into the working
      // copy only. Once the user commits the file, it holds the change, or what they made of it
      // since (edited, moved, removed). Looking for the old text instead re-applied changes the
      // user had edited: a pure insertion's empty old text is found anywhere (bug report 2026-11-12).
      if (await this.committedSinceAccept(it, head, headBlobs)) {
        const f = await view.read(it.file);
        const probe = { ...it, oldText: applied, newText: applied, range: { start: it.range.start, end: it.range.start + applied.length } };
        it.resolution!.committed = f && anchor(probe, f.text) ? head : `external:${head}`;
        await this.store.putItem(it);
      } else stillOpen.push(it);
    }
    // The user's shared edits replace HEAD as the starting point. They already hold every item
    // accepted before they were taken (accepting writes the working copy), or what the user made
    // of it since; only items accepted after a manual share are applied on top.
    const share = await this.sharedTree(cfg, head);
    const shared = share && share.tree !== (await this.repo.run(["rev-parse", `${head}^{tree}`])) ? share.tree : null;
    let toApply = stillOpen;
    // Accepted items the base should hold but can't: agents would never see them (bug report
    // 2026-11-18), so they are recorded and shown to the reviewer.
    const missing: { id: string; reason: string }[] = [];
    if (share) {
      const sview = this.treeView(share.tree);
      toApply = [];
      for (const it of stillOpen) {
        if (share.at === null || acceptedAt(it) <= share.at) continue;
        if (it.kind !== "modify") {
          if ((await this.wholeFileState(it, sview)) === "open") toApply.push(it);
          continue;
        }
        const f = await sview.read(it.file);
        // With its accepted neighbours: one right next to it changed its surroundings (bug report 2026-11-18).
        if (f && anchorNear({ ...it, newText: it.resolution!.appliedText }, f.text, await this.refText(it), await this.neighbours(it))) toApply.push(it);
        else if (!f || !this.holdsApplied(it, f.text)) missing.push({ id: it.id, reason: "it can't be located in your shared edits" });
      }
    }
    const key = head + ":" + (shared ?? "") + ":" + toApply.map((i) => i.id).join(",") + ":" + missing.map((m) => m.id).join(",");
    const state = await this.store.state();
    const current = await this.repo.revParse(BASE_REF);
    if (state.base?.key === key && current === state.base.commit) return current;

    let commit = head;
    if (toApply.length || shared) {
      const from = shared ?? head;
      const res = await applyItems(toApply, this.treeView(from), {
        refText: this.refText,
        neighbours: this.neighbours,
        overrides: new Map(toApply.map((i) => [i.id, i.resolution!.appliedText])),
      });
      for (const f of res.failed) missing.push({ id: f.item.id, reason: f.reason });
      const what = [
        ...(shared ? ["your shared edits"] : []),
        ...(res.applied.length ? [`accepted, not yet committed: ${res.applied.map((a) => a.item.id).join(", ")}`] : []),
      ];
      commit = await this.repo.buildCommit({
        parents: [head],
        baseRev: from,
        changes: await this.changesToCommitMap(res.changes),
        message: `stet: review base (${what.join("; ")})`,
      });
    }
    await this.repo.run(["update-ref", BASE_REF, commit]);
    const s = await this.store.state();
    s.base = { key, commit, ...(missing.length ? { missing } : {}) };
    await this.store.saveState(s);
    return commit;
  }

  /**
   * Accepted items whose commit is no longer on the main branch (a `git reset --hard`, a rebase
   * that dropped it). Stet kept saying "accepted and committed" while the text was gone, and
   * refused to undo them (test report 2026-11-20, D9). An item whose change is still in the
   * working copy is uncommitted again: it can be undone, and the next commit takes it. One whose
   * change is gone is pending again, and the agent is told. Checked only when main moved other
   * than forward.
   */
  private async checkDroppedCommits(cfg: StetConfig, head: string): Promise<void> {
    const state = await this.store.state();
    const last = state.mainHead;
    if (last === head) return;
    const forward = !!last && (await this.repo.tryRun(["merge-base", "--is-ancestor", last, head])) !== null;
    if (!forward) {
      const reach = new Map<string, boolean>();
      const changed: Item[] = [];
      const working = this.workingView();
      for (const it of await this.store.items()) {
        const c = it.status === "accepted" ? it.resolution?.committed?.replace(/^external:/, "") : undefined;
        if (!c) continue;
        if (!reach.has(c)) reach.set(c, (await this.repo.tryRun(["merge-base", "--is-ancestor", c, head])) !== null);
        if (reach.get(c)) continue;
        const f = it.kind === "modify" ? await working.read(it.file).catch(() => null) : null;
        const kept = it.kind === "modify" ? !!f && this.holdsApplied(it, f.text) : (await this.wholeFileState(it, working).catch(() => "other")) === "done";
        if (kept) {
          it.resolution!.committed = null;
          it.resolution!.headBlob = await this.repo.blobId(head, it.file);
          await this.store.putItem(it);
        } else {
          await this.reopen(it, `its commit ${c.slice(0, 8)} is no longer on ${cfg.mainBranch} (git reset?), and your file doesn't have it`, "accepted");
        }
        changed.push(it);
      }
      if (changed.length) await this.updateGroups(changed);
    }
    const s = await this.store.state();
    s.mainHead = head;
    await this.store.saveState(s);
  }

  /** Whether `text` already holds an accepted item's applied text where the item was. */
  private holdsApplied(it: Item, text: string): boolean {
    const applied = it.resolution!.appliedText;
    return !!anchor({ ...it, oldText: applied, newText: applied, range: { start: it.range.start, end: it.range.start + applied.length } }, text);
  }

  /**
   * Accepted changes agents don't get: the review base could not apply them on top of your
   * last commit or shared edits. Empty when everything works. Committing them (*Finish review*)
   * or sharing your edits again passes them on.
   */
  async missingFromBase(): Promise<{ item: Item; reason: string }[]> {
    return this.store.withLock(async () => {
      await this.ensureBase();
      return this.missingNow();
    });
  }

  /** `missingFromBase` for a base just ensured. Call under lock. */
  private async missingNow(): Promise<{ item: Item; reason: string }[]> {
    const out: { item: Item; reason: string }[] = [];
    for (const m of (await this.store.state()).base?.missing ?? []) {
      const it = await this.store.getItem(m.id);
      if (it?.status === "accepted" && it.resolution && !it.resolution.committed) out.push({ item: it, reason: m.reason });
    }
    return out;
  }

  /** The tree of the user's edits that agents see per `shareEdits`, or null for "HEAD only". */
  /**
   * The user's edits agents see instead of HEAD, and when they were taken: `at` null = now (they
   * hold every accepted item), "" = a share from before 0.6.1 (time unknown).
   */
  private async sharedTree(cfg: StetConfig, head: string): Promise<{ tree: string; at: string | null } | null> {
    if (cfg.shareEdits === "saved") {
      const tree = await this.workingTree(cfg, head);
      return tree ? { tree, at: null } : null;
    }
    if (cfg.shareEdits === "manual") {
      const s = (await this.store.state()).shared;
      // A share is based on a commit; once main moves on, agents see the new commit instead.
      if (s && s.head === head) return { tree: s.tree, at: s.at ?? "" };
    }
    return null;
  }

  /**
   * Whether the user has committed an accepted item's file since the accept (HEAD's file differs
   * from then). Items accepted before 0.6.1 don't record HEAD's file: for them, any commit since
   * the accept that touched the file counts; otherwise HEAD's file is recorded now.
   */
  private async committedSinceAccept(it: Item, head: string, blobs: Map<string, string | null>): Promise<boolean> {
    if (!blobs.has(it.file)) blobs.set(it.file, await this.repo.blobId(head, it.file));
    const blob = blobs.get(it.file) ?? null;
    const r = it.resolution!;
    if (r.headBlob !== undefined) return blob !== r.headBlob;
    // Commit times have whole seconds: only a later second counts, or a commit made just before
    // the accept (in the same second) would count as committing it.
    const last = Number(await this.repo.tryRun(["log", "-1", "--format=%ct", head, "--", it.file]));
    if (last > Math.floor(Date.parse(acceptedAt(it)) / 1000)) return true;
    r.headBlob = blob;
    await this.store.putItem(it);
    return false;
  }

  /**
   * A tree of the project folder as saved on disk, on top of main at `head`: tracked files (and
   * files staged with `git add`) as they are now, plus new TeX/BibTeX files git doesn't ignore.
   * Other new files (build output, PDFs) stay out. Uses its own index; the user's is untouched.
   * Null if the project folder has another branch checked out.
   */
  private async workingTree(cfg: StetConfig, head: string): Promise<string | null> {
    if ((await this.projectBranch()) !== cfg.mainBranch) return null;
    if ((await this.repo.revParse("HEAD")) !== head) return null;
    const dir = await mkdtemp(join(tmpdir(), "stet-share-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      // Starting from a copy of the user's index makes git re-read only files whose stat changed.
      const copied = await copyFile(join(this.commonDir, "index"), env.GIT_INDEX_FILE).then(() => true, () => false);
      if (!copied || (await this.repo.tryRun(["add", "-u"], { env })) === null) {
        await this.repo.run(["read-tree", head], { env });
        await this.repo.run(["add", "-u"], { env });
      }
      const untracked = (await this.repo.run(["ls-files", "-z", "--others", "--exclude-standard"], { env }))
        .split("\0")
        .filter((p) => p && isSafeRepoPath(p) && this.profile(cfg, p).document);
      for (let i = 0; i < untracked.length; i += 100) await this.repo.run(["add", "--", ...untracked.slice(i, i + 100)], { env });
      return await this.repo.run(["write-tree"], { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * *Share my edits*: agents see the saved project files from now on (until main moves on).
   * Returns false when there was nothing new to share.
   */
  async shareEdits(): Promise<boolean> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const head = await this.mainHead(cfg);
      const tree = await this.workingTree(cfg, head);
      if (!tree) throw new StetError(`Your project folder isn't on '${cfg.mainBranch}'. Switch back to it to share your edits with agents.`);
      const s = await this.store.state();
      if (s.shared?.head === head && s.shared.tree === tree) return false;
      s.shared = { head, tree, at: now() };
      await this.store.saveState(s);
      const before = await this.repo.revParse(BASE_REF);
      return (await this.ensureBase()) !== before;
    });
  }

  /** Which edits agents see, and whether saved edits exist that they don't. */
  async shareStatus(): Promise<{ mode: StetConfig["shareEdits"]; unshared: boolean }> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const base = await this.ensureBase();
      const tree = await this.workingTree(cfg, await this.mainHead(cfg));
      return { mode: cfg.shareEdits, unshared: !!tree && tree !== (await this.repo.run(["rev-parse", `${base}^{tree}`])) };
    });
  }

  /** Set `shareEdits`; returns false when it already had that value. */
  async setShareEdits(mode: StetConfig["shareEdits"]): Promise<boolean> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      if (cfg.shareEdits === mode) return false;
      await this.store.saveConfig(validateConfig({ ...cfg, shareEdits: mode }));
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Agents (§7.1)

  async listAgents(): Promise<Agent[]> {
    return this.store.agents();
  }

  async newAgent(id: string, opts: { kind?: AgentKind; path?: string } = {}): Promise<Agent> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new StetError(`Invalid agent id '${id}' (use letters, digits, '.', '_', '-').`);
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const branch = cfg.agentBranchPrefix + id;
      // An archived agent's name can be used again once its folder and branch are gone (the
      // manual's way to recreate a workspace; test report B2). Its decided changes keep its name.
      const old = await this.store.getAgent(id);
      if (old?.state === "active") throw new StetError(`Agent '${id}' already exists.`);
      if (old && ((await pathExists(old.worktree)) || (await this.repo.revParse(`refs/heads/${old.branch}`))))
        throw new StetError(`Agent '${id}' is archived, but its folder or branch is still there. Delete them with \`stet agent archive ${id} --remove\`, or choose another name.`);
      if (await this.repo.revParse(`refs/heads/${branch}`)) throw new StetError(`Branch '${branch}' already exists.`);
      const base = await this.ensureBase();
      const root = resolve(this.mainPath, cfg.worktreeRoot.replace("{repo}", basename(this.mainPath)));
      const path = opts.path ? resolve(opts.path) : join(root, id);
      // Inside the project, the workspace would be both "the project" and "the workspace" to the guard.
      if (isInside(path, this.mainPath)) throw new StetError(`The agent workspace (${path}) must be outside your project folder; check worktreeRoot in .git/stet/config.json.`);
      await mkdir(dirname(path), { recursive: true });
      await this.repo.run(["worktree", "add", "-b", branch, path, base]);
      const agent: Agent = {
        id,
        kind: opts.kind ?? "other",
        branch,
        worktree: path.replace(/\\/g, "/"),
        baseCommit: base,
        lastTip: base,
        replayedAt: now(),
        feedbackCursor: (await this.store.state()).nextEvent - 1,
        createdAt: now(),
        state: "active",
      };
      await this.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      return agent;
    });
  }

  /** (Re)write the agent's instructions, MCP config and guardrail files. */
  async refreshWorkspace(agentOrId: Agent | string): Promise<WorkspaceResult | null> {
    const agent = typeof agentOrId === "string" ? await this.requireAgent(agentOrId) : agentOrId;
    const cfg = await this.config();
    if (!cfg.cli) return null;
    const gitDir = await this.checkWorktree(agent.worktree);
    const r = await writeWorkspaceFiles({ agent, mainPath: this.mainPath, commonDir: this.commonDir, gitDir, cli: cfg.cli, profile: documentProfile(cfg) });
    // What was written, kept where the agent can't write: the MCP server checks it at each start.
    agent.toolConfigs = r.toolConfigs;
    await this.store.withLock(async () => {
      const stored = await this.store.getAgent(agent.id);
      if (stored) await this.store.putAgent({ ...stored, toolConfigs: r.toolConfigs });
    });
    return r;
  }

  /**
   * Tool settings in the agent's workspace that differ from what Stet last wrote (see
   * `changedToolConfigs`). Workspaces written before Stet kept a record have nothing to compare.
   */
  async changedToolConfigs(agent: Agent): Promise<string[]> {
    if (!agent.toolConfigs) return [];
    await this.checkWorktree(agent.worktree);
    return changedToolConfigs(agent.worktree, agent.toolConfigs);
  }

  /**
   * Rewrite every active agent's workspace files (after an update brings new instructions).
   * One agent's failure (e.g. its folder was deleted) doesn't stop the others.
   */
  async refreshWorkspaces(): Promise<{ agent: string; result?: WorkspaceResult | null; error?: string }[]> {
    return this.store.withLock(async () => {
      const out: { agent: string; result?: WorkspaceResult | null; error?: string }[] = [];
      for (const a of await this.store.agents()) {
        if (a.state !== "active") continue;
        try {
          out.push({ agent: a.id, result: await this.refreshWorkspace(a) });
        } catch (e) {
          out.push({ agent: a.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    });
  }

  /** The agent whose worktree contains `cwd`; adopts matching worktrees made by other tools. */
  async agentForCwd(cwd: string): Promise<Agent> {
    // A known workspace's git link is checked before git runs there: a link to a repository the
    // agent made would make git read that repository's config (security report 5e4c6af, S1).
    const registered = (await this.store.agents()).find((a) => a.state !== "archived" && isInside(cwd, a.worktree));
    if (registered) await this.checkWorktree(registered.worktree);
    const wt = new Repo(cwd, this.untrustedConfig);
    const top = await wt.tryRun(["rev-parse", "--show-toplevel"]);
    const branch = await wt.tryRun(["symbolic-ref", "--short", "HEAD"]);
    const cfg = await this.config();
    if (!top || !branch?.startsWith(cfg.agentBranchPrefix)) {
      throw new StetError(
        `This folder is not a Stet agent workspace (branch '${branch ?? "?"}'). ` +
          `Create one with \`stet agent new <name>\` in the project and work inside the folder it prints.`,
      );
    }
    const id = branch.slice(cfg.agentBranchPrefix.length);
    const existing = await this.store.getAgent(id);
    if (existing?.state === "archived") throw new StetError(archivedMessage(existing));
    await this.checkWorktree(top);
    if (existing) return existing;
    return this.store.withLock(async () => {
      const base = await this.ensureBase();
      const mb = (await this.repo.tryRun(["merge-base", branch, base])) ?? base;
      const agent: Agent = {
        id,
        kind: "other",
        branch,
        worktree: top,
        baseCommit: mb,
        lastTip: mb,
        replayedAt: now(),
        feedbackCursor: (await this.store.state()).nextEvent - 1,
        createdAt: now(),
        state: "active",
      };
      await this.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      return agent;
    });
  }

  /**
   * Retire an agent: withdraw its pending items and, optionally, delete its folder and branch.
   * The agent learns why on its next tool call (see `archivedMessage`); a kept folder gets the
   * same notice in place of its instructions.
   */
  async archiveAgent(
    id: string,
    opts: { removeWorktree?: boolean; discardUnsubmitted?: boolean } = {},
  ): Promise<{ agent: Agent; withdrawn: string[]; worktreeRemoved: boolean }> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(id);
      // Deleting the folder loses what the agent didn't submit: only when asked for (test report D4).
      if (opts.removeWorktree && !opts.discardUnsubmitted && (await pathExists(agent.worktree))) {
        const unsubmitted = await this.unsubmittedFiles(agent).catch(() => [] as string[]);
        if (unsubmitted.length) {
          throw new StetError(
            `${id} has changes it did not submit (${unsubmitted.slice(0, 5).join(", ")}${unsubmitted.length > 5 ? `, and ${unsubmitted.length - 5} more` : ""}); ` +
              `deleting its folder would lose them. Archive it without deleting the folder, or delete them with it explicitly (--force).`,
          );
        }
      }
      const withdrawn: string[] = [];
      for (const it of (await this.store.items()).filter((i) => i.agent === id && isLive(i.status))) {
        this.setStatus(it, "withdrawn", "user", "agent archived");
        await this.store.putItem(it);
        withdrawn.push(it.id);
      }
      // Its open notes are closed too: nobody will act on them any more.
      for (const n of (await this.store.notes()).filter((n) => n.agent === id && n.state === "open")) {
        n.state = "resolved";
        await this.store.putNote(n);
      }
      let worktreeRemoved = false;
      if (opts.removeWorktree) {
        await this.repo.tryRun(["worktree", "remove", "--force", agent.worktree]);
        await this.repo.tryRun(["branch", "-D", agent.branch]);
        worktreeRemoved = !(await pathExists(agent.worktree));
      }
      agent.state = "archived";
      agent.archived = { at: now(), withdrawn, worktreeRemoved };
      await this.store.putAgent(agent);
      await this.store.appendEvent({ type: "archived", agent: id, items: withdrawn, data: { worktreeRemoved } });
      if (!worktreeRemoved) {
        const notice = `${STET_MARKER}\n# This workspace is archived\n\n${archivedMessage(agent)}\n`;
        for (const f of ["CLAUDE.local.md", "AGENTS.override.md"]) await writeInside(agent.worktree, f, notice).catch(() => undefined);
      }
      await this.updateGroups((await this.store.items()).filter((i) => withdrawn.includes(i.id)));
      return { agent, withdrawn, worktreeRemoved };
    });
  }

  /** The agent whose workspace is (or was) at `path`, found in the store even if the folder is gone. */
  async agentByWorktree(path: string): Promise<Agent | null> {
    return (await this.store.agents()).find((a) => samePath(a.worktree, path)) ?? null;
  }

  /**
   * Git access to an agent's files that does not rely on the worktree's own git metadata
   * (spec §9; see `AgentFiles`).
   */
  agentFiles(agent: Agent): Promise<AgentFiles> {
    return AgentFiles.open(this.repo, this.commonDir, agent);
  }

  /** Paths an agent changed in its workspace but did not submit yet (Stet's own files excluded). */
  async unsubmittedFiles(agent: Agent): Promise<string[]> {
    return (await this.agentFiles(agent)).uncommitted();
  }

  /** Git settings for calls inside agent worktrees (no hooks, no submodules). */
  get untrustedConfig(): string[] {
    return untrustedWorktreeConfig(join(this.store.root, "config.json"));
  }

  private checkWorktree(path: string): Promise<string> {
    return verifyAgentWorktree(path, this.commonDir);
  }

  private async requireAgent(id: string): Promise<Agent> {
    const a = await this.store.getAgent(id);
    if (!a) throw new StetError(`Unknown agent '${id}'.`);
    return a;
  }

  async agentStatus(agentId: string): Promise<AgentStatus> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      return (await this.statusesOf([agent]))[0]!;
    });
  }

  /** Status of every active agent, computed from one read of the store (for UIs refreshing all agents). */
  async agentStatuses(): Promise<AgentStatus[]> {
    return this.store.withLock(async () => this.statusesOf((await this.store.agents()).filter((a) => a.state === "active")));
  }

  private async statusesOf(agents: Agent[]): Promise<AgentStatus[]> {
    if (!agents.length) return [];
    const base = await this.ensureBase();
    const cfg = await this.config();
    const items = await this.store.items();
    const notes = await this.store.notes();
    const events = await this.store.events(Math.min(...agents.map((a) => a.feedbackCursor)));
    // Same content under a different commit (e.g. the user committed accepted changes) needs no sync.
    const trees = new Map<string, Promise<string | null>>();
    const tree = (rev: string) => {
      if (!trees.has(rev)) trees.set(rev, this.repo.tryRun(["rev-parse", `${rev}^{tree}`]));
      return trees.get(rev)!;
    };
    const missing = await this.missingNow();
    const out: AgentStatus[] = [];
    for (const agent of agents) {
      const counts: Partial<Record<ItemStatus, number>> = {};
      for (const it of items) if (it.agent === agent.id) counts[it.status] = (counts[it.status] ?? 0) + 1;
      const unread = events.filter((e) => e.seq > agent.feedbackCursor && e.agent === agent.id && FEEDBACK_TYPES.includes(e.type)).length;
      const syncNeeded = agent.baseCommit !== base && (await tree(agent.baseCommit)) !== (await tree(base));
      const notesWaiting = notes.filter((n) => n.agent === agent.id && n.state === "open" && !n.deliveredAt).length;
      const missingAccepted = missing.filter((m) => m.item.agent === agent.id).map((m) => m.item.id);
      out.push({ agent, mainBranch: cfg.mainBranch, base, syncNeeded, counts, unreadFeedback: unread, notesWaiting, missingAccepted });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Submit (§7.2, §6.3, §6.4)

  private async candidatesFor(cfg: StetConfig, base: string, tip: string, touched: Set<string>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const changes = await this.diffNames(base, tip);
    for (const ch of changes) {
      if (!touched.has(ch.path) && !(ch.oldPath && touched.has(ch.oldPath))) continue;
      for (const p of [ch.path, ch.oldPath ?? ch.path]) {
        if (!isSafeRepoPath(p)) throw new StetError(`The path '${p}' is not allowed in a proposal (it could reach the git directory on some systems). Remove or rename it, then submit again.`);
      }
      // Stet's own workspace files are never proposals (unless the project tracks them).
      if (isWorkspaceFile(ch.path) && ch.status === "A") continue;
      const oldPath = ch.status === "R" ? ch.oldPath! : ch.path;
      const oldBuf = ch.status === "A" ? null : await this.repo.readBlob(base, oldPath);
      const newBuf = ch.status === "D" ? null : await this.repo.readBlob(tip, ch.path);
      if (newBuf && newBuf.length > cfg.maxFileMB * 1024 * 1024) {
        throw new StetError(
          `${ch.path} is ${(newBuf.length / 1024 / 1024).toFixed(1)} MB, more than the ${cfg.maxFileMB} MB Stet takes for a file ` +
            `(the reviewer can raise "maxFileMB" in .git/stet/config.json). Leave it out (git checkout -- ${ch.path}, or delete it), then submit again.`,
        );
      }
      const binary = (oldBuf && isBinary(oldBuf)) || (newBuf && isBinary(newBuf));
      const oldText = oldBuf ? toLf(oldBuf.toString("utf8")) : "";
      const newText = newBuf ? toLf(newBuf.toString("utf8")) : "";
      // Read again later in the submit (anchoring, re-merging): keep what was read.
      if (oldBuf && !binary) this.cacheText(base + ":" + oldPath, { text: oldText, eol: detectEol(oldBuf.toString("utf8")) });
      if (newBuf && !binary) this.cacheText(tip + ":" + ch.path, { text: newText, eol: detectEol(newBuf.toString("utf8")) });
      const whole = (kind: Item["kind"]): Candidate => ({
        file: ch.path,
        ...(ch.status === "R" ? { oldFile: oldPath } : {}),
        kind,
        start: 0,
        end: 0,
        newStart: 0,
        newEnd: newText.length,
        oldText: binary ? "" : oldText,
        newText: binary ? "" : newText,
      });
      if (binary) {
        // Text with a byte that isn't UTF-8 is still shown, the byte marked: shown as "(binary
        // file)", it hid what accepting it writes (security report 5e4c6af, S7).
        const [os, ns] = [oldBuf && textWithBadBytes(oldBuf), newBuf && textWithBadBytes(newBuf)];
        out.push({
          ...whole("binary"),
          oldBlob: oldBuf ? await this.repo.blobId(base, oldPath) : null,
          newBlob: newBuf ? await this.repo.blobId(tip, ch.path) : null,
          ...((os ?? null) !== null || (ns ?? null) !== null ? { shownText: { old: os ?? null, new: ns ?? null } } : {}),
        });
      } else if (ch.status === "A") out.push(whole("add-file"));
      else if (ch.status === "D") out.push(whole("delete-file"));
      else if (ch.status === "R") out.push(whole("rename-file"));
      else {
        for (const e of splitText(this.profile(cfg, ch.path), oldText, newText, cfg.split)) {
          out.push({ ...e, file: ch.path, kind: "modify" });
        }
      }
    }
    return out;
  }

  private fingerprint(c: { file: string; kind: string; oldText: string; newText: string; newBlob?: string | null }) {
    return "sha256:" + sha256([c.file, c.kind, normalizeWs(c.oldText), normalizeWs(c.newText), c.newBlob ?? ""].join("\u0000"));
  }

  async submit(
    agentId: string,
    opts: { title: string; rationale?: string; groups?: GroupHint[]; notes?: NoteHint[] },
  ): Promise<SubmitResult> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const agent = await this.requireAgent(agentId);
      if (agent.state !== "active") throw new StetError(archivedMessage(agent));
      const base = await this.ensureBase();
      const files = await this.agentFiles(agent);
      const tip = await files.commitAll(`${opts.title}\n\n${opts.rationale ?? ""}\n\nStet-Agent: ${agentId}`);
      const result: SubmitResult = {
        changeset: null, items: [], groups: [], ungrouped: [], superseded: [], withdrawn: [], repeats: [], moves: [], warnings: [], sync: null,
      };

      if (tip !== agent.lastTip) {
        await this.itemize(cfg, agent, tip, opts, result);
        agent.lastTip = tip;
        await this.store.putAgent(agent);
        // A very large round: said to the agent and the reviewer, not refused. 3,000 changes in
        // one held the store lock for over a minute (security report 5e4c6af, S15).
        const nFiles = new Set(result.items.map((i) => i.file)).size;
        if (result.changeset && (result.items.length > LARGE_SUBMIT.items || nFiles > LARGE_SUBMIT.files)) {
          const what = `${result.items.length} changes in ${nFiles} file${nFiles === 1 ? "" : "s"}`;
          result.warnings.push(`This round is very large (${what}): it is slow for Stet and hard to review. Submit in smaller rounds, one topic each.`);
          result.changeset.stetNote = `A very large round: ${what}.`;
          await this.store.putChangeset(result.changeset);
        }
      } else result.warnings.push("Nothing new to submit.");

      if (agent.baseCommit !== base) result.sync = await this.sync(agentId);
      return result;
    });
  }

  private async itemize(
    cfg: StetConfig,
    agent: Agent,
    tip: string,
    opts: { title: string; rationale?: string; groups?: GroupHint[]; notes?: NoteHint[] },
    result: SubmitResult,
  ): Promise<void> {
    const base = agent.baseCommit;
    const touched = new Set<string>();
    for (const ch of await this.diffNames(agent.lastTip, tip)) {
      touched.add(ch.path);
      if (ch.oldPath) touched.add(ch.oldPath);
    }
    const allItems = await this.store.items();
    // An unrelated paragraph replacing another is one change, unless one of them moved (§6.4.7).
    const agentPure = allItems.filter((i) => i.agent === agent.id && isLive(i.status) && i.kind === "modify" && !touched.has(i.file));
    let cands = separateMoved(await this.candidatesFor(cfg, base, tip, touched), agentPure, cfg.grouping.moves);
    // Items whose change is still in the agent's tree: live ones, plus ones resolved since the last replay.
    const resolvedAt = (i: Item) => i.history[i.history.length - 1]!.at;
    const existing = allItems.filter(
      (i) =>
        i.agent === agent.id &&
        i.baseCommit === base &&
        (isLive(i.status) || (["accepted", "rejected"].includes(i.status) && resolvedAt(i) >= (agent.replayedAt ?? ""))) &&
        (touched.has(i.file) || (i.oldFile !== undefined && touched.has(i.oldFile))),
    );

    // Re-merge candidates that fall inside an existing item's range (keeps atomic merges stable).
    for (const e of existing.filter((e) => e.kind === "modify" && e.status === "pending")) {
      const inside = cands.filter((c) => c.kind === "modify" && c.file === e.file && c.start >= e.range.start && c.end <= e.range.end);
      if (inside.length < 2 && !(inside.length === 1 && (inside[0]!.start !== e.range.start || inside[0]!.end !== e.range.end))) continue;
      const crossing = cands.some((c) => c.kind === "modify" && c.file === e.file && !inside.includes(c) && overlaps(c, e.range));
      if (crossing || !inside.length) continue;
      const first = inside[0]!;
      const last = inside[inside.length - 1]!;
      const newStart = first.newStart - (first.start - e.range.start);
      const newEnd = last.newEnd + (e.range.end - last.end);
      const tipText = (await this.textAt(tip, e.file))!.text;
      const baseText = (await this.textAt(base, e.file))!.text;
      const merged: Candidate = {
        file: e.file, kind: "modify", start: e.range.start, end: e.range.end, newStart, newEnd,
        oldText: baseText.slice(e.range.start, e.range.end), newText: tipText.slice(newStart, newEnd),
      };
      cands = [...cands.filter((c) => !inside.includes(c)), merged];
    }

    const sameAs = (c: Candidate, e: Item) =>
      c.file === e.file && c.kind === e.kind && (c.oldFile ?? null) === (e.oldFile ?? null) &&
      c.start === e.range.start && c.end === e.range.end && c.newText === e.newText && (c.newBlob ?? null) === (e.newBlob ?? null);

    const matched = new Map<Candidate, Item>();
    const used = new Set<Item>();
    for (const c of cands) {
      const e = existing.find((e) => !used.has(e) && sameAs(c, e));
      if (e) {
        matched.set(c, e);
        used.add(e);
      }
    }
    const fresh = cands.filter((c) => !matched.has(c));

    // Atomic hints merge fresh candidates before items exist.
    const hints = opts.groups ?? [];
    const tipRange = async (w: string) => {
      const where = parseWhere(w);
      const text = where.text;
      if (where.from === undefined) return { file: where.file, range: null, text };
      const t = await this.textAt(tip, where.file);
      if (!t) return { file: where.file, range: { start: -1, end: -1 }, text };
      return { file: where.file, range: lineRange(t.text, where.from, where.to!), text };
    };
    const unit = (c: Candidate, key: string): HintUnit => ({
      key, file: c.file, ...(c.oldFile ? { oldFile: c.oldFile } : {}), wholeFile: c.kind !== "modify", newStart: c.newStart, newEnd: c.newEnd,
      oldText: c.oldText, newText: c.newText,
    });
    const hintMatches = async (where: string[], pool: Candidate[]) => {
      const out = new Set<Candidate>();
      for (const w of where) {
        const { file, range, text } = await tipRange(w);
        const hits = pool.filter((c) => unitMatches(unit(c, ""), file, range, text));
        if (!hits.length) result.warnings.push(`'${w}' matched no change.`);
        for (const h of hits) out.add(h);
      }
      return [...out];
    };
    const effectiveHints: GroupHint[] = [];
    for (const h of hints) {
      if (h.kind !== "atomic") {
        effectiveHints.push(h);
        continue;
      }
      const matchedC = (await hintMatches(h.where, fresh)).filter((c) => c.kind === "modify");
      const keyEdits = matchedC.filter((c) => this.isKeyEdit(cfg, c));
      const members = matchedC.filter((c) => !keyEdits.includes(c));
      if (keyEdits.length)
        result.warnings.push(`Atomic group '${h.title}': kept ${keyEdits.map((k) => JSON.stringify(k.newText.trim())).join(", ")} separate (renames are items of their own; link them instead).`);
      if (members.length < 2) continue;
      const files = new Set(members.map((m) => m.file));
      members.sort((a, b) => a.start - b.start);
      const first = members[0]!;
      const last = members[members.length - 1]!;
      const baseText = files.size === 1 ? (await this.textAt(base, first.file))!.text : "";
      const between = baseText.slice(first.end, last.start);
      const others = fresh.filter((c) => !members.includes(c) && c.file === first.file && c.start < last.end && c.end > first.start);
      if (others.some((o) => keyEdits.includes(o))) {
        result.warnings.push(`Atomic group '${h.title}' would swallow a rename; treated as related.`);
        effectiveHints.push({ ...h, kind: "related" });
        continue;
      }
      if (files.size !== 1 || /\n[ \t]*\n/.test(between) || others.length) {
        result.warnings.push(`Atomic group '${h.title}' spans more than one paragraph or file; treated as linked.`);
        effectiveHints.push({ ...h, kind: "linked" });
        continue;
      }
      const tipText = (await this.textAt(tip, first.file))!.text;
      const merged: Candidate = {
        file: first.file, kind: "modify", start: first.start, end: last.end, newStart: first.newStart, newEnd: last.newEnd,
        oldText: baseText.slice(first.start, last.end), newText: tipText.slice(first.newStart, last.newEnd),
      };
      fresh.splice(0, fresh.length, ...fresh.filter((c) => !members.includes(c)), merged);
      (merged as any).note = h.rationale ? `${h.title}: ${h.rationale}` : h.title;
    }

    // A reworded sentence with a piece that repeats an earlier rejection: keep that sentence's
    // changes together as one item. Auto-rejecting only the piece left the rest a broken
    // sentence, which accepting would have put into the document (bug report 2026-11-18).
    const rejectedFps = new Set(allItems.filter((i) => i.status === "rejected" && !i.acceptFailed).map((i) => i.fingerprint));
    const repeats = (c: Candidate) => rejectedFps.has(this.fingerprint(c));
    for (const file of new Set(fresh.filter((c) => c.kind === "modify" && repeats(c)).map((c) => c.file))) {
      const list = fresh.filter((c) => c.kind === "modify" && c.file === file).sort((a, b) => a.start - b.start);
      const baseText = (await this.textAt(base, file))!.text;
      const tipText = (await this.textAt(tip, file))!.text;
      // Runs of changes with no sentence end, paragraph break or other (unchanged) item between them.
      const runs: Candidate[][] = [];
      for (const c of list) {
        const run = runs[runs.length - 1];
        const prev = run?.[run.length - 1];
        const between = (o: Candidate) => o.file === file && !fresh.includes(o) && o.start >= prev!.end && o.end <= c.start;
        if (prev && !SENTENCE_BREAK.test(baseText.slice(prev.end, c.start)) && !cands.some(between)) run.push(c);
        else runs.push([c]);
      }
      for (const run of runs) {
        if (run.length < 2 || !run.some(repeats) || run.some((c) => this.isKeyEdit(cfg, c) || (c as any).note)) continue;
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const merged: Candidate = {
          file, kind: "modify", start: first.start, end: last.end, newStart: first.newStart, newEnd: last.newEnd,
          oldText: baseText.slice(first.start, last.end), newText: tipText.slice(first.newStart, last.newEnd),
        };
        fresh.splice(fresh.indexOf(first), 1, merged);
        for (const c of run.slice(1)) fresh.splice(fresh.indexOf(c), 1);
        result.warnings.push(
          `Kept ${run.length} changes to one sentence of ${file} together as one item: part of it repeats a change the reviewer rejected earlier.`,
        );
      }
    }

    // Existing items that disappeared: superseded (if replaced) or withdrawn.
    const stillThere = new Set(matched.values());
    const replacedBy = new Map<Item, Candidate>();
    for (const e of existing) {
      if (stillThere.has(e) || !isLive(e.status)) continue;
      const repl = fresh.find((c) => c.file === e.file && (e.kind !== "modify" || overlaps(c, e.range)));
      if (repl) replacedBy.set(e, repl);
      else {
        this.setStatus(e, "withdrawn", "agent", "change removed from the agent workspace");
        await this.store.putItem(e);
        result.withdrawn.push(e.id);
      }
    }

    if (!fresh.length && !result.withdrawn.length) {
      result.warnings.push("Nothing new to submit.");
      return;
    }

    // Create items.
    // A rejection right after a failed accept is about applying, not the change: it doesn't count.
    const rejected = new Map(allItems.filter((i) => i.status === "rejected" && !i.acceptFailed).map((i) => [i.fingerprint, i]));
    const [csId] = await this.store.allocate("changeset");
    // Changes are numbered within their round (submission): 12.1, 12.2, …
    const ids = fresh.map((_, k) => itemId(csId!, k + 1));
    const baseTextOf = async (c: Candidate) => (await this.textAt(base, c.oldFile ?? c.file))?.text ?? "";
    const created: Item[] = [];
    const candOf = new Map<Item, Candidate>();
    const itemOf = new Map<Candidate, Item>();
    for (let k = 0; k < fresh.length; k++) {
      const c = fresh[k]!;
      const bt = await baseTextOf(c);
      const item: Item = {
        id: ids[k]!,
        agent: agent.id,
        changeset: csId!,
        file: c.file,
        ...(c.oldFile ? { oldFile: c.oldFile } : {}),
        kind: c.kind,
        baseCommit: base,
        range: { start: c.start, end: c.end },
        oldText: c.oldText,
        newText: c.newText,
        ...(c.kind === "binary" ? { oldBlob: c.oldBlob ?? null, newBlob: c.newBlob ?? null, ...(c.shownText ? { shownText: c.shownText } : {}) } : {}),
        context: c.kind === "modify" ? captureContext(bt, c.start, c.end) : { before: "", after: "" },
        fingerprint: this.fingerprint(c),
        note: (c as any).note ?? null,
        groups: [],
        status: "pending",
        resolution: null,
        supersedes: null,
        conflictsWith: [],
        history: [{ at: now(), status: "pending", by: "agent" }],
        thread: [],
      };
      const prev = rejected.get(item.fingerprint);
      if (prev) {
        this.setStatus(item, "rejected", "stet", `repeat of ${prev.id}`);
        result.repeats.push(item.id);
      }
      created.push(item);
      candOf.set(item, c);
      itemOf.set(c, item);
    }
    chainInsertions(created, compareItemIds);
    const inherited: { from: Item; to: Item }[] = [];
    for (const [e, c] of replacedBy) {
      const item = created[fresh.indexOf(c)]!;
      item.supersedes ??= e.id;
      inherited.push({ from: e, to: item });
      this.setStatus(e, "superseded", "agent", `superseded by ${item.id}`);
      await this.store.putItem(e);
      result.superseded.push(e.id);
    }
    // A move loses an item it can't do without: dissolve it, so its group isn't inherited by a
    // replacement that moves something else (bug report 2026-11-13: an old move group ended up
    // linking unrelated items). Detection below pairs the remaining items again where it can.
    const gone = existing.filter((e) => result.superseded.includes(e.id) || result.withdrawn.includes(e.id));
    await this.dissolveMoves(gone, new Map(allItems.map((i) => [i.id, i])));

    // Conflicts with other agents' live items (same base only; others are checked at accept time).
    for (const other of allItems.filter((i) => i.agent !== agent.id && isLive(i.status) && i.baseCommit === base && i.kind === "modify")) {
      for (const it of created.filter((c) => c.file === other.file && c.kind === "modify" && isLive(c.status))) {
        if (overlaps(it.range, other.range)) {
          it.conflictsWith.push(other.id);
          other.conflictsWith.push(it.id);
          await this.store.putItem(other);
        }
      }
    }

    // Notes.
    for (const n of opts.notes ?? []) {
      const pool = [...created.map((i) => candOf.get(i)!), ...[...matched.keys()]];
      const hits = await hintMatches(Array.isArray(n.where) ? n.where : [n.where], pool);
      for (const h of hits) {
        const it = itemOf.get(h) ?? matched.get(h);
        if (!it) continue;
        it.note = it.note ? `${it.note}\n${n.note}` : n.note;
        if (!created.includes(it)) await this.store.putItem(it);
      }
    }

    // Groups: explicit hints + auto detection.
    const live = created.filter((i) => isLive(i.status));
    const drafts: GroupDraft[] = [];
    // Auto-detection also sees the agent's earlier pending items (a \label here, its \ref from before).
    const newIds = new Set(created.map((i) => i.id));
    const earlier = (await this.store.items()).filter((i) => i.agent === agent.id && isLive(i.status) && !newIds.has(i.id) && !result.superseded.includes(i.id));
    // Moved passages (§6.4.7), decided as one change. Over all pending items: re-splitting at a
    // later submit can leave the two sides of a move in different rounds.
    for (const m of detectMoves([...earlier, ...live], cfg.grouping.moves, cfg.split.abbreviations, (it) => this.profile(cfg, it.file).syntax)) {
      const move = { from: m.from.map((i) => i.id), to: m.to.map((i) => i.id), changed: m.changed };
      for (const it of [...m.from, ...m.to]) it.move = { from: [...move.from], to: [...move.to], changed: move.changed };
      result.moves.push(move);
      drafts.push({ kind: "linked", title: m.title, rationale: null, source: "auto", items: [...move.from, ...move.to] });
    }
    // Moved and rewritten beyond a move: accepting one half alone would lose or duplicate it.
    for (const m of detectRewritten([...earlier, ...live], cfg.grouping.moves, cfg.split.abbreviations, (it) => this.profile(cfg, it.file).syntax)) {
      if (!newIds.has(m.from.id) && !newIds.has(m.to.id)) continue;
      drafts.push({ kind: "linked", title: m.title, rationale: null, source: "auto", items: [m.from.id, m.to.id] });
    }
    const idOfCand = (c: Candidate) => itemOf.get(c)?.id ?? matched.get(c)?.id;
    const known = new Map<string, Item>([...created, ...matched.values(), ...earlier].map((i) => [i.id, i]));
    for (const h of effectiveHints) {
      const pool = [...live.map((i) => candOf.get(i)!), ...[...matched.entries()].filter(([, e]) => isLive(e.status)).map(([c]) => c)];
      const members = (await hintMatches(h.where, pool)).map(idOfCand).filter((x): x is string => !!x);
      // Parts of a linked group (§6.4.6); their changes belong to the group too.
      let parts: PartDraft[] | undefined;
      if (h.parts?.length) {
        if (h.kind !== "linked") result.warnings.push(`Group '${h.title}': only linked groups have parts; ignored them.`);
        else {
          parts = [];
          for (const p of h.parts) {
            const ids = (await hintMatches(p.where, pool)).map(idOfCand).filter((x): x is string => !!x);
            for (const i of ids) if (!members.includes(i)) members.push(i);
            if (ids.length) parts.push({ title: p.title, items: ids });
          }
        }
      }
      if (!members.length) continue;
      // Linked only where accepting some alone would break the document (§6.4.6). Without a
      // dependency Stet can see, and without the agent's reason, the group is related, and only the
      // changes that need each other are linked.
      if (h.kind === "linked" && !h.reason && members.length > 1) {
        const units = parts?.length ? [...parts.map((p) => p.items), members.filter((m) => !parts!.some((p) => p.items.includes(m)))].filter((u) => u.length) : undefined;
        const comps = await this.dependencies(members.map((id) => known.get(id)).filter((x): x is Item => !!x), units);
        if (comps.length > 1) {
          drafts.push({ kind: "related", title: h.title, rationale: h.rationale ?? null, source: "agent", items: members });
          const kept = comps.filter((c) => c.length > 1);
          for (const c of kept) {
            const part = parts?.find((p) => c.every((i) => p.items.includes(i)));
            drafts.push({ kind: "linked", title: part?.title ?? `${h.title} (${c.length} changes that need each other)`, rationale: null, source: "auto", items: c });
          }
          result.warnings.push(unlinkedWarning(h.title, kept));
          continue;
        }
      }
      const rationale = h.reason ? `Linked because: ${h.reason}${h.rationale ? `\n\n${h.rationale}` : ""}` : (h.rationale ?? null);
      drafts.push({ kind: h.kind, title: h.title, rationale, source: "agent", items: members, ...(parts ? { parts } : {}) });
    }
    drafts.push(...autoGroups([...earlier, ...live], cfg.grouping, (f) => this.profile(cfg, f)).filter((d) => d.items.some((i) => newIds.has(i))));
    const finalDrafts = normalizeGroups(drafts);
    const gids = await this.store.allocate("group", finalDrafts.length);
    const byId = new Map<string, Item>([...created, ...matched.values(), ...earlier].map((i) => [i.id, i]));
    // A replacement takes over the groups of the item it supersedes.
    const getItem = async (id: string) => byId.get(id) ?? (await this.store.getItem(id)) ?? undefined;
    for (const { from, to } of inherited) {
      for (const gid of from.groups) {
        const g = await this.store.getGroup(gid);
        if (!g || g.state === "resolved") continue;
        const swap = (ids: string[]) => ids.map((i) => (i === from.id ? to.id : i)).filter((x, k, arr) => arr.indexOf(x) === k);
        g.items = swap(g.items);
        if (g.parts) {
          g.parts = g.parts.map((p) => ({ ...p, items: swap(p.items) }));
          byId.set(to.id, to);
          result.warnings.push(...(await this.settleParts(g, getItem)));
        }
        await this.store.putGroup(g);
        if (!to.groups.includes(gid)) to.groups.push(gid);
      }
    }
    const groups: Group[] = finalDrafts.map((d, k) => ({
      id: gids[k]!, agent: agent.id, changeset: csId!, kind: d.kind, title: d.title, rationale: d.rationale,
      source: d.source, items: d.items, ...(d.kind === "linked" && d.parts ? { parts: d.parts } : {}), state: "open",
    }));
    // Linked groups from earlier submissions that now share members get merged into the new one.
    const priorGroups = (await this.store.groups()).filter((g) => g.agent === agent.id && g.kind === "linked" && g.state === "open");
    const merged = new Set<Group>();
    for (const g of groups.filter((g) => g.kind === "linked")) {
      for (const pg of priorGroups.filter((pg) => pg.items.some((i) => g.items.includes(i)))) {
        const parts = combineParts(pg, g);
        if (parts) g.parts = parts;
        merged.add(g);
        for (const i of pg.items) if (!g.items.includes(i)) g.items.push(i);
        g.title = joinTitles(pg.title, g.title);
        for (const i of pg.items) {
          const it = byId.get(i) ?? (await this.store.getItem(i));
          if (it) {
            it.groups = it.groups.filter((x) => x !== pg.id);
            byId.set(it.id, it);
          }
        }
        await this.store.deleteGroup(pg.id);
      }
    }
    for (const g of groups) {
      for (const i of g.items) {
        const it = byId.get(i) ?? (await this.store.getItem(i));
        if (it && !it.groups.includes(g.id)) {
          it.groups.push(g.id);
          byId.set(it.id, it);
        }
      }
      result.warnings.push(...(await this.settleParts(g, getItem, merged.has(g))));
      await this.store.putGroup(g);
    }
    for (const it of byId.values()) if (!created.includes(it)) await this.store.putItem(it);

    const changeset: Changeset = {
      id: csId!, agent: agent.id, title: opts.title, rationale: opts.rationale ?? "", submittedAt: now(),
      items: created.map((i) => i.id), groups: groups.map((g) => g.id),
    };
    for (const it of created) await this.store.putItem(it);
    await this.store.putChangeset(changeset);
    await this.store.appendEvent({ type: "items_submitted", agent: agent.id, items: created.map((i) => i.id), data: { changeset: csId } });
    for (const id of result.repeats) {
      const it = byId.get(id)!;
      await this.store.appendEvent({
        type: "repeat_rejected", agent: agent.id, items: [id],
        data: { item: await this.describe(it), previous: it.history[it.history.length - 1]!.note },
      });
    }

    result.changeset = changeset;
    result.items = created;
    result.groups = groups;
    result.ungrouped = created.filter((i) => !i.groups.length && isLive(i.status)).map((i) => i.id);
  }

  // -------------------------------------------------------------------------
  // Sync / replay (§7.6)

  async sync(agentId: string): Promise<SyncResult> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      if (agent.state !== "active") throw new StetError(archivedMessage(agent));
      const files = await this.agentFiles(agent);
      const dirty = await files.uncommitted();
      const tip = await files.tip();
      const refused = dirty.length
        ? `The agent workspace has uncommitted changes (${dirty.join(", ")}). Submit them (stet submit) or discard them before syncing.`
        : tip !== agent.lastTip
          ? "The agent workspace has unsubmitted commits. Submit them before syncing."
          : null;
      if (refused) {
        // Notes don't wait for a clean workspace: they arrive with the refusal (§7.8).
        const notes = await this.deliverNotes(agent);
        throw new StetError([refused, ...notes.map((d) => describeNote(d))].join("\n"));
      }
      const base = await this.ensureBase();
      const live = (await this.store.items()).filter((i) => i.agent === agentId && isLive(i.status));
      const res = await applyItems(live, this.treeView(base), { refText: this.refText, neighbours: this.neighbours });
      const stale: Item[] = [];
      const baseTexts = new Map<string, string>();
      for (const { item, reason } of res.failed) {
        await this.markStale(item, reason, base);
        stale.push(item);
      }
      for (const { item, span } of res.applied) {
        if (item.kind === "modify") {
          if (!baseTexts.has(item.file)) baseTexts.set(item.file, (await this.textAt(base, item.file))!.text);
          const bt = baseTexts.get(item.file)!;
          item.range = { ...span };
          item.context = captureContext(bt, span.start, span.end);
        }
        item.baseCommit = base;
      }
      chainInsertions(res.applied.map((a) => a.item), compareItemIds);
      for (const { item } of res.applied) await this.store.putItem(item);
      const commit = res.changes.size
        ? await this.repo.buildCommit({
            parents: [base],
            baseRev: base,
            changes: await this.changesToCommitMap(res.changes),
            message: `stet: pending proposals of ${agentId}\n\nStet-Agent: ${agentId}`,
          })
        : base;
      await files.checkout(commit);
      agent.baseCommit = base;
      agent.lastTip = commit;
      agent.replayedAt = now();
      await this.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      await this.store.appendEvent({ type: "synced", agent: agentId, data: { base, stale: stale.map((s) => s.id) } });
      await this.updateGroups(stale);
      const notes = await this.deliverNotes(agent);
      return { base, stale, kept: res.applied.length, notes };
    });
  }

  private async markStale(item: Item, reason: string, againstRev?: string) {
    this.setStatus(item, "stale", "stet", reason);
    await this.store.putItem(item);
    let current: string | undefined;
    if (againstRev && item.kind === "modify") {
      const t = (await this.textAt(againstRev, item.file))?.text;
      if (t) {
        const at = Math.min(item.range.start, t.length);
        current = t.slice(Math.max(0, at - 200), at + 200 + item.oldText.length);
      }
    }
    await this.store.appendEvent({
      type: "stale", agent: item.agent, items: [item.id],
      data: { item: await this.describe(item), reason, ...(current !== undefined ? { currentText: current } : {}) },
    });
  }

  /**
   * Check the parts of a linked group (§6.4.6) and join the ones that break the rules. Accepting
   * is simulated on the review base the members were made against. Returns notes for the agent.
   */
  /**
   * The sets of changes among `members` that need each other: the rules of §6.4.6 from single
   * changes up, plus the same symbol or term replaced, within one of `units` (the agent's parts:
   * a notation change it split by section stays split).
   */
  private async dependencies(members: Item[], units?: string[][]): Promise<string[][]> {
    const base = members.find((m) => isLive(m.status))?.baseCommit;
    const singles = members.map((m) => ({ title: m.id, items: [m.id] }));
    const unitOf = new Map((units ?? []).flatMap((u, k) => u.map((i) => [i, k] as const)));
    const sameSymbol = (a: Item, b: Item) => !units || unitOf.get(a.id) === unitOf.get(b.id);
    const cfg = await this.config();
    const { parts } = await settleParts(singles, members, base ? (lists) => this.interference(lists, this.treeView(base)) : undefined, { sameSymbol, profileOf: (f) => this.profile(cfg, f), grouping: cfg.grouping });
    return parts ? parts.map((p) => p.items) : [members.map((m) => m.id)];
  }

  private async settleParts(g: Group, get: (id: string) => Promise<Item | undefined>, merged = false): Promise<string[]> {
    if (g.kind !== "linked" || !g.parts) {
      delete g.parts;
      return [];
    }
    const members = (await Promise.all(g.items.map(get))).filter((x): x is Item => !!x && x.status !== "superseded");
    const base = members.find((m) => isLive(m.status))?.baseCommit;
    const cfg = await this.config();
    const { parts, notes } = await settleParts(g.parts, members, base ? (lists) => this.interference(lists, this.treeView(base)) : undefined, { profileOf: (f) => this.profile(cfg, f), quietOverlaps: merged, grouping: cfg.grouping });
    if (parts) g.parts = parts;
    else delete g.parts;
    // Joins of parts Stet proposed itself are no news to the agent.
    return g.source === "auto" ? [] : notes.map((n) => `Group '${g.title}': ${n}`);
  }

  /**
   * Pairs (a, b) of item lists where accepting all of a (onto `view`) would keep b from being
   * accepted: b's changes overlap a's (accepting a makes them stale) or can't be located afterwards.
   */
  private async interference(lists: Item[][], view: FileView): Promise<[number, number][]> {
    const opts = { refText: this.refText };
    const out: [number, number][] = [];
    const before = await Promise.all(lists.map((l) => locate(l, view, opts)));
    for (let a = 0; a < lists.length; a++) {
      const res = await applyItems(lists[a]!, view, opts);
      if (res.failed.length) continue; // not applicable on its own here; accept will say why
      const after: FileView = {
        read: async (p) => {
          if (!res.changes.has(p)) return view.read(p);
          const c = res.changes.get(p);
          return c && "text" in c ? c : null;
        },
        blobId: async (p) => (res.changes.has(p) ? (res.changes.get(p) === null ? null : "changed") : view.blobId(p)),
      };
      for (let b = 0; b < lists.length; b++) {
        if (b === a) continue;
        const located = before[b]!.located;
        const clash = located.some((l) =>
          res.applied.some((x) => x.item.file === l.item.file && (l.item.kind !== "modify" || x.item.kind !== "modify" || conflicts(l.span, x.span))),
        );
        // Part a is accepted in this simulation: a change next to it is found with its text, as
        // after a real accept (bug report 2026-11-19: parts in one paragraph were always joined).
        const simulated = { ...opts, neighbours: async (it: Item) => [...appliedAsNeighbours(res.applied, it), ...(await this.neighbours(it))] };
        const lost = clash ? [] : (await locate(located.map((l) => l.item), after, simulated)).failed;
        if (clash || lost.length) out.push([a, b]);
      }
    }
    return out;
  }

  /** Recompute group states after status changes; emits group_broken once per group. */
  private async updateGroups(changed: Item[]) {
    const gids = new Set(changed.flatMap((i) => i.groups));
    for (const gid of gids) {
      const g = await this.store.getGroup(gid);
      if (!g) continue;
      // Superseded members have been replaced by newer versions; they no longer count.
      const members = (await Promise.all(g.items.map((i) => this.store.getItem(i)))).filter(
        (x): x is Item => !!x && x.status !== "superseded",
      );
      if (!members.length) continue;
      const statuses = members.map((m) => m.status);
      let state: Group["state"] = statuses.every((s) => !isLive(s)) ? "resolved" : "open";
      // Each part of a linked group is resolved as one (§6.4.6); without parts, the whole group is.
      const units = g.kind !== "linked" ? [] : g.parts ? g.parts.map((p) => members.filter((m) => p.items.includes(m.id))).filter((u) => u.length) : [members];
      for (const u of units) {
        const accepted = u.filter((m) => m.status === "accepted").length;
        const dead = u.filter((m) => ["rejected", "stale", "withdrawn"].includes(m.status)).length;
        if ((accepted && accepted < u.length) || (dead && u.some((m) => isLive(m.status)))) state = "broken";
      }
      if (state === "broken" && g.state !== "broken") {
        await this.store.appendEvent({
          type: "group_broken", agent: g.agent, group: g.id, items: g.items,
          data: { title: g.title, members: members.map((m) => ({ id: m.id, status: m.status, file: m.file })) },
        });
      }
      // Some parts accepted, others not: the document compiles but may be inconsistent.
      if (state === "resolved" && g.state !== "resolved" && g.parts && units.length > 1) {
        const outcome = (u: Item[]) => (u.every((m) => m.status === "accepted") ? "accepted" : u.find((m) => m.status !== "accepted")!.status);
        const parts = g.parts.flatMap((p, k) => {
          const u = members.filter((m) => p.items.includes(m.id));
          return u.length ? [{ id: partId(g.id, k), title: p.title, outcome: outcome(u), items: u.map((m) => m.id) }] : [];
        });
        if (parts.some((p) => p.outcome === "accepted") && parts.some((p) => p.outcome !== "accepted")) {
          await this.store.appendEvent({ type: "group_partial", agent: g.agent, group: g.id, items: g.items, data: { title: g.title, parts } });
        }
      }
      if (state !== g.state) {
        g.state = state;
        await this.store.putGroup(g);
      }
    }
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
  listGroups = () => this.store.groups();
  listChangesets = () => this.store.changesets();

  /** Current 1-based line of an item in the working copy (or its base line if it can't be located). */
  async locateInWorkingCopy(item: Item): Promise<{ line: number; span: Span | null }> {
    if (item.kind !== "modify") return { line: 1, span: null };
    const f = await this.workingView().read(item.file).catch(() => null); // not UTF-8 any more: not located
    const span = f ? await this.anchorItem(item, f.text) : null;
    return { line: span && f ? lineOf(f.text, span.start) : await this.itemLine(item), span };
  }

  /** Where an item's old text sits in `text` (LF line endings), e.g. an editor buffer with unsaved edits. */
  async locateInText(item: Item, text: string): Promise<Span | null> {
    if (item.kind !== "modify") return null;
    return this.anchorItem(item, text);
  }

  /** Accepted items whose changes are in the working copy but not yet committed. */
  async uncommittedAccepted(): Promise<Item[]> {
    return (await this.store.items()).filter((i) => i.status === "accepted" && i.resolution && !i.resolution.committed);
  }

  /**
   * What Finish review would commit, without committing: the accepted items, and the files that
   * also hold edits of the user's (committed along, whole files). For its question (test report v0.16.0, D6).
   */
  async commitPreview(): Promise<{ items: Item[]; yourEdits: string[] }> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      await this.ensureBase();
      const items = (await this.uncommittedAccepted()).sort((a, b) => compareItemIds(a.id, b.id));
      if (!items.length) return { items, yourEdits: [] };
      const paths = [...new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]))];
      return { items, yourEdits: await this.filesWithOtherEdits(items, paths, await this.mainHead(cfg)) };
    });
  }

  /**
   * Commit accepted-but-uncommitted items ("Finish review"). Commits their whole files,
   * so the user's own edits in those files are included.
   */
  async commitAcceptedItems(opts: { subject?: string } = {}): Promise<{ commit: string | null; items: Item[]; yourEdits: string[] }> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const onBranch = await this.projectBranch();
      if (onBranch !== cfg.mainBranch)
        throw new StetError(`Your project folder is on '${onBranch ?? "a detached HEAD"}', not '${cfg.mainBranch}'. Switch back first.`);
      await this.ensureBase(); // marks items the user already committed
      const items = (await this.uncommittedAccepted()).sort((a, b) => compareItemIds(a.id, b.id));
      if (!items.length) return { commit: null, items, yourEdits: [] };
      const paths = [...new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]))];
      const yourEdits = await this.filesWithOtherEdits(items, paths, await this.mainHead(cfg));
      const commit = await this.commitAccepted(items, paths, opts.subject, yourEdits);
      await this.ensureBase();
      return { commit, items: commit ? items : [], yourEdits: commit ? yourEdits : [] };
    });
  }

  /**
   * Of `paths`, those whose working copy holds more than the accepted `items` applied to `head`:
   * the user's own edits, which a commit of the whole file takes along (test report D8). A file
   * where that can't be told (an item no longer found in `head`) counts as one.
   */
  private async filesWithOtherEdits(items: Item[], paths: string[], head: string): Promise<string[]> {
    const overrides = new Map(items.map((i) => [i.id, i.resolution?.appliedText ?? i.newText]));
    const sim = await applyItems(items, this.treeView(head), { refText: this.refText, overrides, neighbours: this.neighbours }).catch(() => null);
    const unsure = new Set(sim ? sim.failed.flatMap((f) => [f.item.file, ...(f.item.oldFile ? [f.item.oldFile] : [])]) : paths);
    const out: string[] = [];
    for (const p of paths) {
      if (unsure.has(p)) {
        out.push(p);
        continue;
      }
      const want = sim!.changes.has(p) ? sim!.changes.get(p)! : await this.treeView(head).read(p);
      const blob = await this.workingView().blobId(p);
      if (want === null || blob === null) {
        if ((want === null) !== (blob === null)) out.push(p);
        continue;
      }
      if ("blob" in want) {
        if (want.blob !== blob) out.push(p);
        continue;
      }
      const cur = await this.workingView().read(p).catch(() => null);
      if (!cur || cur.text !== want.text) out.push(p);
    }
    return out;
  }

  private async requireItems(ids: string[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const id of ids) {
      const it = await this.store.getItem(id.toUpperCase());
      if (!it) throw new StetError(`Unknown item '${id}'.`);
      out.push(it);
    }
    return out;
  }

  /** Live items that must be accepted (or rejected) together with `items`: their linked groups' parts (§6.4.5–6). */
  /**
   * Dissolve the moves (§6.4.7) of items that no longer stand (superseded, withdrawn): the other
   * items become ordinary deletions and insertions, and the move's own group goes. `known`:
   * in-memory items to update, so callers holding them don't write old versions back.
   */
  private async dissolveMoves(gone: Item[], known: Map<string, Item>): Promise<void> {
    for (const g of gone) {
      if (!g.move) continue;
      const ids = [...moveFrom(g.move), ...moveTo(g.move)];
      const members: Item[] = [];
      for (const id of ids) {
        const it = known.get(id) ?? (await this.store.getItem(id));
        if (it) members.push(it);
      }
      const all = new Set(ids);
      for (const gid of new Set(members.flatMap((m) => m.groups))) {
        const grp = await this.store.getGroup(gid);
        // Only the group that is just this move; an agent's larger linked group stays.
        if (grp?.kind !== "linked" || grp.source !== "auto" || grp.items.length !== all.size || !grp.items.every((i) => all.has(i))) continue;
        await this.store.deleteGroup(gid);
        for (const m of members) m.groups = m.groups.filter((x) => x !== gid);
      }
      for (const m of members) {
        delete m.move;
        await this.store.putItem(m);
      }
    }
  }

  /**
   * Items with the rest of their moves (§6.4.7): part of a move is never decided alone, it would
   * drop or duplicate the passage.
   */
  private async withMovePartners(items: Item[]): Promise<Item[]> {
    const out = [...items];
    for (const it of items) {
      for (const p of moveOthers(it)) {
        if (out.some((o) => o.id === p)) continue;
        const pi = await this.store.getItem(p);
        if (pi && isLive(pi.status)) out.push(pi);
      }
    }
    return out;
  }

  private async linkedMembers(items: Item[]): Promise<Item[]> {
    const out = new Map<string, Item>();
    for (const it of items) {
      for (const gid of it.groups) {
        const g = await this.store.getGroup(gid);
        if (g?.kind !== "linked") continue;
        for (const m of linkedUnit(g, it.id)) {
          const mi = await this.store.getItem(m);
          if (mi && isLive(mi.status)) out.set(mi.id, mi);
        }
      }
      // The items of a move belong together even if their group was dissolved.
      for (const p of moveOthers(it)) {
        const pi = await this.store.getItem(p);
        if (pi && isLive(pi.status)) out.set(pi.id, pi);
      }
    }
    return [...out.values()];
  }

  /**
   * Warnings for the linked groups of these items that are now decided differently: some members
   * accepted, others rejected, withdrawn, stale or still pending (parts decided one at a time, or `--only`). The
   * agent was told (group_partial, group_broken); the reviewer heard nothing, and a \ref could be
   * committed without its \label (test report 2026-11-20, D3).
   */
  async partlyDecided(items: Item[]): Promise<string[]> {
    const out: string[] = [];
    const cfg = await this.config();
    // Typst stops at a reference to a missing label; LaTeX prints "??" (test report 5e4c6af, D1).
    const breaks = (ms: Item[]) => ms.some((m) => !!this.profile(cfg, m.file).references?.strict);
    for (const gid of new Set(items.flatMap((i) => i.groups))) {
      const g = await this.store.getGroup(gid);
      if (g?.kind !== "linked") continue;
      const members = (await Promise.all(g.items.map((i) => this.store.getItem(i)))).filter((x): x is Item => !!x && x.status !== "superseded");
      const yes = members.filter((m) => m.status === "accepted");
      const no = members.filter((m) => m.status === "rejected" || m.status === "withdrawn" || m.status === "stale");
      const open = members.filter((m) => isLive(m.status));
      if (!yes.length) continue;
      if (!no.length) {
        // Accepted a part, the rest still to decide: say so, or a \label is committed and its
        // \refs left dangling without a word (test report v0.16.0, D3).
        if (open.length)
          out.push(
            `${g.id} (${oneLine(g.title, 80)}) is a linked group, now partly accepted: ${yes.map((m) => m.id).join(", ")} accepted, ` +
              `${open.map((m) => m.id).join(", ")} still to decide. ${breaks(members) ? "The document may not compile" : "The document is inconsistent"} until they are accepted too.`,
          );
        continue;
      }
      out.push(
        `${g.id} (${oneLine(g.title, 80)}) is a linked group, now partly accepted: ${yes.map((m) => m.id).join(", ")} accepted, ` +
          `${no.map((m) => m.id).join(", ")} ${no.every((m) => m.status === "rejected") ? "rejected" : "not"}. ` +
          `Check that the document ${breaks(members) ? "still compiles" : "is still consistent"} (a reference to a label that no longer exists, say). Undo takes a decision back.`,
      );
    }
    return out;
  }

  /** A group (G3) or one of its parts (G3.2), with its pending items. */
  async groupTarget(id: string): Promise<{ group: Group; part: GroupPart | null; pending: string[] }> {
    const pid = parsePartId(id);
    const g = await this.store.getGroup(pid ? pid.group : id.trim().toUpperCase());
    if (!g) throw new StetError(`Unknown group '${id}'.`);
    const part = pid ? (g.parts?.[pid.index] ?? null) : null;
    if (pid && !part) throw new StetError(`${g.id} has ${g.parts?.length ? `only ${g.parts.length} parts` : "no parts"}.`);
    const pending: string[] = [];
    for (const i of part ? part.items : g.items) {
      const it = await this.store.getItem(i);
      if (it && isLive(it.status)) pending.push(i);
    }
    return { group: g, part, pending };
  }

  /** Accept the pending items of a group (G3) or of one part (G3.2). */
  async acceptGroup(groupId: string, opts: { commit?: boolean; confirmEffects?: boolean } = {}): Promise<AcceptResult> {
    const { pending } = await this.groupTarget(groupId);
    if (!pending.length) throw new StetError(`${groupId.toUpperCase()} has no pending items.`);
    return this.accept(pending, opts);
  }

  /**
   * The checks of an accept and its edits, in `view`, without writing anything: what `accept`
   * applies, or the error it gives. Call under lock.
   */
  private async planAccept(ids: string[], opts: { edited?: Record<string, string>; overrideLinked?: boolean; confirmEffects?: boolean }, view: FileView) {
    const cfg = await this.config();
    const items = await this.withMovePartners(await this.requireItems(ids));
    for (const it of items) if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
    const bad = items.flatMap((i) => [i.file, ...(i.oldFile !== undefined ? [i.oldFile] : [])]).filter((f) => !isSafeRepoPath(f));
    if (bad.length) throw new StetError(`Refusing to write outside the project or into its git directory: ${bad.join(", ")}`);
    const onBranch = await this.projectBranch();
    if (onBranch !== cfg.mainBranch)
      throw new StetError(`Your project folder is on '${onBranch ?? "a detached HEAD"}', not '${cfg.mainBranch}'. Switch back before accepting.`);

    // Files that take effect (a latexmkrc, .gitattributes, AGENTS.md…): only when asked for
    // explicitly (security report 5e4c6af, S12).
    const effects = items.filter((i) => itemEffect(i));
    if (effects.length && !opts.confirmEffects) {
      throw new StetError(
        `${effects.map((i) => `${i.id} changes ${i.file}: ${itemEffect(i)}`).join("; ")}. ` +
          `Look at ${effects.length > 1 ? "them" : "it"} first (stet show ${effects[0]!.id}), then accept with --confirm.`,
      );
    }
    const warnings: string[] = [];
    const missing = (await this.linkedMembers(items)).filter((m) => !items.some((i) => i.id === m.id));
    if (missing.length) {
      if (!opts.overrideLinked) {
        throw new StetError(
          `${items.map((i) => i.id).join(", ")} ${items.length > 1 ? "are" : "is"} linked with ${missing.map((m) => m.id).join(", ")}: ` +
            `accepting only part of a linked group can break the document. Accept the whole group, or override explicitly.`,
        );
      }
      // Typst stops at a reference to a missing label; say so (test report 5e4c6af, D1).
      const strict = [...items, ...missing].some((m) => !!this.profile(cfg, m.file).references?.strict);
      warnings.push(`Accepted without linked items ${missing.map((m) => m.id).join(", ")}; the group is now broken${strict ? ", and the document may not compile until they are accepted too" : ""}.`);
    }
    // The reviewer's drafts (from a file's review document), unless this accept gives other text.
    const overrides = new Map(items.filter((i) => i.draft !== undefined).map((i) => [i.id, i.draft!]));
    for (const [k, v] of Object.entries(opts.edited ?? {})) overrides.set(k.toUpperCase(), toLf(v));
    const res = await applyItems(items, view, { refText: this.refText, overrides, neighbours: this.neighbours });
    return { cfg, items, warnings, missing, overrides, res };
  }

  private static failedMessage(failed: { item: Item; reason: string }[]): string {
    const lost = failed.filter((f) => /can't be located/.test(f.reason)).map((f) => f.item.id);
    return (
      `Nothing was applied, because ${failed.length === 1 ? "a change" : "some changes"} could not be applied:\n` +
      failed.map((f) => `  ${f.item.id}: ${f.reason}`).join("\n") +
      // What to do next, for a change whose words were edited meanwhile (test report v0.16.0, UX).
      (lost.length ? `\nYou edited ${lost.length > 1 ? "their" : "its"} text or the text around ${lost.length > 1 ? "them" : "it"} since (${lost.join(", ")}): reject ${lost.length > 1 ? "them" : "it"}, or ask the agent for a revision against your current text.` : "")
    );
  }

  /**
   * Throws what `accept` would, with `unsaved` (an editor's unsaved texts, by file) in place of
   * those files; writes nothing. An editor saves its buffers only for an accept that will work:
   * a failed accept had already saved them (test report v0.16.0, D7).
   */
  async checkAccept(ids: string[], opts: { edited?: Record<string, string>; overrideLinked?: boolean; confirmEffects?: boolean; unsaved?: Record<string, string> } = {}): Promise<void> {
    return this.store.withLock(async () => {
      await this.recoverInterrupted();
      const disk = this.workingView();
      const unsaved = new Map(Object.entries(opts.unsaved ?? {}));
      const view: FileView = {
        read: async (p) => {
          const t = unsaved.get(p);
          if (t === undefined) return disk.read(p);
          return { text: toLf(t), eol: (await disk.read(p).catch(() => null))?.eol ?? detectEol(t) };
        },
        blobId: (p) => disk.blobId(p),
      };
      const { res } = await this.planAccept(ids, opts, view);
      if (res.failed.length) throw new StetError(Stet.failedMessage(res.failed));
    });
  }

  async accept(
    ids: string[],
    opts: { edited?: Record<string, string>; overrideLinked?: boolean; commit?: boolean; confirmEffects?: boolean } = {},
  ): Promise<AcceptResult> {
    return this.store.withLock(async () => {
      await this.recoverInterrupted();
      const view = this.workingView();
      const { cfg, items, warnings, missing, overrides, res } = await this.planAccept(ids, opts, view);
      const files = new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]));
      const wantCommit = opts.commit ?? cfg.autoCommit === "when-clean";
      const dirtyBefore = new Set<string>();
      if (wantCommit) for (const f of files) if ((await this.repo.status([f])).length) dirtyBefore.add(f);

      if (res.failed.length) {
        // Remembered, so rejecting such an item afterwards doesn't block the change for good.
        for (const f of res.failed) {
          f.item.acceptFailed = { at: now(), reason: f.reason };
          await this.store.putItem(f.item);
        }
        throw new StetError(Stet.failedMessage(res.failed));
      }

      // Other live items overlapping what we accept become stale.
      const stale: Item[] = [];
      const acceptedIds = new Set(items.map((i) => i.id));
      const others = (await this.store.items()).filter((i) => isLive(i.status) && !acceptedIds.has(i.id) && files.has(i.file));
      const spans = new Map((await locate(others, view, { refText: this.refText, neighbours: this.neighbours })).located.map((l) => [l.item.id, l.span]));
      for (const o of others) {
        const span = spans.get(o.id);
        const hit = res.applied.find(
          (a) => a.item.file === o.file && (o.kind !== "modify" || a.item.kind !== "modify" || (span && conflicts(span, a.span))),
        );
        if (hit) stale.push(o);
      }

      const appliedText = (a: (typeof res.applied)[number]) => (a.item.kind === "binary" || a.item.kind === "delete-file" ? a.item.newText : a.text);
      const editedOf = (a: (typeof res.applied)[number]) => overrides.has(a.item.id) && overrides.get(a.item.id) !== a.item.newText;
      // What HEAD holds now, to tell later when the user has committed these files (ensureBase).
      const head = await this.mainHead(cfg);
      const headBlobs = new Map<string, string | null>();
      for (const f of new Set(res.applied.map((a) => a.item.file))) headBlobs.set(f, await this.repo.blobId(head, f));
      await this.writeWorking(
        res.changes,
        res.applied.map((a) => ({ id: a.item.id, appliedText: appliedText(a), edited: editedOf(a) })),
      );

      const decision = randomUUID();
      for (const a of res.applied) {
        const edited = editedOf(a);
        this.setStatus(a.item, "accepted", "user", undefined, decision);
        delete a.item.acceptFailed;
        delete a.item.draft;
        a.item.resolution = { appliedText: appliedText(a), edited, committed: null, headBlob: headBlobs.get(a.item.file) ?? null };
        await this.store.putItem(a.item);
        await this.store.appendEvent({
          type: "accepted", agent: a.item.agent, items: [a.item.id],
          data: { item: await this.describe(a.item), ...(edited ? { finalText: a.text } : {}) },
        });
      }
      await rm(this.journalPath, { force: true });
      for (const s of stale) await this.markStale(s, `overlaps accepted ${res.applied.find((a) => a.item.file === s.file)!.item.id}`);

      let committed: string | null = null;
      if (wantCommit) {
        if (dirtyBefore.size) warnings.push(`Not committed: ${[...dirtyBefore].join(", ")} had uncommitted edits of yours.`);
        else committed = await this.commitAccepted(res.applied.map((a) => a.item), [...res.changes.keys()]);
      }
      await this.updateGroups([...items, ...stale]);
      if (!missing.length) warnings.push(...(await this.partlyDecided(items)));
      // The review base is rebuilt lazily, when an agent next needs it (status, sync, submit):
      // rebuilding it here made every accept several git calls slower.
      const accepted = res.applied.map((a) => a.item).sort((a, b) => compareItemIds(a.id, b.id));
      return { accepted, stale, committed, warnings };
    });
  }

  /**
   * Commit message for accepted items: a summary line (the changeset titles, or the user's own
   * `subject`), then the accepted changes per changeset and a `Stet-Applied` trailer.
   */
  async commitMessage(items: Item[], subject?: string): Promise<{ subject: string; body: string }> {
    const byCs = new Map<string, Item[]>();
    for (const it of items) byCs.set(it.changeset, [...(byCs.get(it.changeset) ?? []), it]);
    const lines: string[] = [];
    const titles: string[] = [];
    for (const [csId, its] of byCs) {
      const cs = await this.store.getChangeset(csId);
      // Agent-written titles on one line, without control characters: tools that print `git log`
      // raw would run escape sequences (security report 5e4c6af, S13).
      const title = cs ? oneLine(cs.title, 200) : "";
      if (cs && !titles.includes(title)) titles.push(title);
      lines.push(`- ${cs ? `${title} (${cs.agent}, ${csId})` : csId}: ${its.map((i) => i.id).join(", ")}`);
    }
    const agents = [...new Set(items.map((i) => i.agent))].join(", ");
    let auto = titles.length === 1 ? titles[0]! : `Accept ${items.length} changes from ${agents}`;
    if (titles.length > 1 && titles.join("; ").length <= 60) auto = titles.join("; ");
    const ids = items.map((i) => i.id).join(",");
    return {
      subject: (subject && oneLine(subject, 200)) || auto,
      body: `Accepted in Stet review (${agents}):\n${lines.join("\n")}\n\nStet-Applied: ${ids}`,
    };
  }

  private async commitAccepted(items: Item[], paths: string[], subject?: string, yourEdits: string[] = []): Promise<string | null> {
    const msg = await this.commitMessage(items, subject);
    const body = yourEdits.length ? msg.body.replace(/\n\nStet-Applied:/, `\n\nAlso the reviewer's own edits in ${yourEdits.join(", ")}.\n\nStet-Applied:`) : msg.body;
    await this.repo.run(["add", "-A", "--", ...paths]);
    const r = await this.repo.tryRun(["commit", "-q", "--only", "-m", `${msg.subject}\n\n${body}`, "--", ...paths]);
    if (r === null) return null;
    const head = (await this.repo.revParse("HEAD"))!;
    for (const it of items) {
      it.resolution!.committed = head;
      await this.store.putItem(it);
    }
    return head;
  }

  /**
   * Reject items. For linked members, `mode` decides what happens to the rest of the group:
   * "all" rejects them too, "revise-rest" asks for revision, "only" breaks the group.
   */
  async reject(ids: string[], opts: { reason?: string; mode?: "all" | "revise-rest" | "only" } = {}): Promise<Item[]> {
    return this.store.withLock(async () => {
      const items = opts.mode === "only" ? await this.requireItems(ids) : await this.withMovePartners(await this.requireItems(ids));
      for (const it of items) if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
      const rest = (await this.linkedMembers(items)).filter((m) => !items.some((i) => i.id === m.id));
      if (rest.length && !opts.mode) {
        throw new StetError(
          `${items.map((i) => i.id).join(", ")} is linked with ${rest.map((m) => m.id).join(", ")}. ` +
            `Choose: reject all of them, reject this one and request revision of the rest, or reject only this one.`,
        );
      }
      const toReject = opts.mode === "all" ? [...items, ...rest] : items;
      const decision = randomUUID();
      for (const it of toReject) {
        this.setStatus(it, "rejected", "user", opts.reason, decision);
        delete it.draft;
        if (opts.reason) it.thread.push({ at: now(), author: "user", text: `Rejected: ${opts.reason}` });
        await this.store.putItem(it);
        await this.store.appendEvent({
          type: "rejected", agent: it.agent, items: [it.id],
          data: {
            item: await this.describe(it),
            ...(opts.reason ? { reason: opts.reason } : {}),
            ...(it.acceptFailed ? { acceptFailed: it.acceptFailed.reason } : {}),
          },
        });
      }
      if (opts.mode === "revise-rest") {
        for (const r of rest) {
          const text = `Linked item ${items.map((i) => i.id).join(", ")} was rejected${opts.reason ? `: ${opts.reason}` : ""}. Please revise.`;
          await this.requestRevisionLocked(r, text, decision);
        }
      }
      await this.updateGroups([...toReject, ...rest]);
      return toReject;
    });
  }

  /**
   * Undo the reviewer's decision on an item, together with the items decided with it (the rest of
   * its linked group or move): a revision request, a rejection, or an accept not committed yet, whose change is taken
   * out of the working copy again. The items are pending again, and so are items the accept made
   * stale. The agent is told. A committed accept is in git's history: revert it with git.
   */
  async undo(id: string): Promise<UndoResult> {
    return this.undoMany([id]);
  }

  /**
   * Undo the decisions of several changes at once, in one lock and one write: undoing an accept
   * of 400 changes one by one took 16 s (test report 5e4c6af, B5). Accepted changes are taken out
   * together; all of them, or none when one can't be.
   */
  async undoMany(ids: string[]): Promise<UndoResult> {
    return this.store.withLock(async () => {
      await this.recoverInterrupted();
      const items = await this.requireItems([...new Set(ids)]);
      for (const it of items) {
        if (it.status !== "accepted" && it.status !== "rejected" && it.status !== "needs_revision")
          throw new StetError(`${it.id} is ${it.status}: only accepted and rejected changes, and revision requests, can be undone.`);
      }
      const reopened = new Map<string, Item>();
      for (const item of items.filter((i) => i.status === "needs_revision")) {
        // A revision request the agent hasn't answered yet (an answer supersedes the change):
        // taken back, the change is pending again, and the agent is told (test report v0.16.0, B5).
        await this.reopen(item, "revision request taken back", "needs_revision");
        reopened.set(item.id, item);
      }
      for (const item of items.filter((i) => i.status === "rejected")) {
        // The revision requests this rejection sent to the rest of its linked group (reject
        // --revise-rest) are taken back too, unless the agent has answered them meanwhile.
        const unit = await this.decidedWith(item);
        const revised = (await this.sameDecision(item)).filter((i) => i.status === "needs_revision");
        for (const it of unit) if (it.status === "rejected") await this.reopen(it, "rejection undone", "rejected");
        for (const it of revised) if (it.status === "needs_revision") await this.reopen(it, "rejection of a linked change undone", "needs_revision");
        for (const it of [...unit, ...revised]) reopened.set(it.id, it);
      }
      const accepted = items.filter((i) => i.status === "accepted");
      if (!accepted.length) {
        await this.updateGroups([...reopened.values()]);
        return { reopened: [...reopened.values()], restored: [] };
      }
      const units = new Map<string, Item>();
      for (const item of accepted) if (!units.has(item.id)) for (const it of await this.decidedWith(item)) units.set(it.id, it);
      const unit = [...units.values()];
      const result = await this.undoAccepted(unit);
      if (reopened.size) await this.updateGroups([...reopened.values()]);
      return { reopened: [...reopened.values(), ...result.reopened], restored: result.restored };
    });
  }

  /** Take accepted changes (whole units, see `decidedWith`) out of the working copy. Call under lock. */
  private async undoAccepted(unit: Item[]): Promise<UndoResult> {
    {
      const committed = unit.find((i) => i.resolution?.committed);
      if (committed) {
        const c = committed.resolution!.committed!.replace(/^external:/, "");
        throw new StetError(`${committed.id} is committed already (${c.slice(0, 8)}): Stet can't undo it any more. Revert it with git if you need to.`);
      }
      const cfg = await this.config();
      const onBranch = await this.projectBranch();
      if (onBranch !== cfg.mainBranch)
        throw new StetError(`Your project folder is on '${onBranch ?? "a detached HEAD"}', not '${cfg.mainBranch}'. Switch back before undoing.`);

      // The inverse changes: from the applied text back to the old one. Each is found against its
      // base with what is accepted there made (this change, and the other accepted ones not
      // committed yet), as the working copy has it: text where nothing changed since is then
      // known for what it is, and another accepted change's same words are never taken for this
      // one's (test report v0.16.0, D1).
      const unitIds = new Set(unit.map((i) => i.id));
      const acceptedOthers = (await this.store.items()).filter(
        (o) => o.kind === "modify" && o.status === "accepted" && o.resolution && !o.resolution.committed && !unitIds.has(o.id),
      );
      const refs = new Map<string, string>();
      const inverse: Item[] = [];
      for (const it of unit) {
        const applied = it.resolution!.appliedText;
        if (it.kind === "modify") {
          const ref = (await this.refText(it)) ?? "";
          const sameText = (o: Item) => o.kind === "modify" && o.id !== it.id && o.file === it.file && o.baseCommit === it.baseCommit && !!o.resolution;
          const made = [it, ...unit.filter(sameText), ...acceptedOthers.filter(sameText)]
            .map((o) => ({ id: o.id, range: o.range, oldText: o.oldText, text: o.resolution!.appliedText }))
            .sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end);
          let after = "";
          let pos = 0;
          let start = it.range.start;
          for (const m of made) {
            // Changes that overlap another or no longer match their base are left out (this one never is).
            if (m.id !== it.id && (m.range.start < pos || ref.slice(m.range.start, m.range.end) !== m.oldText)) continue;
            if (m.id === it.id) start = after.length + (m.range.start - pos);
            after += ref.slice(pos, m.range.start) + m.text;
            pos = m.range.end;
          }
          after += ref.slice(pos);
          const range = { start, end: start + applied.length };
          refs.set(it.id, after);
          inverse.push({ ...it, oldText: applied, newText: it.oldText, range, context: captureContext(after, range.start, range.end) });
        } else if (it.kind === "add-file") inverse.push({ ...it, kind: "delete-file", oldText: applied, newText: "" });
        else if (it.kind === "delete-file") inverse.push({ ...it, kind: "add-file", oldText: "", newText: it.oldText });
        else if (it.kind === "rename-file") inverse.push({ ...it, file: it.oldFile!, oldFile: it.file, oldText: applied, newText: it.oldText });
        else {
          const { oldFile, ...rest } = it;
          inverse.push({ ...rest, ...(oldFile ? { file: oldFile, oldFile: it.file } : {}), oldBlob: it.newBlob ?? null, newBlob: it.oldBlob ?? null });
        }
      }
      const res = await applyItems(inverse, this.workingView(), {
        refText: async (i) => refs.get(i.id) ?? (await this.refText(i)),
      });
      if (res.failed.length) {
        throw new StetError(
          "Nothing was undone, because some changes are no longer as accepted (you edited them since?):\n" +
            res.failed.map((f) => `  ${f.item.id}: ${f.reason}`).join("\n"),
        );
      }
      await this.writeWorking(res.changes, unit.map((i) => ({ id: i.id, appliedText: "", edited: false })), true);
      for (const it of unit) await this.reopen(it, "accept undone", "accepted");
      await rm(this.journalPath, { force: true });

      // Items the accept made stale (`overlaps accepted <id>`) are pending again.
      const ids = new Set(unit.map((i) => i.id));
      const restored: Item[] = [];
      for (const it of await this.store.items()) {
        const last = it.history[it.history.length - 1];
        const by = last?.note?.match(/^overlaps accepted (\S+)$/)?.[1];
        if (it.status !== "stale" || !by || !ids.has(by)) continue;
        await this.reopen(it, `the accept of ${by} was undone`, "stale");
        restored.push(it);
      }
      await this.updateGroups([...unit, ...restored]);
      return { reopened: unit, restored };
    }
  }

  /**
   * An item and those decided together with it, in the same state: its move partners, its linked
   * unit, and the rest of its linked group decided in the same accept or reject. Accepting G1
   * whole and undoing one of its parts left a \label renamed without its \refs (test report
   * 2026-11-20, D2).
   */
  private async decidedWith(item: Item): Promise<Item[]> {
    const out = new Map<string, Item>([[item.id, item]]);
    const add = async (id: string) => {
      const it = await this.store.getItem(id);
      if (it && it.status === item.status && !out.has(it.id)) out.set(it.id, it);
    };
    for (const p of moveOthers(item)) await add(p);
    for (const gid of item.groups) {
      const g = await this.store.getGroup(gid);
      if (g?.kind === "linked") for (const m of linkedUnit(g, item.id)) await add(m);
    }
    for (const it of await this.sameDecision(item)) if (it.status === item.status) await add(it.id);
    return [...out.values()];
  }

  /** The other members of an item's linked groups whose last change of status came from the same decision. */
  private async sameDecision(item: Item): Promise<Item[]> {
    const decision = item.history[item.history.length - 1]?.decision;
    if (!decision) return [];
    const out = new Map<string, Item>();
    for (const gid of item.groups) {
      const g = await this.store.getGroup(gid);
      if (g?.kind !== "linked") continue;
      for (const id of g.items) {
        if (id === item.id || out.has(id)) continue;
        const it = await this.store.getItem(id);
        if (it && it.history[it.history.length - 1]?.decision === decision) out.set(id, it);
      }
    }
    return [...out.values()];
  }

  private async reopen(it: Item, note: string, was: ItemStatus): Promise<void> {
    this.setStatus(it, "pending", "user", note);
    it.resolution = null;
    delete it.acceptFailed;
    await this.store.putItem(it);
    await this.store.appendEvent({ type: "reopened", agent: it.agent, items: [it.id], data: { item: await this.describe(it), was } });
  }

  // -------------------------------------------------------------------------
  // PDF previews (§14)

  /** No builder for a language without previews. */
  private previews: { env: PreviewEnv; builder: PreviewBuilder | null } | null = null;

  /** What PDF previews can use here, and what is missing. Never installs or downloads anything. */
  async previewStatus(recheck = false): Promise<PreviewEnv> {
    if (!this.previews || recheck) {
      const cfg = (await this.config()).preview;
      const doc = documentProfile(await this.config());
      const env = doc.typesetter ? await detectPreviewEnv(cfg, doc.typesetter) : { status: "unavailable" as const, isolation: null, message: noPreviews(doc) };
      this.previews = { env, builder: doc.typesetter ? new PreviewBuilder(this.repo, join(this.store.root, "previews"), cfg, env, doc) : null };
    }
    return this.previews.env;
  }

  /** Build the container image previews run in. It downloads packages: call it only on the user's request. */
  async setupPreview(opts: { extras?: boolean } = {}): Promise<{ ok: boolean; log: string; status: PreviewEnv }> {
    const doc = documentProfile(await this.config());
    const r = doc.typesetter ? await setupPreviewImage((await this.config()).preview, doc.typesetter, opts) : { ok: false, log: noPreviews(doc) };
    if (r.ok && opts.extras) {
      // From now on the image with the extra fonts.
      await this.store.withLock(async () => {
        const cfg = await this.config();
        await this.store.saveConfig(validateConfig({ ...cfg, preview: { ...cfg.preview, texExtras: true } }));
      });
    }
    // Previews built before (failed ones included) were made with the old image.
    if (r.ok) await rm(join(this.store.root, "previews"), { recursive: true, force: true });
    return { ...r, status: await this.previewStatus(true) };
  }

  /**
   * The region of the compiled paper where a change lands, before and after (as images in the
   * preview cache). Text changes in .tex files only; slow (it compiles), so callers show the
   * change first and the preview once it is ready.
   */
  async preview(id: string): Promise<PreviewResult> {
    const item = await this.store.getItem(id.toUpperCase());
    if (!item) throw new StetError(`Unknown item '${id}'.`);
    await this.previewStatus();
    const cfg = await this.config();
    // Changes to the text of the document's own source files (the typesetter's: .tex files).
    const doc = documentProfile(cfg);
    if (!doc.typesetter) return { status: "no-spot", message: noPreviews(doc) };
    const isTex = (i: Item) => i.kind === "modify" && this.profile(cfg, i.file) === doc && !!doc.typesetter?.source.test(i.file);
    if (!isTex(item)) return { status: "no-spot", message: `Only changes to the text of ${doc.typesetter?.sourceName ?? "the document's source files"} have a PDF preview.` };
    const change = async (i: Item): Promise<PreviewChange | null> => {
      const t = await this.textAt(i.baseCommit, i.file);
      return t && { file: i.file, baseText: t.text, eol: t.eol, range: i.range, newText: i.newText };
    };
    // Apply what accepting it would apply: one end of a move or of a linked part alone can leave
    // the document broken (\begin{proof} without its \end, bug report 2026-11-19).
    const together = (list: Item[]) => list.filter((i) => i.id !== item.id && isTex(i) && i.baseCommit === item.baseCommit);
    const unit = isLive(item.status) ? together(await this.linkedMembers(await this.withMovePartners([item]))) : [];
    const request = async (others: Item[], tag: string): Promise<PreviewRequest | null> => {
      const changes = [await change(item), ...(await Promise.all(others.map(change)))];
      if (changes.some((c) => !c)) return null;
      const sig = changes.map((c) => `${c!.file}:${c!.range.start}:${c!.range.end}:${c!.newText}`).join("\u0000");
      return { base: item.baseCommit, key: `${item.id}${tag}-${sha256(sig).slice(0, 12)}`, changes: changes as PreviewChange[], target: 0 };
    };
    const first = await request(unit, "");
    if (!first) return { status: "no-spot", message: `${item.file} isn't in the text this change was proposed against.` };
    const list = (xs: Item[]) => xs.map((i) => i.id).join(", ");
    // Tried in turn, until one compiles without new errors: the change with what is accepted with
    // it; plus the changes of its round that complete it (an environment opened in one change and
    // closed in another, bug report 2026-11-19); its whole round. Else the best of them.
    const round = together((await this.store.items()).filter((i) => i.changeset === item.changeset && isLive(i.status)));
    const pair = completing(item, round.filter((i) => !unit.includes(i)), (f) => this.profile(cfg, f));
    const tries: { others: Item[]; tag: string; note: (x: Item[]) => string }[] = [
      { others: unit, tag: "", note: (x) => `Shown together with ${list(x)}, which ${x.length === 1 ? "is" : "are"} accepted with it.` },
      ...(pair.length ? [{ others: [...unit, ...pair], tag: "-pair", note: (x: Item[]) => `On its own this change breaks the document, so it is shown with ${list(x)}, which complete${x.length === 1 ? "s" : ""} it. Accept them together.` }] : []),
      ...(round.length > unit.length + pair.length ? [{ others: round, tag: "-round", note: (x: Item[]) => `On its own this change breaks the document, so it is shown with the rest of its round (${list(x)}).` }] : []),
    ];
    let best: { r: PreviewResult; note: string } | null = null;
    const errors = (x: PreviewResult) => (x.status === "ready" ? (x.warning?.count ?? 0) : Infinity);
    for (const t of tries) {
      const req = t === tries[0] ? first : await request(t.others, t.tag);
      if (!req) continue;
      const r = await this.previews!.builder!.preview(req);
      if (r.status !== "ready" && (r.status !== "failed" || r.cause !== "change")) return r; // the base itself, or no spot
      const note = t.others.length ? t.note(t.others) : "";
      if (!best || errors(r) < errors(best.r)) best = { r, note };
      if (r.status === "ready" && !r.warning) break;
    }
    const r = best!.r;
    if (r.status !== "ready") return tries.length > 1 ? { ...r, message: `${r.message} Not together with the other changes of its round either.` } : r;
    return best!.note ? { ...r, note: best!.note } : r;
  }

  // -------------------------------------------------------------------------
  // Review document of a file

  /**
   * `text` (the reviewer's current text of `file`, LF) with every pending change to it applied, in
   * the reviewer's wording where they have one, and where each change is in the result. `only`:
   * just these changes (the review of one change, with what accepting it takes along).
   */
  async reviewOf(file: string, text: string, only?: string[]): Promise<ReviewDocument & { items: Item[] }> {
    const items = (await this.store.items()).filter((i) => i.file === file && i.kind === "modify" && isLive(i.status) && (!only || only.includes(i.id)));
    const changes: ReviewChange[] = [];
    const unplaced: string[] = [];
    for (const it of items) {
      const span = await this.anchorItem(it, text);
      if (span) changes.push({ id: it.id, start: span.start, end: span.end, text: it.draft ?? it.newText });
      else unplaced.push(it.id);
    }
    const doc = reviewDocument(text, changes);
    return { ...doc, skipped: [...doc.skipped, ...unplaced], items };
  }

  /**
   * The reviewer saved the review document `doc` as `edited`: their edits become their wording for
   * those changes, which stay pending. Returns the changes whose wording changed, or an error.
   */
  async saveReview(doc: ReviewDocument, edited: string): Promise<{ changed: string[] } | { error: string }> {
    const mapped = mapReviewEdits(doc, toLf(edited));
    if ("error" in mapped) return mapped;
    return this.store.withLock(async () => {
      // Changes that grew over words reworded next to them: the same change, written wider
      // (old and new text both take in those words), if the words are as the change's base has them.
      const wider = new Map<string, Item>();
      for (const [id, g] of mapped.grown) {
        const it = await this.store.getItem(id);
        if (!it || !isLive(it.status)) continue;
        const r = doc.regions.find((x) => x.id === id)!;
        const before = doc.content.slice(r.start - g.before, r.start);
        const after = doc.content.slice(r.end, r.end + g.after);
        const ref = await this.refText(it);
        const { start, end } = it.range;
        if (it.kind !== "modify" || it.move || ref === undefined || ref.slice(start - before.length, start) !== before || ref.slice(end, end + after.length) !== after) {
          return { error: `You reworded text next to ${id} that you changed yourself since: edit that in your file itself, or only ${id}'s own words here.` };
        }
        const range = { start: start - before.length, end: end + after.length };
        wider.set(id, { ...it, range, oldText: before + it.oldText + after, newText: before + it.newText + after, context: captureContext(ref, range.start, range.end) });
      }
      const changed: string[] = [];
      for (const [id, text] of mapped.texts) {
        const it = wider.get(id) ?? (await this.store.getItem(id));
        if (!it || !isLive(it.status)) continue;
        const shown = it.draft ?? it.newText;
        if (text === shown && !wider.has(id)) continue;
        if (text === it.newText) delete it.draft;
        else it.draft = text;
        await this.store.putItem(it);
        changed.push(id);
      }
      return { changed };
    });
  }

  /**
   * The reviewer's wording for a pending change, without accepting it (accepting later uses it).
   * The agent's own text drops the wording. Returns whether anything changed.
   */
  async setDraft(id: string, text: string): Promise<boolean> {
    return this.store.withLock(async () => {
      const it = await this.store.getItem(id.toUpperCase());
      if (!it) throw new StetError(`Unknown change '${id}'.`);
      if (it.kind !== "modify") throw new StetError(`${it.id} changes a whole file; it can only be accepted or rejected.`);
      if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status} already; there is no wording to change.`);
      const lf = toLf(text);
      if (lf === (it.draft ?? it.newText)) return false;
      if (lf === it.newText) delete it.draft;
      else it.draft = lf;
      await this.store.putItem(it);
      return true;
    });
  }

  /** Drop the reviewer's wording for a change: the agent's text again. */
  async clearDraft(id: string): Promise<void> {
    await this.store.withLock(async () => {
      const it = await this.store.getItem(id.toUpperCase());
      if (!it || it.draft === undefined) return;
      delete it.draft;
      await this.store.putItem(it);
    });
  }

  /** Another page of a built preview (the page viewer scrolled on), or null. */
  async previewPage(base: string, key: string, version: "after" | "before", n: number): Promise<{ file: string; width: number; height: number } | null> {
    await this.previewStatus();
    return this.previews!.builder?.page(base, key, version, n) ?? null;
  }

  /** Choose which kinds of news wake an agent (see `NotifyTrigger`). Returns false if unchanged. */
  async setNotifyOn(agentId: string, triggers: NotifyTrigger[]): Promise<boolean> {
    const bad = triggers.filter((t) => !NOTIFY_TRIGGERS.includes(t));
    if (bad.length) throw new StetError(`Unknown kind of news: ${bad.join(", ")} (use ${NOTIFY_TRIGGERS.join(", ")}).`);
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      const next = NOTIFY_TRIGGERS.filter((t) => triggers.includes(t));
      if (next.join() === notifyTriggers(agent).join()) return false;
      if (next.length === NOTIFY_TRIGGERS.length) delete agent.notifyOn;
      else agent.notifyOn = next;
      await this.store.putAgent(agent);
      return true;
    });
  }

  /** *Notify now*: wake an agent waiting with `stet watch`, whatever its notification settings. */
  async pingAgent(agentId: string, message?: string): Promise<void> {
    const agent = await this.requireAgent(agentId);
    if (agent.state !== "active") throw new StetError(`Agent ${agentId} is archived.`);
    if (!(await pathExists(agent.worktree))) throw new StetError(`The workspace of ${agentId} no longer exists.`);
    await pingInbox(agent.worktree, message);
  }

  /** Set how an agent hears about the reviewer's activity (see `NotifyMode`). Returns false if unchanged. */
  async setNotify(agentId: string, mode: NotifyMode): Promise<boolean> {
    if (!NOTIFY_MODES.includes(mode)) throw new StetError(`Unknown notification mode '${mode}' (use ${NOTIFY_MODES.join(", ")}).`);
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      if (notifyMode(agent) === mode) return false;
      agent.notify = mode;
      await this.store.putAgent(agent);
      return true;
    });
  }

  private async requestRevisionLocked(it: Item, text: string, decision?: string) {
    this.setStatus(it, "needs_revision", "user", undefined, decision);
    it.thread.push({ at: now(), author: "user", text });
    await this.store.putItem(it);
    await this.store.appendEvent({ type: "revision_requested", agent: it.agent, items: [it.id], data: { item: await this.describe(it), comment: text } });
  }

  async requestRevision(id: string, text: string): Promise<Item> {
    return this.store.withLock(async () => {
      const [it] = await this.requireItems([id]);
      if (!isLive(it!.status)) throw new StetError(`${it!.id} is ${it!.status}, not pending.`);
      await this.requestRevisionLocked(it!, text);
      return it!;
    });
  }

  async comment(id: string, text: string, author: "user" | "agent" = "user"): Promise<Item> {
    return this.store.withLock(async () => {
      const [it] = await this.requireItems([id]);
      it!.thread.push({ at: now(), author, text });
      await this.store.putItem(it!);
      await this.store.appendEvent({
        type: author === "user" ? "comment" : "reply", agent: it!.agent, items: [it!.id],
        data: { item: await this.describe(it!), text },
      });
      return it!;
    });
  }

  async withdraw(agentId: string, ids: string[], reason?: string): Promise<Item[]> {
    return this.store.withLock(async () => {
      const items = await this.requireItems(ids);
      for (const it of items) {
        if (it.agent !== agentId) throw new StetError(`${it.id} belongs to ${it.agent}.`);
        if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
        this.setStatus(it, "withdrawn", "agent", reason);
        await this.store.putItem(it);
        await this.store.appendEvent({ type: "withdrawn", agent: agentId, items: [it.id], data: reason ? { reason } : {} });
      }
      await this.dissolveMoves(items, new Map(items.map((i) => [i.id, i])));
      await this.updateGroups(items);
      return items;
    });
  }

  // -------------------------------------------------------------------------
  // Grouping after submit (§6.4)

  async group(
    agentId: string | null,
    ids: string[],
    kind: GroupKind,
    title: string,
    rationale?: string,
    parts?: { title: string; items: string[] }[],
    reason?: string,
  ): Promise<{ group: Group | null; merged: Item | null; warnings: string[] }> {
    return this.store.withLock(async () => {
      if (parts?.length && kind !== "linked") throw new StetError("Only linked groups have parts.");
      const partList = (parts ?? []).map((p) => ({ title: p.title, items: p.items.map((i) => i.toUpperCase()) }));
      for (const p of partList) for (const i of p.items) if (!ids.some((x) => x.toUpperCase() === i)) ids = [...ids, i];
      const items = await this.requireItems(ids);
      if (items.length < 2) throw new StetError("A group needs at least two items.");
      const agent = items[0]!.agent;
      for (const it of items) {
        if (agentId && it.agent !== agentId) throw new StetError(`${it.id} belongs to ${it.agent}.`);
        if (it.agent !== agent) throw new StetError("All items of a group must come from the same agent.");
        if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
      }
      if (kind === "atomic") return { group: null, merged: await this.mergeAtomic(items, title, rationale), warnings: [] };
      // An agent's linked group needs a dependency Stet can see, or a reason (§6.4.6).
      if (kind === "linked" && agentId && !reason) {
        const units = partList.length ? [...partList.map((p) => p.items), items.map((i) => i.id).filter((i) => !partList.some((p) => p.items.includes(i)))].filter((u) => u.length) : undefined;
        const comps = await this.dependencies(items, units);
        if (comps.length > 1) throw new StetError(unlinkedRefusal(comps));
      }
      if (reason) rationale = `Linked because: ${reason}${rationale ? `\n\n${rationale}` : ""}`;
      const [gid] = await this.store.allocate("group");
      const group: Group = {
        id: gid!, agent, changeset: items[0]!.changeset, kind, title, rationale: rationale ?? null, source: "agent",
        items: items.map((i) => i.id), ...(partList.length ? { parts: partList } : {}), state: "open",
      };
      const warnings: string[] = [];
      if (kind === "linked") {
        for (const pg of (await this.store.groups()).filter((g) => g.kind === "linked" && g.items.some((i) => group.items.includes(i)))) {
          const merged = combineParts(pg, group);
          if (merged) group.parts = merged;
          for (const i of pg.items) if (!group.items.includes(i)) group.items.push(i);
          group.title = joinTitles(pg.title, group.title);
          await this.store.deleteGroup(pg.id);
          for (const i of pg.items) {
            const it = await this.store.getItem(i);
            if (it) {
              it.groups = it.groups.filter((x) => x !== pg.id);
              await this.store.putItem(it);
            }
          }
        }
      }
      for (const i of group.items) {
        const it = await this.store.getItem(i);
        if (it && !it.groups.includes(group.id)) {
          it.groups.push(group.id);
          await this.store.putItem(it);
        }
      }
      warnings.push(...(await this.settleParts(group, async (i) => (await this.store.getItem(i)) ?? undefined)));
      await this.store.putGroup(group);
      const cs = await this.store.getChangeset(group.changeset);
      if (cs && !cs.groups.includes(group.id)) {
        cs.groups.push(group.id);
        await this.store.putChangeset(cs);
      }
      return { group, merged: null, warnings };
    });
  }

  private async mergeAtomic(items: Item[], title: string, rationale?: string): Promise<Item> {
    const first = items[0]!;
    if (items.some((i) => i.kind !== "modify" || i.file !== first.file || i.baseCommit !== first.baseCommit))
      throw new StetError("Atomic groups need text edits in the same file.");
    const sorted = [...items].sort((a, b) => a.range.start - b.range.start);
    const bt = (await this.refText(first)) ?? "";
    const start = sorted[0]!.range.start;
    const end = sorted[sorted.length - 1]!.range.end;
    // Only the text between the edits counts: an edit that itself crosses a paragraph break is one
    // item already, and merging it with an edit right next to it splits nothing that was together.
    if (sorted.some((it, k) => k > 0 && /\n[ \t]*\n/.test(bt.slice(sorted[k - 1]!.range.end, it.range.start))))
      throw new StetError("Atomic groups must stay within one paragraph; use a linked group instead.");
    let newText = "";
    let pos = start;
    for (const it of sorted) {
      newText += bt.slice(pos, it.range.start) + it.newText;
      pos = it.range.end;
    }
    newText += bt.slice(pos, end);
    // The merged change joins its round under the next free number.
    const taken = (await this.store.items()).filter((i) => i.changeset === first.changeset).map((i) => numberInRound(i.id) ?? 0);
    const id = itemId(first.changeset, Math.max(0, ...taken) + 1);
    const merged: Item = {
      ...first,
      id: id!,
      range: { start, end },
      oldText: bt.slice(start, end),
      newText,
      context: captureContext(bt, start, end),
      fingerprint: this.fingerprint({ file: first.file, kind: "modify", oldText: bt.slice(start, end), newText }),
      note: rationale ? `${title}: ${rationale}` : title,
      groups: [...new Set(items.flatMap((i) => i.groups))],
      supersedes: sorted.map((i) => i.id).join(","),
      conflictsWith: [...new Set(items.flatMap((i) => i.conflictsWith))],
      history: [{ at: now(), status: "pending", by: "agent" }],
      thread: items.flatMap((i) => i.thread),
      status: "pending",
    };
    for (const it of items) {
      this.setStatus(it, "superseded", "agent", `merged into ${merged.id}`);
      await this.store.putItem(it);
    }
    await this.store.putItem(merged);
    for (const gid of merged.groups) {
      const g = await this.store.getGroup(gid);
      if (!g) continue;
      g.items = [...g.items.filter((i) => !items.some((x) => x.id === i)), merged.id];
      // The merged item replaces its originals in their parts; parts it now spans are joined.
      if (g.parts) {
        g.parts = g.parts.map((p) => ({ ...p, items: [...new Set(p.items.map((i) => (items.some((x) => x.id === i) ? merged.id : i)))] }));
        await this.settleParts(g, async (i) => (await this.store.getItem(i)) ?? undefined);
      }
      await this.store.putGroup(g);
    }
    const cs = await this.store.getChangeset(merged.changeset);
    if (cs) {
      cs.items.push(merged.id);
      await this.store.putChangeset(cs);
    }
    return merged;
  }

  async ungroup(groupId: string, agentId?: string): Promise<void> {
    await this.store.withLock(async () => {
      const g = await this.store.getGroup(groupId.toUpperCase());
      if (!g) throw new StetError(`Unknown group '${groupId}'.`);
      if (agentId && g.agent !== agentId) throw new StetError(`${g.id} belongs to ${g.agent}.`);
      for (const i of g.items) {
        const it = await this.store.getItem(i);
        if (it) {
          it.groups = it.groups.filter((x) => x !== g.id);
          await this.store.putItem(it);
        }
      }
      const cs = await this.store.getChangeset(g.changeset);
      if (cs) {
        cs.groups = cs.groups.filter((x) => x !== g.id);
        await this.store.putChangeset(cs);
      }
      await this.store.deleteGroup(g.id);
    });
  }

  // -------------------------------------------------------------------------
  // Reviewer notes (§7.8)

  /**
   * Leave a note for an agent on a passage of `file`: an offset range, or 1-based lines. `text`
   * is the file as the reviewer sees it (e.g. an editor with unsaved edits); default: the file on disk.
   */
  async addNote(
    agentId: string,
    where: { file: string; start?: number; end?: number; fromLine?: number; toLine?: number; text?: string },
    body: string,
  ): Promise<Note> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      if (agent.state !== "active") throw new StetError(`Agent ${agent.id} is archived.`);
      if (!body.trim()) throw new StetError("The note is empty.");
      const file = where.file.replace(/\\/g, "/");
      if (!isSafeRepoPath(file)) throw new StetError(`'${where.file}' is not a file in the project.`);
      const text = where.text !== undefined ? toLf(where.text) : (await this.workingView().read(file))?.text;
      if (text === undefined) throw new StetError(`${file} does not exist.`);
      let { start, end } = where;
      if (start === undefined || end === undefined) {
        const from = where.fromLine ?? 1;
        const to = Math.max(from, where.toLine ?? from);
        ({ start, end } = lineRange(text, from, to));
        if (end > start && text[end - 1] === "\n") end--;
      }
      if (start < 0 || end > text.length || start > end) throw new StetError("The passage is outside the file.");
      const [id] = await this.store.allocate("note");
      const note: Note = {
        id: id!, agent: agent.id, file, text: text.slice(start, end), range: { start, end }, context: captureContext(text, start, end),
        body: body.trim(), createdAt: now(), state: "open", deliveredAt: null, thread: [],
      };
      await this.store.putNote(note);
      await this.store.appendEvent({ type: "note_added", agent: agent.id, data: { note: note.id, file } });
      return note;
    });
  }

  listNotes = (filter: { agent?: string; state?: Note["state"] } = {}) =>
    this.store.notes().then((ns) => ns.filter((n) => (!filter.agent || n.agent === filter.agent) && (!filter.state || n.state === filter.state)));

  async getNote(id: string): Promise<Note> {
    const n = await this.store.getNote(id.trim().toUpperCase());
    if (!n) throw new StetError(`Unknown note '${id}'.`);
    return n;
  }

  /** Where a note's passage is in `text` (LF), e.g. an editor buffer. */
  locateNoteInText(note: Note, text: string): Span | null {
    return anchor({ oldText: note.text, range: note.range, context: note.context }, text);
  }

  /** A reply in a note's thread: the reviewer's reaches the agent as feedback once the note was delivered. */
  async replyNote(id: string, text: string, author: "user" | "agent"): Promise<Note> {
    return this.store.withLock(async () => {
      const n = await this.getNote(id);
      if (!text.trim()) throw new StetError("The reply is empty.");
      n.thread.push({ at: now(), author, text: text.trim() });
      await this.store.putNote(n);
      await this.store.appendEvent({ type: author === "user" ? "note_comment" : "note_reply", agent: n.agent, data: { note: n.id, file: n.file, text: text.trim() } });
      return n;
    });
  }

  async resolveNote(id: string): Promise<Note> {
    return this.store.withLock(async () => {
      const n = await this.getNote(id);
      if (n.state === "resolved") return n;
      n.state = "resolved";
      await this.store.putNote(n);
      await this.store.appendEvent({ type: "note_resolved", agent: n.agent, data: { note: n.id, file: n.file } });
      return n;
    });
  }

  /** Open a resolved note again (from History): the agent is told, if it had it already. */
  async reopenNote(id: string): Promise<Note> {
    return this.store.withLock(async () => {
      const n = await this.getNote(id);
      if (n.state === "open") return n;
      n.state = "open";
      await this.store.putNote(n);
      await this.store.appendEvent({ type: "note_reopened", agent: n.agent, data: { note: n.id, file: n.file } });
      return n;
    });
  }

  /** Hand the agent its open, undelivered notes, located in its workspace as it is now. Under the lock. */
  private async deliverNotes(agent: Agent): Promise<DeliveredNote[]> {
    const waiting = (await this.store.notes()).filter((n) => n.agent === agent.id && n.state === "open" && !n.deliveredAt);
    const out: DeliveredNote[] = [];
    for (const n of waiting) {
      const buf = isSafeRepoPath(n.file) ? await readInside(agent.worktree, n.file).catch(() => null) : null;
      const text = buf ? toLf(buf.toString("utf8")) : null;
      const span = text !== null ? this.locateNoteInText(n, text) : null;
      const lines = span && text !== null ? { from: lineOf(text, span.start), to: lineOf(text, Math.max(span.start, span.end - 1)) } : null;
      n.deliveredAt = now();
      await this.store.putNote(n);
      out.push({ note: n, lines });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Feedback (§10)

  async feedback(agentId: string, opts: { ack?: boolean } = {}): Promise<StetEvent[]> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      const all = await this.store.events(agent.feedbackCursor);
      const notes = new Map((await this.store.notes()).map((n) => [n.id, n]));
      // Note events before the note was delivered are part of the delivery itself (§7.8).
      const early = (e: StetEvent) => {
        if (e.type !== "note_comment" && e.type !== "note_resolved" && e.type !== "note_reopened") return false;
        const n = notes.get(String(e.data?.note ?? ""));
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
}
