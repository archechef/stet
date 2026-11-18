/**
 * View model for the Stet panel and editor integration. No `vscode` import here,
 * so it can be unit-tested with vitest.
 */
import {
  compareItemIds,
  inlineDiff,
  linkedUnit,
  moveChangesOf,
  moveFrom,
  moveOthers,
  movesOut,
  moveTo,
  numberInRound,
  oneLine,
  partId,
  partIndexOf,
  roundOf,
  type Agent,
  type Changeset,
  type Group,
  type InlineDiff,
  type Item,
  type ItemStatus,
  type Note,
} from "@stet/core";

export interface Snapshot {
  agents: Agent[];
  changesets: Changeset[];
  groups: Group[];
  items: Item[];
  /** Reviewer notes to agents (spec §7.8). */
  notes: Note[];
  /** Agents whose workspace is behind the review base. */
  syncNeeded: Set<string>;
  /** Accepted items not committed yet. */
  uncommitted: Item[];
  /** Saved edits exist that agents don't see yet (setting stet.shareEdits). */
  unshared: boolean;
  /** Accepted, uncommitted items agents don't get (the review base can't apply them). Usually empty. */
  missing: { id: string; reason: string }[];
}

export type Node =
  | { type: "agent"; agent: Agent }
  /** An open reviewer note, under its agent (Review panel only). */
  | { type: "note"; note: Note }
  | { type: "changeset"; changeset: Changeset }
  | { type: "group"; group: Group }
  /** A part of a linked group (spec §6.4.6), accepted or rejected on its own. */
  | { type: "part"; group: Group; index: number }
  /** `parent`: the changeset, group or part id the item is shown under. */
  | { type: "item"; item: Item; parent: string };

/**
 * An item or group id together with its project, as passed by CodeLens and hover links.
 * Ids like 12.3 or G1 are numbered per project, so an id alone is ambiguous with several projects open.
 */
export interface Ref {
  path: string;
  id: string;
}

export const isRef = (v: unknown): v is Ref =>
  !!v && typeof v === "object" && typeof (v as Ref).path === "string" && typeof (v as Ref).id === "string";

export const LIVE: readonly ItemStatus[] = ["pending", "needs_revision"];
export const isLive = (i: Item) => LIVE.includes(i.status);
const num = (id: string) => Number(id.slice(1));
const byNum = (a: { id: string }, b: { id: string }) => num(a.id) - num(b.id);
const byId = (a: { id: string }, b: { id: string }) => compareItemIds(a.id, b.id);

/** Which changes a tree shows: the Review panel the open ones, the History view the decided ones. */
export type TreeMode = "review" | "history";

/**
 * Tree structure: agent → round (changeset) → group → (part →) item, ungrouped items directly
 * under the round. The same round can appear in both trees: its open changes under Review, its decided
 * ones under History.
 */
export class TreeModel {
  private items = new Map<string, Item>();
  private groups = new Map<string, Group>();

  constructor(
    readonly snap: Snapshot,
    readonly mode: TreeMode = "review",
  ) {
    for (const i of snap.items) this.items.set(i.id, i);
    for (const g of snap.groups) this.groups.set(g.id, g);
  }

  visible(i: Item): boolean {
    return this.mode === "history" ? !isLive(i) : isLive(i);
  }

  /** Visible members of a group (atomic groups never show: their members are merged). */
  members(g: Group): Item[] {
    if (g.kind === "atomic") return [];
    return g.items.map((id) => this.items.get(id)).filter((i): i is Item => !!i && this.visible(i)).sort(byId);
  }

  /** Visible members of the k-th part of a group. */
  partMembers(g: Group, k: number): Item[] {
    const ids = g.parts?.[k]?.items ?? [];
    return this.members(g).filter((i) => ids.includes(i.id));
  }

  /** The linked group and part an item belongs to, if its group has parts. */
  partOf(item: Item): { group: Group; index: number } | undefined {
    const g = this.linkedGroup(item);
    const index = g ? partIndexOf(g, item.id) : -1;
    return g && index >= 0 ? { group: g, index } : undefined;
  }

  private groupsOf(cs: Changeset): Group[] {
    return this.snap.groups.filter((g) => g.changeset === cs.id && this.members(g).length > 0).sort(byNum);
  }

