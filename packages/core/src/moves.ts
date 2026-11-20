/**
 * Moves (spec §6.4.7): a longer passage deleted in one place and inserted in another, word for
 * word, is reviewed as one change instead of an unrelated deletion and insertion. Up to a few
 * changed words still count, and are shown; anything more stays a deletion and an insertion.
 */
import { diffArrays } from "diff";
import { isLive, moveFrom, moveTo, movesOut, type Item, type MoveInfo } from "./model.js";
import type { Edit } from "./split.js";
import { normalizeWs, sharedWords, wordSimilarity } from "./text.js";

export interface MoveSettings {
  enabled: boolean;
  minWords: number;
  maxChangedWords: number | null;
}

/** A deletion and an insertion this alike (word similarity) are one passage moved and rewritten. */
export const REWRITTEN_MIN = 0.5;

export interface MovePair {
  /** The deleting items, in the order their blocks appear in the insertion. */
  from: Item[];
  /** The inserting items, in the order their blocks appear in the deletion. */
  to: Item[];
  changed: number;
  title: string;
}

/** Blocks shorter than this aren't matched as pieces of a move of several blocks. */
const MIN_PIECE = 5;

/** Words of a passage: moves are compared word for word, spacing and line breaks aside. */
export const moveWords = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** Words that differ between two passages: for each differing stretch, the longer side. */
export function changedWords(a: string[], b: string[]): number {
  let n = 0;
  let removed = 0;
  let added = 0;
  for (const ch of diffArrays(a, b)) {
    const count = ch.count ?? ch.value.length;
    if (ch.removed) removed += count;
    else if (ch.added) added += count;
    else {
      n += Math.max(removed, added);
      removed = added = 0;
    }
  }
  return n + Math.max(removed, added);
}

/**
 * A lower bound of `changedWords` from the words shared in any order, without the diff: the words
 * of the longer side that the other doesn't have all count as changed.
 */
const fewestChanged = (a: string[], b: string[]): number => Math.max(a.length, b.length) - sharedWords(a, b);

/** How many changed words a passage of `words` words may have and still count as a move: one per 10, at least one. */
export const allowedChanges = (words: number, max: number | null): number => Math.min(max ?? Infinity, Math.max(1, Math.floor(words / 10)));

export interface MoveChange {
  /** Character range in the moved-in text (empty: words were dropped here). */
  start: number;
  end: number;
  /** The words of the moved-out text this replaces ("" for an addition). */
  was: string;
  now: string;
}

/** The paragraphs of a passage (split at blank lines), as word lists. */
const blocksOf = (s: string): string[][] => s.split(/\n[ \t]*\n/).map(moveWords).filter((w) => w.length);

/**
 * Do `a` and `b` hold the same paragraphs, possibly in another order? Pairs each block of `b`
 * with the closest unpaired block of `a`: `a`'s blocks in `b`'s order, and the words changed.
 * Null if the counts differ or more than `allowed` words change.
 */
function sameBlocks(a: string[][], b: string[][], allowed: number): { order: number[]; changed: number } | null {
  if (a.length < 2 || a.length !== b.length) return null;
  const left = new Set(a.keys());
  const order: number[] = [];
  let changed = 0;
  for (const bb of b) {
    let best = -1;
    let bestN = Infinity;
    for (const k of left) {
      if (Math.abs(a[k]!.length - bb.length) > allowed - changed) continue;
      if (fewestChanged(a[k]!, bb) >= Math.min(bestN, allowed - changed + 1)) continue;
      const n = changedWords(a[k]!, bb);
      if (n < bestN) [best, bestN] = [k, n];
      if (!n) break;
    }
    if (best < 0 || changed + bestN > allowed) return null;
    changed += bestN;
    left.delete(best);
    order.push(best);
  }
  return { order, changed };
}

