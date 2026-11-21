/** Grouping helpers (spec §6.4). */
import { posix } from "node:path";
import type { GroupingConfig } from "./config.js";
import { type LanguageProfile, profileByName } from "./lang/index.js";
import type { KeyKind } from "./lang/profile.js";
import type { GroupKind, Item } from "./model.js";
import { changedSides, changeTitle, combineParts, type PartDraft } from "./parts.js";
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

const short = (s: string) => {
  const t = normalizeWs(s);
  return t.length > 30 ? t.slice(0, 29) + "…" : t;
};

/**
 * Automatic group detection over the items of one changeset. What a language defines, uses and
 * reads in comes from each file's profile (`profileOf`).
 */
export function autoGroups(items: Item[], cfg: GroupingConfig, profileOf: (file: string) => LanguageProfile = profileByName): GroupDraft[] {
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

  /** Whether one of `users` is in a language where using a missing key is an error (Typst). */
  const strict = (users: Item[]) => users.some((u) => !!profileOf(u.file).references?.strict);

  // Old/new text of an item including its context, so keys cut by the split are still visible.
  const oldWin = (it: Item) => it.context.before + it.oldText + it.context.after;
  const newWin = (it: Item) => it.context.before + it.newText + it.context.after;
  /** The keys of `kind` an item stops and starts using (`\ref{a}`), in its own language. */
  const uses = (it: Item, kind: KeyKind["id"]) => profileOf(it.file).references?.uses(kind, oldWin(it), newWin(it), cfg) ?? { removed: [], added: [] };
  /** The keys of `kind` an item stops and starts defining (`\label{a}`, a bibliography entry). */
  const definitions = (it: Item, kind: KeyKind["id"]) => (profileOf(it.file).references?.definitions(it) ?? []).filter((d) => d.kind.id === kind);

  // A key renamed where it is defined, with the changes that rename its uses.
  const renames = (kind: KeyKind["id"]) => {
    for (const def of text) {
      for (const d of definitions(def, kind)) {
        const { removed, added } = d;
        if (removed.length !== 1 || added.length !== 1) continue;
        const [a, b] = [removed[0]!, added[0]!];
        const users = text.filter((it) => {
          if (it === def) return false;
          const { removed, added } = uses(it, kind);
          return removed.includes(a) && added.includes(b);
        });
        if (users.length) {
          // In LaTeX a missing label or citation key is only a warning: each change can be its own
          // part. In Typst it is an error, so the rename is one unit.
          const members = [def, ...users];
          groups.push({
            kind: "linked",
            title: `Rename ${d.kind.noun} ${a} → ${b}`,
            rationale: null,
            source: "auto",
            items: members.map((m) => m.id),
            ...(strict(users) ? {} : { parts: members.map((m) => ({ title: changeTitle(m), items: [m.id] })) }),
          });
        }
      }
    }
  };

  // A new key with the changes that start using it: a bibliography entry, in a change of new
  // entries only; and any key used where a use of a missing key is an error (Typst: a new
  // `<label>` and a new `@label`).
  const additions = (kind: KeyKind["id"]) => {
    for (const def of text) {
      for (const d of definitions(def, kind)) {
        const lenient = !!d.kind.addTitle && d.added.length === 1 && d.fresh;
        for (const key of d.added) {
          // Uses renamed along with a renamed key are the rename's own group.
          const renamedFrom = d.removed.length === 1 && d.added.length === 1 ? d.removed[0]! : null;
          const all = text.filter((it) => {
            if (it === def) return false;
            const u = uses(it, kind);
            return u.added.includes(key) && !(renamedFrom !== null && u.removed.includes(renamedFrom));
          });
          const users = lenient ? all : all.filter((u) => strict([u]));
          if (!users.length) continue;
          const members = [def, ...users];
          groups.push({
            kind: "linked",
            title: d.kind.addTitle?.(key) ?? `Add ${d.kind.noun} ${key} and refer to it`,
            rationale: null,
            source: "auto",
            items: members.map((m) => m.id),
            ...(strict(users) ? {} : { parts: members.map((m) => ({ title: changeTitle(m), items: [m.id] })) }),
          });
        }
      }
    }
  };

  if (cfg.autoDetect.includes("label")) {
    renames("label");
    additions("label");
  }

  // A macro or environment renamed (or defined, or removed) with the changes that use it:
  // accepting some alone leaves a use undefined, which is an error, not a warning.
  if (cfg.autoDetect.includes("macro")) {
    const sides = new Map(text.filter((i) => i.kind === "modify").map((i) => [i, changedSides(i)]));
    for (const [def, sd] of sides) {
      const rules = profileOf(def.file).definitions;
      if (!rules) continue;
      const [o, nw] = [rules.definedIn(sd.old), rules.definedIn(sd.new)];
      for (const kind of rules.kinds) {
        const [a, b] = [o[kind] ?? new Set<string>(), nw[kind] ?? new Set<string>()];
        const removed = [...a].filter((x) => !b.has(x));
        const added = [...b].filter((x) => !a.has(x));
        if (!removed.length && !added.length) continue;
        const users = [...sides].filter(
          ([u, us]) =>
            u !== def &&
            (added.some((x) => rules.usesIn(us.new, x, kind) && !rules.usesIn(us.old, x, kind)) ||
              removed.some((x) => rules.usesIn(us.old, x, kind) && !rules.usesIn(us.new, x, kind))),
        );
        if (!users.length) continue;
        const name = (x: string) => rules.written(x, kind);
        const what = rules.noun(kind);
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

  // A file added or deleted with the change that starts or stops reading it in (LaTeX: \input,
  // \include, \includegraphics): that change alone breaks the document ("file not found").
  // Test report 2026-11-20, D6.
  if (cfg.autoDetect.includes("input")) {
    const edits = items.filter((i) => i.kind === "modify");
    for (const f of items) {
      const added = f.kind === "add-file" || (f.kind === "binary" && !f.oldBlob && !!f.newBlob);
      const deleted = f.kind === "delete-file" || (f.kind === "binary" && !!f.oldBlob && !f.newBlob);
      if (!added && !deleted) continue;
      const users = edits.filter((it) => {
        const inc = profileOf(it.file).includes;
        if (!inc) return false;
        const [was, is] = [inc.filesIn(oldWin(it)), inc.filesIn(newWin(it))];
        const [more, less] = added ? [is, was] : [was, is];
        return [...more].some(([ref, n]) => n > (less.get(ref) ?? 0) && namesFile(inc, ref, it.file, f.file));
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
    renames("citation");
    additions("citation");
  }
  return groups;
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

/**
 * Whether `ref`, read in by `from`, names `file`: as written, relative to `from`'s folder (Typst,
 * where chapters in subfolders read `../figures/x.png`), or from the
 * project's root (Typst's `/figures/x.png`).
 */
function namesFile(inc: { names(ref: string, file: string): boolean }, ref: string, from: string, file: string): boolean {
  if (inc.names(ref, file)) return true;
  if (ref.startsWith("/")) return inc.names(ref.replace(/^\/+/, ""), file);
  const dir = posix.dirname(from);
  return dir !== "." && inc.names(posix.normalize(posix.join(dir, ref)), file);
}

/** Join two group titles, skipping near-duplicates ("a -> b" vs "a → b"). */
export function joinTitles(a: string, b: string): string {
  const norm = (t: string) => t.toLowerCase().replace(/->|→/g, "→").replace(/\s+/g, " ").trim();
  // Each title of b once: joined titles piled up with every revision.
  const parts = a.split(" + ");
  for (const t of b.split(" + ")) if (!parts.some((p) => norm(p) === norm(t))) parts.push(t);
  return parts.join(" + ");
}
