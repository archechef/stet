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
import { isLive, type GroupPart, type Item } from "./model.js";
import { normalizeWs } from "./text.js";

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

/** Changes whose dependants Stet can't see: packages, classes, included files. */
const GLOBAL = /\\(?:usepackage|RequirePackage|documentclass|input|include|includeonly|usetikzlibrary|usepgfplotslibrary)(?![A-Za-z@])/;

const CMD_DEFS =
  /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newrobustcmd|renewrobustcmd|DeclarePairedDelimiterX?|newlength|newsavebox)\*?\s*\{?\s*\\([A-Za-z@]+)/g;
const TEX_DEFS = /\\(?:def|gdef|edef|xdef|let|newif)\s*\\([A-Za-z@]+)/g;
const ENV_DEFS = /\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem|declaretheorem|newtcolorbox)\*?\s*\{([A-Za-z@*]+)\}/g;

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

/** Commands and environments defined on the lines an item changes. */
function definitions(it: Item): { cmds: Set<string>; envs: Set<string> } {
  const t = changedLines(it);
  const cmds = new Set<string>();
  const envs = new Set<string>();
  for (const m of t.matchAll(CMD_DEFS)) cmds.add(m[1]!);
  for (const m of t.matchAll(TEX_DEFS)) cmds.add(m[1]!.startsWith("if") ? m[1]!.slice(2) : m[1]!);
  for (const m of t.matchAll(ENV_DEFS)) envs.add(m[1]!);
  return { cmds, envs };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does an item change a line that uses command `\name` or environment `name`? */
function uses(it: Item, name: string, env: boolean): boolean {
  const t = changedLines(it);
  if (env) return new RegExp(`\\\\(?:begin|end)\\s*\\{${esc(name)}\\}`).test(t);
  return new RegExp(`\\\\(?:if)?${esc(name)}(?![A-Za-z@])`).test(t);
}

/** How a change shifts the nesting of braces, environments, display math and `$`. */
function imbalance(it: Item): number[] {
  const counts = (s: string) => {
    const t = s.replace(/\\\\/g, "").replace(/\\[{}$]/g, "");
    const n = (re: RegExp) => (t.match(re) ?? []).length;
    return [n(/\{/g) - n(/\}/g), n(/\\begin\s*\{/g) - n(/\\end\s*\{/g), n(/\\\[/g) - n(/\\\]/g), n(/\\\(/g) - n(/\\\)/g), n(/\$/g) % 2];
  };
  const a = counts(it.oldText);
  const b = counts(it.newText);
  return b.map((x, k) => x - a[k]!);
}

/**
 * Turn proposed parts into valid ones. Members not in any proposed part form one more part.
 * Returns no parts when everything ends up in one, and a note for every join.
 */
export async function settleParts(
  proposed: PartDraft[],
  members: Item[],
  interferes?: Interference,
): Promise<{ parts: GroupPart[] | undefined; notes: string[] }> {
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
      if (prev !== undefined) join(prev, k, `both contain ${i}`, true);
      else partOf.set(i, k);
    }
  });
  const at = (it: Item) => partOf.get(it.id)!;

  // Whole-file changes and package/class/include changes: other parts may depend on them.
  const global = members.find((m) => m.kind !== "modify" || GLOBAL.test(m.oldText) || GLOBAL.test(m.newText));
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

  // The same change twice: one part.
  const bySub = new Map<string, Item>();
  for (const m of members) {
    const s = substitution(m);
    if (s === null) continue;
    const first = bySub.get(s);
    if (first) join(at(first), at(m), `they make the same change (${changeTitle(m)})`);
    else bySub.set(s, m);
  }

  // A definition and the changes that use it: an undefined macro or environment is an error.
  for (const d of members) {
    const { cmds, envs } = definitions(d);
    for (const [names, env] of [[cmds, false], [envs, true]] as const) {
      for (const name of names) {
        for (const u of members) {
          if (u !== d && find(at(u)) !== find(at(d)) && uses(u, name, env)) {
            join(at(d), at(u), `${d.id} defines ${env ? `the environment ${name}` : `\\${name}`}, which ${u.id} uses`);
          }
        }
      }
    }
  }

  // Braces, environments and math that only close in another part.
  const roots = () => [...new Set(drafts.map((_, k) => find(k)))];
  const unbalanced = roots().filter((r) => {
    const sum = [0, 0, 0, 0, 0];
    for (const i of itemsOf(r)) imbalance(byId.get(i)!).forEach((x, k) => (sum[k]! += x));
    return sum.some((x, k) => (k === 4 ? x % 2 !== 0 : x !== 0));
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