/** Where the moved-in text differs from the moved-out text, word by word (paragraphs that changed order are compared with each other). */
export function moveChanges(fromText: string, toText: string): MoveChange[] {
  const fb = blocksOf(fromText);
  const sb = sameBlocks(fb, blocksOf(toText), Infinity);
  if (sb && sb.order.some((k, j) => k !== j) && sb.changed < changedWords(fb.flat(), moveWords(toText))) {
    fromText = sb.order.map((k) => fb[k]!.join(" ")).join("\n\n");
  }
  const words = [...toText.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  const out: MoveChange[] = [];
  let bi = 0;
  let pending: { was: string[]; now: typeof words } | null = null;
  const flush = () => {
    if (!pending) return;
    const now = pending.now;
    const at = now.length ? now[0]!.start : bi < words.length ? words[bi]!.start : toText.trimEnd().length;
    out.push({ start: at, end: now.length ? now[now.length - 1]!.end : at, was: pending.was.join(" "), now: now.map((w) => w.text).join(" ") });
    pending = null;
  };
  for (const ch of diffArrays(moveWords(fromText), words.map((w) => w.text))) {
    const count = ch.count ?? ch.value.length;
    if (ch.removed) (pending ??= { was: [], now: [] }).was.push(...ch.value);
    else if (ch.added) {
      (pending ??= { was: [], now: [] }).now.push(...words.slice(bi, bi + count));
      bi += count;
    } else {
      flush();
      bi += count;
    }
  }
  flush();
  return out;
}

/** A single sectioning or environment line, such as `\section{Results}` or `\end{proof}`. */
const isStructureLine = (t: string) => /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end)\*?\s*(?:\[[^\]]*\])?\{[^\n]*\}[^\n]*\s*$/.test(t) && !t.trim().includes("\n");

const SENTENCE_END = /[.?!][)\]}'"’”$]*$/;

function sentences(words: string[], abbreviations: Set<string>): number {
  return words.filter((w) => SENTENCE_END.test(w) && !abbreviations.has(w)).length;
}

/** A line that starts a LaTeX structure (section, environment, item): a paragraph may follow it directly. */
const STRUCTURE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end|item|label|caption|maketitle|noindent|medskip|bigskip|smallskip|par)\b/;

/** Is `text` (an item's old or new text, inside the item's context) a whole paragraph or environment? */
function wholeBlock(it: Item, text: string): string | null {
  const t = text.trim();
  const env = /^\\begin\s*\{([^}]+)\}/.exec(t)?.[1];
  if (env && new RegExp(`\\\\end\\s*\\{${env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}$`).test(t)) return `${env} environment`;
  const before = it.context.before + /^\s*/.exec(text)![0];
  const after = /\s*$/.exec(text)![0] + it.context.after;
  const prevLine = before.replace(/[ \t]*$/, "").split("\n").slice(-2, -1)[0];
  const starts = /(^|\n[ \t]*\n)[ \t]*$/.test(before) || (/\n[ \t]*$/.test(before) && prevLine !== undefined && STRUCTURE.test(prevLine));
  const nextLine = after.replace(/^[ \t]*/, "").split("\n")[1];
  const ends = /^[ \t]*(\n[ \t]*\n|\n?[ \t]*$)/.test(after) || (/^[ \t]*\n/.test(after) && nextLine !== undefined && STRUCTURE.test(nextLine));
  return starts && ends ? "paragraph" : null;
}

const short = (s: string) => {
  const t = normalizeWs(s);
  return t.length > 30 ? t.slice(0, 29) + "…" : t;
};

const howChanged = (changed: number) => (changed ? `${changed} word${changed > 1 ? "s" : ""} changed` : "unchanged");

/**
 * Where `small`'s words occur in `big` as (nearly) one stretch: first and last word index in
 * `big`, or null. Exact occurrences first; otherwise at most `allowed` words may differ.
 */
function within(small: string[], big: string[], allowed: number): [number, number] | null {
  outer: for (let k = 0; k + small.length <= big.length; k++) {
    for (let j = 0; j < small.length; j++) if (big[k + j] !== small[j]) continue outer;
    return [k, k + small.length - 1];
  }
  if (!allowed || small.length - sharedWords(small, big) > allowed) return null;
  let bi = 0;
  let first = -1;
  let last = -1;
  let common = 0;
  for (const ch of diffArrays(small, big)) {
    const n = ch.count ?? ch.value.length;
    if (ch.added) bi += n;
    else if (!ch.removed) {
      if (first < 0) first = bi;
      last = bi + n - 1;
      common += n;
      bi += n;
    }
  }
  if (first < 0 || small.length - common > allowed || last - first + 1 > small.length + allowed) return null;
  return [first, last];
}

/**
 * Moves among an agent's pending items (§6.4.7), exact ones first (any rounds: re-splitting at a
 * later submit can put the two sides of a move into different rounds):
 * - a deletion and an insertion of the same passage, or of the same paragraphs in another order;
 * - several deleted blocks that land next to each other, so they form one insertion;
 * - one deleted stretch of several blocks that go to different places.
 * The moved text must have at least `minWords` words, be two sentences or more or whole
 * paragraphs/environments, and differ in no more words than allowed.
 */
