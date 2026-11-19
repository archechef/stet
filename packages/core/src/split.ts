/**
 * Turning a file diff into reviewable edits (spec §6.1–6.2).
 * All texts are LF-normalized; offsets are UTF-16 indexes into them.
 */
import { diffArrays, diffLines } from "diff";
import { isBlank, tokenize, type Token } from "./tokenizer.js";
import type { SplitConfig } from "./config.js";
import { paragraphSimilarity, wordSimilarity } from "./text.js";

export interface Edit {
  /** Range in the old (base) text. */
  start: number;
  end: number;
  /** Range in the new (agent) text. */
  newStart: number;
  newEnd: number;
  oldText: string;
  newText: string;
  /**
   * An unrelated paragraph replacing another is one change, but it can be taken apart into a
   * deletion and an insertion: when one of them belongs to a move (§6.4.7).
   */
  halves?: [Edit, Edit];
}

/** Paragraphs this alike (word similarity) are one paragraph edited; less alike, unrelated. */
export const PAIR_MIN = 0.5;

export type FileClass = "tex" | "bib" | "text";

export function splitText(cls: FileClass, oldText: string, newText: string, cfg: SplitConfig): Edit[] {
  if (oldText === newText) return [];
  if (cls === "tex") return splitLatex(oldText, newText, cfg);
  if (cls === "bib") return splitBib(oldText, newText) ?? splitLineHunks(oldText, newText);
  return splitLineHunks(oldText, newText);
}

function makeEdit(oldText: string, newText: string, start: number, end: number, newStart: number, newEnd: number): Edit {
  return { start, end, newStart, newEnd, oldText: oldText.slice(start, end), newText: newText.slice(newStart, newEnd) };
}

// ---------------------------------------------------------------------------
// Line diff helpers

interface LineRegion {
  oldStart: number; // line indexes, [start, end)
  oldEnd: number;
  newStart: number;
  newEnd: number;
}

function splitLinesKeep(text: string): string[] {
  const lines = text.split(/(?<=\n)/);
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

function lineOffsets(lines: string[]): number[] {
  const offs = [0];
  for (const l of lines) offs.push(offs[offs.length - 1]! + l.length);
  return offs;
}

function changedLineRegions(oldText: string, newText: string): LineRegion[] {
  const regions: LineRegion[] = [];
  let o = 0;
  let n = 0;
  let cur: LineRegion | null = null;
  for (const ch of diffLines(oldText, newText)) {
    const count = ch.count ?? 0;
    if (!ch.added && !ch.removed) {
      if (cur) regions.push(cur);
      cur = null;
      o += count;
      n += count;
      continue;
    }
    cur ??= { oldStart: o, oldEnd: o, newStart: n, newEnd: n };
    if (ch.removed) cur.oldEnd = o += count;
    else cur.newEnd = n += count;
  }
  if (cur) regions.push(cur);
  return regions;
}

export function splitLineHunks(oldText: string, newText: string): Edit[] {
  const oldOffs = lineOffsets(splitLinesKeep(oldText));
  const newOffs = lineOffsets(splitLinesKeep(newText));
  return changedLineRegions(oldText, newText).map((r) =>
    makeEdit(oldText, newText, oldOffs[r.oldStart]!, oldOffs[r.oldEnd]!, newOffs[r.newStart]!, newOffs[r.newEnd]!),
  );
}

// ---------------------------------------------------------------------------
// BibTeX: one edit per changed entry

interface BibEntry {
  key: string;
  start: number;
  end: number;
  text: string;
}

function parseBib(text: string): { entries: BibEntry[]; skeleton: string } | null {
  const entries: BibEntry[] = [];
  const re = /^[ \t]*@(\w+)\s*\{\s*([^,\s]*)\s*,/gm;
  const starts: { start: number; key: string }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (/^(string|preamble|comment)$/i.test(m[1]!)) continue;
    starts.push({ start: m.index, key: m[2]! });
  }
  let skeleton = "";
  let prevEnd = 0;
  for (let i = 0; i < starts.length; i++) {
    const { start, key } = starts[i]!;
    // Entry ends at its matching closing brace.
    let depth = 0;
    let end = -1;
    for (let j = text.indexOf("{", start); j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) {
        end = j + 1;
        break;
      }
    }
    if (end === -1 || (i + 1 < starts.length && end > starts[i + 1]!.start)) return null;
    skeleton += text.slice(prevEnd, start) + "\u0000";
    prevEnd = end;
    entries.push({ key, start, end, text: text.slice(start, end) });
  }
  skeleton += text.slice(prevEnd);
  const keys = new Set(entries.map((e) => e.key));
  if (keys.size !== entries.length) return null; // duplicate keys: fall back
  return { entries, skeleton };
}