  private ungrouped(cs: Changeset): Item[] {
    return this.snap.items
      .filter((i) => i.changeset === cs.id && this.visible(i))
      .filter((i) => !i.groups.some((gid) => {
        const g = this.groups.get(gid);
        return g && g.kind !== "atomic";
      }))
      .sort(byId);
  }

  private csVisible(cs: Changeset): boolean {
    return this.groupsOf(cs).length > 0 || this.ungrouped(cs).length > 0;
  }

  children(node?: Node): Node[] {
    if (!node) {
      return this.snap.agents
        .filter((a) => (this.mode === "review" && a.state === "active") || this.snap.items.some((i) => i.agent === a.id && this.visible(i)))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((agent) => ({ type: "agent", agent }));
    }
    switch (node.type) {
      case "agent":
        return [
          ...this.openNotes(node.agent.id).map((note): Node => ({ type: "note", note })),
          ...this.snap.changesets
            .filter((c) => c.agent === node.agent.id && this.csVisible(c))
            .sort((a, b) => num(b.id) - num(a.id))
            .map((changeset): Node => ({ type: "changeset", changeset })),
        ];
      case "note":
        return [];
      case "changeset":
        return [
          ...this.groupsOf(node.changeset).map((group): Node => ({ type: "group", group })),
          ...this.ungrouped(node.changeset).map((item): Node => ({ type: "item", item, parent: node.changeset.id })),
        ];
      case "group": {
        const g = node.group;
        if (g.parts) return g.parts.flatMap((_, index): Node[] => (this.partMembers(g, index).length ? [{ type: "part", group: g, index }] : []));
        return this.members(g).map((item) => ({ type: "item", item, parent: g.id }));
      }
      case "part":
        return this.partMembers(node.group, node.index).map((item) => ({ type: "item", item, parent: partId(node.group.id, node.index) }));
      case "item":
        return [];
    }
  }

  /** Open notes for an agent, shown in the Review panel only. */
  openNotes(agent: string): Note[] {
    return this.mode === "review" ? this.snap.notes.filter((n) => n.agent === agent && n.state === "open").sort(byNum) : [];
  }

  liveCount(pred: (i: Item) => boolean): number {
    return this.snap.items.filter((i) => isLive(i) && pred(i)).length;
  }

  /** How the decided changes matching `pred` were decided, e.g. "5 accepted · 2 rejected". */
  outcome(pred: (i: Item) => boolean): string {
    const counts = new Map<ItemStatus, number>();
    for (const i of this.snap.items) if (!isLive(i) && pred(i)) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
    const order: ItemStatus[] = ["accepted", "rejected", "stale", "withdrawn", "superseded"];
    return order.filter((st) => counts.has(st)).map((st) => `${counts.get(st)} ${STATUS_TEXT[st]}`).join(" · ");
  }

  item(id: string): Item | undefined {
    return this.items.get(id.toUpperCase());
  }

  group(id: string): Group | undefined {
    return this.groups.get(id.toUpperCase());
  }

  /** Live items that must be accepted with `ids` (their linked group, or its part), excluding `ids` themselves. */
  linkedRest(ids: string[]): Item[] {
    const out = new Map<string, Item>();
    for (const id of ids) {
      for (const gid of this.item(id)?.groups ?? []) {
        const g = this.groups.get(gid);
        if (g?.kind !== "linked") continue;
        for (const m of linkedUnit(g, id.toUpperCase())) {
          const mi = this.items.get(m);
          if (mi && isLive(mi) && !ids.includes(mi.id)) out.set(mi.id, mi);
        }
      }
      for (const o of this.moveRest(this.item(id))) if (!ids.includes(o.id)) out.set(o.id, o);
    }
    return [...out.values()].sort(byId);
  }

  /** The other items of an item's move that are still pending. */
  private moveRest(item: Item | undefined): Item[] {
    return item ? moveOthers(item).map((o) => this.items.get(o)).filter((o): o is Item => !!o && isLive(o)) : [];
  }

  /** An item and the rest of its move, if it is part of one (spec §6.4.7): decided together. */
  withMove(item: Item): string[] {
    return [item.id, ...this.moveRest(item).map((o) => o.id)];
  }

