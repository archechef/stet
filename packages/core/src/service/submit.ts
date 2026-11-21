/** Submit and sync (§7.2, §7.6, §6.3, §6.4): an agent's work made into changes, and replayed onto the review base. */
import { captureContext, chainInsertions } from "../anchor.js";
import { applyItems, overlaps } from "../apply.js";
import type { StetConfig } from "../config.js";
import { StetError } from "../errors.js";
import { autoGroups, type GroupDraft, type GroupHint, type HintUnit, type NoteHint, normalizeGroups, parseWhere, unitMatches } from "../grouping.js";
import { archivedMessage } from "../instructions.js";
import { type Agent, type Changeset, compareItemIds, type Group, type Item, isLive, itemId } from "../model.js";
import { detectMoves, detectRewritten, separateMoved } from "../moves.js";
import { describeNote } from "../notes.js";
import { absorbLinked, type PartDraft } from "../parts.js";
import type { Stet, SubmitResult, SyncResult } from "../service.js";
import { type Edit, splitText } from "../split.js";
import { detectEol, isBinary, isSafeRepoPath, lineRange, normalizeWs, sha256, textWithBadBytes, toLf } from "../text.js";
import { isWorkspaceFile } from "../workspace.js";
import { now } from "./common.js";
import { PendingWrites } from "./pending.js";

