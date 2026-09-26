/** Relocating an item in changed text (spec §8). */
import { diffLines } from "diff";
import { allIndexesOf, similarity } from "./text.js";

export interface Anchorable {
  oldText: string;
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

/**
 * Map an offset from `ref` to `target` through a line diff.
 * Returns null when the offset lies inside a changed region.
 */
function makeMapper(ref: string, target: string): (offset: number, isEnd: boolean) => number | null {
  const segs: { refStart: number; refEnd: number; tgtStart: number; equal: boolean }[] = [];
  let r = 0;
  let t = 0;
  for (const ch of diffLines(ref, target)) {
    const len = ch.value.length;
    if (ch.added) {
      segs.push({ refStart: r, refEnd: r, tgtStart: t, equal: false });
      t += len;
    } else if (ch.removed) {
      segs.push({ refStart: r, refEnd: r + len, tgtStart: t, equal: false });
      r += len;
    } else {
      segs.push({ refStart: r, refEnd: r + len, tgtStart: t, equal: true });
      r += len;
      t += len;
    }
  }
  return (offset, isEnd) => {
    for (const s of segs) {
      if (!s.equal) continue;
      const inside = isEnd ? offset > s.refStart && offset <= s.refEnd : offset >= s.refStart && offset < s.refEnd;
      if (inside) return s.tgtStart + (offset - s.refStart);
    }
    // Offset at the very end of the text.
    if (offset === ref.length && isEnd !== undefined) {
      const last = segs[segs.length - 1];
      if (!last || last.equal) return target.length;
    }
    return null;
  };
}

/**
 * Find where `item` (defined against `ref`) now lives in `target`.
 * `ref` may be omitted when the base text is unavailable; steps 1–2 are then skipped.
 */
export function anchor(item: Anchorable, target: string, ref?: string): Span | null {
  const { oldText, range, context } = item;
  const check = (s: number, e: number) => target.slice(s, e) === oldText;

  // 1. Fast path.
  if (ref !== undefined && ref === target) return check(range.start, range.end) ? { ...range } : null;

  // 2. Mapped path.
  if (ref !== undefined) {
    const map = makeMapper(ref, target);
    const s = oldText ? map(range.start, false) : map(range.start, true) ?? map(range.start, false);
    const e = oldText ? map(range.end, true) : s;
    if (s !== null && e !== null && e - s === oldText.length && check(s, e)) {
      // Pure insertions also need their context to still match on at least one side.
      if (oldText || target.slice(0, s).endsWith(context.before.slice(-20)) || target.slice(s).startsWith(context.after.slice(0, 20)))
        return { start: s, end: e };
    }
  }

  // 3. Exact search with full context.
  const full = context.before + oldText + context.after;
  const hits = allIndexesOf(target, full);
  if (hits.length === 1) {
    const s = hits[0]! + context.before.length;
    return { start: s, end: s + oldText.length };
  }

  // 4. Fuzzy: candidate positions scored by context similarity.
  const candidates = new Set<number>();
  if (oldText) for (const i of allIndexesOf(target, oldText)) candidates.add(i);
  else {
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
