/**
 * Moves (spec §6.4.7): a longer passage deleted in one place and inserted in another, word for
 * word, is reviewed as one change instead of an unrelated deletion and insertion. Up to a few
 * changed words still count, and are shown; anything more stays a deletion and an insertion.
 */
import { diffArrays } from "diff";
import { isLive, type Item } from "./model.js";
import { normalizeWs } from "./text.js";

export interface MoveSettings {
  enabled: boolean;
  minWords: number;
  maxChangedWords: number;
}

export interface MovePair {
  from: Item;
  to: Item;
  changed: number;
  title: string;
}

/** Words of a passage: moves are compared word for word, spacing and line breaks aside. */
export const moveWords = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** Words that differ between two passages: for each differing stretch, the longer side. */
export function changedWords(a: string[], b: string[]): number {
  let n = 0;
  let removed = 0;
  let added = 0;
  for (const ch of diffArrays(a, b)) {
    const count = ch.count ?? ch.value.length;
    if (ch.removed) removed += count;
    else if (ch.added) added += count;
    else {
      n += Math.max(removed, added);
      removed = added = 0;
    }
  }
  return n + Math.max(removed, added);
}

/** How many changed words a passage of `words` words may have and still count as a move. */
export const allowedChanges = (words: number, max: number): number => Math.min(max, Math.floor(words / 20));

export interface MoveChange {
  /** Character range in the moved-in text (empty: words were dropped here). */
  start: number;
  end: number;
  /** The words of the moved-out text this replaces ("" for an addition). */
  was: string;
  now: string;
}

/** Where the moved-in text differs from the moved-out text, word by word. */
export function moveChanges(fromText: string, toText: string): MoveChange[] {
  const words = [...toText.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
  const out: MoveChange[] = [];
  let bi = 0;
  let pending: { was: string[]; now: typeof words } | null = null;
  const flush = () => {
    if (!pending) return;
    const now = pending.now;
    const at = now.length ? now[0]!.start : bi < words.length ? words[bi]!.start : toText.trimEnd().length;
    out.push({ start: at, end: now.length ? now[now.length - 1]!.end : at, was: pending.was.join(" "), now: now.map((w) => w.text).join(" ") });
    pending = null;
  };
  for (const ch of diffArrays(moveWords(fromText), words.map((w) => w.text))) {
    const count = ch.count ?? ch.value.length;
    if (ch.removed) (pending ??= { was: [], now: [] }).was.push(...ch.value);
    else if (ch.added) {
      (pending ??= { was: [], now: [] }).now.push(...words.slice(bi, bi + count));
      bi += count;
    } else {
      flush();
      bi += count;
    }
  }
  flush();
  return out;
}

const SENTENCE_END = /[.?!][)\]}'"’”$]*$/;

function sentences(words: string[], abbreviations: Set<string>): number {
  return words.filter((w) => SENTENCE_END.test(w) && !abbreviations.has(w)).length;
}

/** A line that starts a LaTeX structure (section, environment, item): a paragraph may follow it directly. */
const STRUCTURE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end|item|label|caption|maketitle|noindent|medskip|bigskip|smallskip|par)\b/;

/** Is `text` (an item's old or new text, inside the item's context) a whole paragraph or environment? */
function wholeBlock(it: Item, text: string): string | null {
  const t = text.trim();
  const env = /^\\begin\s*\{([^}]+)\}/.exec(t)?.[1];
  if (env && new RegExp(`\\\\end\\s*\\{${env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}$`).test(t)) return `${env} environment`;
  const before = it.context.before + /^\s*/.exec(text)![0];
  const after = /\s*$/.exec(text)![0] + it.context.after;
  const prevLine = before.replace(/[ \t]*$/, "").split("\n").slice(-2, -1)[0];
  const starts = /(^|\n[ \t]*\n)[ \t]*$/.test(before) || (/\n[ \t]*$/.test(before) && prevLine !== undefined && STRUCTURE.test(prevLine));
  const nextLine = after.replace(/^[ \t]*/, "").split("\n")[1];
  const ends = /^[ \t]*(\n[ \t]*\n|\n?[ \t]*$)/.test(after) || (/^[ \t]*\n/.test(after) && nextLine !== undefined && STRUCTURE.test(nextLine));
  return starts && ends ? "paragraph" : null;
}

const short = (s: string) => {
  const t = normalizeWs(s);
  return t.length > 30 ? t.slice(0, 29) + "…" : t;
};

/**
 * Pairs of a deletion and an insertion in the same round that move a passage: at least
 * `minWords` words, two sentences or more or a whole paragraph/environment, and no more changed
 * words than allowed. Exact moves are paired first.
 */
export function detectMoves(items: Item[], s: MoveSettings, abbreviations: string[]): MovePair[] {
  if (!s.enabled) return [];
  const abbr = new Set(abbreviations);
  const mods = items.filter((i) => i.kind === "modify" && isLive(i.status) && !i.move);
  const dels = mods.filter((i) => i.oldText.trim() && !i.newText.trim());
  const ins = mods.filter((i) => i.newText.trim() && !i.oldText.trim());
  const cands: MovePair[] = [];
  for (const d of dels) {
    const dw = moveWords(d.oldText);
    if (dw.length < s.minWords) continue;
    const allowed = allowedChanges(dw.length, s.maxChangedWords);
    for (const i of ins) {
      if (i.changeset !== d.changeset) continue;
      const iw = moveWords(i.newText);
      if (Math.abs(dw.length - iw.length) > allowed) continue;
      const changed = changedWords(dw, iw);
      if (changed > allowed) continue;
      const n = sentences(dw, abbr);
      const block = wholeBlock(d, d.oldText) ?? wholeBlock(i, i.newText);
      if (n < 2 && !block) continue;
      const what = block && block !== "paragraph" ? block : n >= 2 ? `${n} sentences` : "paragraph";
      const how = changed ? `${changed} word${changed > 1 ? "s" : ""} changed` : "unchanged";
      cands.push({ from: d, to: i, changed, title: `Move “${short(d.oldText)}” (${what}, ${how})` });
    }
  }
  cands.sort((a, b) => a.changed - b.changed);
  const used = new Set<string>();
  const out: MovePair[] = [];
  for (const c of cands) {
    if (used.has(c.from.id) || used.has(c.to.id)) continue;
    used.add(c.from.id);
    used.add(c.to.id);
    out.push(c);
  }
  return out;
}
