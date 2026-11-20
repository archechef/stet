/** Grouping helpers (spec §6.4). */
import type { GroupingConfig } from "./config.js";
import type { GroupKind, Item } from "./model.js";
import { changedSides, changeTitle, combineParts, DEF_KINDS, definedIn, usesIn, type PartDraft } from "./parts.js";
import { normalizeWs } from "./text.js";

export interface GroupHint {
  kind: GroupKind;
  title: string;
  rationale?: string;
  where: string[];
  /** Linked groups: pieces that can each be accepted on their own (spec §6.4.6). */
  parts?: { title: string; where: string[] }[];
  /**
   * Linked groups: why accepting only some of the changes would break the document. Stet keeps
   * a linked group whose changes don't depend on each other in a way it can see only with one.
   */
  reason?: string;
}

export interface NoteHint {
  where: string | string[];
  note: string;
}

export interface Where {
  file: string;
  /** 1-based inclusive line range; absent = whole file. */
  from?: number;
  to?: number;
  /**
   * Only changes whose new text (or, for a deletion, old text) contains this: picks one change
   * among several on a line. A LaTeX paragraph is often a single line, so lines alone can't
   * separate the parts of a group within it.
   */
  text?: string;
}

/** `file`, `file:line`, `file:from-to`, each optionally followed by a quoted snippet: `main.tex:12 "suggestion"`. */
export function parseWhere(w: string): Where {
  let s = w.trim();
  let text: string | undefined;
  const q = /\s+"((?:[^"\\]|\\.)*)"\s*$/.exec(s);
  if (q) {
    text = q[1]!.replace(/\\(.)/g, "$1");
    s = s.slice(0, q.index).trim();
  }
  s = s.replace(/\\/g, "/").replace(/^\.\//, "");
  const withText = text ? { text } : {};
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return { file: s, ...withText };
  const from = Number(m[2]);
  return { file: m[1]!, from, to: m[3] ? Number(m[3]) : from, ...withText };
}

/** A unit a hint can match: an item (or candidate) with its range in the agent's tip. */
export interface HintUnit {
  key: string;
  file: string;
  oldFile?: string;
  wholeFile: boolean;
  /** Character range in the tip text of `file`. */
  newStart: number;
  newEnd: number;
  /** The change's texts, for locations with a snippet. */
  oldText?: string;
  newText?: string;
}

/** Does `unit` match a where-range (already converted to tip character offsets) and snippet? */
export function unitMatches(unit: HintUnit, file: string, range: { start: number; end: number } | null, text?: string): boolean {
  if (unit.file !== file && unit.oldFile !== file) return false;
  if (text !== undefined) {
    const t = normalizeWs(text);
    const has = (s: string | undefined) => s !== undefined && normalizeWs(s).includes(t);
    if (!(has(unit.newText) || (!normalizeWs(unit.newText ?? "") && has(unit.oldText)))) return false;
  }
  if (!range || unit.wholeFile) return true;
  if (unit.newStart === unit.newEnd) return unit.newStart >= range.start && unit.newStart <= range.end;
  return unit.newStart < range.end && range.start < unit.newEnd;
}

export interface GroupDraft {
  kind: GroupKind;
  title: string;
  rationale: string | null;
  source: "agent" | "commit" | "auto";
  items: string[];
  /** Proposed parts of a linked group, checked later (spec §6.4.6). */
  parts?: PartDraft[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const short = (s: string) => {
  const t = normalizeWs(s);
  return t.length > 30 ? t.slice(0, 29) + "…" : t;
};

/** Keys referenced by `\cmd[opt]{a,b}` for the given command names. */
function keyCounts(text: string, cmds: string[]): Map<string, number> {
  const re = new RegExp(`\\\\(?:${cmds.map(esc).join("|")})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)\\}`, "g");
  const out = new Map<string, number>();
  for (const m of text.matchAll(re)) for (const k of m[1]!.split(",")) if (k.trim()) out.set(k.trim(), (out.get(k.trim()) ?? 0) + 1);
  return out;
}

/**
 * Keys an item stops and starts referencing. Its two windows share their context (the original
 * text), so only the item's own text makes the counts differ: an unchanged `\ref{a}` nearby in
 * the context must not hide that this item replaces `a`.
 */
function keyChange(oldWin: string, newWin: string, cmds: string[]): { removed: string[]; added: string[] } {
  const o = keyCounts(oldWin, cmds);
  const n = keyCounts(newWin, cmds);
  return {
    removed: [...o].filter(([k, c]) => c > (n.get(k) ?? 0)).map(([k]) => k),
    added: [...n].filter(([k, c]) => c > (o.get(k) ?? 0)).map(([k]) => k),
  };
}

const diffSets = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));