export function splitBib(oldText: string, newText: string): Edit[] | null {
  const o = parseBib(oldText);
  const n = parseBib(newText);
  if (!o || !n) return null;
  const oldByKey = new Map(o.entries.map((e) => [e.key, e]));
  const newByKey = new Map(n.entries.map((e) => [e.key, e]));
  // Anything outside entries (or reordering) changed: line hunks are clearer.
  const commonOld = o.entries.filter((e) => newByKey.has(e.key)).map((e) => e.key);
  const commonNew = n.entries.filter((e) => oldByKey.has(e.key)).map((e) => e.key);
  if (commonOld.join("\n") !== commonNew.join("\n")) return null;
  const bare = (s: string) => s.replace(/\u0000|\s+/g, "");
  if (bare(o.skeleton) !== bare(n.skeleton)) return null;
  const edits: Edit[] = [];
  for (const e of o.entries) {
    const ne = newByKey.get(e.key);
    if (!ne) {
      // Deleted entry: also remove the whitespace after it.
      const end = e.end + (/^\s*/.exec(oldText.slice(e.end))?.[0].length ?? 0);
      edits.push({ start: e.start, end, newStart: 0, newEnd: 0, oldText: oldText.slice(e.start, end), newText: "" });
    } else if (ne.text !== e.text) {
      edits.push(makeEdit(oldText, newText, e.start, e.end, ne.start, ne.end));
    }
  }
  // Added entries: insert after the preceding surviving entry, else before the
  // first old entry, else at the end of the file.
  for (let i = 0; i < n.entries.length; i++) {
    const ne = n.entries[i]!;
    if (oldByKey.has(ne.key)) continue;
    const prev = n.entries.slice(0, i).reverse().find((e) => oldByKey.has(e.key));
    let at: number;
    let insert: string;
    if (prev) {
      at = oldByKey.get(prev.key)!.end;
      insert = "\n\n" + ne.text;
    } else if (o.entries.length) {
      at = o.entries[0]!.start;
      insert = ne.text + "\n\n";
    } else {
      at = oldText.length;
      insert = (oldText && !oldText.endsWith("\n") ? "\n" : "") + (oldText ? "\n" : "") + ne.text + "\n";
    }
    edits.push({ start: at, end: at, newStart: ne.start, newEnd: ne.end, oldText: "", newText: insert });
  }
  return edits.sort((a, b) => a.start - b.start || a.newStart - b.newStart);
}

// ---------------------------------------------------------------------------
// LaTeX-aware splitting

interface U {
  o: number; // old token index or -1
  n: number; // new token index or -1
}

const BOUNDARY_CMDS = new Set([
  "\\begin", "\\end", "\\item", "\\par", "\\part", "\\chapter", "\\section", "\\subsection",
  "\\subsubsection", "\\paragraph", "\\subparagraph",
]);

const MATH_ENVS = /^(equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath|dmath)\*?$/;

function isBoundaryCmd(t: Token): boolean {
  return t.type === "cmd" && BOUNDARY_CMDS.has(t.text.replace(/\*$/, ""));
}

/** Matching brace index for every brace token (unmatched braces are absent). */
function braceMatches(toks: Token[]): Map<number, number> {
  const m = new Map<number, number>();
  const stack: number[] = [];
  toks.forEach((t, i) => {
    if (t.type === "lbrace") stack.push(i);
    else if (t.type === "rbrace" && stack.length) {
      const j = stack.pop()!;
      m.set(i, j);
      m.set(j, i);
    }
  });
  return m;
}

/** Token index spans [a, b] (inclusive) of math content, including delimiters. */
function mathSpans(toks: Token[]): [number, number][] {
  const spans: [number, number][] = [];
  let open: { i: number; text: string } | null = null;
  const closer: Record<string, string> = { $: "$", $$: "$$", "\\(": "\\)", "\\[": "\\]" };
  const envStack: { i: number; name: string }[] = [];
  const envName = (i: number): string | null => {
    let k = i + 1;
    while (k < toks.length && toks[k]!.type === "ws") k++;
    if (toks[k]?.type !== "lbrace") return null;
    let name = "";
    for (k++; k < toks.length && toks[k]!.type !== "rbrace"; k++) name += toks[k]!.text;
    return k < toks.length ? name : null;
  };
  const envEnd = (i: number): number => {
    let k = i + 1;
    while (k < toks.length && toks[k]!.type !== "rbrace") k++;
    return Math.min(k, toks.length - 1);
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (open) {
      if (t.type === "math" && t.text === closer[open.text]) {
        spans.push([open.i, i]);
        open = null;
      } else if (t.type === "parbreak") open = null; // unbalanced: give up on this span
      continue;
    }
    if (t.type === "math" && closer[t.text]) open = { i, text: t.text };
    else if (t.type === "cmd" && (t.text === "\\begin" || t.text === "\\end")) {
      const name = envName(i);
      if (!name || !MATH_ENVS.test(name)) continue;
      if (t.text === "\\begin") envStack.push({ i, name });
      else {
        const k = envStack.findLastIndex((e) => e.name === name);
        if (k !== -1) {
          spans.push([envStack[k]!.i, envEnd(i)]);
          envStack.length = k;
        }
      }
    }
  }
  return spans;
}

/** Commands whose argument is an identifier that is only meaningful as a whole. */
const KEY_ARG_CMDS = /^\\(label|[cCvV]?ref|eqref|pageref|autoref|nameref|cite\w*|\w*cite|nocite|input|include|includegraphics|usepackage|documentclass|bibliography|bibliographystyle|begin|end)\*?$/;

/** Token spans [cmd, closing brace] of key arguments such as \label{sec:intro} or \cite[p.~3]{knuth}. */
function keyArgSpans(toks: Token[], braces: Map<number, number>): [number, number][] {
  const spans: [number, number][] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.type !== "cmd" || !KEY_ARG_CMDS.test(toks[i]!.text)) continue;
    let k = i + 1;
    while (toks[k]?.type === "ws") k++;
    while (toks[k]?.text === "[") {
      while (k < toks.length && toks[k]!.text !== "]" && toks[k]!.type !== "parbreak") k++;
      k++;
      while (toks[k]?.type === "ws") k++;
    }
    if (toks[k]?.type !== "lbrace") continue;
    const close = braces.get(k);
    if (close !== undefined && close > k) spans.push([i, close]);
  }
  return spans;
}

interface Side {
  toks: Token[];
  pos: number[]; // token index -> U index
  braces: Map<number, number>;
  /** Spans that must be taken whole: math and key arguments. */
  math: [number, number][];
  /** Key-argument spans only (never merged with neighbouring edits). */
  keys: [number, number][];
}

