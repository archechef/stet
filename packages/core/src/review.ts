/**
 * The review document of a file: the reviewer's text with every pending change in it applied,
 * which they can edit like text before deciding ("Review all changes in this file").
 * Edits inside a change become the reviewer's wording for it (a draft: the change stays pending
 * until they accept it); words reworded right next to a change make it grow to take them in;
 * edits elsewhere belong in the file itself and are refused.
 */
import { diffChars, diffWordsWithSpace } from "diff";

export interface ReviewChange {
  id: string;
  /** Where the change's old text is in the reviewer's current text. */
  start: number;
  end: number;
  /** The text shown for it: the reviewer's wording if they have one, else the agent's. */
  text: string;
}

export interface ReviewDocument {
  content: string;
  /** Where each change's text is in `content`, in order. */
  regions: { id: string; start: number; end: number }[];
  /** Changes left out because they overlap one shown before them (another agent's, say). */
  skipped: string[];
}

/** Apply `changes` to `text` (those that don't overlap an earlier one, in order of position). */
export function reviewDocument(text: string, changes: ReviewChange[]): ReviewDocument {
  const sorted = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: ReviewChange[] = [];
  const skipped: string[] = [];
  for (const c of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && c.start < prev.end) skipped.push(c.id);
    else kept.push(c);
  }
  let content = "";
  let pos = 0;
  const regions: ReviewDocument["regions"] = [];
  for (const c of kept) {
    content += text.slice(pos, c.start);
    regions.push({ id: c.id, start: content.length, end: content.length + c.text.length });
    content += c.text;
    pos = c.end;
  }
  content += text.slice(pos);
  return { content, regions, skipped };
}

/** How much a change grew, in characters of the reviewer's text taken in before and after it. */
export interface Growth {
  before: number;
  after: number;
}

type Part = { value: string; added?: boolean; removed?: boolean };

/** The edits of `parts` as spans of the old content (an insertion is empty). */
function editSpans(parts: Part[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let p = 0;
  for (const part of parts) {
    const n = part.value.length;
    if (part.added) out.push({ from: p, to: p });
    else if (part.removed) out.push({ from: p, to: p + n });
    if (!part.added) p += n;
  }
  return out;
}

const inside = (e: { from: number; to: number }, r: { start: number; end: number }) => e.from >= r.start && e.to <= r.end;

/** Between an edit and a change: only spaces and punctuation, in one paragraph. */
const NEXT_TO = /^[\s\p{P}]*$/u;

/**
 * Grow regions to take in edits next to them, separated by nothing but spaces and punctuation in
 * the same paragraph: the reviewer rewording a change as a whole, whose words a diff counts partly
 * outside it (test report v0.16.0, B9). Null if an edit is apart from every change, or a change
 * would grow into another.
 */
function growRegions(content: string, regions: ReviewDocument["regions"], edits: { from: number; to: number }[]): ReviewDocument["regions"] | null {
  const rs = regions.map((r) => ({ ...r }));
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of edits) {
      if (rs.some((r) => inside(e, r))) continue;
      let best: { k: number; gap: number } | null = null;
      rs.forEach((r, k) => {
        const gap = e.to <= r.start ? content.slice(e.to, r.start) : e.from >= r.end ? content.slice(r.end, e.from) : "";
        if (!NEXT_TO.test(gap) || gap.includes("\n\n")) return;
        if (!best || gap.length < best.gap) best = { k, gap: gap.length };
      });
      if (!best) return null;
      const r = rs[(best as { k: number }).k]!;
      const start = Math.min(r.start, e.from);
      const end = Math.max(r.end, e.to);
      if (rs.some((o) => o !== r && o.start < end && o.end > start)) return null;
      r.start = start;
      r.end = end;
      changed = true;
    }
  }
  return rs;
}

/**
 * The reviewer saved `edited` (the review document's content, changed). Returns each change's
 * text after the edit, and how much changes grew to take in words reworded next to them; or an
 * error when text apart from every change was edited.
 */
export function mapReviewEdits(doc: ReviewDocument, edited: string): { texts: Map<string, string>; grown: Map<string, Growth> } | { error: string } {
  let parts: Part[] = diffChars(doc.content, edited);
  let regions = doc.regions;

  // Every edit must fall inside a change; text typed right at a change's edge counts as inside.
  const outside = editSpans(parts).find((e) => !regions.some((r) => inside(e, r)));
  if (outside) {
    // Words reworded next to a change: by words (letters in common don't split a rewording), and
    // the change grows to take them in.
    const words: Part[] = diffWordsWithSpace(doc.content, edited);
    const grown = growRegions(doc.content, regions, editSpans(words));
    if (!grown) {
      const near = doc.content
        .slice(Math.max(0, outside.from - 25), outside.to + 25)
        .replace(/\s+/g, " ")
        .trim();
      return {
        error: `You edited text outside the proposed changes (near “${near}”). Edit that in your file itself; here only proposed text, and words right next to it, can change.`,
      };
    }
    parts = words;
    regions = grown;
  }
  // Where an offset of the old content is in the new one: before text inserted exactly there
  // (`first`), or after it (`last`).
  const where = (x: number): { first: number; last: number } => {
    let first: number | undefined;
    let last = 0;
    let pp = 0;
    let uu = 0;
    for (const part of parts) {
      const n = part.value.length;
      if (part.added) {
        if (pp === x) {
          first ??= uu;
          last = uu + n;
        }
        uu += n;
      } else if (part.removed) {
        if (x >= pp && x <= pp + n) {
          first ??= uu;
          last = uu;
        }
        pp += n;
      } else {
        if (x >= pp && x <= pp + n) {
          first ??= uu + (x - pp);
          last = uu + (x - pp);
        }
        pp += n;
        uu += n;
      }
    }
    return { first: first ?? edited.length, last: first === undefined ? edited.length : last };
  };

  const texts = new Map<string, string>();
  regions.forEach((r, k) => {
    const start = where(r.start).first;
    // Text typed where this change ends and the next begins goes to the next one.
    const end = regions[k + 1]?.start === r.end ? where(r.end).first : where(r.end).last;
    texts.set(r.id, edited.slice(start, Math.max(start, end)));
  });
  const grown = new Map<string, Growth>();
  regions.forEach((r, k) => {
    const o = doc.regions[k]!;
    if (r.start !== o.start || r.end !== o.end) grown.set(r.id, { before: o.start - r.start, after: r.end - o.end });
  });
  return { texts, grown };
}