/** Automatic group detection over the items of one changeset. */
export function autoGroups(items: Item[], cfg: GroupingConfig): GroupDraft[] {
  const groups: GroupDraft[] = [];
  const text = items.filter((i) => i.kind === "modify" || i.kind === "add-file");

  if (cfg.autoDetect.includes("repeat")) {
    const byPair = new Map<string, Item[]>();
    for (const it of text) {
      if (!normalizeWs(it.oldText) && !normalizeWs(it.newText)) continue;
      const key = normalizeWs(it.oldText) + "\u0000" + normalizeWs(it.newText);
      byPair.set(key, [...(byPair.get(key) ?? []), it]);
    }
    for (const list of byPair.values()) {
      if (list.length < cfg.autoRepeatMin) continue;
      const it = list[0]!;
      groups.push({
        kind: "related",
        title: `Replace "${short(it.oldText)}" → "${short(it.newText)}" (${list.length}×)`,
        rationale: null,
        source: "auto",
        items: list.map((i) => i.id),
      });
    }
  }

  // Old/new text of an item including its context, so keys cut by the split are still visible.
  const oldWin = (it: Item) => it.context.before + it.oldText + it.context.after;
  const newWin = (it: Item) => it.context.before + it.newText + it.context.after;

  const renames = (cmds: string[], defs: (it: Item) => { removed: string[]; added: string[] }, label: string) => {
    for (const def of text) {
      const { removed, added } = defs(def);
      if (removed.length !== 1 || added.length !== 1) continue;
      const [a, b] = [removed[0]!, added[0]!];
      const users = text.filter((it) => {
        if (it === def) return false;
        const { removed, added } = keyChange(oldWin(it), newWin(it), cmds);
        return removed.includes(a) && added.includes(b);
      });
      if (users.length) {
        // A missing label or citation key is only a warning: each change can be its own part.
        const members = [def, ...users];
        groups.push({
          kind: "linked",
          title: `Rename ${label} ${a} → ${b}`,
          rationale: null,
          source: "auto",
          items: members.map((m) => m.id),
          parts: members.map((m) => ({ title: changeTitle(m), items: [m.id] })),
        });
      }
    }
  };

  if (cfg.autoDetect.includes("label")) {
    renames(cfg.refCommands, (it) => keyChange(oldWin(it), newWin(it), ["label"]), "label");
  }

  // A macro or environment renamed (or defined, or removed) with the changes that use it:
  // accepting some alone leaves a use undefined, which is an error, not a warning.
  if (cfg.autoDetect.includes("macro")) {
    const sides = new Map(text.filter((i) => i.kind === "modify").map((i) => [i, changedSides(i)]));
    for (const [def, sd] of sides) {
      const [o, nw] = [definedIn(sd.old), definedIn(sd.new)];
      for (const kind of DEF_KINDS) {
        const [a, b] = [o[kind], nw[kind]];
        const removed = [...a].filter((x) => !b.has(x));
        const added = [...b].filter((x) => !a.has(x));
        if (!removed.length && !added.length) continue;
        const users = [...sides].filter(
          ([u, us]) =>
            u !== def &&
            (added.some((x) => usesIn(us.new, x, kind) && !usesIn(us.old, x, kind)) || removed.some((x) => usesIn(us.old, x, kind) && !usesIn(us.new, x, kind))),
        );
        if (!users.length) continue;
        const name = (x: string) => (kind === "cmd" ? `\\${x}` : x);
        const what = { cmd: "macro", env: "environment", style: "TikZ style" }[kind];
        const title =
          removed.length === 1 && added.length === 1
            ? `Rename ${what} ${name(removed[0]!)} → ${name(added[0]!)}`
            : added.length
              ? `Define ${added.map(name).join(", ")} and use ${added.length > 1 ? "them" : "it"}`
              : `Remove ${removed.map(name).join(", ")} and ${removed.length > 1 ? "their" : "its"} uses`;
        groups.push({ kind: "linked", title, rationale: null, source: "auto", items: [def.id, ...users.map(([u]) => u.id)] });
      }
    }
  }

  // A file added or deleted with the \input, \include or \includegraphics that starts or stops
  // reading it: the command alone stops LaTeX ("file not found"). Test report 2026-11-20, D6.
  if (cfg.autoDetect.includes("input")) {
    const edits = items.filter((i) => i.kind === "modify");
    for (const f of items) {
      const added = f.kind === "add-file" || (f.kind === "binary" && !f.oldBlob && !!f.newBlob);
      const deleted = f.kind === "delete-file" || (f.kind === "binary" && !!f.oldBlob && !f.newBlob);
      if (!added && !deleted) continue;
      const users = edits.filter((it) => {
        const [was, is] = [includedFiles(oldWin(it)), includedFiles(newWin(it))];
        const [more, less] = added ? [is, was] : [was, is];
        return [...more].some(([ref, n]) => n > (less.get(ref) ?? 0) && namesFile(ref, f.file));
      });
      if (!users.length) continue;
      groups.push({
        kind: "linked",
        title: added ? `Add ${f.file} and read it in` : `Delete ${f.file} and stop reading it in`,
        rationale: null,
        source: "auto",
        items: [f.id, ...users.map((u) => u.id)],
      });
    }
  }

  if (cfg.autoDetect.includes("cite")) {
    const bibKeys = (t: string) => new Set([...t.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]!));
    const bibItems = text.filter((it) => it.file.toLowerCase().endsWith(".bib"));
    renames(cfg.citeCommands, (it) => {
      if (!bibItems.includes(it)) return { removed: [], added: [] };
      const o = bibKeys(it.oldText);
      const n = bibKeys(it.newText);
      return { removed: diffSets(o, n), added: diffSets(n, o) };
    }, "citation key");
    // Newly added entries + the edits that start citing them.
    for (const bib of bibItems) {
      const added = diffSets(bibKeys(bib.newText), bibKeys(bib.oldText));
      if (added.length !== 1 || bibKeys(bib.oldText).size) continue;
      const key = added[0]!;
      const users = text.filter((it) => it !== bib && keyChange(oldWin(it), newWin(it), cfg.citeCommands).added.includes(key));
      if (users.length) {
        const members = [bib, ...users];
        groups.push({
          kind: "linked", title: `Add reference ${key}`, rationale: null, source: "auto",
          items: members.map((m) => m.id), parts: members.map((m) => ({ title: changeTitle(m), items: [m.id] })),
        });
      }
    }
  }
  return groups;
}