function side(toks: Token[], u: U[], key: "o" | "n"): Side {
  const pos = new Array<number>(toks.length);
  u.forEach((e, i) => {
    if (e[key] >= 0) pos[e[key]] = i;
  });
  const braces = braceMatches(toks);
  const keys = keyArgSpans(toks, braces);
  return { toks, pos, braces, math: [...mathSpans(toks), ...keys], keys };
}

/** Extend [s, e) in U so that braces and math spans on this side are whole. */
function growSide(r: [number, number], u: U[], sd: Side, key: "o" | "n"): boolean {
  let changed = false;
  for (let i = r[0]; i < r[1]; i++) {
    const t = u[i]![key];
    if (t < 0) continue;
    const m = sd.braces.get(t);
    if (m === undefined) continue;
    const p = sd.pos[m]!;
    if (p < r[0]) {
      r[0] = p;
      changed = true;
    } else if (p >= r[1]) {
      r[1] = p + 1;
      changed = true;
    }
  }
  for (const [a, b] of sd.math) {
    const pa = sd.pos[a]!;
    const pb = sd.pos[b]!;
    if (pa < r[1] && pb >= r[0] && (pa < r[0] || pb >= r[1])) {
      r[0] = Math.min(r[0], pa);
      r[1] = Math.max(r[1], pb + 1);
      changed = true;
    }
  }
  return changed;
}

function splitLatex(oldText: string, newText: string, cfg: SplitConfig): Edit[] {
  const oldLines = splitLinesKeep(oldText);
  const newLines = splitLinesKeep(newText);
  const oldOffs = lineOffsets(oldLines);
  const newOffs = lineOffsets(newLines);
  const blank = (l: string | undefined) => l !== undefined && l.trim() === "";

  // Expand line regions to whole paragraphs so token diffs see full sentences.
  const raw = changedLineRegions(oldText, newText);
  const expanded: LineRegion[] = [];
  raw.forEach((r, idx) => {
    const lo = idx > 0 ? raw[idx - 1]!.oldEnd : 0;
    const hi = idx + 1 < raw.length ? raw[idx + 1]!.oldStart : oldLines.length;
    // Only into a paragraph the change is part of: a change that starts (ends) with a paragraph
    // break on both sides stops there. Otherwise a moved paragraph next to a heading merged with
    // it, and with a change below it, into one rewritten item (bug report 2026-11-13).
    const edge = (o: number, n: number) => (r.oldEnd > r.oldStart && !blank(oldLines[o])) || (r.newEnd > r.newStart && !blank(newLines[n]));
    let up = 0;
    if (edge(r.oldStart, r.newStart)) while (r.oldStart - up > lo && !blank(oldLines[r.oldStart - up - 1])) up++;
    let down = 0;
    if (edge(r.oldEnd - 1, r.newEnd - 1)) while (r.oldEnd + down < hi && !blank(oldLines[r.oldEnd + down])) down++;
    const e = { oldStart: r.oldStart - up, oldEnd: r.oldEnd + down, newStart: r.newStart - up, newEnd: r.newEnd + down };
    const last = expanded[expanded.length - 1];
    // Changes only blank lines apart are diffed together: the line diff cuts a paragraph inserted
    // before an edited one at the blank line between them, which pairs the new paragraph with the
    // old one (bug report C42). Paragraphs are paired by similarity inside a region instead.
    const blankGap = (a: string[], from: number, to: number) => a.slice(from, to).every((l) => !l.trim());
    if (last && (last.oldEnd >= e.oldStart || (blankGap(oldLines, last.oldEnd, e.oldStart) && blankGap(newLines, last.newEnd, e.newStart)))) {
      last.oldEnd = e.oldEnd;
      last.newEnd = e.newEnd;
    } else expanded.push(e);
  });

  const edits: Edit[] = [];
  for (const r of expanded) {
    const os = oldOffs[r.oldStart]!;
    const ns = newOffs[r.newStart]!;
    const oldSeg = oldText.slice(os, oldOffs[r.oldEnd]);
    const newSeg = newText.slice(ns, newOffs[r.newEnd]);
    for (const e of joinAdjacent(splitSegment(oldSeg, newSeg, cfg))) {
      for (const piece of perBlock(oldText, newText, { ...e, start: e.start + os, end: e.end + os, newStart: e.newStart + ns, newEnd: e.newEnd + ns })) {
        edits.push(unrelated(oldText, newText, piece));
      }
    }
  }
  return edits;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean);
/** A line that starts a LaTeX structure: a paragraph may begin right after it, or end right before it. */
const STRUCTURE_LINE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end|item|label|caption|maketitle|noindent|medskip|bigskip|smallskip|par)\b/;

/**
 * A deletion right next to an insertion is one replacement: a paragraph rewritten into one
 * joined onto the next line came out as an unrelated deletion and insertion. (If one half moved,
 * submit takes them apart again, see `Edit.halves`.)
 */
function joinAdjacent(edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  const pure = (e: Edit, ins: boolean) => (ins ? !e.oldText && !!e.newText.trim() : !e.newText && !!e.oldText.trim());
  // A change of whitespace only (a line break that goes with a new line) belongs to its neighbour.
  const blank = (e: Edit) => !e.oldText.trim() && !e.newText.trim();
  for (const e of edits) {
    const last = out[out.length - 1];
    const touch = last && last.end === e.start && last.newEnd === e.newStart;
    if (touch && ((pure(last!, false) && pure(e, true)) || (pure(last!, true) && pure(e, false)) || blank(e) || blank(last!))) {
      out[out.length - 1] = {
        start: last!.start, end: e.end, newStart: last!.newStart, newEnd: e.newEnd,
        oldText: last!.oldText + e.oldText, newText: last!.newText + e.newText,
      };
    } else out.push(e);
  }
  return out;
}

/** Sectioning commands and environment bounds: a structure line that is a piece of its own. */
const SECTION_LINE = /^[ \t]*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end)\b/;

