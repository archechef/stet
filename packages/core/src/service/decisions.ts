/** Deciding changes (§7.3, §7.4): accept, reject, undo, revise, comment, withdraw, and committing accepts. */
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { captureContext } from "../anchor.js";
import { type AcceptFailure, applyItems, conflicts, type FileView, locate } from "../apply.js";
import { itemEffect } from "../effects.js";
import { notFound, StetError } from "../errors.js";
import {
  type Accepted,
  canUndo,
  compareItemIds,
  DROPPED_STATUSES,
  type Group,
  type GroupPart,
  type Item,
  type ItemStatus,
  isAccepted,
  isLive,
  isUncommitted,
  type Lookup,
  linkedRest,
  linkedUnit,
  moveFrom,
  moveOthers,
  moveTo,
  parsePartId,
} from "../model.js";
import type { AcceptResult, Stet, UndoResult } from "../service.js";
import { detectEol, isSafeRepoPath, oneLine, sha256, toLf } from "../text.js";
import { now, requirePending } from "./common.js";
import type { Records } from "./pending.js";

/** Changes with the linked group each is in, for messages: "1.2 (G1 “Terms”), 1.5". */
export function linkedNames(items: Item[], look: Lookup): string {
  const byGroup = new Map<string, string[]>();
  for (const it of items) {
    const g = it.groups.map((x) => look.group(x)).find((x) => x?.kind === "linked");
    const key = g ? `${g.id} “${oneLine(g.title, 60)}”` : "";
    byGroup.set(key, [...(byGroup.get(key) ?? []), it.id]);
  }
  return [...byGroup].map(([g, ids]) => (g ? `${ids.join(", ")} (${g})` : ids.join(", "))).join(", ");
}

export class Decisions {
  constructor(private readonly stet: Stet) {}

  /** Refuse to write the user's files or commit while the project folder is off the main branch. */
  private async requireMainBranch(main: string, then: string): Promise<void> {
    const on = await this.stet.projectBranch();
    if (on !== main) throw new StetError(`Your project folder is on '${on ?? "a detached HEAD"}', not '${main}'. Switch back ${then}.`);
  }

  /** Accepted items whose changes are in the working copy but not yet committed. */
  async uncommittedAccepted(): Promise<Accepted[]> {
    return (await this.stet.store.items()).filter(isUncommitted);
  }

