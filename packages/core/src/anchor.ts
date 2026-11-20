/** Relocating an item in changed text (spec §8). */
import { diffLines } from "diff";
import { allIndexesOf, similarity } from "./text.js";

export interface Anchorable {
  oldText: string;
  /** The text replacing it (for accepted items: the text actually applied). See `insideNewText`. */
  newText?: string;
  range: { start: number; end: number };
  context: { before: string; after: string };
}

export interface Span {
  start: number;
  end: number;
}

export const CONTEXT_CHARS = 80;
const FUZZY_THRESHOLD = 0.8;
const FUZZY_MARGIN = 0.05;

export function captureContext(text: string, start: number, end: number): { before: string; after: string } {
  return { before: text.slice(Math.max(0, start - CONTEXT_CHARS), start), after: text.slice(end, end + CONTEXT_CHARS) };
}

/** A change accepted from the same base: where it was, and the text that replaced it. */
export interface Neighbour {
  range: Span;
  oldText: string;
  text: string;
}

/**
 * `anchor`, and if that fails, again with `neighbours` (changes accepted from the item's base)
 * made in `ref` too. A change right next to an accepted one has lost the context on that side:
 * a sentence rewritten up to the line break that the next change removes (bug report
 * 2026-11-18). With the neighbours in its reference, that context is the accepted text.
 */
export function anchorNear(item: Anchorable, target: string, ref: string | undefined, neighbours: Neighbour[]): Span | null {
  const span = anchor(item, target, ref);
  if (span || ref === undefined) return span;
  const { start, end } = item.range;
  const others = neighbours
    .filter((n) => n.range.end <= start || n.range.start >= end)
    .filter((n) => ref.slice(n.range.start, n.range.end) === n.oldText)
    .sort((a, b) => a.range.start - b.range.start);
  if (!others.length) return null;
  let text = "";
  let pos = 0;
  let shift = 0;
  for (const n of others) {
    if (n.range.start < pos) return null; // neighbours overlapping each other: give up
    text += ref.slice(pos, n.range.start) + n.text;
    pos = n.range.end;
    if (n.range.end <= start) shift += n.text.length - n.oldText.length;
  }
  text += ref.slice(pos);
  const range = { start: start + shift, end: end + shift };
  if (text.slice(range.start, range.end) !== item.oldText) return null;
  return anchor({ ...item, range, context: captureContext(text, range.start, range.end) }, target, text);
}

/**
 * Several insertions at one spot (entries appended to a .bib file, paragraphs added at the end of
 * a section) have the same position and surroundings, so once one of them is applied the others
 * could land before it. Give each later one (in item order) the earlier ones' text as part of
 * the context before it, so it finds its place after them. Changes `items` in place.
 */
export function chainInsertions(
  items: { id: string; file: string; kind: string; oldText: string; newText: string; range: Span; context: { before: string; after: string } }[],
  order: (a: string, b: string) => number,
): void {
  const spots = new Map<string, typeof items>();
  for (const it of items) {
    if (it.kind !== "modify" || it.oldText !== "" || it.range.start !== it.range.end) continue;
    const key = `${it.file}\0${it.range.start}`;
    spots.set(key, [...(spots.get(key) ?? []), it]);
  }
  for (const list of spots.values()) {
    list.sort((a, b) => order(a.id, b.id));
    let earlier = "";
    for (const it of list) {
      if (earlier) it.context = { ...it.context, before: (it.context.before + earlier).slice(-CONTEXT_CHARS) };
      earlier += it.newText;
    }
  }
}

/**
 * Map an offset from `ref` to `target` through a line diff.
 * Returns null when the offset lies inside a changed region.
 */
type Mapper = ((offset: number, isEnd: boolean) => number | null) & {
  /** Whether [start, end) of the target lies in text unchanged from the reference (somewhere). */
  unchanged(start: number, end: number): boolean;
};

/**
 * Recently built mappers. Locating many items of one file against the same two texts (an editor
 * buffer, an accept, a sync) then costs one line diff instead of one per item.
 */
const mapperCache: { ref: string; target: string; map: Mapper }[] = [];
const MAPPER_CACHE_SIZE = 4;

function makeMapper(ref: string, target: string): Mapper {
  const hit = mapperCache.find((c) => c.ref === ref && c.target === target);
  if (hit) return hit.map;
  const map = buildMapper(ref, target);
  mapperCache.unshift({ ref, target, map });
  mapperCache.length = Math.min(mapperCache.length, MAPPER_CACHE_SIZE);
  return map;
}

function buildMapper(ref: string, target: string): Mapper {
  // Unchanged stretches, in order; everything between them changed.
  const equal: { refStart: number; refEnd: number; tgtStart: number }[] = [];
  let r = 0;
  let t = 0;
  let lastEqual = true;
  for (const ch of diffLines(ref, target)) {
    const len = ch.value.length;
    if (ch.added) t += len;
    else if (ch.removed) r += len;
    else {
      equal.push({ refStart: r, refEnd: r + len, tgtStart: t });
      r += len;
      t += len;
    }
    lastEqual = !ch.added && !ch.removed;
  }
  const map = (offset: number, isEnd: boolean) => {
    // Binary search for the stretch containing the offset (ends are inclusive for range ends).
    let lo = 0;
    let hi = equal.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = equal[mid]!;
      if (isEnd ? offset <= s.refStart : offset < s.refStart) hi = mid - 1;
      else if (isEnd ? offset > s.refEnd : offset >= s.refEnd) lo = mid + 1;
      else return s.tgtStart + (offset - s.refStart);
    }
    // Offset at the very end of the text.
    if (offset === ref.length && isEnd !== undefined && lastEqual) return target.length;
    return null;
  };
  const unchanged = (start: number, end: number) => equal.some((s) => s.tgtStart <= start && end <= s.tgtStart + (s.refEnd - s.refStart));
  return Object.assign(map, { unchanged });
}