/**
 * Where a run of inserted (deleted) text may be cut into pieces of its own: at paragraph breaks,
 * and around sectioning lines and environments, outside any environment, braces or display math
 * the run opens. Cuts are offsets in `t` where a piece starts.
 */
function blockCuts(t: string, leading: boolean): number[] {
  const cuts: number[] = [];
  let env = 0;
  let brace = 0;
  let display = 0;
  const lines = t.split(/(?<=\n)/);
  let pos = 0;
  let prevLine = "";
  for (const line of lines) {
    const top = env === 0 && brace === 0 && display === 0;
    if (top && pos > 0) {
      const before = t.slice(0, pos);
      const blankBefore = /\n[ \t]*\n$/.test(before);
      const structural = (SECTION_LINE.test(line) || SECTION_LINE.test(prevLine)) && line.trim() !== "" && prevLine.trim() !== "";
      if (blankBefore && line.trim()) {
        // The separator goes with the piece after it when the run starts with one, else before.
        if (leading) {
          const sep = /(?:\n[ \t]*)+\n$/.exec(before)![0].length;
          if (pos - sep > 0) cuts.push(pos - sep);
        } else cuts.push(pos);
      } else if (structural) cuts.push(leading ? pos - 1 : pos);
    }
    const code = line.replace(/\\[{}$%]/g, "").replace(/%.*$/, "");
    env += (code.match(/\\begin\s*\{/g) ?? []).length - (code.match(/\\end\s*\{/g) ?? []).length;
    brace += (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length;
    display += (code.match(/\\\[/g) ?? []).length - (code.match(/\\\]/g) ?? []).length;
    if (line.trim()) prevLine = line;
    pos += line.length;
  }
  return [...new Set(cuts)].filter((c) => c > 0 && c < t.length).sort((a, b) => a - b);
}

/**
 * A pure insertion or deletion of several paragraphs: one change per paragraph, and per heading
 * or environment, so each can be decided alone (and moved paragraphs among them are found). An
 * environment the run opens stays whole.
 */
function perBlock(oldText: string, newText: string, e: Edit): Edit[] {
  const ins = !e.oldText.trim() && !!e.newText.trim();
  const del = !e.newText.trim() && !!e.oldText.trim();
  if (!ins && !del) return [e];
  const t = ins ? e.newText : e.oldText;
  const leading = /^\s*\n/.test(t) && !/\n\s*$/.test(t);
  const cuts = blockCuts(t, leading);
  if (!cuts.length) return [e];
  const out: Edit[] = [];
  const bounds = [0, ...cuts, t.length];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const [a, b] = [bounds[k]!, bounds[k + 1]!];
    // The other side's (whitespace) text goes with the first piece.
    out.push(
      ins
        ? makeEdit(oldText, newText, k === 0 ? e.start : e.end, e.end, e.newStart + a, e.newStart + b)
        : makeEdit(oldText, newText, e.start + a, e.start + b, k === 0 ? e.newStart : e.newEnd, e.newEnd),
    );
  }
  return out.filter((x) => (ins ? x.newText : x.oldText).trim() || x.oldText || x.newText);
}

/** The paragraph(s) around [s, e) of `text`: from after a blank or structure line to before the next. */
function blockAround(text: string, s: number, e: number): [number, number] {
  let a = text.lastIndexOf("\n", s - 1) + 1;
  for (;;) {
    if (a === 0) break;
    const prevStart = text.lastIndexOf("\n", a - 2) + 1;
    const prev = text.slice(prevStart, a - 1);
    if (!prev.trim() || STRUCTURE_LINE.test(prev)) break;
    a = prevStart;
  }
  let b = text.indexOf("\n", Math.max(e, s + 1) - 1);
  if (b < 0) b = text.length;
  for (;;) {
    if (b >= text.length) break;
    const nextEnd = text.indexOf("\n", b + 1);
    const next = text.slice(b + 1, nextEnd < 0 ? text.length : nextEnd);
    if (!next.trim() || STRUCTURE_LINE.test(next)) break;
    b = nextEnd < 0 ? text.length : nextEnd;
  }
  while (a < b && /[ \t]/.test(text[a]!)) a++;
  return [a, b];
}

/**
 * A change that replaces whole paragraphs with unrelated ones: widened to the whole paragraphs
 * (a shared full stop at the end means nothing then), and given its halves (see `Edit.halves`).
 */
function unrelated(oldText: string, newText: string, e: Edit): Edit {
  if (!e.oldText.trim() || !e.newText.trim()) return e;
  if (wordSimilarity(words(e.oldText), words(e.newText), PAIR_MIN) >= PAIR_MIN) return e;
  const [os, oe] = blockAround(oldText, e.start, e.end);
  const [ns, ne] = blockAround(newText, e.newStart, e.newEnd);
  // Most of the paragraphs, on both sides: a few shared characters at the edges at most.
  const most = (a: number, b: number, s: number, t: number) => s >= a && t <= b && (t - s) / Math.max(1, b - a) >= 0.8;
  if (!most(os, oe, e.start, e.end) || !most(ns, ne, e.newStart, e.newEnd)) return e;
  const whole = makeEdit(oldText, newText, os, oe, ns, ne);
  // The halves take a paragraph break with them, so either one alone leaves the text well formed.
  const after = (t: string, at: number) => /^\n(?:[ \t]*\n)+/.exec(t.slice(at))?.[0].length ?? 0;
  const before = (t: string, at: number) => /(?:\n[ \t]*)+\n$/.exec(t.slice(0, at))?.[0].length ?? 0;
  const [oa, na] = [after(oldText, oe), after(newText, ne)];
  if (oa && na) {
    const del = makeEdit(oldText, newText, os, oe + oa, ne + na, ne + na);
    const ins = makeEdit(oldText, newText, os, os, ns, ne + na);
    return { ...whole, halves: [del, ins] };
  }
  const [ob, nb] = [before(oldText, os), before(newText, ns)];
  if (ob && nb) {
    const del = makeEdit(oldText, newText, os - ob, oe, ns - nb, ns - nb);
    const ins = makeEdit(oldText, newText, os - ob, os - ob, ns - nb, ne);
    return { ...whole, halves: [del, ins] };
  }
  return whole;
}

/** A sentence is one change when more than this share of its words change… */
const SENTENCE_REWRITE = 0.4;
/** …or when it would come apart into this many pieces. */
const SENTENCE_PIECES = 4;

type Same = (a: Token, b: Token) => boolean;

/** Token diff of ot[oa, ob) and nt[na, nb), appended to `u`. */
function diffRange(ot: Token[], nt: Token[], oa: number, ob: number, na: number, nb: number, same: Same, u: U[]): void {
  // Anchor the common prefix and suffix before diffing the middle. The diff matches greedily from
  // the front: for a block inserted before a paragraph whose first words also occur in the block,
  // it matched those words inside the block, and a pure insertion became a replacement ("The
  // algorithm " → block + "The algorithm "), which hid moves (bug report 2026-11-13). When one
  // side is wholly a suffix of the other, the change is an insertion (deletion) in front.
  const lo = ob - oa;
  const ln = nb - na;
  const shorter = Math.min(lo, ln);
  let suf = 0;
  while (suf < shorter && same(ot[ob - 1 - suf]!, nt[nb - 1 - suf]!)) suf++;
  let pre = 0;
  if (suf < shorter) {
    while (pre < shorter && same(ot[oa + pre]!, nt[na + pre]!)) pre++;
    suf = 0;
    while (suf < shorter - pre && same(ot[ob - 1 - suf]!, nt[nb - 1 - suf]!)) suf++;
  }
  for (let k = 0; k < pre; k++) u.push({ o: oa + k, n: na + k });
  let oi = oa + pre;
  let ni = na + pre;
  for (const ch of diffArrays(ot.slice(oi, ob - suf), nt.slice(ni, nb - suf), { comparator: same })) {
    const count = ch.count ?? ch.value.length;
    for (let k = 0; k < count; k++) {
      if (ch.removed) u.push({ o: oi++, n: -1 });
      else if (ch.added) u.push({ o: -1, n: ni++ });
      else u.push({ o: oi++, n: ni++ });
    }
  }
  for (let k = 0; k < suf; k++) u.push({ o: oi++, n: ni++ });
}

/**
 * Paragraphs of a token list: [first, end) token indexes of the runs between paragraph breaks.
 * A structure line (`\section{…}`, `\begin{proof}`, `\item …`) is a block of its own: the
 * paragraph after it starts there, and pairing it with the heading glued a heading to an inserted
 * paragraph (heading + new paragraph inserted, old heading deleted).
 */
function tokenBlocks(toks: Token[]): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  const close = (i: number) => {
    if (s >= 0) {
      let e = i;
      while (e > s && toks[e - 1]!.type === "ws") e--;
      if (e > s) out.push([s, e]);
    }
    s = -1;
  };
  const lineStart = (i: number) => i === 0 || (toks[i - 1]!.type !== "comment" && /\n[ \t]*$/.test(toks[i - 1]!.text));
  let structure = false; // the current block is a structure line
  for (let i = 0; i <= toks.length; i++) {
    const t = toks[i];
    if (!t || t.type === "parbreak") {
      close(i);
      structure = false;
      continue;
    }
    if (t.type === "ws" && t.text.includes("\n") && structure) {
      close(i);
      structure = false;
      continue;
    }
    if (isBoundaryCmd(t) && lineStart(i)) {
      close(i);
      s = i;
      structure = true;
      continue;
    }
    if (s < 0 && t.type !== "ws") s = i;
  }
  return out;
}

/** Paired paragraphs: old blocks o[0]..o[1] became new blocks n[0]..n[1] (inclusive). */
interface BlockPair {
  o: [number, number];
  n: [number, number];
}

/**
 * Which old paragraph became which new one: the in-order pairing of the most alike paragraphs
 * (word similarity at least PAIR_MIN). Pairing by position instead showed a paragraph edited in
 * place as replaced by a new neighbour and inserted again (bug report C42). A paragraph split in
 * two (or two merged) pairs with both.
 */
function pairBlocks(ot: Token[], nt: Token[], ob: [number, number][], nb: [number, number][]): BlockPair[] {
  const wordsOf = (toks: Token[], [a, b]: [number, number]) => toks.slice(a, b).filter((t) => !isBlank(t)).map((t) => t.text);
  const ow = ob.map((b) => wordsOf(ot, b));
  const nw = nb.map((b) => wordsOf(nt, b));
  const m = ob.length;
  const k = nb.length;
  const score = Array.from({ length: m + 1 }, () => new Array<number>(k + 1).fill(0));
  const sim = Array.from({ length: m }, () => new Array<number>(k).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= k; j++) {
      const s = paragraphSimilarity(ow[i - 1]!, nw[j - 1]!, PAIR_MIN);
      sim[i - 1]![j - 1] = s;
      score[i]![j] = Math.max(score[i - 1]![j]!, score[i]![j - 1]!, s >= PAIR_MIN ? score[i - 1]![j - 1]! + s : 0);
    }
  }
  const pairs: BlockPair[] = [];
  for (let i = m, j = k; i > 0 && j > 0; ) {
    const s = sim[i - 1]![j - 1]!;
    if (s >= PAIR_MIN && score[i]![j] === score[i - 1]![j - 1]! + s) {
      pairs.unshift({ o: [i - 1, i - 1], n: [j - 1, j - 1] });
      i--;
      j--;
    } else if (score[i - 1]![j]! >= score[i]![j - 1]!) i--;
    else j--;
  }
  // Take in unpaired neighbours while that makes the pair more alike: a split or merged paragraph.
  const usedO = new Set(pairs.map((p) => p.o[0]));
  const usedN = new Set(pairs.map((p) => p.n[0]));
  const simOf = (p: BlockPair) => wordSimilarity(ow.slice(p.o[0], p.o[1] + 1).flat(), nw.slice(p.n[0], p.n[1] + 1).flat());
  for (const p of pairs) {
    let cur = simOf(p);
    for (let grown = true; grown; ) {
      grown = false;
      const tries: BlockPair[] = [
        { o: p.o, n: [p.n[0] - 1, p.n[1]] }, { o: p.o, n: [p.n[0], p.n[1] + 1] },
        { o: [p.o[0] - 1, p.o[1]], n: p.n }, { o: [p.o[0], p.o[1] + 1], n: p.n },
      ];
      for (const t of tries) {
        const newO = t.o[0] !== p.o[0] ? t.o[0] : t.o[1] !== p.o[1] ? t.o[1] : -1;
        const newN = t.n[0] !== p.n[0] ? t.n[0] : t.n[1] !== p.n[1] ? t.n[1] : -1;
        if (newO >= 0 && (newO >= m || usedO.has(newO))) continue;
        if (newN >= 0 && (newN >= k || usedN.has(newN))) continue;
        if (newO < -1 || newN < -1 || t.o[0] < 0 || t.n[0] < 0) continue;
        const sc = simOf(t);
        if (sc > cur + 0.05) {
          [p.o, p.n, cur] = [t.o, t.n, sc];
          if (newO >= 0) usedO.add(newO);
          if (newN >= 0) usedN.add(newN);
          grown = true;
          break;
        }
      }
    }
  }
  return pairs;
}

