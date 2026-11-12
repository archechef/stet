/** Stet service layer (spec §7, §12.1). All frontends go through this class. */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { applyItems, locate, overlaps, type FileChange, type FileView, type TextFile } from "./apply.js";
import { anchor, captureContext, type Span } from "./anchor.js";
import { matchesAny, validateConfig, type StetConfig } from "./config.js";
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
  parsePartId,
  partId,
  type Agent,
  type AgentKind,
  type Changeset,
  type Group,
  type GroupKind,
  type GroupPart,
  type Item,
  type ItemStatus,
  type Note,
  type StetEvent,
} from "./model.js";
import { describeNote, type DeliveredNote } from "./notes.js";
import { combineParts, settleParts, type PartDraft } from "./parts.js";
import { isKeyEdit, splitText, type Edit, type FileClass } from "./split.js";
import { Store, writeJsonAtomic } from "./store.js";
import { inspect, prepare, readInside, replaceFile, UnsafePathError, writeInside, type Target } from "./safefs.js";
import { archivedMessage, STET_MARKER } from "./instructions.js";
import { installHooks } from "./hooks.js";
import { isWorkspaceFile, writeWorkspaceFiles, type CliCommand, type WorkspaceResult } from "./workspace.js";
import { isInside, pathExists, samePath } from "./paths.js";
import { StetError } from "./errors.js";
import { AgentFiles } from "./agentfiles.js";
import { verifyAgentWorktree } from "./worktree.js";
import { detectEol, fromLf, isBinary, isSafeRepoPath, lineOf, lineRange, normalizeWs, sha256, toLf } from "./text.js";

export { StetError };