  /**
   * What Finish review would commit, without committing: the accepted items, and the files that
   * also hold edits of the user's (committed along, whole files). For its question. Updates the
   * review base first (`ensureBase`), which records items the user has committed by hand.
   */
  async commitPreview(opts: { unsaved?: Record<string, string> } = {}): Promise<{ items: Item[]; yourEdits: string[]; scope: string; scopeSaved: string }> {
    return this.stet.store.withLock(async () => {
      const cfg = await this.stet.config();
      await this.stet.baseOps.ensureBase();
      const items = (await this.uncommittedAccepted()).sort((a, b) => compareItemIds(a.id, b.id));
      const paths = [...new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]))];
      const [scope, scopeSaved] = [await this.commitScope(items, paths), await this.commitScope(items, paths, opts.unsaved)];
      if (!items.length) return { items, yourEdits: [], scope, scopeSaved };
      return { items, yourEdits: await this.filesWithOtherEdits(items, paths, await this.stet.mainHead(cfg)), scope, scopeSaved };
    });
  }

  /**
   * What a commit of `items` takes: the changes, their wording, and the content of each of their
   * files (`unsaved`: text that will be saved into a file first). Finish review asks, then commits
   * only what it asked about (decisions review db49f7d, 4).
   */
  private async commitScope(items: Item[], paths: string[], unsaved: Record<string, string> = {}): Promise<string> {
    const view = this.stet.workingView();
    const files: string[] = [];
    for (const p of [...paths].sort()) {
      if (unsaved[p] !== undefined) files.push(`${p}\0t${sha256(toLf(unsaved[p]))}`);
      else {
        const f = await view.read(p).catch(() => undefined);
        files.push(`${p}\0${f === null ? "-" : f ? `t${sha256(f.text)}` : `b${await view.blobId(p)}`}`);
      }
    }
    return sha256(JSON.stringify([items.map((i) => [i.id, i.resolution?.appliedText ?? ""]), files]));
  }

  /**
   * Commit accepted-but-uncommitted items ("Finish review"). Commits their whole files,
   * so the user's own edits in those files are included. `scope`: what the reviewer was shown
   * (`commitPreview`); when the accepted changes or their files differ from it now (decided or
   * edited elsewhere meanwhile), nothing is committed (code `scope_changed`).
   */
  async commitAcceptedItems(opts: { subject?: string; scope?: string } = {}): Promise<{ commit: string | null; items: Item[]; yourEdits: string[] }> {
    return this.stet.store.withLock(async () => {
      const cfg = await this.stet.config();
      await this.requireMainBranch(cfg.mainBranch, "first");
      await this.stet.baseOps.ensureBase(); // marks items the user already committed
      const items = (await this.uncommittedAccepted()).sort((a, b) => compareItemIds(a.id, b.id));
      const paths = [...new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]))];
      if (opts.scope !== undefined && (await this.commitScope(items, paths)) !== opts.scope)
        throw new StetError(
          `The accepted changes or their files changed since you were asked (now: ${items.map((i) => i.id).join(", ") || "none"}). Nothing was committed.`,
          { code: "scope_changed" },
        );
      if (!items.length) return { commit: null, items, yourEdits: [] };
      const yourEdits = await this.filesWithOtherEdits(items, paths, await this.stet.mainHead(cfg));
      const commit = await this.commitAccepted(items, paths, opts.subject, yourEdits);
      await this.stet.baseOps.ensureBase();
      return { commit, items: commit ? items : [], yourEdits: commit ? yourEdits : [] };
    });
  }

  /**
   * Of `paths`, those whose working copy holds more than the accepted `items` applied to `head`:
   * the user's own edits, which a commit of the whole file takes along. A file
   * where that can't be told (an item no longer found in `head`) counts as one.
   */
  private async filesWithOtherEdits(items: Item[], paths: string[], head: string): Promise<string[]> {
    const overrides = new Map(items.map((i) => [i.id, i.resolution?.appliedText ?? i.newText]));
    const sim = await applyItems(items, this.stet.treeView(head), { refText: this.stet.refText, overrides, neighbours: this.stet.neighbours }).catch(
      () => null,
    );
    const unsure = new Set(sim ? sim.failed.flatMap((f) => [f.item.file, ...(f.item.oldFile ? [f.item.oldFile] : [])]) : paths);
    const out: string[] = [];
    for (const p of paths) {
      if (unsure.has(p)) {
        out.push(p);
        continue;
      }
      const want = sim!.changes.has(p) ? sim!.changes.get(p)! : await this.stet.treeView(head).read(p);
      const blob = await this.stet.workingView().blobId(p);
      if (want === null || blob === null) {
        if ((want === null) !== (blob === null)) out.push(p);
        continue;
      }
      if ("blob" in want) {
        if (want.blob !== blob) out.push(p);
        continue;
      }
      const cur = await this.stet
        .workingView()
        .read(p)
        .catch(() => null);
      if (!cur || cur.text !== want.text) out.push(p);
    }
    return out;
  }

  /**
   * Dissolve the moves (§6.4.7) of items that no longer stand (superseded, withdrawn): the other
   * items become ordinary deletions and insertions, and the move's own group goes. `known`:
   * in-memory items to update, so callers holding them don't write old versions back.
   */
  async dissolveMoves(gone: Item[], known: Map<string, Item>, rec: Records = this.stet.store): Promise<void> {
    for (const g of gone) {
      if (!g.move) continue;
      const ids = [...moveFrom(g.move), ...moveTo(g.move)];
      const members: Item[] = [];
      for (const id of ids) {
        const it = known.get(id) ?? (await rec.getItem(id));
        if (it) members.push(it);
      }
      const all = new Set(ids);
      for (const gid of new Set(members.flatMap((m) => m.groups))) {
        const grp = await rec.getGroup(gid);
        // Only the group that is just this move; an agent's larger linked group stays.
        if (grp?.kind !== "linked" || grp.source !== "auto" || grp.items.length !== all.size || !grp.items.every((i) => all.has(i))) continue;
        await rec.deleteGroup(gid);
        for (const m of members) m.groups = m.groups.filter((x) => x !== gid);
      }
      for (const m of members) {
        delete m.move;
        await rec.putItem(m);
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
        const pi = await this.stet.store.getItem(p);
        if (pi && isLive(pi.status)) out.push(pi);
      }
    }
    return out;
  }

  /**
   * Warnings for the linked groups of these items that are now decided differently: some members
   * accepted, others rejected, withdrawn, stale or still pending (parts decided one at a time, or `--only`). The
   * agent was told (group_partial, group_broken); the reviewer heard nothing, and a \ref could be
   * committed without its \label.
   */
  async partlyDecided(items: Item[]): Promise<string[]> {
    const out: string[] = [];
    const cfg = await this.stet.config();
    // Typst stops at a reference to a missing label; LaTeX prints "??".
    const breaks = (ms: Item[]) => ms.some((m) => !!this.stet.profile(cfg, m.file).references?.strict);
    for (const gid of new Set(items.flatMap((i) => i.groups))) {
      const g = await this.stet.store.getGroup(gid);
      if (g?.kind !== "linked") continue;
      const members = (await Promise.all(g.items.map((i) => this.stet.store.getItem(i)))).filter((x): x is Item => !!x && x.status !== "superseded");
      const yes = members.filter((m) => m.status === "accepted");
      const no = members.filter((m) => DROPPED_STATUSES.includes(m.status));
      const open = members.filter((m) => isLive(m.status));
      if (!yes.length) continue;
      if (!no.length) {
        // Accepted a part, the rest still to decide: say so, or a \label is committed and its
        // \refs left dangling without a word.
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
    const g = await this.stet.store.getGroup(pid ? pid.group : id.trim().toUpperCase());
    if (!g) throw notFound(`Unknown group '${id}'.`);
    const part = pid ? (g.parts?.[pid.index] ?? null) : null;
    if (pid && !part) throw new StetError(`${g.id} has ${g.parts?.length ? `only ${g.parts.length} parts` : "no parts"}.`);
    const pending: string[] = [];
    for (const i of part ? part.items : g.items) {
      const it = await this.stet.store.getItem(i);
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
    const cfg = await this.stet.config();
    const items = await this.withMovePartners(await this.stet.requireItems(ids));
    for (const it of items) requirePending(it);
    const bad = items.flatMap((i) => [i.file, ...(i.oldFile !== undefined ? [i.oldFile] : [])]).filter((f) => !isSafeRepoPath(f));
    if (bad.length) throw new StetError(`Refusing to write outside the project or into its git directory: ${bad.join(", ")}`);
    await this.requireMainBranch(cfg.mainBranch, "before accepting");

    // Files that take effect (a latexmkrc, .gitattributes, AGENTS.md…): only when asked for
    // explicitly.
    const effects = items.flatMap((item) => {
      const reason = itemEffect(item, cfg);
      return reason ? [{ item, reason }] : [];
    });
    if (effects.length && !opts.confirmEffects) {
      throw new StetError(
        `${effects.map(({ item, reason }) => `${item.id} changes ${item.file}: ${reason}`).join("; ")}. ` +
          `Look at ${effects.length > 1 ? "them" : "it"} first (stet show ${effects[0]!.item.id}), then accept with --confirm.`,
      );
    }
    const warnings: string[] = [];
    const look = await this.stet.lookup();
    const missing = linkedRest(
      items.map((i) => i.id),
      look,
    );
    if (missing.length) {
      if (!opts.overrideLinked) {
        throw new StetError(
          `${items.map((i) => i.id).join(", ")} ${items.length > 1 ? "are" : "is"} linked with ${linkedNames(missing, look)}: ` +
            `accepting only part of a linked group can break the document. Accept them together (${[...items, ...missing].map((i) => i.id).join(" ")}), or override explicitly.`,
        );
      }
      // Typst stops at a reference to a missing label; say so.
      const strict = [...items, ...missing].some((m) => !!this.stet.profile(cfg, m.file).references?.strict);
      warnings.push(
        `Accepted without linked items ${missing.map((m) => m.id).join(", ")}; the group is now broken${strict ? ", and the document may not compile until they are accepted too" : ""}.`,
      );
    }
    // The reviewer's drafts (from a file's review document), unless this accept gives other text.
    const overrides = new Map(items.filter((i) => i.draft !== undefined).map((i) => [i.id, i.draft!]));
    for (const [k, v] of Object.entries(opts.edited ?? {})) overrides.set(k.toUpperCase(), toLf(v));
    const res = await applyItems(items, view, { refText: this.stet.refText, overrides, neighbours: this.stet.neighbours });
    return { cfg, items, warnings, missing, overrides, res };
  }

  /** The error of an accept that applied nothing, with the changes that can't be located any more. */
  private static notApplied(failed: AcceptFailure[]): StetError {
    const lost = failed.filter((f) => f.lost).map((f) => f.item.id);
    const message =
      `Nothing was applied, because ${failed.length === 1 ? "a change" : "some changes"} could not be applied:\n` +
      failed.map((f) => `  ${f.item.id}: ${f.reason}`).join("\n") +
      // What to do next, for a change whose words were edited meanwhile.
      (lost.length
        ? `\nYou edited ${lost.length > 1 ? "their" : "its"} text or the text around ${lost.length > 1 ? "them" : "it"} since (${lost.join(", ")}): reject ${lost.length > 1 ? "them" : "it"}, or ask the agent for a revision against your current text.`
        : "");
    return new StetError(message, { code: "not_applied", lost });
  }

  /**
   * Throws what `accept` would, with `unsaved` (an editor's unsaved texts, by file) in place of
   * those files; writes nothing. An editor saves its buffers only for an accept that will work:
   * a failed accept had already saved them.
   */
  async checkAccept(
    ids: string[],
    opts: { edited?: Record<string, string>; overrideLinked?: boolean; confirmEffects?: boolean; unsaved?: Record<string, string> } = {},
  ): Promise<void> {
    return this.stet.store.withLock(async () => {
      await this.stet.recoverInterrupted();
      const disk = this.stet.workingView();
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
      if (res.failed.length) throw Decisions.notApplied(res.failed);
    });
  }

  async accept(
    ids: string[],
    opts: { edited?: Record<string, string>; overrideLinked?: boolean; commit?: boolean; confirmEffects?: boolean } = {},
  ): Promise<AcceptResult> {
    return this.stet.store.withLock(async () => {
      await this.stet.recoverInterrupted();
      const view = this.stet.workingView();
      const { cfg, items, warnings, missing, overrides, res } = await this.planAccept(ids, opts, view);
      const files = new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]));
      const wantCommit = opts.commit ?? cfg.autoCommit === "when-clean";
      const dirtyBefore = new Set<string>();
      if (wantCommit) for (const f of files) if ((await this.stet.repo.status([f])).length) dirtyBefore.add(f);

      if (res.failed.length) {
        // Remembered, so rejecting such an item afterwards doesn't block the change for good.
        for (const f of res.failed) {
          f.item.acceptFailed = { at: now(), reason: f.reason };
          await this.stet.store.putItem(f.item);
        }
        throw Decisions.notApplied(res.failed);
      }

      // Other live items overlapping what we accept become stale.
      const stale: Item[] = [];
      const acceptedIds = new Set(items.map((i) => i.id));
      const others = (await this.stet.store.items()).filter((i) => isLive(i.status) && !acceptedIds.has(i.id) && files.has(i.file));
      const spans = new Map(
        (await locate(others, view, { refText: this.stet.refText, neighbours: this.stet.neighbours })).located.map((l) => [l.item.id, l.span]),
      );
      for (const o of others) {
        const span = spans.get(o.id);
        const hit = res.applied.find((a) => a.item.file === o.file && (o.kind !== "modify" || a.item.kind !== "modify" || (span && conflicts(span, a.span))));
        if (hit) stale.push(o);
      }

      const appliedText = (a: (typeof res.applied)[number]) => (a.item.kind === "binary" || a.item.kind === "delete-file" ? a.item.newText : a.text);
      const editedOf = (a: (typeof res.applied)[number]) => overrides.has(a.item.id) && overrides.get(a.item.id) !== a.item.newText;
      // What HEAD holds now, to tell later when the user has committed these files (ensureBase).
      const head = await this.stet.mainHead(cfg);
      const headBlobs = new Map<string, string | null>();
      for (const f of new Set(res.applied.map((a) => a.item.file))) headBlobs.set(f, await this.stet.repo.blobId(head, f));
      await this.stet.writeWorking(
        res.changes,
        res.applied.map((a) => ({ id: a.item.id, appliedText: appliedText(a), edited: editedOf(a) })),
      );

      const decision = randomUUID();
      for (const a of res.applied) {
        const edited = editedOf(a);
        this.stet.setStatus(a.item, "accepted", "user", undefined, { decision });
        delete a.item.acceptFailed;
        delete a.item.draft;
        a.item.resolution = { appliedText: appliedText(a), edited, committed: null, headBlob: headBlobs.get(a.item.file) ?? null };
        await this.stet.store.putItem(a.item);
        await this.stet.store.appendEvent({
          type: "accepted",
          agent: a.item.agent,
          items: [a.item.id],
          data: { item: await this.stet.describe(a.item), ...(edited ? { finalText: a.text } : {}) },
        });
      }
      await rm(this.stet.journalPath, { force: true });
      for (const s of stale) {
        const by = res.applied.find((a) => a.item.file === s.file)!.item.id;
        await this.stet.submitOps.markStale(s, `overlaps accepted ${by}`, { staleBy: by });
      }

      let committed: string | null = null;
      if (wantCommit) {
        if (dirtyBefore.size) warnings.push(`Not committed: ${[...dirtyBefore].join(", ")} had uncommitted edits of yours.`);
        else
          committed = await this.commitAccepted(
            res.applied.map((a) => a.item).filter(isAccepted), // all of them, accepted just now
            [...res.changes.keys()],
          );
      }
      await this.stet.groupOps.updateGroups([...items, ...stale]);
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
      const cs = await this.stet.store.getChangeset(csId);
      // Agent-written titles on one line, without control characters: tools that print `git log`
      // raw would run escape sequences.
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

  private async commitAccepted(items: Accepted[], paths: string[], subject?: string, yourEdits: string[] = []): Promise<string | null> {
    const msg = await this.commitMessage(items, subject);
    const body = yourEdits.length
      ? msg.body.replace(/\n\nStet-Applied:/, `\n\nAlso the reviewer's own edits in ${yourEdits.join(", ")}.\n\nStet-Applied:`)
      : msg.body;
    await this.stet.repo.run(["add", "-A", "--", ...paths]);
    const r = await this.stet.repo.tryRun(["commit", "-q", "--only", "-m", `${msg.subject}\n\n${body}`, "--", ...paths]);
    if (r === null) return null;
    const head = (await this.stet.repo.revParse("HEAD"))!;
    for (const it of items) {
      it.resolution.committed = head;
      await this.stet.store.putItem(it);
    }
    return head;
  }

  /**
   * Reject items. For linked members, `mode` decides what happens to the rest of the group:
   * "all" rejects them too, "revise-rest" asks for revision, "only" breaks the group.
   */
  async reject(ids: string[], opts: { reason?: string; mode?: "all" | "revise-rest" | "only" } = {}): Promise<Item[]> {
    return this.stet.store.withLock(async () => {
      const items = opts.mode === "only" ? await this.stet.requireItems(ids) : await this.withMovePartners(await this.stet.requireItems(ids));
      for (const it of items) requirePending(it);
      const look = await this.stet.lookup();
      const rest = linkedRest(
        items.map((i) => i.id),
        look,
      );
      if (rest.length && !opts.mode) {
        throw new StetError(
          `${items.map((i) => i.id).join(", ")} ${items.length > 1 ? "are" : "is"} linked with ${linkedNames(rest, look)}. ` +
            `Choose: reject all of them, reject this one and request revision of the rest, or reject only this one.`,
          { code: "linked" },
        );
      }
      const toReject = opts.mode === "all" ? [...items, ...rest] : items;
      const decision = randomUUID();
      for (const it of toReject) {
        this.stet.setStatus(it, "rejected", "user", opts.reason, { decision });
        delete it.draft;
        if (opts.reason) it.thread.push({ at: now(), author: "user", text: `Rejected: ${opts.reason}` });
        await this.stet.store.putItem(it);
        await this.stet.store.appendEvent({
          type: "rejected",
          agent: it.agent,
          items: [it.id],
          data: {
            item: await this.stet.describe(it),
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
      await this.stet.groupOps.updateGroups([...toReject, ...rest]);
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
   * of 400 changes one by one took 16 s. Accepted changes are taken out
   * together; all of them, or none when one can't be.
   *
   * `decisions`: for each id, the decision (`HistoryEntry.decision`) that is to be undone. A change
   * whose latest decision is another one was decided again since, in another window or the CLI, and
   * is left alone: checked here, in the lock (decisions review db49f7d, 5).
   */
  async undoMany(ids: string[], opts: { decisions?: Record<string, string> } = {}): Promise<UndoResult> {
    return this.stet.store.withLock(async () => {
      await this.stet.recoverInterrupted();
      const want = opts.decisions;
      const items = (await this.stet.requireItems([...new Set(ids)])).filter((it) => !want?.[it.id] || it.history.at(-1)?.decision === want[it.id]);
      if (!items.length) return { reopened: [], restored: [] };
      for (const it of items) {
        // A committed accept is refused below, with its commit.
        if (!canUndo(it) && it.status !== "accepted")
          throw new StetError(`${it.id} is ${it.status}: only accepted and rejected changes, and revision requests, can be undone.`);
      }
      const reopened = new Map<string, Item>();
      const rejected: { unit: Item[]; revised: Item[] }[] = [];
      for (const item of items.filter((i) => i.status === "rejected")) {
        // The revision requests this rejection sent to the rest of its linked group (reject
        // --revise-rest) are taken back too, unless the agent has answered them meanwhile.
        const unit = (await this.decidedWith(item)).filter((i) => i.status === "rejected");
        const revised = (await this.sameDecision(item)).filter((i) => i.status === "needs_revision");
        rejected.push({ unit, revised });
      }
      // A rejected change comes back only if it can still be applied: checked for all of them
      // first, so nothing is undone when one can't.
      await this.requireReopenable(rejected.flatMap((r) => r.unit));
      // The accepts next: undoing them can still refuse (you edited their text since), and then
      // no rejection may have been undone either (decisions review db49f7d, 3).
      const accepted = items.filter((i) => i.status === "accepted");
      const units = new Map<string, Accepted>();
      for (const item of accepted) if (!units.has(item.id)) for (const it of (await this.decidedWith(item)).filter(isAccepted)) units.set(it.id, it);
      const result = units.size ? await this.undoAccepted([...units.values()]) : { reopened: [], restored: [] };
      for (const item of items.filter((i) => i.status === "needs_revision")) {
        // A revision request the agent hasn't answered yet (an answer supersedes the change):
        // taken back, the change is pending again, and the agent is told.
        await this.reopen(item, "revision request taken back", "needs_revision");
        reopened.set(item.id, item);
      }
      for (const { unit, revised } of rejected) {
        for (const it of unit) if (it.status === "rejected") await this.reopen(it, "rejection undone", "rejected");
        for (const it of revised) if (it.status === "needs_revision") await this.reopen(it, "rejection of a linked change undone", "needs_revision");
        for (const it of [...unit, ...revised]) reopened.set(it.id, it);
      }
      if (reopened.size) await this.stet.groupOps.updateGroups([...reopened.values()]);
      return { reopened: [...reopened.values(), ...result.reopened], restored: result.restored };
    });
  }

  /** Take accepted changes (whole units, see `decidedWith`) out of the working copy. */
  private async undoAccepted(unit: Accepted[]): Promise<UndoResult> {
    this.stet.store.assertLocked("undoing an accept");
    const committed = unit.find((i) => i.resolution.committed);
    if (committed?.resolution.committed) {
      throw new StetError(
        `${committed.id} is committed already (${committed.resolution.committed.slice(0, 8)}): Stet can't undo it any more. Revert it with git if you need to.`,
      );
    }
    const cfg = await this.stet.config();
    await this.requireMainBranch(cfg.mainBranch, "before undoing");

    // The inverse changes: from the applied text back to the old one. Each is found against its
    // base with what is accepted there made (this change, and the other accepted ones not
    // committed yet), as the working copy has it: text where nothing changed since is then
    // known for what it is, and another accepted change's same words are never taken for this
    // one's.
    const unitIds = new Set(unit.map((i) => i.id));
    const acceptedOthers = (await this.stet.store.items()).filter((o): o is Accepted => o.kind === "modify" && isUncommitted(o) && !unitIds.has(o.id));
    const refs = new Map<string, string>();
    const inverse: Item[] = [];
    for (const it of unit) {
      const applied = it.resolution.appliedText;
      if (it.kind === "modify") {
        const ref = (await this.stet.refText(it)) ?? "";
        const sameText = (o: Item) => o.kind === "modify" && o.id !== it.id && o.file === it.file && o.baseCommit === it.baseCommit;
        const made = [it, ...unit.filter(sameText), ...acceptedOthers.filter(sameText)]
          .map((o) => ({ id: o.id, range: o.range, oldText: o.oldText, text: o.resolution.appliedText }))
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
    const res = await applyItems(inverse, this.stet.workingView(), {
      refText: async (i) => refs.get(i.id) ?? (await this.stet.refText(i)),
    });
    if (res.failed.length) {
      throw new StetError(
        "Nothing was undone, because some changes are no longer as accepted (you edited them since?):\n" +
          res.failed.map((f) => `  ${f.item.id}: ${f.reason}`).join("\n"),
      );
    }
    await this.stet.writeWorking(
      res.changes,
      unit.map((i) => ({ id: i.id, appliedText: "", edited: false })),
      { undo: true },
    );
    for (const it of unit) await this.reopen(it, "accept undone", "accepted");
    await rm(this.stet.journalPath, { force: true });

    // Items the accept made stale are pending again.
    const ids = new Set(unit.map((i) => i.id));
    const restored: Item[] = [];
    for (const it of await this.stet.store.items()) {
      const last = it.history[it.history.length - 1];
      const by = last?.staleBy;
      if (it.status !== "stale" || !by || !ids.has(by)) continue;
      await this.reopen(it, `the accept of ${by} was undone`, "stale");
      restored.push(it);
    }
    await this.stet.groupOps.updateGroups([...unit, ...restored]);
    return { reopened: unit, restored };
  }

  /**
   * An item and those decided together with it, in the same state: its move partners, its linked
   * unit, and the rest of its linked group decided in the same accept or reject. Accepting G1
   * whole and undoing one of its parts left a \label renamed without its \refs.
   */
  private async decidedWith(item: Item): Promise<Item[]> {
    const out = new Map<string, Item>([[item.id, item]]);
    const add = async (id: string) => {
      const it = await this.stet.store.getItem(id);
      if (it && it.status === item.status && !out.has(it.id)) out.set(it.id, it);
    };
    for (const p of moveOthers(item)) await add(p);
    for (const gid of item.groups) {
      const g = await this.stet.store.getGroup(gid);
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
      const g = await this.stet.store.getGroup(gid);
      if (g?.kind !== "linked") continue;
      for (const id of g.items) {
        if (id === item.id || out.has(id)) continue;
        const it = await this.stet.store.getItem(id);
        if (it && it.history[it.history.length - 1]?.decision === decision) out.set(id, it);
      }
    }
    return [...out.values()];
  }

  /**
   * Rejected changes made pending again must still apply to your files as they are now, and must
   * not compete with a pending change of their agent for the same text (its revision, made after
   * the rejection): the agent's workspace holds one text. Throws, saying why, when one doesn't.
   */
  private async requireReopenable(items: Item[]): Promise<void> {
    if (!items.length) return;
    const ids = new Set(items.map((i) => i.id));
    const agents = new Set(items.map((i) => i.agent));
    const live = (await this.stet.store.items()).filter((o) => agents.has(o.agent) && isLive(o.status) && !ids.has(o.id));
    const opts = { refText: this.stet.refText, neighbours: this.stet.neighbours };
    const { located, failed } = await locate([...items, ...live], this.stet.workingView(), opts);
    const why: string[] = [];
    for (const f of failed) if (ids.has(f.item.id)) why.push(`${f.item.id}: ${f.reason}`);
    const spans = new Map(located.map((l) => [l.item.id, l]));
    for (const it of items) {
      const mine = spans.get(it.id);
      if (!mine) continue;
      if (it.kind !== "modify") {
        // A whole file: it must still be as the change expects.
        const res = await applyItems([it], this.stet.workingView(), opts);
        for (const f of res.failed) why.push(`${it.id}: ${f.reason}`);
        continue;
      }
      const clash = located.find((l) => !ids.has(l.item.id) && l.item.kind === "modify" && l.item.file === it.file && conflicts(l.span, mine.span));
      if (clash) why.push(`${it.id}: ${it.agent} proposes ${clash.item.id} for the same text now; reject or withdraw it first`);
    }
    if (why.length) throw new StetError(`Can't undo the rejection, because the change can no longer be applied (${why.join("; ")}). Nothing was undone.`);
  }

  async reopen(it: Item, note: string, was: ItemStatus): Promise<void> {
    this.stet.setStatus(it, "pending", "user", note);
    it.resolution = null;
    delete it.acceptFailed;
    await this.stet.store.putItem(it);
    await this.stet.store.appendEvent({ type: "reopened", agent: it.agent, items: [it.id], data: { item: await this.stet.describe(it), was } });
  }

  private async requestRevisionLocked(it: Item, text: string, decision?: string) {
    this.stet.setStatus(it, "needs_revision", "user", undefined, { decision });
    it.thread.push({ at: now(), author: "user", text });
    await this.stet.store.putItem(it);
    await this.stet.store.appendEvent({
      type: "revision_requested",
      agent: it.agent,
      items: [it.id],
      data: { item: await this.stet.describe(it), comment: text },
    });
  }

  async requestRevision(id: string, text: string): Promise<Item> {
    return this.stet.store.withLock(async () => {
      const [it] = await this.stet.requireItems([id]);
      requirePending(it!);
      // A decision of its own, so that Undo can tell it from a later one.
      await this.requestRevisionLocked(it!, text, randomUUID());
      return it!;
    });
  }

  async comment(id: string, text: string, author: "user" | "agent" = "user"): Promise<Item> {
    return this.stet.store.withLock(async () => {
      const [it] = await this.stet.requireItems([id]);
      it!.thread.push({ at: now(), author, text });
      await this.stet.store.putItem(it!);
      await this.stet.store.appendEvent({
        type: author === "user" ? "comment" : "reply",
        agent: it!.agent,
        items: [it!.id],
        data: { item: await this.stet.describe(it!), text },
      });
      return it!;
    });
  }

  async withdraw(agentId: string, ids: string[], reason?: string): Promise<Item[]> {
    return this.stet.store.withLock(async () => {
      const items = await this.stet.requireItems(ids);
      for (const it of items) {
        if (it.agent !== agentId) throw new StetError(`${it.id} belongs to ${it.agent}.`);
        requirePending(it);
        this.stet.setStatus(it, "withdrawn", "agent", reason);
        await this.stet.store.putItem(it);
        await this.stet.store.appendEvent({ type: "withdrawn", agent: agentId, items: [it.id], data: reason ? { reason } : {} });
      }
      await this.dissolveMoves(items, new Map(items.map((i) => [i.id, i])));
      await this.stet.groupOps.updateGroups(items);
      return items;
    });
  }
}