/**
 * The token alignment of a changed region. With several paragraphs on a side, paragraphs are
 * paired by similarity first and diffed pair by pair; what lies between pairs (new or removed
 * paragraphs) is diffed on its own. `hard` gets the alignment indexes where a pair starts or ends.
 */
function alignTokens(ot: Token[], nt: Token[], same: Same, hard: Set<number>): U[] {
  const u: U[] = [];
  const ob = tokenBlocks(ot);
  const nb = tokenBlocks(nt);
  const pairs = ob.length > 1 || nb.length > 1 ? pairBlocks(ot, nt, ob, nb) : [];
  if (!pairs.length) {
    gap(ot, nt, 0, ot.length, 0, nt.length, same, u, ob.length > 1 || nb.length > 1);
    return u;
  }
  let o = 0;
  let n = 0;
  for (const p of pairs) {
    const [os, oe] = [ob[p.o[0]]![0], ob[p.o[1]]![1]];
    const [ns, ne] = [nb[p.n[0]]![0], nb[p.n[1]]![1]];
    gap(ot, nt, o, os, n, ns, same, u, true);
    hard.add(u.length);
    diffRange(ot, nt, os, oe, ns, ne, same, u);
    hard.add(u.length);
    [o, n] = [oe, ne];
  }
  gap(ot, nt, o, ot.length, n, nt.length, same, u, true);
  return u;
}

