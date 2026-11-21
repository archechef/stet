/**
 * What changes inside one item, for display: an item is kept whole for review (e.g. a whole
 * formula), but the editor shows only the tokens that actually differ.
 */
import { diffArrays } from "diff";
import { type Token, tokenizeWords } from "./tokenizer.js";

export interface InlineDiff {
  /** Spans of the old text that are removed, [start, end) offsets into the old text. */
  removed: [number, number][];
  /** Text inserted at an offset of the old text (after the removed span ending there, if any). */
  inserted: { at: number; text: string }[];
}

interface Hunk {
  /** Removed span in the old text (empty for pure insertions). */
  start: number;
  end: number;
  /** Inserted span in the new text. */
  nStart: number;
  nEnd: number;
}

/**
 * Token-level difference between `oldText` and `newText`. Whitespace is left out of the matching
 * (re-wrapped lines are no change, and struck-through spaces are invisible). Hunks separated only
 * by whitespace are merged, and a mostly rewritten text is shown as one replacement: word-by-word
 * confetti is harder to read than the whole. `tokenize`: the language's (its profile's syntax).
 */
export function inlineDiff(oldText: string, newText: string, tokenize: (text: string) => Token[] = tokenizeWords): InlineDiff {
  const whole: InlineDiff = {
    removed: oldText ? [[0, oldText.length]] : [],
    inserted: newText ? [{ at: oldText.length, text: newText }] : [],
  };
  if (!oldText || !newText) return whole;

  const solid = (t: Token) => t.type !== "ws" && t.type !== "parbreak";
  const ot = tokenize(oldText).filter(solid);
  const nt = tokenize(newText).filter(solid);
  const end = (t: Token) => t.start + t.text.length;
  const hunks: Hunk[] = [];
  let oi = 0;
  let ni = 0;
  let kept = 0;
  let open: Hunk | null = null;
  // Where an insertion goes when nothing is removed: right after the last kept old token.
  const after = () => (oi > 0 ? end(ot[oi - 1]!) : 0);
  for (const ch of diffArrays(ot, nt, { comparator: (a, b) => a.text === b.text })) {
    const n = ch.count ?? ch.value.length;
    if (!ch.added && !ch.removed) {
      if (open) {
        hunks.push(open);
        open = null;
      }
      oi += n;
      ni += n;
      kept += n;
      continue;
    }
    open ??= { start: after(), end: after(), nStart: -1, nEnd: -1 };
    if (ch.removed) {
      if (open.end === open.start) open.start = ot[oi]!.start;
      oi += n;
      open.end = end(ot[oi - 1]!);
    } else {
      if (open.nStart < 0) open.nStart = nt[ni]!.start;
      ni += n;
      open.nEnd = end(nt[ni - 1]!);
    }
  }
  if (open) hunks.push(open);
  if (!hunks.length) return breaksOnly(oldText, newText) ?? whole;

  // Merge hunks separated only by whitespace: "a b" → "c d" reads better as one replacement.
  const merged: Hunk[] = [];
  for (const h of hunks) {
    const prev = merged[merged.length - 1];
    if (prev && /^\s*$/.test(oldText.slice(prev.end, h.start))) {
      prev.end = Math.max(prev.end, h.end);
      if (h.nStart >= 0) {
        if (prev.nStart < 0) prev.nStart = h.nStart;
        prev.nEnd = h.nEnd;
      }
    } else merged.push({ ...h });
  }

  if (!merged.length || kept < ot.length / 2) return whole;
  // A pure insertion brings the whitespace before it, or it would stick to the preceding word.
  for (const h of merged) {
    if (h.end === h.start && h.nStart > 0) while (h.nStart > 0 && /\s/.test(newText[h.nStart - 1]!)) h.nStart--;
  }
  return {
    removed: merged.filter((h) => h.end > h.start).map((h) => [h.start, h.end]),
    inserted: merged.filter((h) => h.nStart >= 0).map((h) => ({ at: h.end, text: newText.slice(h.nStart, h.nEnd) })),
  };
}

/** The whitespace before each word of `s`, and after the last: [start, end) offsets. */
function gaps(s: string): [number, number][] {
  const out: [number, number][] = [];
  let prev = 0;
  for (const m of s.matchAll(/\S+/g)) {
    out.push([prev, m.index]);
    prev = m.index + m[0].length;
  }
  out.push([prev, s.length]);
  return out;
}

/**
 * The same words with paragraph breaks added, removed or moved (a sentence that now starts the
 * next paragraph): just those breaks, not the whole text struck through and inserted again.
 */
function breaksOnly(oldText: string, newText: string): InlineDiff | null {
  const [og, ng] = [gaps(oldText), gaps(newText)];
  if (og.length !== ng.length || og.length < 2) return null;
  const br = /\n[ \t]*\n/;
  const d: InlineDiff = { removed: [], inserted: [] };
  og.forEach(([a, b], i) => {
    const [c, e] = ng[i]!;
    if (br.test(oldText.slice(a, b)) === br.test(newText.slice(c, e))) return;
    if (b > a) d.removed.push([a, b]);
    d.inserted.push({ at: b, text: newText.slice(c, e) });
  });
  return d.inserted.length ? d : null;
}
