/**
 * Turning a file diff into reviewable edits (spec §6.1–6.2).
 * All texts are LF-normalized; offsets are UTF-16 indexes into them.
 */
import { diffArrays, diffLines } from "diff";
import { isBlank, tokenize, type Token } from "./tokenizer.js";
import type { SplitConfig } from "./config.js";

export interface Edit {
  /** Range in the old (base) text. */
  start: number;
  end: number;
  /** Range in the new (agent) text. */
  newStart: number;
  newEnd: number;
  oldText: string;
  newText: string;
}

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
    let up = 0;
    while (r.oldStart - up > lo && !blank(oldLines[r.oldStart - up - 1])) up++;
    let down = 0;
    while (r.oldEnd + down < hi && !blank(oldLines[r.oldEnd + down])) down++;
    const e = { oldStart: r.oldStart - up, oldEnd: r.oldEnd + down, newStart: r.newStart - up, newEnd: r.newEnd + down };
    const last = expanded[expanded.length - 1];
    if (last && last.oldEnd >= e.oldStart) {
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
    for (const e of splitSegment(oldSeg, newSeg, cfg)) {
      edits.push({ ...e, start: e.start + os, end: e.end + os, newStart: e.newStart + ns, newEnd: e.newEnd + ns });
    }
  }
  return edits;
}

export function splitSegment(oldSeg: string, newSeg: string, cfg: SplitConfig): Edit[] {
  const ot = tokenize(oldSeg);
  const nt = tokenize(newSeg);
  const same = (a: Token, b: Token) =>
    a.text === b.text || (cfg.ignoreReflow && a.type === "ws" && b.type === "ws");
  const u: U[] = [];
  let oi = 0;
  let ni = 0;
  for (const ch of diffArrays(ot, nt, { comparator: same })) {
    const count = ch.count ?? ch.value.length;
    for (let k = 0; k < count; k++) {
      if (ch.removed) u.push({ o: oi++, n: -1 });
      else if (ch.added) u.push({ o: -1, n: ni++ });
      else u.push({ o: oi++, n: ni++ });
    }
  }
  const isChange = (e: U) => e.o < 0 || e.n < 0;

  // Raw edits: maximal runs of changed entries.
  let ranges: [number, number][] = [];
  for (let i = 0; i < u.length; ) {
    if (!isChange(u[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < u.length && isChange(u[j]!)) j++;
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
    if (content <= cfg.mergeGap && !boundaryIn(last[1], r[0]) && !isKey(last) && !isKey(r)) last[1] = r[1];
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
      if (last && (r[0] < last[1] || (r[0] === last[1] && !isKey(last) && !isKey(r)))) {
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
    if (e.o >= 0 && e.n >= 0 && ot[e.o]!.type === "parbreak") p++;
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
  for (const [s, e] of coarse) {
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
