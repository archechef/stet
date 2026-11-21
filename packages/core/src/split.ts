/**
 * Turning a file diff into reviewable edits (spec §6.1–6.2).
 * All texts are LF-normalized; offsets are UTF-16 indexes into them.
 */
import { diffArrays, diffLines } from "diff";
import { isBlank, type Token } from "./tokenizer.js";
import type { LanguageProfile, SyntaxRules } from "./lang/profile.js";
import type { SplitConfig } from "./config.js";
import { commonWords, paragraphSimilarity, sharedWordsMatrix, wordSimilarity } from "./text.js";

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
   * An unrelated paragraph replacing another is one change, but it can be taken apart into its
   * deletions and insertions, a paragraph each: when one of them belongs to a move (§6.4.7).
   */
  halves?: Edit[];
}

/** Paragraphs this alike (word similarity) are one paragraph edited; less alike, unrelated. */
export const PAIR_MIN = 0.5;

/**
 * A file's changes as reviewable edits: by its language's syntax (sentences, paragraphs), else by
 * its own units (BibTeX entries), else by changed lines.
 */
export function splitText(profile: LanguageProfile, oldText: string, newText: string, cfg: SplitConfig): Edit[] {
  if (oldText === newText) return [];
  if (profile.syntax) return splitSyntax(profile.syntax, oldText, newText, cfg);
  return profile.splitUnits?.(oldText, newText) ?? splitLineHunks(oldText, newText);
}

