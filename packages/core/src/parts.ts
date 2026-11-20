/**
 * Parts of linked groups (spec §6.4.6). A part can be accepted or rejected on its own, so two
 * conditions must hold for every part:
 *   1. accepting it alone leaves the document compiling (warnings such as undefined references
 *      or citations are fine; errors such as an undefined macro are not), and
 *   2. accepting it does not keep any other part from being accepted later.
 * Proposed parts that can't be shown to meet them are joined. Identical changes always stay in
 * one part: reviewing forty copies of the same substitution separately helps nobody.
 */
import { joinTitles } from "./grouping.js";
import { isLive, moveOthers, type GroupPart, type Item } from "./model.js";
import { diffArrays } from "diff";
import { normalizeWs } from "./text.js";
import { profileByName, type LanguageProfile } from "./lang/index.js";

export interface PartDraft {
  title: string;
  items: string[];
}

/** Pairs of parts (indices into the list given) where accepting the first blocks the second. */
export type Interference = (parts: Item[][]) => Promise<[number, number][]>;

const short = (s: string) => {
  const t = normalizeWs(s);
  return t.length > 30 ? t.slice(0, 29) + "…" : t;
};

/** A title naming one change: \ref{a} → \ref{b}. */
export function changeTitle(it: Item): string {
  if (it.kind !== "modify") return `${it.kind} ${it.file}`;
  if (!normalizeWs(it.oldText)) return `+ ${short(it.newText)}`;
  if (!normalizeWs(it.newText)) return `− ${short(it.oldText)}`;
  return `${short(it.oldText)} → ${short(it.newText)}`;
}

const substitution = (it: Item) => (it.kind === "modify" ? normalizeWs(it.oldText) + "\u0000" + normalizeWs(it.newText) : null);

/** The profile of a file, for parts: by its name unless the caller knows the config. */
export type ProfileOf = (file: string) => LanguageProfile;

/**
 * Symbols and terms an item replaces one for one: `$n$` → `$m$`, `\alpha` → `\beta`, "estimator"
 * → "statistic". Short words count only in math (so "a" → "the" doesn't); keys of \label,
 * \ref and \cite don't (a rename is decided reference by reference). Needs the language's syntax.
 */
export function replacements(it: Item, profileOf: ProfileOf = profileByName): Set<string> {
  const out = new Set<string>();
  const syntax = profileOf(it.file).syntax;
  if (it.kind !== "modify" || !syntax || syntax.isKeyEdit(it.oldText, it.newText)) return out;
  const math = syntax.inMath(it.context.before.slice(-60) + it.oldText);
  // In math, 2n is the symbols 2 and n.
  const toks = (t: string) =>
    syntax
      .tokenize(t)
      .filter((x) => x.type !== "ws" && x.type !== "parbreak" && x.type !== "comment")
      .flatMap((x) => (math && x.type === "word" ? (x.text.match(/\p{N}+|\p{L}+|./gu) ?? [x.text]) : [x.text]));
  const counts = (w: string) => syntax.isCommand(w) || /^\p{L}{4,}$/u.test(w) || (math && /^[\p{L}\p{N}]{1,3}$/u.test(w));
  const chunks = diffArrays(toks(it.oldText), toks(it.newText));
  for (let k = 0; k + 1 < chunks.length; k++) {
    const [a, b] = [chunks[k]!, chunks[k + 1]!];
    const one = (c: typeof a) => (c.count ?? c.value.length) === 1;
    if (a.removed && b.added && one(a) && one(b) && counts(a.value[0]!)) out.add(`${a.value[0]}\u0000${b.value[0]}`);
    if (a.added && b.removed && one(a) && one(b) && counts(b.value[0]!)) out.add(`${b.value[0]}\u0000${a.value[0]}`);
  }
  return out;
}

/** The whole lines of `win` covering [start, end). */
function linesAround(win: string, start: number, end: number): string {
  const s = win.lastIndexOf("\n", start - 1) + 1;
  const e = win.indexOf("\n", end);
  return win.slice(s, e < 0 ? win.length : e);
}

/** The changed lines of an item, before and after (with the context that completes them). */
function changedLines(it: Item): string {
  const b = it.context.before.length;
  const oldWin = it.context.before + it.oldText + it.context.after;
  const newWin = it.context.before + it.newText + it.context.after;
  return linesAround(oldWin, b, b + it.oldText.length) + "\n" + linesAround(newWin, b, b + it.newText.length);
}

