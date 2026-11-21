/**
 * The BibTeX profile: a .bib file is reviewed entry by entry, and its keys are the citation keys
 * of the documents that cite them.
 */
import type { Item } from "../model.js";
import { type Edit, makeEdit } from "../split.js";
import { CITATION, LATEX_PARTS } from "./latex.js";
import type { LanguageProfile } from "./profile.js";

// ---------------------------------------------------------------------------
// One edit per changed entry

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

function splitBib(oldText: string, newText: string): Edit[] | null {
  const o = parseBib(oldText);
  const n = parseBib(newText);
  if (!o || !n) return null;
  const oldByKey = new Map(o.entries.map((e) => [e.key, e]));
  const newByKey = new Map(n.entries.map((e) => [e.key, e]));
  // Anything outside entries (or reordering) changed: line hunks are clearer.
  const commonOld = o.entries.filter((e) => newByKey.has(e.key)).map((e) => e.key);
  const commonNew = n.entries.filter((e) => oldByKey.has(e.key)).map((e) => e.key);
  if (commonOld.join("\n") !== commonNew.join("\n")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: NUL marks removed text.
  const bare = (s: string) => s.replace(/\u0000|\s+/g, "");
  if (bare(o.skeleton) !== bare(n.skeleton)) return null;
  // An entry whose key changed, and nothing else, in the same place: one change of the key, so
  // that it links with the citations renamed along (spec §6.4: "Rename citation key a → b").
  const after = (entries: BibEntry[], k: number, has: Map<string, BibEntry>) =>
    entries
      .slice(0, k)
      .reverse()
      .find((x) => has.has(x.key))?.key ?? null;
  const renamed = new Map<string, BibEntry>();
  for (const [k, e] of o.entries.entries()) {
    if (newByKey.has(e.key)) continue;
    const ne = n.entries.find(
      (x, j) =>
        !oldByKey.has(x.key) &&
        ![...renamed.values()].includes(x) &&
        x.text.replace(x.key, e.key) === e.text &&
        after(n.entries, j, oldByKey) === after(o.entries, k, newByKey),
    );
    if (ne) renamed.set(e.key, ne);
  }
  const edits: Edit[] = [];
  // Deleted entries at the end of the file (nothing but whitespace after them) take the blank line
  // before them, not the file's last line break: else the file ended in a blank line (test
  // report 5e4c6af, B7).
  const gone = (e: BibEntry) => !newByKey.has(e.key) && !renamed.has(e.key);
  let tail = o.entries.length;
  while (tail > 0 && gone(o.entries[tail - 1]!)) tail--;
  const atEnd = tail < o.entries.length && !oldText.slice(o.entries[o.entries.length - 1]!.end).trim();
  for (const [k, e] of o.entries.entries()) {
    const ne = newByKey.get(e.key) ?? renamed.get(e.key);
    if (!ne) {
      // Deleted entry: also remove the whitespace after it (before it, at the end of the file).
      const before = atEnd && k >= tail ? (/\s*$/.exec(oldText.slice(0, e.start))?.[0].length ?? 0) : 0;
      const start = e.start - before;
      const end = before ? e.end : e.end + (/^\s*/.exec(oldText.slice(e.end))?.[0].length ?? 0);
      edits.push({ start, end, newStart: 0, newEnd: 0, oldText: oldText.slice(start, end), newText: "" });
    } else if (ne.text !== e.text) {
      edits.push(makeEdit(oldText, newText, e.start, e.end, ne.start, ne.end));
    }
  }
  // Added entries: insert after the preceding surviving entry, else before the
  // first old entry, else at the end of the file.
  for (let i = 0; i < n.entries.length; i++) {
    const ne = n.entries[i]!;
    if (oldByKey.has(ne.key) || [...renamed.values()].includes(ne)) continue;
    const prev = n.entries
      .slice(0, i)
      .reverse()
      .find((e) => oldByKey.has(e.key));
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

/** The keys of the entries in `t`. */
const bibKeys = (t: string) => new Set([...t.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]!));
const diffSets = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

export const BIBTEX: LanguageProfile = {
  id: "bibtex",
  name: "BibTeX",
  files: "bib",
  defaultFiles: ["*.bib"],
  extensions: /\.bib$/i,
  fence: "latex",
  document: true,
  splitUnits: splitBib,
  // Entries nest braces as LaTeX does: a change opening one that another closes is one part.
  parts: LATEX_PARTS,
  references: {
    // Entries define citation keys; a new file of entries only adds them ("Add reference knuth").
    definitions: (it: Item) => {
      if (!it.file.toLowerCase().endsWith(".bib")) return [];
      const [o, n] = [bibKeys(it.oldText), bibKeys(it.newText)];
      return [{ kind: CITATION, removed: diffSets(o, n), added: diffSets(n, o), fresh: !o.size }];
    },
    uses: () => ({ removed: [], added: [] }),
  },
};