export function detectMoves(items: Item[], s: MoveSettings, abbreviations: string[]): MovePair[] {
  if (!s.enabled) return [];
  const abbr = new Set(abbreviations);
  const mods = items.filter((i) => i.kind === "modify" && isLive(i.status) && !i.move);
  const dels = mods.filter((i) => i.oldText.trim() && !i.newText.trim());
  const ins = mods.filter((i) => i.newText.trim() && !i.oldText.trim());
  const used = new Set<string>();
  const out: MovePair[] = [];

  // One block to one place.
  const cands: MovePair[] = [];
  for (const d of dels) {
    const dw = moveWords(d.oldText);
    // A heading or environment line moved as it is counts, however short: alone, its deletion
    // or insertion would lose or duplicate it.
    const line = isStructureLine(d.oldText);
    if (dw.length < s.minWords && !line) continue;
    const allowed = allowedChanges(dw.length, s.maxChangedWords);
    for (const i of ins) {
      if (i.agent !== d.agent) continue;
      const iw = moveWords(i.newText);
      if (dw.length < s.minWords && normalizeWs(d.oldText) !== normalizeWs(i.newText)) continue;
      if (dw.length < s.minWords) {
        cands.push({ from: [d], to: [i], changed: 0, title: `Move “${short(d.oldText)}” (${/\\(?:begin|end)\b/.test(d.oldText) ? "environment line" : "heading"}, unchanged)` });
        continue;
      }
      if (Math.abs(dw.length - iw.length) > allowed) continue;
      // Also bounds a reordering (`sameBlocks`): its blocks hold the same words.
      if (fewestChanged(dw, iw) > allowed) continue;
      let changed = changedWords(dw, iw);
      // Two blocks that were next to each other at both ends, in swapped order, come out as one
      // deletion and one insertion (bug report 2026-11-13).
      let blocks: string[][] | null = null;
      if (changed > allowed) {
        const sb = sameBlocks(blocksOf(d.oldText), blocksOf(i.newText), allowed);
        if (!sb) continue;
        changed = sb.changed;
        blocks = blocksOf(d.oldText);
      }
      const n = sentences(dw, abbr);
      const block = wholeBlock(d, d.oldText) ?? wholeBlock(i, i.newText);
      if (n < 1 && !block) continue;
      const what = block && block !== "paragraph" ? block : n >= 2 ? `${n} sentences` : n === 1 && !block ? "sentence" : "paragraph";
      const title = blocks
        ? `Move ${blocks.length} passages ${blocks.map((b) => `“${short(b.join(" "))}”`).join(", ")} (reordered, ${n >= 2 ? `${n} sentences` : "paragraphs"}, ${howChanged(changed)})`
        : `Move “${short(d.oldText)}” (${what}, ${howChanged(changed)})`;
      cands.push({ from: [d], to: [i], changed, title });
    }
  }
  cands.sort((a, b) => a.changed - b.changed);
  for (const c of cands) {
    if (used.has(c.from[0]!.id) || used.has(c.to[0]!.id)) continue;
    used.add(c.from[0]!.id);
    used.add(c.to[0]!.id);
    out.push(c);
  }

  // Several blocks: one item on one side holds them all, one item each on the other.
  const sides = [
    { bigs: ins, smalls: dels, bigText: (i: Item) => i.newText, smallText: (i: Item) => i.oldText, into: true },
    { bigs: dels, smalls: ins, bigText: (i: Item) => i.oldText, smallText: (i: Item) => i.newText, into: false },
  ];
  for (const { bigs, smalls, bigText, smallText, into } of sides) {
    for (const big of bigs) {
      if (used.has(big.id)) continue;
      const bw = moveWords(bigText(big));
      if (bw.length < s.minWords) continue;
      const allowed = allowedChanges(bw.length, s.maxChangedWords);
      const found: { item: Item; words: string[]; at: [number, number] }[] = [];
      for (const sm of smalls) {
        if (used.has(sm.id) || sm.agent !== big.agent) continue;
        const sw = moveWords(smallText(sm));
        if (sw.length < MIN_PIECE) continue;
        const at = within(sw, bw, allowed);
        if (at) found.push({ item: sm, words: sw, at });
      }
      found.sort((a, b) => a.at[0] - b.at[0]);
      const pieces: typeof found = [];
      for (const f of found) if (!pieces.length || f.at[0] > pieces[pieces.length - 1]!.at[1]) pieces.push(f);
      if (pieces.length < 2) continue;
      const changed = changedWords(pieces.flatMap((p) => p.words), bw);
      if (changed > allowed) continue;
      const n = sentences(bw, abbr);
      if (n < 1 && !pieces.every((p) => wholeBlock(p.item, smallText(p.item)))) continue;
      for (const x of [big, ...pieces.map((p) => p.item)]) used.add(x.id);
      const blocks = pieces.map((p) => p.item);
      const names = blocks.map((b) => `“${short(smallText(b))}”`).join(", ");
      out.push({
        from: into ? blocks : [big],
        to: into ? [big] : blocks,
        changed,
        title: `Move ${blocks.length} passages ${names} (${n >= 2 ? `${n} sentences` : "paragraphs"}, ${howChanged(changed)})`,
      });
    }
  }
  return mergeNeighbours(out, abbr);
}

