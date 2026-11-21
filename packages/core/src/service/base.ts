/** The review base (§7.3): what agents start from and see of your accepted changes and edits. */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchor, anchorNear } from "../anchor.js";
import { applyItems } from "../apply.js";
import { type StetConfig, validateConfig } from "../config.js";
import { StetError } from "../errors.js";
import type { Item } from "../model.js";
import type { Stet } from "../service.js";
import { isSafeRepoPath } from "../text.js";
import { now } from "./common.js";

export const BASE_REF = "refs/stet/base";

/** When the user (last) accepted an item; "" if unknown. */
export const acceptedAt = (it: Item) => [...it.history].reverse().find((h) => h.status === "accepted")?.at ?? "";

// ---------------------------------------------------------------------------
// Result types

export class ReviewBase {
  constructor(private readonly stet: Stet) {}

  /** Make sure refs/stet/base = main HEAD + accepted-but-uncommitted items. Call under lock. */
  async ensureBase(): Promise<string> {
    await this.stet.recoverInterrupted();
    const cfg = await this.stet.config();
    const head = await this.stet.mainHead(cfg);
    await this.checkDroppedCommits(cfg, head);
    const pending = (await this.stet.store.items()).filter((i) => i.status === "accepted" && i.resolution && !i.resolution.committed);
    const view = this.stet.treeView(head);
    const stillOpen: Item[] = [];
    const headBlobs = new Map<string, string | null>();
    for (const it of pending) {
      const applied = it.resolution!.appliedText;
      if (it.kind !== "modify") {
        // Compare content, not just existence: a replaced binary exists before and after.
        const state = await this.stet.wholeFileState(it, view);
        if (state === "open") stillOpen.push(it);
        else {
          it.resolution!.committed = head;
          if (state !== "done") it.resolution!.committedWithEdits = true;
          await this.stet.store.putItem(it);
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
        it.resolution!.committed = head;
        if (!f || !anchor(probe, f.text)) it.resolution!.committedWithEdits = true;
        await this.stet.store.putItem(it);
      } else stillOpen.push(it);
    }
    // The user's shared edits replace HEAD as the starting point. They already hold every item
    // accepted before they were taken (accepting writes the working copy), or what the user made
    // of it since; only items accepted after a manual share are applied on top.
    const share = await this.sharedTree(cfg, head);
    const shared = share && share.tree !== (await this.stet.repo.run(["rev-parse", `${head}^{tree}`])) ? share.tree : null;
    let toApply = stillOpen;
    // Accepted items the base should hold but can't: agents would never see them (bug report
    // 2026-11-18), so they are recorded and shown to the reviewer.
    const missing: { id: string; reason: string }[] = [];
    if (share) {
      const sview = this.stet.treeView(share.tree);
      toApply = [];
      for (const it of stillOpen) {
        if (share.at === null || acceptedAt(it) <= share.at) continue;
        if (it.kind !== "modify") {
          if ((await this.stet.wholeFileState(it, sview)) === "open") toApply.push(it);
          continue;
        }
        const f = await sview.read(it.file);
        // With its accepted neighbours: one right next to it changed its surroundings (bug report 2026-11-18).
        if (f && anchorNear({ ...it, newText: it.resolution!.appliedText }, f.text, await this.stet.refText(it), await this.stet.neighbours(it)))
          toApply.push(it);
        else if (!f || !this.holdsApplied(it, f.text)) missing.push({ id: it.id, reason: "it can't be located in your shared edits" });
      }
    }
    const key = head + ":" + (shared ?? "") + ":" + toApply.map((i) => i.id).join(",") + ":" + missing.map((m) => m.id).join(",");
    const state = await this.stet.store.state();
    const current = await this.stet.repo.revParse(BASE_REF);
    if (state.base?.key === key && current === state.base.commit) return current;

    let commit = head;
    if (toApply.length || shared) {
      const from = shared ?? head;
      const res = await applyItems(toApply, this.stet.treeView(from), {
        refText: this.stet.refText,
        neighbours: this.stet.neighbours,
        overrides: new Map(toApply.map((i) => [i.id, i.resolution!.appliedText])),
      });
      for (const f of res.failed) missing.push({ id: f.item.id, reason: f.reason });
      const what = [
        ...(shared ? ["your shared edits"] : []),
        ...(res.applied.length ? [`accepted, not yet committed: ${res.applied.map((a) => a.item.id).join(", ")}`] : []),
      ];
      commit = await this.stet.repo.buildCommit({
        parents: [head],
        baseRev: from,
        changes: await this.stet.changesToCommitMap(res.changes),
        message: `stet: review base (${what.join("; ")})`,
      });
    }
    await this.stet.repo.run(["update-ref", BASE_REF, commit]);
    const s = await this.stet.store.state();
    s.base = { key, commit, ...(missing.length ? { missing } : {}) };
    await this.stet.store.saveState(s);
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
    const state = await this.stet.store.state();
    const last = state.mainHead;
    if (last === head) return;
    const forward = !!last && (await this.stet.repo.tryRun(["merge-base", "--is-ancestor", last, head])) !== null;
    if (!forward) {
      const reach = new Map<string, boolean>();
      const changed: Item[] = [];
      const working = this.stet.workingView();
      for (const it of await this.stet.store.items()) {
        const c = it.status === "accepted" ? it.resolution?.committed : undefined;
        if (!c) continue;
        if (!reach.has(c)) reach.set(c, (await this.stet.repo.tryRun(["merge-base", "--is-ancestor", c, head])) !== null);
        if (reach.get(c)) continue;
        const f = it.kind === "modify" ? await working.read(it.file).catch(() => null) : null;
        const kept =
          it.kind === "modify" ? !!f && this.holdsApplied(it, f.text) : (await this.stet.wholeFileState(it, working).catch(() => "other")) === "done";
        if (kept) {
          it.resolution!.committed = null;
          delete it.resolution!.committedWithEdits;
          it.resolution!.headBlob = await this.stet.repo.blobId(head, it.file);
          await this.stet.store.putItem(it);
        } else {
          await this.stet.decisionOps.reopen(
            it,
            `its commit ${c.slice(0, 8)} is no longer on ${cfg.mainBranch} (git reset?), and your file doesn't have it`,
            "accepted",
          );
        }
        changed.push(it);
      }
      if (changed.length) await this.stet.groupOps.updateGroups(changed);
    }
    const s = await this.stet.store.state();
    s.mainHead = head;
    await this.stet.store.saveState(s);
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
    return this.stet.store.withLock(async () => {
      await this.ensureBase();
      return this.missingNow();
    });
  }

  /** `missingFromBase` for a base just ensured. Call under lock. */
  async missingNow(): Promise<{ item: Item; reason: string }[]> {
    const out: { item: Item; reason: string }[] = [];
    for (const m of (await this.stet.store.state()).base?.missing ?? []) {
      const it = await this.stet.store.getItem(m.id);
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
      const s = (await this.stet.store.state()).shared;
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
    if (!blobs.has(it.file)) blobs.set(it.file, await this.stet.repo.blobId(head, it.file));
    const blob = blobs.get(it.file) ?? null;
    const r = it.resolution!;
    if (r.headBlob !== undefined) return blob !== r.headBlob;
    // Commit times have whole seconds: only a later second counts, or a commit made just before
    // the accept (in the same second) would count as committing it.
    const last = Number(await this.stet.repo.tryRun(["log", "-1", "--format=%ct", head, "--", it.file]));
    if (last > Math.floor(Date.parse(acceptedAt(it)) / 1000)) return true;
    r.headBlob = blob;
    await this.stet.store.putItem(it);
    return false;
  }

  /**
   * A tree of the project folder as saved on disk, on top of main at `head`: tracked files (and
   * files staged with `git add`) as they are now, plus new TeX/BibTeX files git doesn't ignore.
   * Other new files (build output, PDFs) stay out. Uses its own index; the user's is untouched.
   * Null if the project folder has another branch checked out.
   */
  private async workingTree(cfg: StetConfig, head: string): Promise<string | null> {
    if ((await this.stet.projectBranch()) !== cfg.mainBranch) return null;
    if ((await this.stet.repo.revParse("HEAD")) !== head) return null;
    const dir = await mkdtemp(join(tmpdir(), "stet-share-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    try {
      // Starting from a copy of the user's index makes git re-read only files whose stat changed.
      const copied = await copyFile(join(this.stet.commonDir, "index"), env.GIT_INDEX_FILE).then(
        () => true,
        () => false,
      );
      if (!copied || (await this.stet.repo.tryRun(["add", "-u"], { env })) === null) {
        await this.stet.repo.run(["read-tree", head], { env });
        await this.stet.repo.run(["add", "-u"], { env });
      }
      const untracked = (await this.stet.repo.run(["ls-files", "-z", "--others", "--exclude-standard"], { env }))
        .split("\0")
        .filter((p) => p && isSafeRepoPath(p) && this.stet.profile(cfg, p).document);
      for (let i = 0; i < untracked.length; i += 100) await this.stet.repo.run(["add", "--", ...untracked.slice(i, i + 100)], { env });
      return await this.stet.repo.run(["write-tree"], { env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * *Share my edits*: agents see the saved project files from now on (until main moves on).
   * Returns false when there was nothing new to share.
   */
  async shareEdits(): Promise<boolean> {
    return this.stet.store.withLock(async () => {
      const cfg = await this.stet.config();
      const head = await this.stet.mainHead(cfg);
      const tree = await this.workingTree(cfg, head);
      if (!tree) throw new StetError(`Your project folder isn't on '${cfg.mainBranch}'. Switch back to it to share your edits with agents.`);
      const s = await this.stet.store.state();
      if (s.shared?.head === head && s.shared.tree === tree) return false;
      s.shared = { head, tree, at: now() };
      await this.stet.store.saveState(s);
      const before = await this.stet.repo.revParse(BASE_REF);
      return (await this.ensureBase()) !== before;
    });
  }

  /** Which edits agents see, and whether saved edits exist that they don't. */
  async shareStatus(): Promise<{ mode: StetConfig["shareEdits"]; unshared: boolean }> {
    return this.stet.store.withLock(async () => {
      const cfg = await this.stet.config();
      const base = await this.ensureBase();
      const tree = await this.workingTree(cfg, await this.stet.mainHead(cfg));
      return { mode: cfg.shareEdits, unshared: !!tree && tree !== (await this.stet.repo.run(["rev-parse", `${base}^{tree}`])) };
    });
  }

  /** Set `shareEdits`; returns false when it already had that value. */
  async setShareEdits(mode: StetConfig["shareEdits"]): Promise<boolean> {
    return this.stet.store.withLock(async () => {
      const cfg = await this.stet.config();
      if (cfg.shareEdits === mode) return false;
      await this.stet.store.saveConfig(validateConfig({ ...cfg, shareEdits: mode }));
      return true;
    });
  }
}