const INCLUDES = /\\(?:input|include|subfile|includegraphics|includepdf|includestandalone|lstinputlisting|verbatiminput|addbibresource|bibliography)\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;

/** The files a text reads in (\input{chapters/a}, \includegraphics[..]{fig/b}, \bibliography{x,y}), counted. */
function includedFiles(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(INCLUDES)) {
    for (const p of m[1]!.split(",")) {
      const ref = p.trim();
      if (ref) out.set(ref, (out.get(ref) ?? 0) + 1);
    }
  }
  return out;
}

/** Whether `ref` (as written in \input, without extension or with a graphics path left out) names `file`. */
function namesFile(ref: string, file: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const [r, f] = [norm(ref), norm(file)];
  const stem = f.replace(/\.[A-Za-z0-9]+$/, "");
  return [f, stem].some((x) => x === r || x.endsWith("/" + r));
}

/** Merge linked groups that share items (transitively) and drop duplicate groups. */
export function normalizeGroups(drafts: GroupDraft[]): GroupDraft[] {
  const linked = drafts.filter((d) => d.kind === "linked");
  const others = drafts.filter((d) => d.kind !== "linked");
  const merged: GroupDraft[] = [];
  for (const g of linked) {
    const hits = merged.filter((m) => m.items.some((i) => g.items.includes(i)));
    if (!hits.length) {
      merged.push({ ...g, items: [...g.items], ...(g.parts ? { parts: g.parts.map((p) => ({ ...p, items: [...p.items] })) } : {}) });
      continue;
    }
    const target = hits[0]!;
    for (const h of [g, ...hits.slice(1)]) {
      const parts = combineParts(target, h);
      if (parts) target.parts = parts;
      for (const i of h.items) if (!target.items.includes(i)) target.items.push(i);
      if (h !== g) merged.splice(merged.indexOf(h), 1);
      target.title = joinTitles(target.title, h.title);
      if (h.rationale) target.rationale = target.rationale ? target.rationale + "\n\n" + h.rationale : h.rationale;
      if (h.source === "agent") target.source = "agent";
    }
  }
  const all = [...merged, ...others].filter((g) => g.items.length >= 2 || g.source === "agent");
  // Auto groups duplicating an agent group are dropped.
  const sig = (g: GroupDraft) => g.kind + ":" + [...g.items].sort().join(",");
  const agentSigs = new Set(all.filter((g) => g.source !== "auto").map(sig));
  const seen = new Set<string>();
  const linkedSets = all.filter((g) => g.kind === "linked").map((g) => new Set(g.items));
  return all.filter((g) => {
    const s = sig(g);
    if (g.source === "auto" && agentSigs.has(s)) return false;
    // An automatic related group of changes that are linked anyway says nothing more.
    if (g.source === "auto" && g.kind === "related" && linkedSets.some((l) => g.items.every((i) => l.has(i)))) return false;
    if (seen.has(s + g.source)) return false;
    seen.add(s + g.source);
    return true;
  });
}

/** Join two group titles, skipping near-duplicates ("a -> b" vs "a → b"). */
export function joinTitles(a: string, b: string): string {
  const norm = (t: string) => t.toLowerCase().replace(/->|→/g, "→").replace(/\s+/g, " ").trim();
  const parts = a.split(" + ");
  return parts.some((p) => norm(p) === norm(b)) ? a : `${a} + ${b}`;
}