  /** The other items of an item's move, in their order (moved-out ones first). */
  others(item: Item): Item[] {
    return moveOthers(item).map((o) => this.items.get(o)).filter((o): o is Item => !!o);
  }

  /** Is the group exactly one move? */
  isMove(g: Group): boolean {
    const first = this.items.get(g.items[0] ?? "");
    if (!first?.move) return false;
    const all = new Set([...moveFrom(first.move), ...moveTo(first.move)]);
    return g.items.length === all.size && g.items.every((i) => all.has(i));
  }

  /** Lookup for the move helpers of the core. */
  readonly get = (id: string): Item | undefined => this.items.get(id);

  /** The linked group of an item, if any. */
  linkedGroup(item: Item): Group | undefined {
    return item.groups.map((g) => this.groups.get(g)).find((g) => g?.kind === "linked");
  }
}

// ---------------------------------------------------------------------------
// Labels

export { oneLine };

/** How a change is numbered in the panel: 3 for 12.3 (its round shows 12), the full id for old ones. */
export const shortId = (id: string): string => String(numberInRound(id) ?? id);

/** Words a list of move changes touches (the longer side of each). */
const changedCount = (cs: { was: string; now: string }[]) => cs.reduce((n, c) => n + Math.max(words(c.was), words(c.now)), 0);
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

export function itemLabel(it: Item, get?: (id: string) => Item | undefined): string {
  const n = shortId(it.id);
  switch (it.kind) {
    case "add-file":
      return `${n}  new file ${it.file}`;
    case "delete-file":
      return `${n}  delete ${it.file}`;
    case "rename-file":
      return `${n}  rename ${it.oldFile} → ${it.file}`;
    case "binary":
      return `${n}  binary ${it.file}`;
    default:
      if (it.move) {
        if (movesOut(it)) return `${n}  ⇣ moved out: “${oneLine(it.oldText, 40)}”`;
        const k = get ? changedCount(moveChangesOf(it, get)) : it.move.changed;
        return `${n}  ⇡ moved in: “${oneLine(it.newText, 40)}”${k ? ` · ${k} word${k > 1 ? "s" : ""} changed` : ""}`;
      }
      if (!it.oldText) return `${n}  + “${oneLine(it.newText, 50)}”`;
      if (!it.newText) return `${n}  − “${oneLine(it.oldText, 50)}”`;
      return `${n}  “${oneLine(it.oldText, 28)}” → “${oneLine(it.newText, 28)}”`;
  }
}

/** Label of a round (changeset): its number and the agent's title. */
export const roundLabel = (cs: Changeset): string => `Round ${roundOf(cs.id)}: ${cs.title}`;

export const STATUS_TEXT: Record<ItemStatus, string> = {
  pending: "pending",
  needs_revision: "revision requested",
  accepted: "accepted",
  rejected: "rejected",
  withdrawn: "withdrawn",
  superseded: "superseded",
  stale: "stale",
};

export function groupLabel(g: Group): string {
  return g.title;
}

export function groupDescription(g: Group, shown: number, move = false): string {
  if (move) return g.state === "broken" ? "move · broken" : "move";
  const parts = [g.kind === "linked" ? "linked" : g.kind];
  if (g.parts) parts.push(`${g.parts.length} parts`);
  if (g.source === "auto") parts.push("auto");
  if (g.state === "broken") parts.push("broken");
  parts.push(`${shown}`);
  return parts.join(" · ");
}

/** Label of a part of a linked group: "Part 2: Section 3". */
export function partLabel(g: Group, k: number): string {
  return `Part ${k + 1}: ${g.parts?.[k]?.title ?? ""}`;
}

/** "line 40", "lines 12 and 40", "appendix.tex", "elsewhere": where other items of a move are. */
function places(others: Item[], file: string, lineOf: (id: string) => number | null): string {
  const lines = others.map((o) => lineOf(o.id)).filter((l): l is number => l !== null);
  const files = [...new Set(others.filter((o) => lineOf(o.id) === null && o.file !== file).map((o) => o.file))];
  const parts = [...(lines.length ? [`line${lines.length > 1 ? "s" : ""} ${andList(lines.map(String))}`] : []), ...files];
  return parts.length ? andList(parts) : "elsewhere";
}
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The note shown for an item of a move (spec §6.4.7) instead of its text: where the text goes or
 * comes from, and for a moved-in item whether it arrives word for word or with which changes.
 * `lineOf`: the line of another item in the same document, if it is shown there.
 */