/**
 * Find where `item` (defined against `ref`) now lives in `target`.
 * `ref` may be omitted when the base text is unavailable; steps 1–2 are then skipped.
 * Null if the old text isn't there, or only as part of the item's new text (the change is
 * already in `target`).
 */
export function anchor(item: Anchorable, target: string, ref?: string): Span | null {
  const span = findOldText(item, target, ref);
  return span && item.newText !== undefined && insideNewText(item.oldText, item.newText, target, span) ? null : span;
}

/**
 * Whether the old text found at `span` is part of the new text, i.e. the change has already been
 * made there. When the new text contains the old (pk → \pk, H → \Hash), the old text is still
 * found after the change; applying it again gave \\pk and \\Hashash (bug report 2026-10-21).
 */
export function insideNewText(oldText: string, newText: string, target: string, span: Span): boolean {
  if (newText.length <= oldText.length) return false;
  for (let k = newText.indexOf(oldText); k >= 0; k = newText.indexOf(oldText, k + 1)) {
    const s = span.start - k;
    if (s >= 0 && target.startsWith(newText, s)) return true;
    if (k >= newText.length) break; // an empty old text matches at every offset
  }
  return false;
}

/** The one place where the old text appears with its whole context, or null. */
function exactWithContext({ oldText, context }: Anchorable, target: string): Span | null {
  const hits = allIndexesOf(target, context.before + oldText + context.after);
  if (hits.length !== 1) return null;
  const s = hits[0]! + context.before.length;
  return { start: s, end: s + oldText.length };
}

function findOldText(item: Anchorable, target: string, ref?: string): Span | null {
  const { oldText, range, context } = item;
  const check = (s: number, e: number) => target.slice(s, e) === oldText;

  // 1. Fast path.
  if (ref !== undefined && ref === target) return check(range.start, range.end) ? { ...range } : null;

  const mapper = ref !== undefined ? makeMapper(ref, target) : null;
  // Where the old text is in text unchanged from the reference but not at the item's place, it
  // is another occurrence (the mapped path would have found the item's own): never the item's.
  // An undo found another accepted change's words there and reverted that one (test report
  // v0.16.0, D1).
  const elsewhere = (sp: Span) => !!oldText && !!mapper?.unchanged(sp.start, sp.end);

  // 2. Mapped path.
  if (ref !== undefined) {
    const map = mapper!;
    if (oldText) {
      const s = map(range.start, false);
      const e = map(range.end, true);
      if (s !== null && e !== null && e - s === oldText.length && check(s, e)) return { start: s, end: e };
    } else {
      // A pure insertion where the target has new text of its own lands before or after that
      // text. Prefer the side its context says (an insertion after another one at the same spot
      // carries that one's text in its context, see `chainInsertions`); else the side where the
      // following text still matches. At least one side of the context must still match.
      const sides = [map(range.start, true), map(range.start, false) ?? (range.start === ref.length ? target.length : null)];
      const at = [...new Set(sides.filter((s): s is number => s !== null))];
      const tail = context.before.slice(-20);
      const head = context.after.slice(0, 20);
      const s = at.find((s) => tail && target.slice(0, s).endsWith(tail));
      if (s !== undefined) return { start: s, end: s };
      // Only the following text matches here: the full context may still be found elsewhere.
      const exact = exactWithContext(item, target);
      if (exact) return exact;
      const t = at.find((s) => target.slice(s).startsWith(head));
      if (t !== undefined) return { start: t, end: t };
    }
  }

  // 3. Exact search with full context.
  const exact = exactWithContext(item, target);
  if (exact && !elsewhere(exact)) return exact;

  // 4. Fuzzy: candidate positions scored by context similarity.
  const candidates = new Set<number>();
  if (oldText) {
    for (const i of allIndexesOf(target, oldText)) if (!elsewhere({ start: i, end: i + oldText.length })) candidates.add(i);
  } else {
    const tail = context.before.slice(-20);
    const head = context.after.slice(0, 20);
    if (tail) for (const i of allIndexesOf(target, tail)) candidates.add(i + tail.length);
    if (head) for (const i of allIndexesOf(target, head)) candidates.add(i);
  }
  if (candidates.size > 5000) return null;
  const scored = [...candidates].map((s) => {
    const e = s + oldText.length;
    const before = target.slice(Math.max(0, s - context.before.length), s);
    const after = target.slice(e, e + context.after.length);
    const score = (similarity(before, context.before) + similarity(after, context.after)) / 2;
    return { s, e, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < FUZZY_THRESHOLD) return null;
  const second = scored[1];
  if (second && second.score > best.score - FUZZY_MARGIN) return null;
  return { start: best.s, end: best.e };
}