export const BASE_REF = "refs/stet/base";
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
}

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
    const top = await probe.tryRun(["rev-parse", "--show-toplevel"]);
    if (!top) throw new StetError(`Not inside a git repository: ${cwd}`);
    let common = await probe.run(["rev-parse", "--git-common-dir"]);
    if (!isAbsolute(common)) common = resolve(cwd, common);
    const main = (await probe.worktrees())[0]?.path ?? top;
    return { repo: new Repo(main), mainPath: main, commonDir: common, toplevel: top };
  }

  static async open(cwd: string): Promise<Stet> {
    const { repo, mainPath, commonDir } = await Stet.locate(cwd);
    const store = new Store(join(commonDir, "stet"));
    if (!(await store.exists())) throw new StetError("Stet is not set up in this repository. Run `stet init` in the project folder.");
    return new Stet(mainPath, repo, store);
  }

  static async init(cwd: string, opts: { mainBranch?: string; cli?: CliCommand } = {}): Promise<Stet> {
    const { repo, mainPath, commonDir } = await Stet.locate(cwd);
    const branch = opts.mainBranch ?? (await repo.tryRun(["symbolic-ref", "--short", "HEAD"]));
    if (!branch) throw new StetError("Can't determine the main branch (detached HEAD?). Pass --main <branch>.");
    if (!(await repo.revParse(`refs/heads/${branch}`)))
      throw new StetError(`Branch '${branch}' has no commits yet. Commit your document first, then run \`stet init\`.`);
    const store = new Store(join(commonDir, "stet"));
    await store.init(branch);
    const stet = new Stet(mainPath, repo, store);
    await store.withLock(async () => {
      const cfg = await store.config();
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

  private fileClass(cfg: StetConfig, path: string): FileClass {
    if (matchesAny(path, cfg.files.tex)) return "tex";
    if (matchesAny(path, cfg.files.bib)) return "bib";
    return "text";
  }

  /** Cached reads of blobs at commits. */
  private textCache = new Map<string, TextFile | null>();
  private async textAt(rev: string, path: string): Promise<TextFile | null> {
    const key = rev + ":" + path;
    if (!this.textCache.has(key)) this.textCache.set(key, await this.repo.readText(rev, path));
    return this.textCache.get(key)!;
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
  private async writeWorking(changes: Map<string, FileChange>, resolutions: AcceptJournal["items"]): Promise<void> {
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
    const journal: AcceptJournal = { items: resolutions, filesDone: false, files: [] };
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
    if (j.filesDone) {
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

  private setStatus(item: Item, status: ItemStatus, by: "user" | "agent" | "stet", note?: string) {
    item.status = status;
    item.history.push({ at: now(), status, by, ...(note ? { note } : {}) });
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
        if (f && anchor({ ...it, newText: it.resolution!.appliedText }, f.text, await this.refText(it))) toApply.push(it);
      }
    }
    const key = head + ":" + (shared ?? "") + ":" + toApply.map((i) => i.id).join(",");
    const state = await this.store.state();
    const current = await this.repo.revParse(BASE_REF);
    if (state.base?.key === key && current === state.base.commit) return current;

    let commit = head;
    if (toApply.length || shared) {
      const from = shared ?? head;
      const res = await applyItems(toApply, this.treeView(from), {
        refText: this.refText,
        overrides: new Map(toApply.map((i) => [i.id, i.resolution!.appliedText])),
      });
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
    s.base = { key, commit };
    await this.store.saveState(s);
    return commit;
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
    const since = await this.repo.tryRun(["rev-list", "-1", `--since=${acceptedAt(it)}`, head, "--", it.file]);
    if (since) return true;
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
        .filter((p) => p && isSafeRepoPath(p) && this.fileClass(cfg, p) !== "text");
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
      if (await this.store.getAgent(id)) throw new StetError(`Agent '${id}' already exists.`);
      const cfg = await this.config();
      const branch = cfg.agentBranchPrefix + id;
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
    return writeWorkspaceFiles({ agent, mainPath: this.mainPath, commonDir: this.commonDir, gitDir, cli: cfg.cli });
  }

  /** The agent whose worktree contains `cwd`; adopts matching worktrees made by other tools. */
  async agentForCwd(cwd: string): Promise<Agent> {
    const wt = new Repo(cwd, this.untrustedConfig);
    const top = await wt.tryRun(["rev-parse", "--show-toplevel"]);
    const branch = await wt.tryRun(["symbolic-ref", "--short", "HEAD"]);
    const cfg = await this.config();
    if (!top || !branch || !branch.startsWith(cfg.agentBranchPrefix)) {
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
  async archiveAgent(id: string, opts: { removeWorktree?: boolean } = {}): Promise<{ agent: Agent; withdrawn: string[]; worktreeRemoved: boolean }> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(id);
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
    const out: AgentStatus[] = [];
    for (const agent of agents) {
      const counts: Partial<Record<ItemStatus, number>> = {};
      for (const it of items) if (it.agent === agent.id) counts[it.status] = (counts[it.status] ?? 0) + 1;
      const unread = events.filter((e) => e.seq > agent.feedbackCursor && e.agent === agent.id && FEEDBACK_TYPES.includes(e.type)).length;
      const syncNeeded = agent.baseCommit !== base && (await tree(agent.baseCommit)) !== (await tree(base));
      const notesWaiting = notes.filter((n) => n.agent === agent.id && n.state === "open" && !n.deliveredAt).length;
      out.push({ agent, mainBranch: cfg.mainBranch, base, syncNeeded, counts, unreadFeedback: unread, notesWaiting });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Submit (§7.2, §6.3, §6.4)

  private async candidatesFor(cfg: StetConfig, base: string, tip: string, touched: Set<string>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const changes = await this.repo.diffNames(base, tip);
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
      const binary = (oldBuf && isBinary(oldBuf)) || (newBuf && isBinary(newBuf));
      const oldText = oldBuf ? toLf(oldBuf.toString("utf8")) : "";
      const newText = newBuf ? toLf(newBuf.toString("utf8")) : "";
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
        out.push({
          ...whole("binary"),
          oldBlob: oldBuf ? await this.repo.blobId(base, oldPath) : null,
          newBlob: newBuf ? await this.repo.blobId(tip, ch.path) : null,
        });
      } else if (ch.status === "A") out.push(whole("add-file"));
      else if (ch.status === "D") out.push(whole("delete-file"));
      else if (ch.status === "R") out.push(whole("rename-file"));
      else {
        for (const e of splitText(this.fileClass(cfg, ch.path), oldText, newText, cfg.split)) {
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
        changeset: null, items: [], groups: [], ungrouped: [], superseded: [], withdrawn: [], repeats: [], warnings: [], sync: null,
      };

      if (tip !== agent.lastTip) {
        await this.itemize(cfg, agent, tip, opts, result);
        agent.lastTip = tip;
        await this.store.putAgent(agent);
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
    for (const ch of await this.repo.diffNames(agent.lastTip, tip)) {
      touched.add(ch.path);
      if (ch.oldPath) touched.add(ch.oldPath);
    }
    let cands = await this.candidatesFor(cfg, base, tip, touched);
    const allItems = await this.store.items();
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
      if (where.from === undefined) return { file: where.file, range: null };
      const t = await this.textAt(tip, where.file);
      if (!t) return { file: where.file, range: { start: -1, end: -1 } };
      return { file: where.file, range: lineRange(t.text, where.from, where.to!) };
    };
    const unit = (c: Candidate, key: string): HintUnit => ({
      key, file: c.file, ...(c.oldFile ? { oldFile: c.oldFile } : {}), wholeFile: c.kind !== "modify", newStart: c.newStart, newEnd: c.newEnd,
    });
    const hintMatches = async (where: string[], pool: Candidate[]) => {
      const out = new Set<Candidate>();
      for (const w of where) {
        const { file, range } = await tipRange(w);
        const hits = pool.filter((c) => unitMatches(unit(c, ""), file, range));
        if (!hits.length) result.warnings.push(`'${w}' matched no change.`);
        hits.forEach((h) => out.add(h));
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
      const keyEdits = matchedC.filter((c) => isKeyEdit(c.oldText, c.newText));
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
    const rejected = new Map(allItems.filter((i) => i.status === "rejected").map((i) => [i.fingerprint, i]));
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
        ...(c.kind === "binary" ? { oldBlob: c.oldBlob ?? null, newBlob: c.newBlob ?? null } : {}),
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
    const inherited: { from: Item; to: Item }[] = [];
    for (const [e, c] of replacedBy) {
      const item = created[fresh.indexOf(c)]!;
      item.supersedes ??= e.id;
      inherited.push({ from: e, to: item });
      this.setStatus(e, "superseded", "agent", `superseded by ${item.id}`);
      await this.store.putItem(e);
      result.superseded.push(e.id);
    }

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
    const idOfCand = (c: Candidate) => itemOf.get(c)?.id ?? matched.get(c)?.id;
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
      if (members.length) drafts.push({ kind: h.kind, title: h.title, rationale: h.rationale ?? null, source: "agent", items: members, ...(parts ? { parts } : {}) });
    }
    // Auto-detection also sees the agent's earlier pending items (a \label here, its \ref from before).
    const newIds = new Set(created.map((i) => i.id));
    const earlier = (await this.store.items()).filter((i) => i.agent === agent.id && isLive(i.status) && !newIds.has(i.id) && !result.superseded.includes(i.id));
    drafts.push(...autoGroups([...earlier, ...live], cfg.grouping).filter((d) => d.items.some((i) => newIds.has(i))));
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
    for (const g of groups.filter((g) => g.kind === "linked")) {
      for (const pg of priorGroups.filter((pg) => pg.items.some((i) => g.items.includes(i)))) {
        const parts = combineParts(pg, g);
        if (parts) g.parts = parts;
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
      result.warnings.push(...(await this.settleParts(g, getItem)));
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
      const res = await applyItems(live, this.treeView(base), { refText: this.refText });
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
        await this.store.putItem(item);
      }
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
  private async settleParts(g: Group, get: (id: string) => Promise<Item | undefined>): Promise<string[]> {
    if (g.kind !== "linked" || !g.parts) {
      delete g.parts;
      return [];
    }
    const members = (await Promise.all(g.items.map(get))).filter((x): x is Item => !!x && x.status !== "superseded");
    const base = members.find((m) => isLive(m.status))?.baseCommit;
    const { parts, notes } = await settleParts(g.parts, members, base ? (lists) => this.interference(lists, this.treeView(base)) : undefined);
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
          res.applied.some((x) => x.item.file === l.item.file && (l.item.kind !== "modify" || x.item.kind !== "modify" || overlaps(l.span, x.span))),
        );
        const lost = clash ? [] : (await locate(located.map((l) => l.item), after, opts)).failed;
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
    const f = await this.workingView().read(item.file);
    const span = f ? anchor(item, f.text, await this.refText(item)) : null;
    return { line: span && f ? lineOf(f.text, span.start) : await this.itemLine(item), span };
  }

  /** Where an item's old text sits in `text` (LF line endings), e.g. an editor buffer with unsaved edits. */
  async locateInText(item: Item, text: string): Promise<Span | null> {
    if (item.kind !== "modify") return null;
    return anchor(item, text, await this.refText(item));
  }

  /** Accepted items whose changes are in the working copy but not yet committed. */
  async uncommittedAccepted(): Promise<Item[]> {
    return (await this.store.items()).filter((i) => i.status === "accepted" && i.resolution && !i.resolution.committed);
  }

  /**
   * Commit accepted-but-uncommitted items ("Finish review"). Commits their whole files,
   * so the user's own edits in those files are included.
   */
  async commitAcceptedItems(opts: { subject?: string } = {}): Promise<{ commit: string | null; items: Item[] }> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const onBranch = await this.projectBranch();
      if (onBranch !== cfg.mainBranch)
        throw new StetError(`Your project folder is on '${onBranch ?? "a detached HEAD"}', not '${cfg.mainBranch}'. Switch back first.`);
      await this.ensureBase(); // marks items the user already committed
      const items = (await this.uncommittedAccepted()).sort((a, b) => compareItemIds(a.id, b.id));
      if (!items.length) return { commit: null, items };
      const paths = [...new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]))];
      const commit = await this.commitAccepted(items, paths, opts.subject);
      await this.ensureBase();
      return { commit, items: commit ? items : [] };
    });
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
    }
    return [...out.values()];
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
  async acceptGroup(groupId: string, opts: { commit?: boolean } = {}): Promise<AcceptResult> {
    const { pending } = await this.groupTarget(groupId);
    if (!pending.length) throw new StetError(`${groupId.toUpperCase()} has no pending items.`);
    return this.accept(pending, opts);
  }

  async accept(
    ids: string[],
    opts: { edited?: Record<string, string>; overrideLinked?: boolean; commit?: boolean } = {},
  ): Promise<AcceptResult> {
    return this.store.withLock(async () => {
      await this.recoverInterrupted();
      const cfg = await this.config();
      const items = await this.requireItems(ids);
      for (const it of items) if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
      const bad = items.flatMap((i) => [i.file, ...(i.oldFile !== undefined ? [i.oldFile] : [])]).filter((f) => !isSafeRepoPath(f));
      if (bad.length) throw new StetError(`Refusing to write outside the project or into its git directory: ${bad.join(", ")}`);
      const onBranch = await this.projectBranch();
      if (onBranch !== cfg.mainBranch)
        throw new StetError(`Your project folder is on '${onBranch ?? "a detached HEAD"}', not '${cfg.mainBranch}'. Switch back before accepting.`);

      const warnings: string[] = [];
      const missing = (await this.linkedMembers(items)).filter((m) => !items.some((i) => i.id === m.id));
      if (missing.length) {
        if (!opts.overrideLinked) {
          throw new StetError(
            `${items.map((i) => i.id).join(", ")} ${items.length > 1 ? "are" : "is"} linked with ${missing.map((m) => m.id).join(", ")}: ` +
              `accepting only part of a linked group can break the document. Accept the whole group, or override explicitly.`,
          );
        }
        warnings.push(`Accepted without linked items ${missing.map((m) => m.id).join(", ")}; the group is now broken.`);
      }

      const view = this.workingView();
      const files = new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]));
      const wantCommit = opts.commit ?? cfg.autoCommit === "when-clean";
      const dirtyBefore = new Set<string>();
      if (wantCommit) for (const f of files) if ((await this.repo.status([f])).length) dirtyBefore.add(f);

      const overrides = new Map(Object.entries(opts.edited ?? {}).map(([k, v]) => [k.toUpperCase(), toLf(v)]));
      const res = await applyItems(items, view, { refText: this.refText, overrides });
      if (res.failed.length) {
        throw new StetError(
          "Nothing was applied, because some items could not be applied:\n" +
            res.failed.map((f) => `  ${f.item.id}: ${f.reason}`).join("\n"),
        );
      }

      // Other live items overlapping what we accept become stale.
      const stale: Item[] = [];
      const acceptedIds = new Set(items.map((i) => i.id));
      const others = (await this.store.items()).filter((i) => isLive(i.status) && !acceptedIds.has(i.id) && files.has(i.file));
      const spans = new Map((await locate(others, view, { refText: this.refText })).located.map((l) => [l.item.id, l.span]));
      for (const o of others) {
        const span = spans.get(o.id);
        const hit = res.applied.find(
          (a) => a.item.file === o.file && (o.kind !== "modify" || a.item.kind !== "modify" || (span && overlaps(span, a.span))),
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

      for (const a of res.applied) {
        const edited = editedOf(a);
        this.setStatus(a.item, "accepted", "user");
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
      if (cs && !titles.includes(cs.title)) titles.push(cs.title);
      lines.push(`- ${cs ? `${cs.title} (${cs.agent}, ${csId})` : csId}: ${its.map((i) => i.id).join(", ")}`);
    }
    const agents = [...new Set(items.map((i) => i.agent))].join(", ");
    let auto = titles.length === 1 ? titles[0]! : `Accept ${items.length} changes from ${agents}`;
    if (titles.length > 1 && titles.join("; ").length <= 60) auto = titles.join("; ");
    const ids = items.map((i) => i.id).join(",");
    return {
      subject: subject?.trim() || auto,
      body: `Accepted in Stet review (${agents}):\n${lines.join("\n")}\n\nStet-Applied: ${ids}`,
    };
  }

  private async commitAccepted(items: Item[], paths: string[], subject?: string): Promise<string | null> {
    const msg = await this.commitMessage(items, subject);
    await this.repo.run(["add", "-A", "--", ...paths]);
    const r = await this.repo.tryRun(["commit", "-q", "--only", "-m", `${msg.subject}\n\n${msg.body}`, "--", ...paths]);
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
      const items = await this.requireItems(ids);
      for (const it of items) if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
      const rest = (await this.linkedMembers(items)).filter((m) => !items.some((i) => i.id === m.id));
      if (rest.length && !opts.mode) {
        throw new StetError(
          `${items.map((i) => i.id).join(", ")} is linked with ${rest.map((m) => m.id).join(", ")}. ` +
            `Choose: reject all of them, reject this one and request revision of the rest, or reject only this one.`,
        );
      }
      const toReject = opts.mode === "all" ? [...items, ...rest] : items;
      for (const it of toReject) {
        this.setStatus(it, "rejected", "user", opts.reason);
        if (opts.reason) it.thread.push({ at: now(), author: "user", text: `Rejected: ${opts.reason}` });
        await this.store.putItem(it);
        await this.store.appendEvent({
          type: "rejected", agent: it.agent, items: [it.id],
          data: { item: await this.describe(it), ...(opts.reason ? { reason: opts.reason } : {}) },
        });
      }
      if (opts.mode === "revise-rest") {
        for (const r of rest) {
          const text = `Linked item ${items.map((i) => i.id).join(", ")} was rejected${opts.reason ? `: ${opts.reason}` : ""}. Please revise.`;
          await this.requestRevisionLocked(r, text);
        }
      }
      await this.updateGroups([...toReject, ...rest]);
      return toReject;
    });
  }

  private async requestRevisionLocked(it: Item, text: string) {
    this.setStatus(it, "needs_revision", "user");
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
      const [gid] = await this.store.allocate("group");
      let group: Group = {
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
    if (/\n[ \t]*\n/.test(bt.slice(start, end))) throw new StetError("Atomic groups must stay within one paragraph; use a linked group instead.");
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
        if (e.type !== "note_comment" && e.type !== "note_resolved") return false;
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