export function moveNote(item: Item, get: (id: string) => Item | undefined, lineOf: (id: string) => number | null): { text: string; changed: boolean } | null {
  if (!item.move) return null;
  const out = movesOut(item);
  const others = (out ? moveTo(item.move) : moveFrom(item.move)).map(get).filter((o): o is Item => !!o);
  const where = places(others, item.file, lineOf);
  const ids = (out ? moveTo(item.move) : moveFrom(item.move)).join(", ");
  if (out) return { text: `⇣ moved to ${where} (${ids})`, changed: false };
  const changes = moveChangesOf(item, get);
  if (!changes.length) return { text: `⇡ moved here from ${where} (${ids}), word for word`, changed: false };
  const n = changedCount(changes);
  const list = changes.map((c) => `“${c.was}” → “${c.now}”`).join(", ");
  return { text: `⇡ moved here from ${where} (${ids}) with ${n} word${n > 1 ? "s" : ""} changed: ${list}`, changed: true };
}

/** Short text for ghost-text decorations (no newlines, bounded length). */
export function ghostText(s: string, max = 80): string {
  const t = s.replace(/\r?\n/g, " ⏎ ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** What changes inside an item (removed spans, inserted text), cached: computed on every redraw. */
const diffs = new Map<string, InlineDiff>();
export function itemDiff(item: Pick<Item, "oldText" | "newText">): InlineDiff {
  const key = item.oldText + "\0" + item.newText;
  let d = diffs.get(key);
  if (!d) {
    if (diffs.size > 500) diffs.clear();
    diffs.set(key, (d = inlineDiff(item.oldText, item.newText)));
  }
  return d;
}

/** Line/character of `offset` in `text`, when `text` starts at line/character `start`. */
export function positionIn(start: { line: number; character: number }, text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf("\n");
  if (nl < 0) return { line: start.line, character: start.character + offset };
  return { line: start.line + (before.match(/\n/g)?.length ?? 0), character: offset - nl - 1 };
}

/** Whether ghost text can show `s` in full: one line, not longer than ghostText's limit. */
export const fitsInline = (s: string, max = 80): boolean => !/[\r\n]/.test(s) && s.length <= max;

/** The full new text of a proposal, for the editor's inline widget. Agent text: fenced, never rendered. */
export function proposalMarkdown(item: Item): string {
  const lang = /\.(tex|sty|cls|ltx|dtx|bib)$/i.test(item.file) ? "latex" : "";
  return `*Proposed text, replacing the struck-through text above:*\n\n${fence(item.newText, lang)}`;
}

/** Markdown fenced block that is safe for any content. */
export function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A unified-style diff for hovers. */
export function diffBlock(oldText: string, newText: string): string {
  const lines = [
    ...(oldText ? oldText.split("\n").map((l) => "- " + l) : []),
    ...(newText ? newText.split("\n").map((l) => "+ " + l) : []),
  ];
  return fence(lines.join("\n"), "diff");
}

// ---------------------------------------------------------------------------
// Text positions

/** Line/column of an offset in LF text. Line/column are the same in the CRLF version of the text. */
export class LineIndex {
  private starts: number[] = [0];
  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  /** Offset of a line/character position (clamped to the text). */
  offset(line: number, character: number): number {
    const start = this.starts[Math.max(0, Math.min(line, this.starts.length - 1))]!;
    return Math.min(start + character, this.text.length);
  }

  position(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo]! };
  }
}

export const toLf = (s: string) => s.replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// Agents

export function suggestAgentId(kind: "claude-code" | "codex" | "other", existing: string[]): string {
  const prefix = kind === "claude-code" ? "claude" : kind === "codex" ? "codex" : "agent";
  for (let n = 1; ; n++) if (!existing.includes(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse `node --version` output; returns the major version or null. */
export function nodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}
