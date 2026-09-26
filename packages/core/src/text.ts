import { createHash } from "node:crypto";

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
export function isSafeRepoPath(p: string): boolean {
  if (!p || p.includes("\0") || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  return p.split(/[\\/]/).every((seg) => {
    if (seg === "" || seg === "." || seg === "..") return false;
    const win = seg.replace(/[. ]+$/, "").toLowerCase();
    return win !== ".git" && !/^git~\d+$/.test(win) && !seg.includes(":");
  });
}

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