/**
 * Moves of neighbouring blocks are one move: paragraphs moved together (their deletions next to
 * each other) or landing together (their insertions at one place). Each new paragraph is a
 * change of its own, so a move of three paragraphs is first found as three.
 */
function mergeNeighbours(moves: MovePair[], abbr: Set<string>): MovePair[] {
  const pos = (i: Item) => [i.file, i.range.start, i.range.end] as const;
  const before = (a: Item, b: Item) => a.file.localeCompare(b.file) || a.range.start - b.range.start || compareIds(a.id, b.id);
  // Next to each other where they left and where they landed, in the same order: one block moved.
  // (Only one side next to each other is separate moves: a reordered section is many moves, not
  // one all-or-nothing change.)
  const follows = (a: MovePair, b: MovePair) =>
    a.from.some((x) => b.from.some((y) => x.file === y.file && x.range.end === y.range.start)) &&
    // Insertions take no room in the old text: at one place, their order is that of their ids.
    a.to.some((x) => b.to.some((y) => pos(x)[0] === pos(y)[0] && x.range.start === y.range.start && compareIds(x.id, y.id) < 0));
  const touching = (a: MovePair, b: MovePair) => follows(a, b) || follows(b, a);
  const list = [...moves];
  for (let merged = true; merged; ) {
    merged = false;
    for (let a = 0; a < list.length && !merged; a++) {
      for (let b = a + 1; b < list.length && !merged; b++) {
        if (!touching(list[a]!, list[b]!)) continue;
        const [m1, m2] = [list[a]!, list[b]!];
        const from = [...m1.from, ...m2.from];
        const to = [...m1.to, ...m2.to].sort(before);
        // `from` in the order the blocks land, `to` in the order they left.
        const landing = (d: Item) => [m1, m2].find((m) => m.from.includes(d))!.to[0]!;
        from.sort((x, y) => before(landing(x), landing(y)) || before(x, y));
        const names = from.map((d) => `“${short(d.oldText)}”`).join(", ");
        const changed = m1.changed + m2.changed;
        const n = sentences(from.flatMap((d) => moveWords(d.oldText)), abbr);
        const reordered = from.some((d, k) => k > 0 && before(from[k - 1]!, d) > 0);
        list.splice(b, 1);
        list[a] = { from, to, changed, title: `Move ${from.length} passages ${names} (${reordered ? "reordered, " : ""}${n >= 2 ? `${n} sentences` : "paragraphs"}, ${howChanged(changed)})` };
        merged = true;
      }
    }
  }
  return list;
}

const compareIds = (a: string, b: string) => {
  const p = (x: string) => x.split(".").map((k) => Number(k.replace(/\D/g, "")) || 0);
  const [x, y] = [p(a), p(b)];
  for (let k = 0; k < Math.max(x.length, y.length); k++) if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) - (y[k] ?? 0);
  return 0;
};

/**
 * Passages moved and rewritten too much to count as moves (§6.4.7): a deletion and an insertion
 * of the same agent, a sentence or more of at least `minWords` words each, at least REWRITTEN_MIN
 * alike. Accepting only one of them would lose or duplicate the passage, so they are linked.
 */