/**
 * Text between paired paragraphs (or a region without pairs): diffed token by token, unless
 * paragraphs there were replaced by unrelated text (`blocks`: the region has several). Then it is
 * one replacement, not a token diff that matches stray words ("\begin{proof} …" → "The proof
 * is in the appendix").
 */
function gap(ot: Token[], nt: Token[], oa: number, ob: number, na: number, nb: number, same: Same, u: U[], blocks: boolean): void {
  const words = (toks: Token[], a: number, b: number) => toks.slice(a, b).filter((t) => !isBlank(t)).map((t) => t.text);
  const [ow, nw] = [words(ot, oa, ob), words(nt, na, nb)];
  if (!blocks || !ow.length || !nw.length || paragraphSimilarity(ow, nw, PAIR_MIN) >= PAIR_MIN) {
    diffRange(ot, nt, oa, ob, na, nb, same, u);
    return;
  }
  let pre = 0;
  while (oa + pre < ob && na + pre < nb && isBlank(ot[oa + pre]!) && same(ot[oa + pre]!, nt[na + pre]!)) pre++;
  let suf = 0;
  while (suf < ob - oa - pre && suf < nb - na - pre && isBlank(ot[ob - 1 - suf]!) && same(ot[ob - 1 - suf]!, nt[nb - 1 - suf]!)) suf++;
  for (let k = 0; k < pre; k++) u.push({ o: oa + k, n: na + k });
  for (let k = oa + pre; k < ob - suf; k++) u.push({ o: k, n: -1 });
  for (let k = na + pre; k < nb - suf; k++) u.push({ o: -1, n: k });
  for (let k = 0; k < suf; k++) u.push({ o: ob - suf + k, n: nb - suf + k });
}

/**
 * Slide insertions and deletions that could equally sit a few tokens earlier or later to where
 * they read best: where the text around them matches exactly (`same` takes a line break for a
 * space), then starting a sentence, after a space. A sentence moved inside its paragraph was
 * inserted as ". The method is fast" before the next full stop.
 */
