import { createHash } from "node:crypto";
import { diffArrays } from "diff";

/** Line-ending style of a text file. Stet works on LF text internally and restores the style on write. */
export type Eol = "lf" | "crlf";

export function detectEol(text: string): Eol {
  const crlf = text.indexOf("\r\n");
  if (crlf === -1) return "lf";
  const lf = text.indexOf("\n");
  return lf === crlf + 1 ? "crlf" : "lf";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function fromLf(text: string, eol: Eol): string {
  return eol === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function normalizeWs(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** Offsets [start, end) covering 1-based lines `from`..`to` inclusive. */
export function lineRange(text: string, from: number, to: number): { start: number; end: number } {
  let line = 1;
  let start = from <= 1 ? 0 : -1;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue;
    line++;
    if (line === from) start = i + 1;
    if (line === to + 1) {
      end = i + 1;
      break;
    }
  }
  if (start === -1) start = text.length;
  return { start, end: Math.max(start, end) };
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Similarity in [0, 1]; two empty strings are identical. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * Whether `p` is a safe repository-relative path to write in the user's project: relative,
 * no `.`/`..` segments, and nothing that reaches the git dir on any platform (`.git`,
 * Windows aliases such as `GIT~1` or `.git.`, alternate data streams).
 */
/**
 * How alike two passages are, word by word: twice the words they share in order over all their
 * words (1 = the same, 0 = nothing in common). Below `min`, returns 0 without the full comparison.
 */
export function wordSimilarity(a: string[], b: string[], min = 0): number {
  if (!a.length || !b.length) return 0;
  // Shared words in any order bound the result from above.
  const counts = new Map<string, number>();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of b) {
    const c = counts.get(w);
    if (c) {
      shared++;
      counts.set(w, c - 1);
    }
  }
  if ((2 * shared) / (a.length + b.length) < min) return 0;
  let common = 0;
  for (const ch of diffArrays(a, b)) if (!ch.added && !ch.removed) common += ch.count ?? ch.value.length;
  return (2 * common) / (a.length + b.length);
}

/**
 * Whether two paragraphs are one paragraph edited: alike by `wordSimilarity`, or the shorter one
 * (5 words or more) found almost whole, in order, in the other (most sentences deleted, or many
 * added). Returns a score; at least `min` means alike.
 */
export function paragraphSimilarity(a: string[], b: string[], min: number): number {
  const d = wordSimilarity(a, b, min);
  if (d >= min) return d;
  const short = Math.min(a.length, b.length);
  if (short < 5) return d;
  const counts = new Map<string, number>();
  for (const w of a) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of b) {
    const c = counts.get(w);
    if (c) {
      shared++;
      counts.set(w, c - 1);
    }
  }
  if (shared / short < 0.8) return d;
  let common = 0;
  for (const ch of diffArrays(a, b)) if (!ch.added && !ch.removed) common += ch.count ?? ch.value.length;
  return common / short >= 0.8 ? Math.max(d, min) : d;
}

export function isSafeRepoPath(p: string): boolean {
  if (!p || p.includes("\0") || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  return p.split(/[\\/]/).every((seg) => {
    if (seg === "" || seg === "." || seg === "..") return false;
    const win = seg.replace(/[. ]+$/, "").toLowerCase();
    return win !== ".git" && !/^git~\d+$/.test(win) && !seg.includes(":");
  });
}

/**
 * `s` without control characters (terminal escape sequences) and Unicode direction overrides
 * ("Trojan source"): agent-written text is shown to the reviewer, and must not rewrite or
 * reorder what they see. Line breaks and tabs stay.
 */
export function printable(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Text on one line (whitespace collapsed), cut to `max` characters with an ellipsis. */
export function oneLine(s: string, max = 120): string {
  const t = printable(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Quote for a POSIX shell: nothing inside is expanded (no `$`, backticks or globs). */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}