/** The lines an item changes, as they were and as they are with it. */
export function changedSides(it: Item): { old: string; new: string } {
  const b = it.context.before.length;
  const oldWin = it.context.before + it.oldText + it.context.after;
  const newWin = it.context.before + it.newText + it.context.after;
  return { old: linesAround(oldWin, b, b + it.oldText.length), new: linesAround(newWin, b, b + it.newText.length) };
}

/**
 * How a change shifts what its language nests (LaTeX: braces, environments, display and inline
 * maths, `$`): one count per kind, empty for a language without such rules.
 */
export function imbalance(it: { file: string; oldText: string; newText: string }, profileOf: ProfileOf = profileByName): number[] {
  const rules = profileOf(it.file).parts;
  if (!rules) return [];
  const a = rules.balance(it.oldText);
  const b = rules.balance(it.newText);
  return b.map((x, k) => x - a[k]!);
}

/** Whether summed imbalances leave something open (kinds in `parity` count modulo 2). */
export function isOpen(sum: number[], parity: readonly number[]): boolean {
  return sum.some((x, k) => (parity.includes(k) ? x % 2 !== 0 : x !== 0));
}

/**
 * Turn proposed parts into valid ones. Members not in any proposed part form one more part.
 * Returns no parts when everything ends up in one, and a note for every join.
 */