/** Text between two changes that ends a sentence or a paragraph. */
export const SENTENCE_BREAK = /[.!?]["')\]}]*\s|\n[ \t]*\n/;

export interface Candidate extends Edit {
  file: string;
  oldFile?: string;
  kind: Item["kind"];
  oldBlob?: string | null;
  newBlob?: string | null;
  shownText?: Item["shownText"];

  /** For changes merged from an agent's atomic group: its title and rationale, kept as the item's note. */
  note?: string;
}

/**
 * One text change of `file` in place of several: the base text from `start` to `end` becoming the
 * tip's text from `newStart` to `newEnd`, with everything between the changes it replaces.
 */
export function mergedEdit(file: string, baseText: string, tipText: string, at: { start: number; end: number; newStart: number; newEnd: number }): Candidate {
  return { file, kind: "modify", ...at, oldText: baseText.slice(at.start, at.end), newText: tipText.slice(at.newStart, at.newEnd) };
}

/** Submit: an agent's linked group made related, and what stayed linked. */
export function unlinkedWarning(title: string, linked: string[][]): string {
  return (
    `Group '${title}' is a related group now: Stet saw no dependency between all of its changes, so the reviewer can decide them one by one` +
    (linked.length ? `. Still linked, because they need each other: ${linked.map((c) => c.join(" + ")).join("; ")}` : "") +
    `. Link only changes where accepting some alone breaks the document. If that is the case here in a way Stet can't see, ` +
    `group them again with stet_group, kind "linked", and a "reason" saying why (the reviewer sees it).`
  );
}

/** Above these, a submit is said to be very large (not refused). */
export const LARGE_SUBMIT = { items: 1000, files: 200 };

export class Submission {
  constructor(private readonly stet: Stet) {}

  private async candidatesFor(cfg: StetConfig, base: string, tip: string, touched: Set<string>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const changes = await this.stet.diffNames(base, tip);
    for (const ch of changes) {
      if (!touched.has(ch.path) && !(ch.oldPath && touched.has(ch.oldPath))) continue;
      for (const p of [ch.path, ch.oldPath ?? ch.path]) {
        if (!isSafeRepoPath(p))
          throw new StetError(
            `The path '${p}' is not allowed in a proposal (it could reach the git directory on some systems). Remove or rename it, then submit again.`,
          );
      }
      // Stet's own workspace files are never proposals (unless the project tracks them).
      if (isWorkspaceFile(ch.path) && ch.status === "A") continue;
      const oldPath = ch.status === "R" ? ch.oldPath! : ch.path;
      const oldBuf = ch.status === "A" ? null : await this.stet.repo.readBlob(base, oldPath);
      const newBuf = ch.status === "D" ? null : await this.stet.repo.readBlob(tip, ch.path);
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
      if (oldBuf && !binary) this.stet.cacheText(base + ":" + oldPath, { text: oldText, eol: detectEol(oldBuf.toString("utf8")) });
      if (newBuf && !binary) this.stet.cacheText(tip + ":" + ch.path, { text: newText, eol: detectEol(newBuf.toString("utf8")) });
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
        // file)", it hid what accepting it writes.
        const [os, ns] = [oldBuf && textWithBadBytes(oldBuf), newBuf && textWithBadBytes(newBuf)];
        out.push({
          ...whole("binary"),
          oldBlob: oldBuf ? await this.stet.repo.blobId(base, oldPath) : null,
          newBlob: newBuf ? await this.stet.repo.blobId(tip, ch.path) : null,
          ...((os ?? null) !== null || (ns ?? null) !== null ? { shownText: { old: os ?? null, new: ns ?? null } } : {}),
        });
      } else if (ch.status === "A") out.push(whole("add-file"));
      else if (ch.status === "D") out.push(whole("delete-file"));
      else if (ch.status === "R") out.push(whole("rename-file"));
      else {
        for (const e of splitText(this.stet.profile(cfg, ch.path), oldText, newText, cfg.split)) {
          out.push({ ...e, file: ch.path, kind: "modify" });
        }
      }
    }
    return out;
  }

  fingerprint(c: { file: string; kind: string; oldText: string; newText: string; newBlob?: string | null }) {
    return "sha256:" + sha256([c.file, c.kind, normalizeWs(c.oldText), normalizeWs(c.newText), c.newBlob ?? ""].join("\u0000"));
  }

  async submit(agentId: string, opts: { title: string; rationale?: string; groups?: GroupHint[]; notes?: NoteHint[] }): Promise<SubmitResult> {
    return this.stet.store.withLock(async () => {
      const cfg = await this.stet.config();
      const agent = await this.stet.agentOps.requireAgent(agentId);
      if (agent.state !== "active") throw new StetError(archivedMessage(agent));
      const base = await this.stet.baseOps.ensureBase();
      const files = await this.stet.agentOps.agentFiles(agent);
      const tip = await files.commitAll(`${opts.title}\n\n${opts.rationale ?? ""}\n\nStet-Agent: ${agentId}`);
      const result: SubmitResult = {
        changeset: null,
        items: [],
        groups: [],
        ungrouped: [],
        superseded: [],
        withdrawn: [],
        repeats: [],
        moves: [],
        warnings: [],
        sync: null,
      };

      if (tip !== agent.lastTip) {
        await this.itemize(cfg, agent, tip, opts, result);
        agent.lastTip = tip;
        await this.stet.store.putAgent(agent);
        // A very large round: said to the agent and the reviewer, not refused. 3,000 changes in
        // one held the store lock for over a minute.
        const nFiles = new Set(result.items.map((i) => i.file)).size;
        if (result.changeset && (result.items.length > LARGE_SUBMIT.items || nFiles > LARGE_SUBMIT.files)) {
          const what = `${result.items.length} changes in ${nFiles} file${nFiles === 1 ? "" : "s"}`;
          result.warnings.push(`This round is very large (${what}): it is slow for Stet and hard to review. Submit in smaller rounds, one topic each.`);
          result.changeset.stetNote = `A very large round: ${what}.`;
          await this.stet.store.putChangeset(result.changeset);
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
    // Written in one step at the end (`rec.flush()`): a submit that fails halfway leaves the store as it was.
    const rec = new PendingWrites(this.stet.store);
    const base = agent.baseCommit;
    const touched = new Set<string>();
    for (const ch of await this.stet.diffNames(agent.lastTip, tip)) {
      touched.add(ch.path);
      if (ch.oldPath) touched.add(ch.oldPath);
    }
    const allItems = await rec.items();
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
      const tipText = (await this.stet.textAt(tip, e.file))!.text;
      const baseText = (await this.stet.textAt(base, e.file))!.text;
      const merged = mergedEdit(e.file, baseText, tipText, { ...e.range, newStart, newEnd });
      cands = [...cands.filter((c) => !inside.includes(c)), merged];
    }

    const sameAs = (c: Candidate, e: Item) =>
      c.file === e.file &&
      c.kind === e.kind &&
      (c.oldFile ?? null) === (e.oldFile ?? null) &&
      c.start === e.range.start &&
      c.end === e.range.end &&
      c.newText === e.newText &&
      (c.newBlob ?? null) === (e.newBlob ?? null);

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
      const t = await this.stet.textAt(tip, where.file);
      if (!t) return { file: where.file, range: { start: -1, end: -1 }, text };
      return { file: where.file, range: lineRange(t.text, where.from, where.to!), text };
    };
    const unit = (c: Candidate, key: string): HintUnit => ({
      key,
      file: c.file,
      ...(c.oldFile ? { oldFile: c.oldFile } : {}),
      wholeFile: c.kind !== "modify",
      newStart: c.newStart,
      newEnd: c.newEnd,
      oldText: c.oldText,
      newText: c.newText,
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
      const keyEdits = matchedC.filter((c) => this.stet.isKeyEdit(cfg, c));
      const members = matchedC.filter((c) => !keyEdits.includes(c));
      if (keyEdits.length)
        result.warnings.push(
          `Atomic group '${h.title}': kept ${keyEdits.map((k) => JSON.stringify(k.newText.trim())).join(", ")} separate (renames are items of their own; link them instead).`,
        );
      if (members.length < 2) continue;
      const files = new Set(members.map((m) => m.file));
      members.sort((a, b) => a.start - b.start);
      const first = members[0]!;
      const last = members[members.length - 1]!;
      const baseText = files.size === 1 ? (await this.stet.textAt(base, first.file))!.text : "";
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
      const tipText = (await this.stet.textAt(tip, first.file))!.text;
      const merged = mergedEdit(first.file, baseText, tipText, { start: first.start, end: last.end, newStart: first.newStart, newEnd: last.newEnd });
      merged.note = h.rationale ? `${h.title}: ${h.rationale}` : h.title;
      fresh.splice(0, fresh.length, ...fresh.filter((c) => !members.includes(c)), merged);
    }

    // A reworded sentence with a piece that repeats an earlier rejection: keep that sentence's
    // changes together as one item. Auto-rejecting only the piece left the rest a broken
    // sentence, which accepting would have put into the document.
    const rejectedFps = new Set(allItems.filter((i) => i.status === "rejected" && !i.acceptFailed).map((i) => i.fingerprint));
    const repeats = (c: Candidate) => rejectedFps.has(this.fingerprint(c));
    for (const file of new Set(fresh.filter((c) => c.kind === "modify" && repeats(c)).map((c) => c.file))) {
      const list = fresh.filter((c) => c.kind === "modify" && c.file === file).sort((a, b) => a.start - b.start);
      const baseText = (await this.stet.textAt(base, file))!.text;
      const tipText = (await this.stet.textAt(tip, file))!.text;
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
        if (run.length < 2 || !run.some(repeats) || run.some((c) => this.stet.isKeyEdit(cfg, c) || c.note)) continue;
        const first = run[0]!;
        const last = run[run.length - 1]!;
        const merged = mergedEdit(file, baseText, tipText, { start: first.start, end: last.end, newStart: first.newStart, newEnd: last.newEnd });
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
        this.stet.setStatus(e, "withdrawn", "agent", "change removed from the agent workspace");
        await rec.putItem(e);
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
    const [csId] = await this.stet.store.allocate("changeset");
    // Changes are numbered within their round (submission): 12.1, 12.2, …
    const ids = fresh.map((_, k) => itemId(csId!, k + 1));
    const baseTextOf = async (c: Candidate) => (await this.stet.textAt(base, c.oldFile ?? c.file))?.text ?? "";
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
        note: c.note ?? null,
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
        this.stet.setStatus(item, "rejected", "stet", `repeat of ${prev.id}`);
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
      this.stet.setStatus(e, "superseded", "agent", `superseded by ${item.id}`);
      await rec.putItem(e);
      result.superseded.push(e.id);
    }
    // A move loses an item it can't do without: dissolve it, so its group isn't inherited by a
    // replacement that moves something else (an old move group ended up
    // linking unrelated items). Detection below pairs the remaining items again where it can.
    const gone = existing.filter((e) => result.superseded.includes(e.id) || result.withdrawn.includes(e.id));
    await this.stet.decisionOps.dissolveMoves(gone, new Map(allItems.map((i) => [i.id, i])), rec);

    // Conflicts with other agents' live items (same base only; others are checked at accept time).
    for (const other of allItems.filter((i) => i.agent !== agent.id && isLive(i.status) && i.baseCommit === base && i.kind === "modify")) {
      for (const it of created.filter((c) => c.file === other.file && c.kind === "modify" && isLive(c.status))) {
        if (overlaps(it.range, other.range)) {
          it.conflictsWith.push(other.id);
          other.conflictsWith.push(it.id);
          await rec.putItem(other);
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
        if (!created.includes(it)) await rec.putItem(it);
      }
    }

    // Groups: explicit hints + auto detection.
    const live = created.filter((i) => isLive(i.status));
    const drafts: GroupDraft[] = [];
    // Auto-detection also sees the agent's earlier pending items (a \label here, its \ref from before).
    const newIds = new Set(created.map((i) => i.id));
    const earlier = (await rec.items()).filter((i) => i.agent === agent.id && isLive(i.status) && !newIds.has(i.id) && !result.superseded.includes(i.id));
    // Moved passages (§6.4.7), decided as one change. Over all pending items: re-splitting at a
    // later submit can leave the two sides of a move in different rounds.
    for (const m of detectMoves([...earlier, ...live], cfg.grouping.moves, cfg.split.abbreviations, (it) => this.stet.profile(cfg, it.file).syntax)) {
      const move = { from: m.from.map((i) => i.id), to: m.to.map((i) => i.id), changed: m.changed };
      for (const it of [...m.from, ...m.to]) it.move = { from: [...move.from], to: [...move.to], changed: move.changed };
      result.moves.push(move);
      drafts.push({ kind: "linked", title: m.title, rationale: null, source: "auto", items: [...move.from, ...move.to] });
    }
    // Moved and rewritten beyond a move: accepting one half alone would lose or duplicate it.
    for (const m of detectRewritten([...earlier, ...live], cfg.grouping.moves, cfg.split.abbreviations, (it) => this.stet.profile(cfg, it.file).syntax)) {
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
        const units = parts?.length
          ? [...parts.map((p) => p.items), members.filter((m) => !parts!.some((p) => p.items.includes(m)))].filter((u) => u.length)
          : undefined;
        const comps = await this.stet.groupOps.dependencies(
          members.map((id) => known.get(id)).filter((x): x is Item => !!x),
          units,
        );
        if (comps.length > 1) {
          drafts.push({ kind: "related", title: h.title, rationale: h.rationale ?? null, source: "agent", items: members });
          const kept = comps.filter((c) => c.length > 1);
          for (const c of kept) {
            const part = parts?.find((p) => c.every((i) => p.items.includes(i)));
            drafts.push({
              kind: "linked",
              title: part?.title ?? `${h.title} (${c.length} changes that need each other)`,
              rationale: null,
              source: "auto",
              items: c,
            });
          }
          result.warnings.push(unlinkedWarning(h.title, kept));
          continue;
        }
      }
      const rationale = h.reason ? `Linked because: ${h.reason}${h.rationale ? `\n\n${h.rationale}` : ""}` : (h.rationale ?? null);
      drafts.push({ kind: h.kind, title: h.title, rationale, source: "agent", items: members, ...(parts ? { parts } : {}) });
    }
    drafts.push(...autoGroups([...earlier, ...live], cfg.grouping, (f) => this.stet.profile(cfg, f)).filter((d) => d.items.some((i) => newIds.has(i))));
    const finalDrafts = normalizeGroups(drafts);
    const gids = await this.stet.store.allocate("group", finalDrafts.length);
    const byId = new Map<string, Item>([...created, ...matched.values(), ...earlier].map((i) => [i.id, i]));
    // A replacement takes over the groups of the item it supersedes.
    const getItem = async (id: string) => byId.get(id) ?? (await rec.getItem(id)) ?? undefined;
    for (const { from, to } of inherited) {
      for (const gid of from.groups) {
        const g = await rec.getGroup(gid);
        if (!g || g.state === "resolved") continue;
        const swap = (ids: string[]) => ids.map((i) => (i === from.id ? to.id : i)).filter((x, k, arr) => arr.indexOf(x) === k);
        g.items = swap(g.items);
        if (g.parts) {
          g.parts = g.parts.map((p) => ({ ...p, items: swap(p.items) }));
          byId.set(to.id, to);
          result.warnings.push(...(await this.stet.groupOps.settleParts(g, getItem)));
        }
        await rec.putGroup(g);
        if (!to.groups.includes(gid)) to.groups.push(gid);
      }
    }
    const groups: Group[] = finalDrafts.map((d, k) => ({
      id: gids[k]!,
      agent: agent.id,
      changeset: csId!,
      kind: d.kind,
      title: d.title,
      rationale: d.rationale,
      source: d.source,
      items: d.items,
      ...(d.kind === "linked" && d.parts ? { parts: d.parts } : {}),
      state: "open",
    }));
    // Linked groups from earlier submissions that now share members get merged into the new one.
    const priorGroups = (await rec.groups()).filter((g) => g.agent === agent.id && g.kind === "linked" && g.state === "open");
    const merged = new Set<Group>();
    for (const g of groups.filter((g) => g.kind === "linked")) {
      for (const pg of priorGroups.filter((pg) => pg.items.some((i) => g.items.includes(i)))) {
        absorbLinked(g, pg);
        merged.add(g);
        for (const i of pg.items) {
          const it = byId.get(i) ?? (await rec.getItem(i));
          if (it) {
            it.groups = it.groups.filter((x) => x !== pg.id);
            byId.set(it.id, it);
          }
        }
        await rec.deleteGroup(pg.id);
      }
    }
    for (const g of groups) {
      for (const i of g.items) {
        const it = byId.get(i) ?? (await rec.getItem(i));
        if (it && !it.groups.includes(g.id)) {
          it.groups.push(g.id);
          byId.set(it.id, it);
        }
      }
      result.warnings.push(...(await this.stet.groupOps.settleParts(g, getItem, merged.has(g))));
      await rec.putGroup(g);
    }
    for (const it of byId.values()) if (!created.includes(it)) await rec.putItem(it);

    const changeset: Changeset = {
      id: csId!,
      agent: agent.id,
      title: opts.title,
      rationale: opts.rationale ?? "",
      submittedAt: now(),
      items: created.map((i) => i.id),
      groups: groups.map((g) => g.id),
    };
    for (const it of created) await rec.putItem(it);
    await rec.flush();
    await this.stet.store.putChangeset(changeset);
    await this.stet.store.appendEvent({ type: "items_submitted", agent: agent.id, items: created.map((i) => i.id), data: { changeset: changeset.id } });
    for (const id of result.repeats) {
      const it = byId.get(id)!;
      await this.stet.store.appendEvent({
        type: "repeat_rejected",
        agent: agent.id,
        items: [id],
        data: { item: await this.stet.describe(it), previous: it.history[it.history.length - 1]!.note },
      });
    }

    result.changeset = changeset;
    result.items = created;
    result.groups = groups;
    result.ungrouped = created.filter((i) => !i.groups.length && isLive(i.status)).map((i) => i.id);
  }

  async sync(agentId: string): Promise<SyncResult> {
    return this.stet.store.withLock(async () => {
      const agent = await this.stet.agentOps.requireAgent(agentId);
      if (agent.state !== "active") throw new StetError(archivedMessage(agent));
      const files = await this.stet.agentOps.agentFiles(agent);
      const dirty = await files.uncommitted();
      const tip = await files.tip();
      const refused = dirty.length
        ? `The agent workspace has uncommitted changes (${dirty.join(", ")}). Submit them (stet submit) or discard them before syncing.`
        : tip !== agent.lastTip
          ? "The agent workspace has unsubmitted commits. Submit them before syncing."
          : null;
      if (refused) {
        // Notes don't wait for a clean workspace: they arrive with the refusal (§7.8).
        const notes = await this.stet.noteOps.deliverNotes(agent);
        throw new StetError([refused, ...notes.map((d) => describeNote(d))].join("\n"));
      }
      const base = await this.stet.baseOps.ensureBase();
      const live = (await this.stet.store.items()).filter((i) => i.agent === agentId && isLive(i.status));
      const res = await applyItems(live, this.stet.treeView(base), { refText: this.stet.refText, neighbours: this.stet.neighbours });
      const stale: Item[] = [];
      const baseTexts = new Map<string, string>();
      for (const { item, reason } of res.failed) {
        await this.markStale(item, reason, { againstRev: base });
        stale.push(item);
      }
      for (const { item, span } of res.applied) {
        if (item.kind === "modify") {
          if (!baseTexts.has(item.file)) baseTexts.set(item.file, (await this.stet.textAt(base, item.file))!.text);
          const bt = baseTexts.get(item.file)!;
          item.range = { ...span };
          item.context = captureContext(bt, span.start, span.end);
        }
        item.baseCommit = base;
      }
      chainInsertions(
        res.applied.map((a) => a.item),
        compareItemIds,
      );
      for (const { item } of res.applied) await this.stet.store.putItem(item);
      const commit = res.changes.size
        ? await this.stet.repo.buildCommit({
            parents: [base],
            baseRev: base,
            changes: await this.stet.changesToCommitMap(res.changes),
            message: `stet: pending proposals of ${agentId}\n\nStet-Agent: ${agentId}`,
          })
        : base;
      await files.checkout(commit);
      agent.baseCommit = base;
      agent.lastTip = commit;
      agent.replayedAt = now();
      await this.stet.store.putAgent(agent);
      await this.stet.agentOps.refreshWorkspace(agent);
      await this.stet.store.appendEvent({ type: "synced", agent: agentId, data: { base, stale: stale.map((s) => s.id) } });
      await this.stet.groupOps.updateGroups(stale);
      const notes = await this.stet.noteOps.deliverNotes(agent);
      return { base, stale, kept: res.applied.length, notes };
    });
  }

  /** `staleBy`: the item whose accept made this one stale (undoing it makes this one pending again). */
  async markStale(item: Item, reason: string, opts: { againstRev?: string; staleBy?: string } = {}) {
    const againstRev = opts.againstRev;
    this.stet.setStatus(item, "stale", "stet", reason, opts.staleBy ? { staleBy: opts.staleBy } : {});
    await this.stet.store.putItem(item);
    let current: string | undefined;
    if (againstRev && item.kind === "modify") {
      const t = (await this.stet.textAt(againstRev, item.file))?.text;
      if (t) {
        const at = Math.min(item.range.start, t.length);
        current = t.slice(Math.max(0, at - 200), at + 200 + item.oldText.length);
      }
    }
    await this.stet.store.appendEvent({
      type: "stale",
      agent: item.agent,
      items: [item.id],
      data: { item: await this.stet.describe(item), reason, ...(current !== undefined ? { currentText: current } : {}) },
    });
  }
}