function slide(u: U[], ot: Token[], nt: Token[], same: Same): void {
  const ends = (t: Token | undefined) => !!t && t.type === "punct" && ".?!".includes(t.text);
  const score = (toks: Token[], a: number, b: number): number => {
    const prev = toks[a - 1];
    let sc = 0;
    if (!prev || isBlank(prev)) sc += 1;
    if (!prev || prev.type === "parbreak" || (isBlank(prev) && (a < 2 || ends(toks[a - 2]) || toks[a - 2]!.type === "parbreak"))) sc += 2;
    const last = toks[b - 1];
    if (last && (isBlank(last) || ends(last))) sc += 1;
    return sc;
  };
  for (const key of ["n", "o"] as const) {
    const toks = key === "n" ? nt : ot;
    const other = key === "n" ? "o" : "n";
    for (let i = 0; i < u.length; i++) {
      // A run that only adds (key "n") or only removes (key "o") tokens.
      if (u[i]![other] >= 0 || u[i]![key] < 0) continue;
      let j = i;
      while (j < u.length && u[j]![other] < 0 && u[j]![key] >= 0) j++;
      const at = (d: number) => u[i]![key] + d; // first token of the run shifted by d
      const len = j - i;
      let lo = 0;
      while (i + lo - 1 >= 0 && u[i + lo - 1]!.o >= 0 && u[i + lo - 1]!.n >= 0 && same(toks[at(lo - 1)]!, toks[at(lo - 1) + len]!)) lo--;
      let hi = 0;
      while (j + hi < u.length && u[j + hi]!.o >= 0 && u[j + hi]!.n >= 0 && same(toks[at(hi)]!, toks[at(hi) + len]!)) hi++;
      if (lo === hi) {
        i = j - 1;
        continue;
      }
      const from = i + lo;
      const to = j + hi;
      const commons = u.slice(from, to).filter((e) => e.o >= 0 && e.n >= 0).map((e) => e[other]);
      const first = at(lo);
      const otherToks = key === "n" ? ot : nt;
      // Common pairs in the window whose texts are equal, with the run shifted by d.
      const exact = (d: number): number => {
        let c = 0;
        let x = 0;
        for (let t = first; t < first + (to - from); t++) {
          if (t >= at(d) && t < at(d) + len) continue;
          if (toks[t]!.text === otherToks[commons[x++]!]!.text) c++;
        }
        return c;
      };
      const rate = (d: number) => exact(d) * 10 + score(toks, at(d), at(d) + len);
      let best = 0;
      let bestScore = rate(0);
      for (let d = lo; d <= hi; d++) {
        const sc = rate(d);
        if (sc > bestScore) [best, bestScore] = [d, sc];
      }
      if (best !== 0) {
        // Rebuild the window [i+lo, j+hi): common entries, with the run shifted by `best`.
        const out: U[] = [];
        let c = 0;
        for (let t = first; t < first + (to - from); t++) {
          const inRun = t >= at(best) && t < at(best) + len;
          out.push(inRun ? ({ [key]: t, [other]: -1 } as unknown as U) : ({ [key]: t, [other]: commons[c++]! } as unknown as U));
        }
        u.splice(from, to - from, ...out);
      }
      i = j + best - 1;
    }
  }
}

