/**
 * Finding a change's words on the page. A typesetter maps source *lines* to the page (SyncTeX),
 * and a paragraph is often one source line: it returns the whole paragraph, starting on the page
 * where the paragraph starts. The words themselves say where the change is. Pure functions.
 */
import { diffArrays } from "diff";
import type { SourceBox } from "../lang/profile.js";

/** Where text is on a page (the typesetter's `locate`, or words found on it). */
export type SyncBox = SourceBox;

/** A rectangle on a page, in PDF points from its top-left corner. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PdfWord {
  text: string;
  page: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The words of `pdftotext -bbox-layout` output, in reading order; a word hyphenated at a line end
 * is joined. Around maths pdftotext cuts a printed line into pieces in no stable order (a
 * superscript on a line of its own, the second half of a line before the first), so each block's
 * lines are rebuilt from where the words are: words of the block's usual size on one level make
 * a line, smaller ones (sub- and superscripts, operators) join the line their middle is in, and
 * every line is read left to right. Blocks stay as they are, so columns stay apart, and both
 * versions of a page read maths alike.
 */
export function parseWords(xhtml: string, firstPage: number): PdfWord[] {
  const blocks: PdfWord[][] = [];
  let page = firstPage - 1;
  let block: PdfWord[] | null = null;
  const re = /<page\b|<block\b|<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  for (let m = re.exec(xhtml); m; m = re.exec(xhtml)) {
    if (m[0] === "<page") {
      page++;
      block = null;
    } else if (m[0] === "<block") blocks.push((block = []));
    else
      (block ?? blocks[blocks.push((block = [])) - 1]!).push({
        text: decodeXml(m[5]!),
        page,
        x0: Number(m[1]),
        y0: Number(m[2]),
        x1: Number(m[3]),
        y1: Number(m[4]),
      });
  }
  const out: PdfWord[] = [];
  for (const words of blocks) {
    if (!words.length) continue;
    const h = (w: PdfWord) => w.y1 - w.y0;
    const mid = (w: PdfWord) => (w.y0 + w.y1) / 2;
    const usual = [...words].map(h).sort((a, b) => a - b)[Math.floor(words.length / 2)]!;
    // Lines: the usual-size words, by level.
    const rows: { mid: number; y0: number; y1: number; words: PdfWord[] }[] = [];
    for (const w of [...words].filter((w) => h(w) >= 0.85 * usual).sort((a, b) => mid(a) - mid(b))) {
      const row = rows.find((r) => Math.abs(r.mid - mid(w)) < 0.3 * usual);
      if (row) {
        row.words.push(w);
        row.y0 = Math.min(row.y0, w.y0);
        row.y1 = Math.max(row.y1, w.y1);
      } else rows.push({ mid: mid(w), y0: w.y0, y1: w.y1, words: [w] });
    }
    // The rest: into the line its middle is in, else the nearest.
    for (const w of words.filter((w) => h(w) < 0.85 * usual)) {
      const near = (r: (typeof rows)[number]) => (mid(w) >= r.y0 && mid(w) <= r.y1 ? 0 : Math.min(Math.abs(mid(w) - r.y0), Math.abs(mid(w) - r.y1)));
      const row = rows.reduce<(typeof rows)[number] | undefined>((best, r) => (!best || near(r) < near(best) ? r : best), undefined);
      if (row) row.words.push(w);
      else rows.push({ mid: mid(w), y0: w.y0, y1: w.y1, words: [w] });
    }
    for (const row of rows.sort((a, b) => a.mid - b.mid)) {
      const lineStart = out.length;
      for (const w of row.words.sort((a, b) => a.x0 - b.x0)) {
        const prev = out[out.length - 1];
        // "repre-" at the end of the line before, then "sentation": one word.
        if (prev && out.length === lineStart && prev.page === w.page && /[A-Za-z]-$/.test(prev.text)) {
          prev.text = prev.text.slice(0, -1) + w.text;
          continue;
        }
        out.push(w);
      }
    }
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

/** A word as it is compared on the page: letters and digits only, lower case, ligatures (ﬁ) taken apart. */
export const normWord = (w: string) =>
  w
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

const norm = normWord;

/** The longest common subsequence of `a` and `b`, as pairs of indices. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length,
    m = b.length;
  const d: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i]![j] = a[i] === b[j] ? d[i + 1]![j + 1]! + 1 : Math.max(d[i + 1]![j]!, d[i]![j + 1]!);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[i] === b[j]) {
      out.push([i, j]);
      i++;
      j++;
    } else if (d[i + 1]![j]! >= d[i]![j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * Where `target` (with the words `before` and `after` it, which tell its place among the same
 * words elsewhere) is in `words`: the PDF words of the target, or for a deletion the two words
 * around it. Null if it can't be found with some confidence. `hint`: SyncTeX's page, preferred.
 */
export function findWords(words: PdfWord[], before: string[], target: string[], after: string[], hint?: number): PdfWord[] | null {
  return findWordsIn(words, before, target, after, hint)?.words ?? null;
}

/**
 * A change found on the page: its words, or (`around`) the two words around it. `before` and
 * `after`: the words of its context found right before and after it, which bound where it is
 * (its own words may typeset differently, as maths does: `k^2` is "k", "2").
 */
export interface Located {
  words: PdfWord[];
  around: boolean;
  before?: PdfWord;
  after?: PdfWord;
  /** Shown whole (mostly rewritten), as the editor shows it; set by the caller. */
  whole?: boolean;
}

/** `findWords`, saying whether it found the change's own words or only those around it. */
export function findWordsIn(words: PdfWord[], before: string[], target: string[], after: string[], hint?: number): Located | null {
  // Long changes: their beginning and end are enough to match...
  const t = target.length > 40 ? [...target.slice(0, 20), ...target.slice(-20)] : target;
  const seq = [...before, ...t, ...after];
  if (seq.length < 2) return null;
  const pdf = words.map((w) => norm(w.text));
  // ...in a stretch of the page as long as the whole change, and then some: maths typesets as more
  // words than the source shows (a long rewritten paragraph was found by its end only).
  const span = before.length + after.length + target.length + Math.max(6, Math.ceil(target.length * 1.5));
  let best: { score: number; pairs: [number, number][]; at: number } | null = null;
  for (let s = 0; s < pdf.length; s++) {
    if (!seq.slice(0, 4).includes(pdf[s]!) && !t.includes(pdf[s]!)) continue; // windows start at a likely word
    const pairs = lcs(seq, pdf.slice(s, s + span)).map(([i, j]) => [i, j + s] as [number, number]);
    // Matched words, a little less when far from SyncTeX's page.
    const score = pairs.length - (hint !== undefined && words[s]!.page !== hint ? 0.5 : 0);
    if (!best || score > best.score) best = { score, pairs, at: s };
  }
  if (!best || best.pairs.length < Math.max(2, Math.ceil(seq.length * 0.5))) return null;
  const inTarget = best.pairs.filter(([i]) => i >= before.length && i < before.length + t.length).map(([, j]) => words[j]!);
  const lastBefore = best.pairs.filter(([i]) => i < before.length).at(-1);
  const firstAfter = best.pairs.find(([i]) => i >= before.length + t.length);
  const bounds = { ...(lastBefore ? { before: words[lastBefore[1]]! } : {}), ...(firstAfter ? { after: words[firstAfter[1]]! } : {}) };
  if (inTarget.length) return { words: inTarget, around: false, ...bounds };
  // A deletion (or a change whose words didn't match): the words on either side of it.
  const around = [lastBefore, firstAfter].filter((x): x is [number, number] => !!x).map(([, j]) => words[j]!);
  return around.length ? { words: around, around: true, ...bounds } : null;
}

/**
 * The words that differ between two versions: those of `after` not in `before` (inserted), and
 * the other way round (removed). Compared as typeset, punctuation included (a comma added is a
 * change, and an equation number "(2)" is not the exponent 2), but without hyphens, which
 * reflowing a paragraph adds and removes.
 */
export function wordDiff(before: PdfWord[], after: PdfWord[]): { inserted: PdfWord[]; removed: PdfWord[] } {
  // Maths in pieces, letters apart from digits and each symbol: how pdftotext splits maths into
  // words depends on the spacing of the line ("p+i" in one version is "p + i" in the other). A
  // word differs if a piece of it does. Between two PDFs a change of case is a change.
  type Piece = { text: string; k: number };
  type Tok = { key: string; pieces: Piece[]; prose: boolean };
  const tokens = (ws: PdfWord[]): Tok[] => {
    const out: Tok[] = [];
    ws.forEach((w, k) => {
      const text = w.text.normalize("NFKC").replace(/[\s\-\u00ad\u2010\u2011]/g, "");
      if (!text) return;
      // A prose word, with the punctuation on it, compares whole ("document." is not "document"
      // and a full stop from elsewhere).
      if (/^[^\p{L}\p{M}\p{N}]*\p{L}[\p{L}\p{M}]+[^\p{L}\p{M}\p{N}]*$/u.test(text)) {
        out.push({ key: "", pieces: [{ text, k }], prose: true });
        return;
      }
      // Maths, numbers and punctuation between two prose words: one formula, compared by its pieces
      // in any order (sub- and superscripts are read in another order when lines break differently).
      const last = out[out.length - 1];
      const pieces = (text.match(/[\p{L}\p{M}]+|\p{N}+|[^\p{L}\p{M}\p{N}]/gu) ?? []).map((t) => ({ text: t, k }));
      if (last && !last.prose) last.pieces.push(...pieces);
      else out.push({ key: "", pieces, prose: false });
    });
    for (const t of out)
      t.key = t.prose
        ? t.pieces[0]!.text
        : "\u0001" +
          t.pieces
            .map((p) => p.text)
            .sort()
            .join("\u0001");
    return out;
  };
  const [bt, at] = [tokens(before), tokens(after)];
  // Replacements: what goes and what comes between two parts that stay the same.
  const hunks: { gone: Tok[]; come: Tok[] }[] = [];
  let open: { gone: Tok[]; come: Tok[] } | null = null;
  for (const ch of diffArrays(bt, at, { comparator: (x, y) => x.key === y.key })) {
    if (!ch.added && !ch.removed) {
      open = null;
      continue;
    }
    if (!open) hunks.push((open = { gone: [], come: [] }));
    (ch.removed ? open.gone : open.come).push(...ch.value);
  }
  // A formula that only moved (it stays, and the prose around it changed) is no change.
  const goneByKey = new Map<string, Tok[]>();
  for (const h of hunks) for (const t of h.gone) if (!t.prose) goneByKey.set(t.key, [...(goneByKey.get(t.key) ?? []), t]);
  const stayed = new Set<Tok>();
  for (const h of hunks) {
    for (const t of h.come) {
      const twin = t.prose ? undefined : goneByKey.get(t.key)?.shift();
      if (twin) stayed.add(t).add(twin);
    }
  }
  for (const h of hunks) [h.gone, h.come] = [h.gone.filter((t) => !stayed.has(t)), h.come.filter((t) => !stayed.has(t))];
  const removed = new Set<number>();
  const inserted = new Set<number>();
  for (const h of hunks) {
    for (const t of h.gone) if (t.prose) removed.add(t.pieces[0]!.k);
    for (const t of h.come) if (t.prose) inserted.add(t.pieces[0]!.k);
    // Formulas changed here: their pieces in order, so only the symbols that differ are marked
    // (`k` → `k^2` marks the exponent, not an equation number "(2)" next to it); a piece that
    // only moved within them is no change.
    const bs = h.gone.filter((t) => !t.prose).flatMap((t) => t.pieces);
    const as = h.come.filter((t) => !t.prose).flatMap((t) => t.pieces);
    const gone: Piece[] = [];
    const come: Piece[] = [];
    for (const ch of diffArrays(bs, as, { comparator: (x, y) => x.text === y.text })) (ch.removed ? gone : ch.added ? come : []).push(...ch.value);
    for (const x of gone) {
      const same = come.findIndex((y) => y.text === x.text);
      if (same >= 0) come.splice(same, 1);
      else removed.add(x.k);
    }
    for (const y of come) inserted.add(y.k);
  }
  return { inserted: after.filter((_, k) => inserted.has(k)), removed: before.filter((_, k) => removed.has(k)) };
}

/**
 * The marks of the changes shown: of the words that differ (`differ`, from `wordDiff`), those
 * where a change is on the page (`spans`, from `findWordsIn`, in `words`: the pages compared):
 * between the context found before and after it. Elsewhere a difference is a consequence (an
 * equation or a reference renumbered, a float moved), not the change. A change the editor shows
 * whole (mostly rewritten) is marked whole. Without spans (none could be found), every difference.
 */
export function changeMarks(words: PdfWord[], differ: PdfWord[], spans: Located[]): PdfWord[] {
  const key = (w: PdfWord) => `${w.page}:${w.x0}:${w.y0}:${w.x1}`;
  const index = new Map(words.map((w, i) => [key(w), i]));
  const marked = new Set(differ.map(key));
  const out = new Set<number>();
  let placed = 0;
  for (const s of spans) {
    const own = s.around ? [] : s.words.map((w) => index.get(key(w))).filter((i): i is number => i !== undefined);
    const b = s.before && index.get(key(s.before));
    const a = s.after && index.get(key(s.after));
    // From the context before it to the context after it; its own words where a side is missing.
    const lo = b !== undefined ? b + 1 : own.length ? Math.min(...own) : undefined;
    const hi = a !== undefined ? a - 1 : own.length ? Math.max(...own) : undefined;
    if (lo === undefined || hi === undefined) continue;
    placed++;
    // Whole: its own words, first to last (not, say, a section number between it and the context).
    const [first, last] = s.whole && own.length ? [Math.min(...own), Math.max(...own)] : [Infinity, -Infinity];
    // The context words too where they differ: punctuation added to one ("However" → "However,").
    for (let i = b ?? lo; i <= (a ?? hi); i++) if ((i >= first && i <= last) || marked.has(key(words[i]!))) out.add(i);
  }
  if (!placed) return differ;
  return [...out].sort((x, y) => x - y).map((i) => words[i]!);
}

/** Marked words as boxes, neighbours on one line joined into one. */
export function markRuns(words: PdfWord[]): Box[] {
  const out: Box[] = [];
  let last: (PdfWord & Box) | null = null;
  for (const w of words) {
    if (last && Math.abs(w.y0 - last.y0) < 2 && w.x0 - last.x1 < 12 && w.x0 >= last.x0) {
      last.x1 = Math.max(last.x1, w.x1);
      last.y1 = Math.max(last.y1, w.y1);
      continue;
    }
    last = { ...w };
    out.push(last);
  }
  return out.map(({ x0, y0, x1, y1 }) => ({ x0, y0, x1, y1 }));
}

/** The boxes of words (for `cropRegion`), on the page of the first. */
export function wordBoxes(found: PdfWord[]): SyncBox[] {
  const page = found[0]!.page;
  return found.filter((w) => w.page === page).map((w) => ({ page, h: w.x0, v: w.y1, W: w.x1 - w.x0, H: w.y1 - w.y0 }));
}