export function makeEdit(oldText: string, newText: string, start: number, end: number, newStart: number, newEnd: number): Edit {
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
// Splitting by syntax (spec §6.2)

interface U {
  o: number; // old token index or -1
  n: number; // new token index or -1
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

interface Side {
  toks: Token[];
  pos: number[]; // token index -> U index
  braces: Map<number, number>;
  /** Spans that must be taken whole: math and key arguments. */
  math: [number, number][];
  /** Key-argument spans only (never merged with neighbouring edits). */
  keys: [number, number][];
}

function side(toks: Token[], u: U[], key: "o" | "n", rules: SyntaxRules): Side {
  const pos = new Array<number>(toks.length);
  u.forEach((e, i) => {
    if (e[key] >= 0) pos[e[key]] = i;
  });
  const braces = braceMatches(toks);
  const keys = rules.keySpans(toks, braces);
  return { toks, pos, braces, math: [...rules.mathSpans(toks), ...keys], keys };
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

function splitSyntax(rules: SyntaxRules, oldText: string, newText: string, cfg: SplitConfig): Edit[] {
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
    for (const e of joinAdjacent(splitSegment(oldSeg, newSeg, cfg, rules))) {
      for (const piece of perBlock(oldText, newText, { ...e, start: e.start + os, end: e.end + os, newStart: e.newStart + ns, newEnd: e.newEnd + ns }, rules)) {
        edits.push(unrelated(oldText, newText, piece, rules));
      }
    }
  }
  return shiftedBreaks(oldText, newText, verbatimWhole(oldText, newText, edits, rules));
}

/**
 * Changes inside one verbatim or raw block, joined: re-indenting a listing gave a change per line,
 * and accepting one of them left broken code (test report 5e4c6af, D7).
 */
function verbatimWhole(oldText: string, newText: string, edits: Edit[], rules: SyntaxRules): Edit[] {
  const [inOld, inNew] = [rules.verbatim(oldText), rules.verbatim(newText)];
  // Every line between two places is verbatim (checked at each line start and both ends).
  const verbatimFrom = (inside: (t: Token) => boolean, text: string, a: number, b: number) => {
    const at = (p: number) => inside({ type: "word", text: "", start: p });
    if (!at(a) || !at(Math.max(a, b - 1))) return false;
    for (let p = text.indexOf("\n", a); p >= 0 && p < b; p = text.indexOf("\n", p + 1)) if (!at(p + 1)) return false;
    return true;
  };
  const out: Edit[] = [];
  for (const e of edits) {
    const last = out[out.length - 1];
    if (last && !last.halves && !e.halves && verbatimFrom(inOld, oldText, last.start, e.end) && verbatimFrom(inNew, newText, last.newStart, e.newEnd)) {
      out[out.length - 1] = makeEdit(oldText, newText, last.start, e.end, last.newStart, e.newEnd);
    } else out.push(e);
  }
  return out;
}

/**
 * A paragraph break that moves past a sentence ("… a line. Beta two …" ending one paragraph
 * starts the next instead) is one change of the text where it stood: paragraphs are paired first,
 * so the sentence came out deleted from one and inserted into the next, and showed as moved "word
 * for word" (test report 2026-11-20). A deletion and an insertion next to each other are joined
 * when together they keep the words, (almost) all of them in order, and a paragraph break moves.
 */
function shiftedBreaks(oldText: string, newText: string, edits: Edit[]): Edit[] {
  const del = (e: Edit) => !e.halves && !!e.oldText.trim() && !e.newText.trim();
  const ins = (e: Edit) => !e.halves && !!e.newText.trim() && !e.oldText.trim();
  const out: Edit[] = [];
  for (const e of edits) {
    const last = out[out.length - 1];
    if (last && ((del(last) && ins(e)) || (ins(last) && del(e))) && last.end <= e.start && last.newEnd <= e.newStart) {
      const f = makeEdit(oldText, newText, last.start, e.end, last.newStart, e.newEnd);
      const breaks = PARBREAK.test(f.oldText) || PARBREAK.test(f.newText);
      const [a, b] = [words(f.oldText), words(f.newText)];
      // Text between them (the word the diff slid past, "line."): then the same words exactly,
      // so that a paragraph moved past another stays a move.
      const between = !!oldText.slice(last.end, e.start).trim() || !!newText.slice(last.newEnd, e.newStart).trim();
      const alike = between ? a.length === b.length && a.every((w, i) => w === b[i]) : wordSimilarity(a, b, SHIFTED_ALIKE) >= SHIFTED_ALIKE;
      if (breaks && alike) {
        out[out.length - 1] = f;
        continue;
      }
    }
    out.push(e);
  }
  return out;
}

const PARBREAK = /\n[ \t]*\n/;
/** How alike the text on both sides of a moved paragraph break must be (a word recapitalised, say). */
const SHIFTED_ALIKE = 0.8;

const words = (s: string) => s.split(/\s+/).filter(Boolean);

/**
 * A deletion right next to an insertion is one replacement: a paragraph rewritten into one
 * joined onto the next line came out as an unrelated deletion and insertion. (If one half moved,
 * submit takes them apart again, see `Edit.halves`.)
 */
function joinAdjacent(edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  // Several paragraphs on a side are paragraphs that changed order (see `gap`): kept apart.
  const pure = (e: Edit, ins: boolean) => {
    const t = (ins ? e.newText : e.oldText).trim();
    return (ins ? !e.oldText : !e.newText) && !!t && !/\n[ \t]*\n/.test(t);
  };
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

/**
 * Where a run of inserted (deleted) text may be cut into pieces of its own: at paragraph breaks,
 * and around sectioning lines and environments, outside any environment, braces or display math
 * the run opens. Cuts are offsets in `t` where a piece starts.
 */
function blockCuts(t: string, leading: boolean, rules: SyntaxRules): number[] {
  const cuts: number[] = [];
  // Nesting the run opens (environments, braces, display maths): no cuts inside.
  let depth: number[] = [];
  const lines = t.split(/(?<=\n)/);
  let pos = 0;
  let prevLine = "";
  for (const line of lines) {
    const top = depth.every((d) => d === 0);
    if (top && pos > 0) {
      const before = t.slice(0, pos);
      const blankBefore = /\n[ \t]*\n$/.test(before);
      const structural = (rules.sectionLine.test(line) || rules.sectionLine.test(prevLine)) && line.trim() !== "" && prevLine.trim() !== "";
      if (blankBefore && line.trim()) {
        // The separator goes with the piece after it when the run starts with one, else before.
        if (leading) {
          const sep = /(?:\n[ \t]*)+\n$/.exec(before)![0].length;
          if (pos - sep > 0) cuts.push(pos - sep);
        } else cuts.push(pos);
      } else if (structural) cuts.push(leading ? pos - 1 : pos);
    }
    const d = rules.lineNesting(line);
    depth = d.map((x, k) => x + (depth[k] ?? 0));
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
function perBlock(oldText: string, newText: string, e: Edit, rules: SyntaxRules): Edit[] {
  const ins = !e.oldText.trim() && !!e.newText.trim();
  const del = !e.newText.trim() && !!e.oldText.trim();
  if (!ins && !del) return [e];
  const t = ins ? e.newText : e.oldText;
  // Line breaks go before each piece when the text comes at the end of a line: after it, the
  // last piece alone ran into the old line ("tight.Here it is:", test report 5e4c6af, D4).
  const atLineEnd = /^[ \t]*(?:\n|$)/.test(ins ? oldText.slice(e.end) : newText.slice(e.newEnd));
  const leading = (/^\s*\n/.test(t) || atLineEnd) && !/\n\s*$/.test(t);
  const cuts = blockCuts(t, leading, rules);
  if (!cuts.length) return [e];
  const out: Edit[] = [];
  // A piece of whitespace only (a paragraph break at the start or end) joins its neighbour.
  const bounds = [0, ...cuts, t.length];
  for (let k = 0; k + 1 < bounds.length; ) {
    if (bounds.length > 2 && !t.slice(bounds[k]!, bounds[k + 1]!).trim()) bounds.splice(k + 1 < bounds.length - 1 ? k + 1 : k, 1);
    else k++;
  }
  if (bounds.length <= 2) return [e];
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
function blockAround(text: string, s: number, e: number, rules: SyntaxRules): [number, number] {
  let a = text.lastIndexOf("\n", s - 1) + 1;
  for (;;) {
    if (a === 0) break;
    const prevStart = text.lastIndexOf("\n", a - 2) + 1;
    const prev = text.slice(prevStart, a - 1);
    if (!prev.trim() || rules.structureLine.test(prev)) break;
    a = prevStart;
  }
  let b = text.indexOf("\n", Math.max(e, s + 1) - 1);
  if (b < 0) b = text.length;
  for (;;) {
    if (b >= text.length) break;
    const nextEnd = text.indexOf("\n", b + 1);
    const next = text.slice(b + 1, nextEnd < 0 ? text.length : nextEnd);
    if (!next.trim() || rules.structureLine.test(next)) break;
    b = nextEnd < 0 ? text.length : nextEnd;
  }
  while (a < b && /[ \t]/.test(text[a]!)) a++;
  return [a, b];
}

/**
 * A change that replaces whole paragraphs with unrelated ones: widened to the whole paragraphs
 * (a shared full stop at the end means nothing then), and given its halves (see `Edit.halves`).
 */
function unrelated(oldText: string, newText: string, e: Edit, rules: SyntaxRules): Edit {
  if (!e.oldText.trim() || !e.newText.trim()) return e;
  if (wordSimilarity(words(e.oldText), words(e.newText), PAIR_MIN) >= PAIR_MIN) return e;
  const [os, oe] = blockAround(oldText, e.start, e.end, rules);
  const [ns, ne] = blockAround(newText, e.newStart, e.newEnd, rules);
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
    return { ...whole, halves: [...perBlock(oldText, newText, del, rules), ...perBlock(oldText, newText, ins, rules)] };
  }
  const [ob, nb] = [before(oldText, os), before(newText, ns)];
  if (ob && nb) {
    const del = makeEdit(oldText, newText, os - ob, oe, ns - nb, ns - nb);
    const ins = makeEdit(oldText, newText, os - ob, os - ob, ns - nb, ne);
    return { ...whole, halves: [...perBlock(oldText, newText, del, rules), ...perBlock(oldText, newText, ins, rules)] };
  }
  return whole;
}

/** A sentence is one change when more than this share of its words change… */
const SENTENCE_REWRITE = 0.4;
/** …or when it would come apart into this many pieces. */
const SENTENCE_PIECES = 4;
/** Edits of one sentence with at most this many words between them are one change. */
const SENTENCE_NEAR = 6;

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
function tokenBlocks(toks: Token[], rules: SyntaxRules): [number, number][] {
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
    if (rules.isBoundary(t) && lineStart(i)) {
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
/** Above this many paragraph pairs, `pairBlocks` pairs the obvious ones first (`anchorPairs`). */
const PAIR_ALL_MAX = 2500;

/**
 * Pairs of paragraphs that are surely one paragraph edited: each the other's best match by the
 * word triples they share, at least 90% alike, in order (the longest run of such pairs that keeps
 * the order, as patience diff does with unique lines).
 */
function anchorPairs(ow: string[][], nw: string[][]): { o: number; n: number }[] {
  const triples = (ws: string[]) => (ws.length < 3 ? [ws.join(" ")] : ws.slice(2).map((_, i) => `${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`));
  const where = new Map<string, number[]>();
  nw.forEach((ws, j) => {
    for (const t of new Set(triples(ws))) where.set(t, [...(where.get(t) ?? []), j]);
  });
  const best = (counts: Map<number, number>) => {
    let [at, n] = [-1, 0];
    for (const [j, c] of counts) if (c > n) [at, n] = [j, c];
    return at;
  };
  const bestN = ow.map((ws) => {
    const counts = new Map<number, number>();
    for (const t of new Set(triples(ws))) for (const j of where.get(t) ?? []) counts.set(j, (counts.get(j) ?? 0) + 1);
    return best(counts);
  });
  // The best old match of each new paragraph that was some old paragraph's best.
  const wanted = new Set(bestN.filter((j) => j >= 0));
  const oWhere = new Map<string, number[]>();
  ow.forEach((ws, i) => {
    for (const t of new Set(triples(ws))) oWhere.set(t, [...(oWhere.get(t) ?? []), i]);
  });
  const bestO = new Map<number, number>();
  for (const j of wanted) {
    const counts = new Map<number, number>();
    for (const t of new Set(triples(nw[j]!))) for (const i of oWhere.get(t) ?? []) counts.set(i, (counts.get(i) ?? 0) + 1);
    bestO.set(j, best(counts));
  }
  const cands = bestN.flatMap((j, i) => (j >= 0 && bestO.get(j) === i && wordSimilarity(ow[i]!, nw[j]!, 0.9) >= 0.9 ? [{ o: i, n: j }] : []));
  // Longest run increasing in both (cands are in old order): patience sorting on `n`.
  const tails: number[] = [];
  const prev = new Array<number>(cands.length).fill(-1);
  cands.forEach((c, x) => {
    let [lo, hi] = [0, tails.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cands[tails[mid]!]!.n < c.n) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[x] = tails[lo - 1]!;
    tails[lo] = x;
  });
  const out: { o: number; n: number }[] = [];
  for (let x = tails.length ? tails[tails.length - 1]! : -1; x >= 0; x = prev[x]!) out.unshift(cands[x]!);
  return out;
}

function pairBlocks(ot: Token[], nt: Token[], ob: [number, number][], nb: [number, number][]): BlockPair[] {
  const wordsOf = (toks: Token[], [a, b]: [number, number]) => toks.slice(a, b).filter((t) => !isBlank(t)).map((t) => t.text);
  const ow = ob.map((b) => wordsOf(ot, b));
  const nw = nb.map((b) => wordsOf(nt, b));
  const m = ob.length;
  const k = nb.length;
  // Most pairs share too few words to be alike: known from the counts, without diffing them.
  const shared = sharedWordsMatrix(ow, nw);
  // The most alike pairs in order, between old paragraphs [i0, i1) and new ones [j0, j1).
  const pairIn = (i0: number, i1: number, j0: number, j1: number): BlockPair[] => {
    const [h, w] = [i1 - i0, j1 - j0];
    const score = Array.from({ length: h + 1 }, () => new Float64Array(w + 1));
    const sim = Array.from({ length: h }, () => new Float64Array(w));
    for (let i = 1; i <= h; i++) {
      for (let j = 1; j <= w; j++) {
        const s = paragraphSimilarity(ow[i0 + i - 1]!, nw[j0 + j - 1]!, PAIR_MIN, shared[i0 + i - 1]![j0 + j - 1]!);
        sim[i - 1]![j - 1] = s;
        score[i]![j] = Math.max(score[i - 1]![j]!, score[i]![j - 1]!, s >= PAIR_MIN ? score[i - 1]![j - 1]! + s : 0);
      }
    }
    const out: BlockPair[] = [];
    for (let i = h, j = w; i > 0 && j > 0; ) {
      const s = sim[i - 1]![j - 1]!;
      if (s >= PAIR_MIN && score[i]![j] === score[i - 1]![j - 1]! + s) {
        out.unshift({ o: [i0 + i - 1, i0 + i - 1], n: [j0 + j - 1, j0 + j - 1] });
        i--;
        j--;
      } else if (score[i - 1]![j]! >= score[i]![j - 1]!) i--;
      else j--;
    }
    return out;
  };
  // Many paragraphs each side (every paragraph of a long file edited): comparing every pair took
  // minutes when they all shared their words (test report 2026-11-20, B3). Paragraphs that are
  // plainly one paragraph edited are paired first, and only the stretches between are compared.
  const pairs: BlockPair[] = [];
  let [i0, j0] = [0, 0];
  for (const a of m * k > PAIR_ALL_MAX ? anchorPairs(ow, nw) : []) {
    pairs.push(...pairIn(i0, a.o, j0, a.n), { o: [a.o, a.o], n: [a.n, a.n] });
    [i0, j0] = [a.o + 1, a.n + 1];
  }
  pairs.push(...pairIn(i0, m, j0, k));
  // Take in unpaired neighbours while that makes the pair more alike: a split or merged paragraph.
  const usedO = new Set(pairs.map((p) => p.o[0]));
  const usedN = new Set(pairs.map((p) => p.n[0]));
  const simOf = (p: BlockPair, min = 0) => wordSimilarity(ow.slice(p.o[0], p.o[1] + 1).flat(), nw.slice(p.n[0], p.n[1] + 1).flat(), min);
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
        const sc = simOf(t, cur + 0.05);
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
  // A paragraph cut by a heading or other structure line inserted into it (or joined by removing
  // one): the blocks across it belong to the pair when they hold clearly more of the paragraph's
  // words, in order. Taking them in one at a time never paid, as the heading alone lowers the
  // similarity; the sentence before it came out "replaced" by the one after it (test report
  // 5e4c6af, D4).
  const span = (ws: string[][], r: [number, number]) => ws.slice(r[0], r[1] + 1).flat();
  const common = (p: BlockPair) => commonWords(span(ow, p.o), span(nw, p.n));
  for (const p of pairs) {
    for (let grown = true; grown; ) {
      grown = false;
      const base = common(p);
      for (let step = 1; step <= 3 && !grown; step++) {
        const tries: { t: BlockPair; side: "o" | "n"; add: number[] }[] = [
          { t: { o: p.o, n: [p.n[0] - step, p.n[1]] }, side: "n", add: range(p.n[0] - step, p.n[0]) },
          { t: { o: p.o, n: [p.n[0], p.n[1] + step] }, side: "n", add: range(p.n[1] + 1, p.n[1] + 1 + step) },
          { t: { o: [p.o[0] - step, p.o[1]], n: p.n }, side: "o", add: range(p.o[0] - step, p.o[0]) },
          { t: { o: [p.o[0], p.o[1] + step], n: p.n }, side: "o", add: range(p.o[1] + 1, p.o[1] + 1 + step) },
        ];
        for (const { t, side, add } of tries) {
          const [used, size] = side === "n" ? [usedN, k] : [usedO, m];
          if (add.some((x) => x < 0 || x >= size || used.has(x))) continue;
          // The words gained are of the other side's paragraph: the old one's for new blocks taken in.
          const of = span(side === "n" ? ow : nw, side === "n" ? p.o : p.n).length;
          const gain = common(t) - base;
          if (gain >= 3 && gain >= 0.3 * of) {
            [p.o, p.n] = [t.o, t.n];
            for (const x of add) used.add(x);
            grown = true;
            break;
          }
        }
      }
    }
  }
  return pairs;
}

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

/**
 * The token alignment of a changed region. With several paragraphs on a side, paragraphs are
 * paired by similarity first and diffed pair by pair; what lies between pairs (new or removed
 * paragraphs) is diffed on its own. `hard` gets the alignment indexes where a pair starts or ends.
 */
function alignTokens(ot: Token[], nt: Token[], same: Same, hard: Set<number>, rules: SyntaxRules): U[] {
  const u: U[] = [];
  const ob = tokenBlocks(ot, rules);
  const nb = tokenBlocks(nt, rules);
  const pairs = ob.length > 1 || nb.length > 1 ? pairBlocks(ot, nt, ob, nb) : [];
  // The paragraphs left unpaired on each side, for `gap`: one with a counterpart among the other
  // side's changed order (pairs keep the order).
  const wordsOf = (toks: Token[], [a, b]: [number, number]) => toks.slice(a, b).filter((t) => !isBlank(t)).map((t) => t.text);
  const paired = (k: number, side: "o" | "n") => pairs.some((p) => k >= p[side][0] && k <= p[side][1]);
  const unpaired = {
    o: ob.flatMap((b, k) => (paired(k, "o") ? [] : [wordsOf(ot, b)])),
    n: nb.flatMap((b, k) => (paired(k, "n") ? [] : [wordsOf(nt, b)])),
  };
  if (!pairs.length) {
    // Nothing paired: nothing here changed order either (pairing found nothing alike).
    gap(ot, nt, 0, ot.length, 0, nt.length, same, u, ob.length > 0 && nb.length > 0, hard, { o: [], n: [] }, rules);
    return u;
  }
  let o = 0;
  let n = 0;
  for (const p of pairs) {
    const [os, oe] = [ob[p.o[0]]![0], ob[p.o[1]]![1]];
    const [ns, ne] = [nb[p.n[0]]![0], nb[p.n[1]]![1]];
    gap(ot, nt, o, os, n, ns, same, u, true, hard, unpaired, rules);
    hard.add(u.length);
    diffRange(ot, nt, os, oe, ns, ne, same, u);
    hard.add(u.length);
    [o, n] = [oe, ne];
  }
  gap(ot, nt, o, ot.length, n, nt.length, same, u, true, hard, unpaired, rules);
  return u;
}

/**
 * Text between paired paragraphs (or a region without pairs): diffed token by token, unless
 * paragraphs there were replaced by unrelated text (`blocks`: the region has several). Then it is
 * one replacement, not a token diff that matches stray words ("\begin{proof} …" → "The proof
 * is in the appendix").
 */
function gap(
  ot: Token[], nt: Token[], oa: number, ob: number, na: number, nb: number, same: Same, u: U[], blocks: boolean, hard: Set<number>,
  unpaired: { o: string[][]; n: string[][] },
  rules: SyntaxRules,
): void {
  const words = (toks: Token[], a: number, b: number) => toks.slice(a, b).filter((t) => !isBlank(t)).map((t) => t.text);
  const [ow, nw] = [words(ot, oa, ob), words(nt, na, nb)];
  if (!blocks || !ow.length || !nw.length) {
    diffRange(ot, nt, oa, ob, na, nb, same, u);
    return;
  }
  // Paragraphs here with a counterpart among the other side's unpaired ones changed order:
  // removed and inserted, paragraph by paragraph, so that they are found as moves. Diffed as one
  // text, a reordered section came out as a few huge changes.
  const bw = (toks: Token[], a: number, b: number) => tokenBlocks(toks.slice(a, b), rules).map(([s, e]) => words(toks, a + s, a + e));
  const [obw, nbw] = [bw(ot, oa, ob), bw(nt, na, nb)];
  const alike = (x: string[], ys: string[][]) => ys.some((y) => paragraphSimilarity(x, y, PAIR_MIN) >= PAIR_MIN);
  const reordered = obw.some((x) => alike(x, unpaired.n)) || nbw.some((y) => alike(y, unpaired.o));
  if (reordered) {
    for (let k = oa; k < ob; k++) u.push({ o: k, n: -1 });
    hard.add(u.length);
    for (let k = na; k < nb; k++) u.push({ o: -1, n: k });
    return;
  }
  if (paragraphSimilarity(ow, nw, PAIR_MIN) >= PAIR_MIN) {
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
 * inserted as ". The method is fast" before the next full stop. Likewise after the end of one
 * of the language's other units (`endsUnit`): a new table row came with the separator before it.
 */
function slide(u: U[], ot: Token[], nt: Token[], same: Same, endsUnit: (t: Token) => boolean = () => false): void {
  const ends = (t: Token | undefined) => !!t && t.type === "punct" && ".?!".includes(t.text);
  const score = (toks: Token[], a: number, b: number): number => {
    const prev = toks[a - 1];
    let sc = 0;
    if (!prev || isBlank(prev)) sc += 1;
    if (prev && endsUnit(prev)) sc += 2;
    if (!prev || prev.type === "parbreak" || (isBlank(prev) && (a < 2 || ends(toks[a - 2]) || toks[a - 2]!.type === "parbreak"))) sc += 2;
    const last = toks[b - 1];
    if (last && (isBlank(last) || ends(last) || endsUnit(last))) sc += 1;
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

export function splitSegment(oldSeg: string, newSeg: string, cfg: SplitConfig, rules: SyntaxRules): Edit[] {
  const ot = rules.tokenize(oldSeg);
  const nt = rules.tokenize(newSeg);
  // Reflowing is ignored, except where spaces are content: the agent's edit of a listing's
  // spaces was dropped, and the next sync reverted it (test report 2026-11-20, D7).
  const [oVerb, nVerb] = [rules.verbatim(oldSeg), rules.verbatim(newSeg)];
  const same = (a: Token, b: Token) =>
    a.text === b.text || (cfg.ignoreReflow && a.type === "ws" && b.type === "ws" && !oVerb(a) && !nVerb(b));
  // Where a new unit of the alignment starts (see `alignTokens`): changes don't cross these.
  const hard = new Set<number>();
  const u = alignTokens(ot, nt, same, hard, rules);
  slide(u, ot, nt, same, rules.endsUnit);
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
      if (i >= a && (t.type === "parbreak" || rules.isBoundary(t))) return true;
      if (isSentenceEnd(i)) return true;
    }
    return false;
  };

  const os = side(ot, u, "o", rules);
  const ns = side(nt, u, "n", rules);
  // Edits inside a key argument (\label{...}, \ref{...}, \cite{...}) stay separate items,
  // so renames can be accepted or linked on their own.
  const keyU = [...os.keys.map(([a, b]) => [os.pos[a]!, os.pos[b]! + 1]), ...ns.keys.map(([a, b]) => [ns.pos[a]!, ns.pos[b]! + 1])];
  // Covered by key spans: a Typst key is one token, so `@a` → `@b` is a deletion in the old key's
  // span next to an insertion in the new one's, and merged with any edit nearby, a maths value
  // with it (test report 5e4c6af, D8).
  const isKey = (r: [number, number]) => {
    if (r[1] <= r[0]) return false;
    for (let i = r[0]; i < r[1]; i++) if (!keyU.some(([a, b]) => a! <= i && i < b!)) return false;
    return true;
  };
  const hardIn = (a: number, b: number) => [...hard].some((h) => h >= a && h <= b);
  const structuralIn = (a: number, b: number) => {
    for (let i = a; i < b; i++) {
      const t = oldTok(i);
      if (t && (t.type === "parbreak" || rules.isBoundary(t))) return true;
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

  // Whether an edit rebuilds its sentence: it changes its punctuation, or a word's capitals
  // (a word put before the sentence's first one, a clause turned into a new sentence).
  const restructures = ([a, b]: [number, number]): boolean => {
    const olds: Token[] = [];
    const news: Token[] = [];
    for (let i = a; i < b; i++) {
      const e = u[i]!;
      if (e.o >= 0 && e.n < 0) olds.push(ot[e.o]!);
      if (e.n >= 0 && e.o < 0) news.push(nt[e.n]!);
    }
    const punct = (ts: Token[]) => ts.filter((t) => t.type === "punct" && /^[,;:()—–-]+$/.test(t.text)).map((t) => t.text).sort().join("");
    if (punct(olds) !== punct(news)) return true;
    const words = (ts: Token[]) => ts.filter((t) => !isBlank(t) && t.type !== "punct").map((t) => t.text);
    const [ow, nw] = [words(olds), words(news)];
    return ow.some((w) => nw.some((x) => x !== w && x.toLowerCase() === w.toLowerCase()));
  };

  // The same for single sentences: a sentence rewritten this much, or in this many pieces, is
  // one change. Its pieces rarely read right on their own (bug report C31).
  const sent = new Array<number>(u.length);
  let sc = 0;
  u.forEach((e, i) => {
    if (i > 0 && para[i] !== para[i - 1]) sc++;
    sent[i] = sc;
    // So do the language's other units: table cells, forced line breaks, statements of code.
    const t = e.o >= 0 ? ot[e.o]! : nt[e.n]!;
    if (isSentenceEnd(i) || rules.endsUnit(t) || rules.isBoundary(t)) sc++;
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
    // Edits a few words apart in one sentence that rebuild it are one change: "Plants are … and
    // therefore" → "Because plants are …, they" came as two, and either alone broke the sentence
    // (test report 2026-11-20, D6). Plain word swaps ("very" → "extremely" … "useful" →
    // "helpful") stay apart: each reads right alone.
    let between = 0;
    if (last) for (let i = last[1]; i < r[0]; i++) if (oldTok(i) && !isBlank(oldTok(i)!) && oldTok(i)!.type !== "punct") between++;
    const near = !!last && between <= SENTENCE_NEAR && (restructures(last) || restructures(r));
    const join =
      last && sent[last[1] - 1] === sid && (ratio > SENTENCE_REWRITE || (pieces.get(sid) ?? 0) >= SENTENCE_PIECES || near) &&
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
