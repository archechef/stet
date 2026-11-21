import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { diffArrays } from "diff";
import type { SpokenRules } from "./lang/profile.js";

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
 * How alike two passages are, word by word: twice the words they share in order over all their
 * words (1 = the same, 0 = nothing in common). Below `min`, returns 0 without the full comparison.
 */
export function wordSimilarity(a: string[], b: string[], min = 0, shared?: number): number {
  if (!a.length || !b.length) return 0;
  // Shared words in any order bound the result from above; the diff only runs when it can reach `min`.
  if (min > 0 && (2 * (shared ?? sharedWords(a, b))) / (a.length + b.length) < min) return 0;
  return (2 * commonWords(a, b)) / (a.length + b.length);
}

/** How many words two passages share in any order (a word counts as often as both have it). An upper bound of `commonWords`. */
export function sharedWords(a: string[], b: string[]): number {
  const [small, big] = a.length <= b.length ? [a, b] : [b, a];
  const counts = new Map<string, number>();
  for (const w of small) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of big) {
    const c = counts.get(w);
    if (c) {
      shared++;
      counts.set(w, c - 1);
    }
  }
  return shared;
}

/** How many words two passages share in order (the longest common subsequence). */
export function commonWords(a: string[], b: string[]): number {
  let common = 0;
  for (const ch of diffArrays(a, b)) if (!ch.added && !ch.removed) common += ch.count ?? ch.value.length;
  return common;
}

/**
 * `sharedWords` for every pair of passages in `as` and `bs` (`[i][j]`), through an index of
 * where each word occurs: pairs with no word in common cost nothing. Words are compared as
 * `sharedWords` compares them.
 */
