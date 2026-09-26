/** Grouping helpers (spec §6.4). */
import type { GroupingConfig } from "./config.js";
import type { GroupKind, Item } from "./model.js";
import { normalizeWs } from "./text.js";

export interface GroupHint {
  kind: GroupKind;
  title: string;
  rationale?: string;
  where: string[];
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
}

export function parseWhere(w: string): Where {
  const s = w.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const m = /^(.*?):(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return { file: s };
  const from = Number(m[2]);
  return { file: m[1]!, from, to: m[3] ? Number(m[3]) : from };
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
}

/** Does `unit` match a where-range (already converted to tip character offsets)? */
export function unitMatches(unit: HintUnit, file: string, range: { start: number; end: number } | null): boolean {
  if (unit.file !== file && unit.oldFile !== file) return false;
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
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const short = (s: string) => {
  const t = normalizeWs(s);
  return t.length > 30 ? t.slice(0, 29) + "…" : t;
};

/** Keys referenced by `\cmd[opt]{a,b}` for the given command names. */
function keysIn(text: string, cmds: string[]): Set<string> {
  const re = new RegExp(`\\\\(?:${cmds.map(esc).join("|")})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)\\}`, "g");
  const out = new Set<string>();
  for (const m of text.matchAll(re)) for (const k of m[1]!.split(",")) if (k.trim()) out.add(k.trim());
  return out;
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
        const o = keysIn(oldWin(it), cmds);
        const n = keysIn(newWin(it), cmds);
        return o.has(a) && !n.has(a) && n.has(b);
      });
      if (users.length) {
        groups.push({
          kind: "linked",
          title: `Rename ${label} ${a} → ${b}`,
          rationale: null,
          source: "auto",
          items: [def.id, ...users.map((u) => u.id)],
        });
      }
    }
  };

  if (cfg.autoDetect.includes("label")) {
    renames(cfg.refCommands, (it) => {
      const o = keysIn(oldWin(it), ["label"]);
      const n = keysIn(newWin(it), ["label"]);
      return { removed: diffSets(o, n), added: diffSets(n, o) };
    }, "label");
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
      const users = text.filter((it) => it !== bib && keysIn(newWin(it), cfg.citeCommands).has(key) && !keysIn(oldWin(it), cfg.citeCommands).has(key));
      if (users.length) {
        groups.push({ kind: "linked", title: `Add reference ${key}`, rationale: null, source: "auto", items: [bib.id, ...users.map((u) => u.id)] });
      }
    }
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
      merged.push({ ...g, items: [...g.items] });
      continue;
    }
    const target = hits[0]!;
    for (const h of [g, ...hits.slice(1)]) {
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
  return all.filter((g) => {
    const s = sig(g);
    if (g.source === "auto" && agentSigs.has(s)) return false;
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