export function detectRewritten(items: Item[], s: MoveSettings, abbreviations: string[]): { from: Item; to: Item; title: string }[] {
  if (!s.enabled) return [];
  const abbr = new Set(abbreviations);
  const mods = items.filter((i) => i.kind === "modify" && isLive(i.status) && !i.move);
  const passage = (i: Item, text: string) => {
    const w = moveWords(text);
    return w.length >= s.minWords && (sentences(w, abbr) >= 1 || !!wholeBlock(i, text)) ? w : null;
  };
  const dels = mods.flatMap((i) => (i.oldText.trim() && !i.newText.trim() ? [{ i, w: passage(i, i.oldText) }] : [])).filter((x) => x.w);
  const ins = mods.flatMap((i) => (i.newText.trim() && !i.oldText.trim() ? [{ i, w: passage(i, i.newText) }] : [])).filter((x) => x.w);
  const cands: { from: Item; to: Item; sim: number }[] = [];
  for (const d of dels) {
    for (const n of ins) {
      if (n.i.agent !== d.i.agent) continue;
      const sim = wordSimilarity(d.w!, n.w!, REWRITTEN_MIN);
      if (sim >= REWRITTEN_MIN) cands.push({ from: d.i, to: n.i, sim });
    }
  }
  cands.sort((a, b) => b.sim - a.sim);
  const used = new Set<string>();
  const out: { from: Item; to: Item; title: string }[] = [];
  for (const c of cands) {
    if (used.has(c.from.id) || used.has(c.to.id)) continue;
    used.add(c.from.id);
    used.add(c.to.id);
    out.push({ ...c, title: `Moved and rewritten “${short(c.from.oldText)}”` });
  }
  return out;
}

/**
 * Take apart unrelated replacements (`Edit.halves`) where a half may belong to a move: the
 * paragraph replaced here was moved elsewhere, or the new one came from elsewhere. Their halves
 * then meet their other ends in move detection; other replacements stay one change.
 */
export function separateMoved<T extends Edit>(cands: T[], others: { oldText: string; newText: string }[], s: MoveSettings): T[] {
  if (!s.enabled || !cands.some((c) => c.halves)) return cands;
  const w = (t: string) => moveWords(t);
  const enough = (x: string[]) => x.length >= s.minWords;
  // Whole deletions and insertions, from these changes and the agent's others.
  const pureDel = (x: { oldText: string; newText: string }) => !!x.oldText.trim() && !x.newText.trim();
  const pureIns = (x: { oldText: string; newText: string }) => !!x.newText.trim() && !x.oldText.trim();
  const dels: { src: unknown; w: string[] }[] = [];
  const ins: { src: unknown; w: string[] }[] = [];
  for (const c of [...cands, ...others]) {
    if (pureDel(c)) dels.push({ src: c, w: w(c.oldText) });
    if (pureIns(c)) ins.push({ src: c, w: w(c.newText) });
  }
  for (const c of cands) {
    for (const h of c.halves ?? []) {
      if (pureDel(h)) dels.push({ src: c, w: w(h.oldText) });
      if (pureIns(h)) ins.push({ src: c, w: w(h.newText) });
    }
  }
  const matches = (x: string[], pool: { src: unknown; w: string[] }[], self: unknown) =>
    enough(x) && pool.some((p) => p.src !== self && enough(p.w) && wordSimilarity(x, p.w, REWRITTEN_MIN) >= REWRITTEN_MIN);
  return cands.flatMap((c) => {
    if (!c.halves) return [c];
    const moved = c.halves.some((h) => (pureDel(h) && matches(w(h.oldText), ins, c)) || (pureIns(h) && matches(w(h.newText), dels, c)));
    if (!moved) return [c];
    const { halves, ...rest } = c;
    return halves!.map((h) => ({ ...rest, ...h })) as T[];
  });
}

/** The whole moved-out and moved-in text of a move, blocks in order; null if an item is missing. */
export function moveTexts(m: MoveInfo, get: (id: string) => Item | undefined): { from: string; to: string } | null {
  const from = moveFrom(m).map(get);
  const to = moveTo(m).map(get);
  if (from.some((x) => !x) || to.some((x) => !x)) return null;
  return { from: from.map((x) => x!.oldText).join("\n"), to: to.map((x) => x!.newText).join("\n") };
}

/** Where an inserting item of a move differs from what was moved out (offsets in its new text). */
export function moveChangesOf(item: Item, get: (id: string) => Item | undefined): MoveChange[] {
  if (!item.move || movesOut(item)) return [];
  const from = moveFrom(item.move).map(get);
  const to = moveTo(item.move).map(get);
  if (from.some((x) => !x) || to.some((x) => !x)) return [];
  let toText = "";
  let mine: [number, number] = [0, 0];
  for (const t of to) {
    if (t!.id === item.id) mine = [toText.length, toText.length + t!.newText.length];
    toText += t!.newText + "\n";
  }
  return moveChanges(from.map((x) => x!.oldText).join("\n"), toText)
    .filter((c) => c.start >= mine[0] && c.start <= mine[1])
    .map((c) => ({ ...c, start: c.start - mine[0], end: Math.min(c.end, mine[1]) - mine[0] }));
}