export function sharedWordsMatrix(as: string[][], bs: string[][]): Int32Array[] {
  const ids = new Map<string, number>();
  const bag = (ws: string[]) => {
    const m = new Map<number, number>();
    for (const w of ws) {
      let id = ids.get(w);
      if (id === undefined) ids.set(w, (id = ids.size));
      m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  };
  const aBags = as.map(bag);
  // For each word, the passages of `as` that have it, and how often.
  const where: { at: number; n: number }[][] = [];
  aBags.forEach((m, i) => {
    for (const [id, n] of m) (where[id] ??= []).push({ at: i, n });
  });
  const out = as.map(() => new Int32Array(bs.length));
  bs.forEach((ws, j) => {
    for (const [id, n] of bag(ws)) for (const { at, n: k } of where[id] ?? []) out[at]![j]! += Math.min(n, k);
  });
  return out;
}

/**
 * Whether two paragraphs are one paragraph edited: alike by `wordSimilarity`, or the shorter one
 * (5 words or more) found almost whole, in order, in the other (most sentences deleted, or many
 * added). Returns a score; at least `min` means alike. `shared` (`sharedWords`) may be given when
 * already known.
 */
export function paragraphSimilarity(a: string[], b: string[], min: number, shared?: number): number {
  if (!a.length || !b.length) return 0;
  const short = Math.min(a.length, b.length);
  const s = shared ?? sharedWords(a, b);
  // Neither test can pass without enough words in common: skip the diff.
  const maybeAlike = (2 * s) / (a.length + b.length) >= min;
  const maybeContained = short >= 5 && s / short >= 0.8;
  if (!maybeAlike && !maybeContained) return 0;
  const common = commonWords(a, b);
  const d = maybeAlike ? (2 * common) / (a.length + b.length) : 0;
  if (d >= min || !maybeContained) return d;
  return common / short >= 0.8 ? Math.max(d, min) : d;
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

/**
 * `s` without control characters (terminal escape sequences) and Unicode direction overrides
 * ("Trojan source"): agent-written text is shown to the reviewer, and must not rewrite or
 * reorder what they see. Line breaks and tabs stay.
 */
export function printable(s: string): string {
  // A lone CR is a line break to TeX, Typst and Markdown, but moves a terminal's cursor back over
  // what it printed: shown as the line break it is. Control,
  // direction and invisible characters are shown as visible markers, not dropped: dropped, the
  // file still got them unseen (S11).
  return s.replace(/\r\n?/g, "\n").replace(INVISIBLE, (ch) => `⟨U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

/**
 * Characters that are invisible or change how the text around them is shown: controls (but line
 * breaks and tabs), direction marks and overrides, zero-width characters, the soft hyphen, the
 * byte-order mark, fillers and tag characters.
 */
const INVISIBLE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it finds.
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: single code points, listed on purpose.
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u{e0000}-\u{e007f}]/gu;

/** Text on one line (whitespace collapsed), cut to `max` characters with an ellipsis. */
export function oneLine(s: string, max = 120): string {
  const t = printable(s).replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Whitespace shown: ¶ a paragraph break, ↵ a line break, ␣ a space, for text that is only whitespace. */
function shownWs(s: string): string {
  return s
    .replace(/\n[ \t]*\n\s*/g, "¶")
    .replace(/\n/g, "↵")
    .replace(/[ \t]/g, "␣");
}

const PARBREAK = /\n[ \t]*\n/;

/** The words of `s` and the whitespace around them: `gaps[k]` comes before `words[k]`, the last one after all. */
function wordsAndGaps(s: string): { words: string[]; gaps: string[] } {
  const words: string[] = [];
  const gaps = [""];
  s.split(/(\s+)/).forEach((p, k) => {
    if (k % 2) gaps[gaps.length - 1] += p;
    else if (p) {
      words.push(p);
      gaps.push("");
    }
  });
  return { words, gaps };
}

/** Where a side has a paragraph break the other hasn't (else where they differ in one): a gap index, or -1. */
function breakAt(mine: string[], other: string[]): number {
  const own = mine.findIndex((g, i) => PARBREAK.test(g) && !PARBREAK.test(other[i]!));
  return own >= 0 ? own : mine.findIndex((g, i) => PARBREAK.test(g) !== PARBREAK.test(other[i]!));
}

/**
 * A change of paragraph breaks only, the words kept: "paragraph split", "paragraphs joined", or
 * "paragraph break moved" (one sentence now ends a paragraph, or starts the next); else null.
 */
export function paragraphChange(oldText: string, newText: string): string | null {
  const [a, b] = [wordsAndGaps(oldText), wordsAndGaps(newText)];
  if (a.words.length !== b.words.length || a.words.some((w, i) => w !== b.words[i])) return null;
  let [added, removed] = [false, false];
  a.gaps.forEach((g, i) => {
    const [x, y] = [PARBREAK.test(g), PARBREAK.test(b.gaps[i]!)];
    if (y && !x) added = true;
    if (x && !y) removed = true;
  });
  return added && removed ? "paragraph break moved" : added ? "paragraph split" : removed ? "paragraphs joined" : null;
}

/** A side of a change of paragraph breaks, around its break: "…to fill a line.¶" for "¶Beta two is…". */
function aroundBreak(s: { words: string[]; gaps: string[] }, at: number, max: number): string {
  const shown = (from: number, to: number) => {
    let t = "";
    for (let k = from; k <= to; k++) {
      if (k > from) t += k === at ? shownWs(s.gaps[k]!) : " ";
      else if (k === at) t += shownWs(s.gaps[k]!);
      if (k < s.words.length) t += printable(s.words[k]!);
    }
    return t;
  };
  // Words before and after the break, as many as fit, the ones before first.
  let [from, to] = [at, at];
  for (;;) {
    const last = s.words.length - 1;
    const grow = from > 0 && (to >= last || at - from <= to - at) ? [from - 1, to] : to < last ? [from, to + 1] : null;
    if (!grow) break;
    const t = shown(grow[0]!, grow[1]!);
    if (t.length + 2 > max) break;
    [from, to] = grow as [number, number];
  }
  return (from > 0 ? "…" : "") + shown(from, to) + (to < s.words.length - 1 ? "…" : "");
}

/**
 * Old and new text of a change for a one-line summary, each at most `max` characters: what both
 * share at the start and end is cut (marked …), so the summary shows where they differ. Cut to
 * the same prefix, a formula's change looked like no change at all, and a long label hid what a
 * change did. Whitespace-only text is made visible.
 */
export function changeSummary(oldText: string, newText: string, max = 30): [string, string] {
  const flat = (s: string) => (normalizeWs(s) ? printable(s).replace(/\s+/g, " ").trim() : shownWs(printable(s)));
  let [a, b] = [flat(oldText), flat(newText)];
  if (a === b) [a, b] = [shownWs(printable(oldText)), shownWs(printable(newText))];
  if (a.length <= max && b.length <= max) return [a, b];
  // Only paragraph breaks changed: each side around its break, which a cut would have hidden.
  if (paragraphChange(oldText, newText)) {
    const [x, y] = [wordsAndGaps(oldText), wordsAndGaps(newText)];
    return [aroundBreak(x, breakAt(x.gaps, y.gaps), max), aroundBreak(y, breakAt(y.gaps, x.gaps), max)];
  }
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  // Keep a little of what they share, from a word's start, as context.
  const ctx = 12;
  let from = Math.max(0, pre - ctx);
  if (from > 0) {
    const sp = a.lastIndexOf(" ", pre - 1);
    from = sp >= from - ctx && sp >= 0 && sp < pre ? sp + 1 : from;
  }
  // A change inside a function call starts at the call's name: "#cite(<a>) → #cite(<a>, form: …"
  // read as "…a>) → …a>, form: …".
  const call = callStart(a.slice(0, pre));
  if (call >= 0 && call < from && pre - call <= 30) from = call;
  const cut = (s: string) => {
    const end = Math.min(s.length, s.length - suf + ctx);
    const t = s.slice(from, end);
    const lead = from > 0 ? "…" : "";
    const tail = end < s.length ? "…" : "";
    if (lead.length + t.length + tail.length > max) return lead + t.slice(0, max - lead.length - 1) + "…";
    return lead + t + tail;
  };
  return [cut(a), cut(b)];
}

/** Where the innermost call still open at the end of `s` starts (`#name(`, `name(`), or -1. */
function callStart(s: string): number {
  let depth = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    if (s[i] === ")") depth++;
    else if (s[i] === "(") {
      if (depth > 0) depth--;
      else {
        const m = /#?[\p{L}_][\p{L}\p{N}_.-]*$/u.exec(s.slice(0, i));
        return m ? m.index : -1;
      }
    }
  }
  return -1;
}

/**
 * A change's old and new text for a summary, with the words around a short change (a number, a
 * symbol): "width: 80%" → "width: 90%" said more than "80" → "90".
 */
export function summaryTexts(it: { oldText: string; newText: string; context: { before: string; after: string } }): [string, string] {
  const short = (t: string) => !t.includes("\n") && (t.trim().length <= 4 || !/\p{L}{2}/u.test(t));
  if (!short(it.oldText) || !short(it.newText) || !it.oldText.trim() || !it.newText.trim()) return [it.oldText, it.newText];
  const lineBefore = it.context.before.split("\n").pop() ?? "";
  const lineAfter = it.context.after.split("\n")[0] ?? "";
  const before = /(?:[\p{L}\p{N}_.#-]+\s*[:=]\s*|[\p{L}\p{N}_.#\\-]+\s)?\S*$/u.exec(lineBefore)?.[0] ?? "";
  const after = /^[^\s,;)\]}]*/.exec(lineAfter)?.[0] ?? "";
  return [before + it.oldText + after, before + it.newText + after];
}

/**
 * A change as words, for screen readers: in a formula only what differs ("in the formula … : 2
 * becomes 3"), labels and references spelled out, as the file's language (`rules`) writes them.
 * Raw source buried a one-character change in symbols. Null when the summary says it well enough.
 */
export function spokenChange(oldText: string, newText: string, rules: SpokenRules | undefined): string | null {
  if (!rules) return null;
  const said = (t: string) => rules.words(printable(t)).replace(/\s+/g, " ").trim();
  const maths = rules.maths.test(oldText) || rules.maths.test(newText);
  const keys = rules.keys.test(oldText + newText);
  if (!maths && !keys) return null;
  let pre = 0;
  while (pre < oldText.length && pre < newText.length && oldText[pre] === newText[pre]) pre++;
  let suf = 0;
  while (suf < oldText.length - pre && suf < newText.length - pre && oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]) suf++;
  const [was, now] = [said(oldText.slice(pre, oldText.length - suf)), said(newText.slice(pre, newText.length - suf))];
  if (!maths) return !was ? `insert ${now}` : !now ? `delete ${was}` : `replace ${said(oldText)} with ${said(newText)}`;
  const formula = said(oldText.replace(/\$/g, " ")) || said(newText.replace(/\$/g, " "));
  const change = !was ? `${now} is inserted` : !now ? `${was} is deleted` : `${was} becomes ${now}`;
  return `in the formula ${formula.length > 80 ? formula.slice(0, 79) + "…" : formula}: ${change.replace(/\$/g, "")}`;
}

/** Quote for a POSIX shell: nothing inside is expanded (no `$`, backticks or globs). */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Not text Stet can change word by word: it has NUL bytes, or isn't UTF-8 (a Latin-1 file, say).
 * Such files are proposed and applied whole, byte for byte; read as UTF-8 and written back, every
 * character outside ASCII would have become U+FFFD, on every line.
 */
export function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return !isUtf8(buf);
}