export function splitSegment(oldSeg: string, newSeg: string, cfg: SplitConfig): Edit[] {
  const ot = tokenize(oldSeg);
  const nt = tokenize(newSeg);
  const same = (a: Token, b: Token) =>
    a.text === b.text || (cfg.ignoreReflow && a.type === "ws" && b.type === "ws");
  // Where a new unit of the alignment starts (see `alignTokens`): changes don't cross these.
  const hard = new Set<number>();
  const u = alignTokens(ot, nt, same, hard);
  slide(u, ot, nt, same);
  const isChange = (e: U) => e.o < 0 || e.n < 0;

  // Raw edits: maximal runs of changed entries.
  let ranges: [number, number][] = [];
  for (let i = 0; i < u.length; ) {
    if (!isChange(u[i]!)) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < u.length && isChange(u[j]!) && !hard.has(j)) j++;
    ranges.push([i, j]);
    i = j;
  }
  if (!ranges.length) return [];

  const oldTok = (i: number) => (u[i] && u[i]!.o >= 0 ? ot[u[i]!.o] : undefined);
  const abbreviations = new Set(cfg.abbreviations);
  const isSentenceEnd = (i: number): boolean => {
    const t = oldTok(i);
    if (!t || t.type !== "punct" || !".?!".includes(t.text)) return false;
    const next = oldTok(i + 1);
    if (!next || !isBlank(next)) return false;
    if (t.text !== ".") return true;
    let k = i;
    let word = "";
    while (k >= 0 && oldTok(k) && !isBlank(oldTok(k)!)) word = oldTok(k--)!.text + word;
    return !abbreviations.has(word);
  };
  const boundaryIn = (a: number, b: number): boolean => {
    for (let i = Math.max(0, a - 1); i < b; i++) {
      const t = oldTok(i);
      if (!t) continue;
      if (i >= a && (t.type === "parbreak" || isBoundaryCmd(t))) return true;
      if (isSentenceEnd(i)) return true;
    }
    return false;
  };

  const os = side(ot, u, "o");
  const ns = side(nt, u, "n");
  // Edits inside a key argument (\label{...}, \ref{...}, \cite{...}) stay separate items,
  // so renames can be accepted or linked on their own.
  const keyU = [...os.keys.map(([a, b]) => [os.pos[a]!, os.pos[b]! + 1]), ...ns.keys.map(([a, b]) => [ns.pos[a]!, ns.pos[b]! + 1])];
  const isKey = (r: [number, number]) => keyU.some(([a, b]) => a! <= r[0] && r[1] <= b!);
  const hardIn = (a: number, b: number) => [...hard].some((h) => h >= a && h <= b);
  const structuralIn = (a: number, b: number) => {
    for (let i = a; i < b; i++) {
      const t = oldTok(i);
      if (t && (t.type === "parbreak" || isBoundaryCmd(t))) return true;
    }
    return false;
  };

  // Merge edits separated by a small gap without a boundary.
  const merged: [number, number][] = [ranges[0]!];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1]!;
    let content = 0;
    for (let i = last[1]; i < r[0]; i++) if (!isBlank(oldTok(i)!)) content++;
    if (content <= cfg.mergeGap && !boundaryIn(last[1], r[0]) && !hardIn(last[1], r[0]) && !isKey(last) && !isKey(r)) last[1] = r[1];
    else merged.push(r);
  }
  ranges = merged;

  // Grow to balanced braces / whole math, merging overlaps, until stable.
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of ranges) {
      while (growSide(r, u, os, "o") || growSide(r, u, ns, "n")) changed = true;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const out: [number, number][] = [];
    for (const r of ranges) {
      const last = out[out.length - 1];
      if (last && (r[0] < last[1] || (r[0] === last[1] && !isKey(last) && !isKey(r) && !hard.has(r[0])))) {
        last[1] = Math.max(last[1], r[1]);
        changed = true;
      } else out.push([r[0], r[1]]);
    }
    ranges = out;
  }

  // Coarsen heavily rewritten paragraphs into one edit.
  const para = new Array<number>(u.length);
  let p = 0;
  u.forEach((e, i) => {
    // A paragraph break on either side (an inserted paragraph is a paragraph of its own).
    const t = e.o >= 0 ? ot[e.o]! : nt[e.n]!;
    if (t.type === "parbreak" || hard.has(i)) p++;
    para[i] = p;
  });
  const totals = new Map<number, number>();
  const changedCount = new Map<number, number>();
  // Ratio = changed tokens on both sides / all tokens on both sides.
  u.forEach((e, i) => {
    const t = e.o >= 0 ? ot[e.o]! : nt[e.n]!;
    if (isBlank(t)) return;
    const weight = e.o >= 0 && e.n >= 0 ? 2 : 1;
    totals.set(para[i]!, (totals.get(para[i]!) ?? 0) + weight);
    if (isChange(e)) changedCount.set(para[i]!, (changedCount.get(para[i]!) ?? 0) + 1);
  });
  const coarse: [number, number][] = [];
  for (const r of ranges) {
    const last = coarse[coarse.length - 1];
    const pid = para[r[0]]!;
    const ratio = (changedCount.get(pid) ?? 0) / Math.max(1, totals.get(pid) ?? 0);
    const join = last && para[last[0]] === pid && ratio > cfg.rewriteRatio && !isKey(last) && !isKey(r) && !structuralIn(last[1], r[0]);
    if (join) last[1] = r[1];
    else coarse.push([r[0], r[1]]);
  }

  // The same for single sentences: a sentence rewritten this much, or in this many pieces, is
  // one change. Its pieces rarely read right on their own (bug report C31).
  const sent = new Array<number>(u.length);
  let sc = 0;
  u.forEach((e, i) => {
    if (i > 0 && para[i] !== para[i - 1]) sc++;
    sent[i] = sc;
    // Line breaks and cells of tables, formulas and pseudocode end a "sentence" too.
    const t = e.o >= 0 ? ot[e.o]! : nt[e.n]!;
    // So do the statements of TikZ and other code (`;`).
    if (isSentenceEnd(i) || t.text === "\\\\" || t.text === "&" || t.text === ";" || isBoundaryCmd(t)) sc++;
  });
  const sTotals = new Map<number, number>();
  const sChanged = new Map<number, number>();
  u.forEach((e, i) => {
    const t = e.o >= 0 ? ot[e.o]! : nt[e.n]!;
    if (isBlank(t)) return;
    sTotals.set(sent[i]!, (sTotals.get(sent[i]!) ?? 0) + (e.o >= 0 && e.n >= 0 ? 2 : 1));
    if (isChange(e)) sChanged.set(sent[i]!, (sChanged.get(sent[i]!) ?? 0) + 1);
  });
  const pieces = new Map<number, number>();
  for (const r of coarse) pieces.set(sent[r[0]]!, (pieces.get(sent[r[0]]!) ?? 0) + 1);
  const sentences: [number, number][] = [];
  for (const r of coarse) {
    const last = sentences[sentences.length - 1];
    const sid = sent[r[0]]!;
    const ratio = (sChanged.get(sid) ?? 0) / Math.max(1, sTotals.get(sid) ?? 0);
    const join =
      last && sent[last[1] - 1] === sid && (ratio > SENTENCE_REWRITE || (pieces.get(sid) ?? 0) >= SENTENCE_PIECES) &&
      !isKey(last) && !isKey(r) && !structuralIn(last[1], r[0]) && !hardIn(last[1], r[0]);
    if (join) last[1] = r[1];
    else sentences.push([r[0], r[1]]);
  }

  // Convert U ranges to character offsets.
  const offsetAt = (i: number, key: "o" | "n"): number => {
    const toks = key === "o" ? ot : nt;
    for (let k = i; k < u.length; k++) {
      const t = u[k]![key];
      if (t >= 0) return toks[t]!.start;
    }
    return key === "o" ? oldSeg.length : newSeg.length;
  };
  const edits: Edit[] = [];
  for (const [s, e] of sentences) {
    const edit = makeEdit(oldSeg, newSeg, offsetAt(s, "o"), offsetAt(e, "o"), offsetAt(s, "n"), offsetAt(e, "n"));
    if (edit.oldText !== edit.newText) edits.push(edit);
  }
  return edits;
}

/** Is this edit a whole key argument such as `\label{a}` → `\label{b}`? */
export function isKeyEdit(oldText: string, newText: string): boolean {
  const whole = (t: string) => {
    const m = /^\s*(\\[A-Za-z@]+\*?)(?:\[[^\]]*\])*\{[^{}]*\}\s*$/.exec(t);
    return !!m && KEY_ARG_CMDS.test(m[1]!);
  };
  return (whole(oldText) || !oldText.trim()) && (whole(newText) || !newText.trim()) && (whole(oldText) || whole(newText));
}
