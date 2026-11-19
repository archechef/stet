/**
 * The review document of a file: the reviewer's text with every pending change in it applied,
 * which they can edit like text before deciding ("Review all changes in this file").
 * Edits inside a change become the reviewer's wording for it (a draft: the change stays pending
 * until they accept it); edits elsewhere belong in the file itself and are refused.
 */
import { diffChars } from "diff";

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

/**
 * The reviewer saved `edited` (the review document's content, changed). Returns each change's
 * text after the edit, or an error when text outside every change was edited.
 */
export function mapReviewEdits(doc: ReviewDocument, edited: string): { texts: Map<string, string> } | { error: string } {
  const parts = diffChars(doc.content, edited);
  const { regions } = doc;

  // Every edit must fall inside a change; text typed right at a change's edge counts as inside.
  let p = 0;
  for (const part of parts) {
    const n = part.value.length;
    if (part.added || part.removed) {
      const [from, to] = part.added ? [p, p] : [p, p + n];
      if (!regions.some((r) => from >= r.start && to <= r.end)) {
        const near = doc.content.slice(Math.max(0, from - 25), to + 25).replace(/\s+/g, " ").trim();
        return { error: `You edited text outside the proposed changes (near “${near}”). Edit that in your file itself; here only proposed text can change.` };
      }
    }
    if (!part.added) p += n;
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
  return { texts };
}