export async function settleParts(
  proposed: PartDraft[],
  members: Item[],
  interferes?: Interference,
  opts: { sameSymbol?: (a: Item, b: Item) => boolean; profileOf?: ProfileOf } = {},
): Promise<{ parts: GroupPart[] | undefined; notes: string[] }> {
  const profileOf = opts.profileOf ?? profileByName;
  const byId = new Map(members.map((m) => [m.id, m]));
  const drafts: PartDraft[] = [];
  const placed = new Set<string>();
  for (const p of proposed) {
    const items = [...new Set(p.items)].filter((i) => byId.has(i));
    if (!items.length) continue;
    drafts.push({ title: p.title, items });
    for (const i of items) placed.add(i);
  }
  const rest = members.filter((m) => !placed.has(m.id)).map((m) => m.id);
  if (rest.length) drafts.push({ title: "Other changes", items: rest });
  if (drafts.length < 2) return { parts: undefined, notes: [] };

  // Union-find over the drafts. A part with nothing pending is decided and stays as it is.
  const parent = drafts.map((_, k) => k);
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k]!)));
  const itemsOf = (root: number) => drafts.flatMap((d, k) => (find(k) === root ? d.items : []));
  const open = (root: number) => itemsOf(root).some((i) => isLive(byId.get(i)!.status));
  const titleOf = (root: number) => drafts[root]!.title;
  const notes: string[] = [];
  const join = (a: number, b: number, why: string, force = false): boolean => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb || (!force && (!open(ra) || !open(rb)))) return false;
    notes.push(`joined parts "${titleOf(ra)}" and "${titleOf(rb)}": ${why}.`);
    parent[rb] = ra;
    drafts[ra]!.title = joinTitles(drafts[ra]!.title, drafts[rb]!.title);
    return true;
  };
  const partOf = new Map<string, number>();
  drafts.forEach((d, k) => {
    for (const i of d.items) {
      const prev = partOf.get(i);
      // Usually two parts naming the same line: say how to name one change on it.
      if (prev !== undefined) join(prev, k, `both contain ${i} (to separate changes on one line, add a snippet of the new text to the location: file:line "snippet")`, true);
      else partOf.set(i, k);
    }
  });
  const at = (it: Item) => partOf.get(it.id)!;

  // The items of a move: accepting some alone would lose or duplicate the passage.
  for (const m of members) {
    for (const o of moveOthers(m)) {
      const other = byId.get(o);
      if (other && find(at(m)) !== find(at(other))) join(at(m), at(other), `${m.id} and ${other.id} move one passage`, true);
    }
  }

  // Whole-file changes and package/class/include changes: other parts may depend on them.
  const isGlobal = (m: Item, t: string) => !!profileOf(m.file).parts?.global(t);
  const global = members.find((m) => m.kind !== "modify" || isGlobal(m, m.oldText) || isGlobal(m, m.newText));
  if (global) {
    let joined = false;
    for (let k = 0; k < drafts.length; k++) {
      const [ra, rb] = [find(at(global)), find(k)];
      if (ra !== rb && open(ra) && open(rb)) {
        parent[rb] = ra;
        drafts[ra]!.title = joinTitles(drafts[ra]!.title, drafts[rb]!.title);
        joined = true;
      }
    }
    if (joined) notes.push(`kept as one part: ${global.id} changes a file, package or include that the other changes may need.`);
  }

  // The same change twice: one part (only within one of the agent's parts, where asked).
  const bySub = new Map<string, Item[]>();
  for (const m of members) {
    const s = substitution(m);
    if (s === null) continue;
    const earlier = bySub.get(s) ?? [];
    const first = earlier.find((e) => !opts.sameSymbol || opts.sameSymbol(e, m));
    if (first) join(at(first), at(m), `they make the same change (${changeTitle(m)})`);
    bySub.set(s, [...earlier, m]);
  }

  // The same symbol or term replaced in several places, where asked (finding the changes that
  // need each other): notation must not end up half changed.
  if (opts.sameSymbol) {
    const byRepl = new Map<string, Item[]>();
    for (const m of members) {
      for (const r of replacements(m, profileOf)) {
        for (const first of byRepl.get(r) ?? []) {
          if (opts.sameSymbol(first, m)) join(at(first), at(m), `they both replace ${r.split("\u0000")[0]} with ${r.split("\u0000")[1]}`);
        }
        byRepl.set(r, [...(byRepl.get(r) ?? []), m]);
      }
    }
  }

  // A definition and the changes that use it: an undefined macro or environment is an error.
  for (const d of members) {
    const rules = profileOf(d.file).definitions;
    if (!rules) continue;
    const defs = rules.definedIn(changedLines(d));
    for (const kind of rules.kinds) {
      for (const name of defs[kind] ?? []) {
        for (const u of members) {
          if (u !== d && find(at(u)) !== find(at(d)) && rules.usesIn(changedLines(u), name, kind)) {
            join(at(d), at(u), `${d.id} defines ${rules.described(name, kind)}, which ${u.id} uses`);
          }
        }
      }
    }
  }

  // Braces, environments and math that only close in another part.
  const roots = () => [...new Set(drafts.map((_, k) => find(k)))];
  const unbalanced = roots().filter((r) => {
    // Summed per language: a brace in a .bib file closes none in a .tex file.
    const sums = new Map<LanguageProfile, number[]>();
    for (const i of itemsOf(r)) {
      const it = byId.get(i)!;
      const p = profileOf(it.file);
      const sum = sums.get(p) ?? [];
      imbalance(it, profileOf).forEach((x, k) => (sum[k] = (sum[k] ?? 0) + x));
      sums.set(p, sum);
    }
    return [...sums].some(([p, sum]) => isOpen(sum, p.parts?.parity ?? []));
  });
  for (const r of unbalanced.slice(1)) join(unbalanced[0]!, r, "braces, environments or math opened in one are closed in the other");

  // Accepting one part must leave every other part acceptable.
  if (interferes) {
    for (let round = 0; round < drafts.length; round++) {
      const live = roots().filter(open);
      if (live.length < 2) break;
      const lists = live.map((r) => itemsOf(r).map((i) => byId.get(i)!).filter((m) => isLive(m.status)));
      let joined = false;
      for (const [a, b] of await interferes(lists)) {
        if (join(live[a]!, live[b]!, "accepting one would keep the other from being accepted (they touch the same text)")) joined = true;
      }
      if (!joined) break;
    }
  }

  const final = roots().sort((a, b) => a - b);
  if (final.length < 2) return { parts: undefined, notes };
  const order = new Map(members.map((m, k) => [m.id, k]));
  const parts = final.map((r): GroupPart => {
    const items = itemsOf(r).sort((a, b) => order.get(a)! - order.get(b)!);
    let title = drafts[r]!.title;
    const first = byId.get(items[0]!)!;
    if (items.length > 1 && title === changeTitle(first) && items.every((i) => substitution(byId.get(i)!) === substitution(first))) title += ` (${items.length}×)`;
    return { title, items };
  });
  return { parts, notes };
}

/** The parts of a group, or the group as one part. */
export const partsOrWhole = (g: { title: string; items: string[]; parts?: PartDraft[] | undefined }): PartDraft[] =>
  g.parts?.length ? g.parts.map((p) => ({ title: p.title, items: [...p.items] })) : [{ title: g.title, items: [...g.items] }];

/** Parts of two linked groups merged into one; undefined if neither had parts. */
export function combineParts(
  a: { title: string; items: string[]; parts?: PartDraft[] | undefined },
  b: { title: string; items: string[]; parts?: PartDraft[] | undefined },
): PartDraft[] | undefined {
  if (!a.parts?.length && !b.parts?.length) return undefined;
  return [...partsOrWhole(a), ...partsOrWhole(b)];
}