/**
 * A file that isn't UTF-8 text, as text to review: bytes that aren't UTF-8 shown as ⟨0xFF⟩.
 * Null for a real binary file (a zero byte near the start).
 */
export function textWithBadBytes(buf: Buffer): string | null {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return null;
  let out = "";
  let start = 0;
  for (let i = 0; i < buf.length; ) {
    const b = buf[i]!;
    const len = b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (len && i + len <= buf.length && isUtf8(buf.subarray(i, i + len))) {
      i += len;
      continue;
    }
    out += buf.subarray(start, i).toString("utf8") + `⟨0x${b.toString(16).toUpperCase().padStart(2, "0")}⟩`;
    start = ++i;
  }
  return toLf(out + buf.subarray(start).toString("utf8"));
}

/**
 * The changed lines of two texts with `context` lines around them, as "- ", "+ " and "  " lines
 * ("…" where lines are left out). For reviewing whole files that aren't split into changes.
 */
export function lineDiff(oldText: string, newText: string, context = 2): string[] {
  const parts = diffArrays(oldText ? oldText.split("\n") : [], newText ? newText.split("\n") : []);
  const rows: { sign: string; line: string }[] = [];
  for (const p of parts) for (const line of p.value) rows.push({ sign: p.added ? "+ " : p.removed ? "- " : "  ", line });
  const near = rows.map((r, i) => r.sign !== "  " || rows.slice(Math.max(0, i - context), i + context + 1).some((x) => x.sign !== "  "));
  const out: string[] = [];
  rows.forEach((r, i) => {
    if (near[i]) out.push(r.sign + r.line);
    else if (i === 0 || near[i - 1]) out.push("…");
  });
  return out;
}

export function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}
