/**
 * The panel's view model: the snapshot of a project, its tree of agents, rounds, groups and changes,
 * the filter, and which change a command acts on. No `vscode` import here, so it can be unit-tested.
 */
import {
  type Agent,
  type Changeset,
  compareItemIds,
  type Group,
  type Item,
  type ItemStatus,
  isLiveItem,
  itemEffect,
  linkedRest,
  moveFrom,
  moveOthers,
  moveTo,
  type Note,
  partId,
  partIndexOf,
  profileByName,
  roundOf,
} from "@stet/core";
import { noLinks, STATUS_TEXT } from "./text.js";

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
  /** A reviewer note: an open one under its agent (Review panel), a resolved one under its agent's notes (History). */
  | { type: "note"; note: Note }
  /** An agent's resolved notes, folded into one row (History only). */
  | { type: "notes"; agent: Agent }
  | { type: "changeset"; changeset: Changeset }
  | { type: "group"; group: Group }
  /** A part of a linked group (spec §6.4.6), accepted or rejected on its own. */
  | { type: "part"; group: Group; index: number }
  /** An agent's changes to one file (grouped by file, setting stet.groupBy). */
  | { type: "file"; agent: Agent; file: string }
  /** History grouped by file: the file's older rounds, not shown yet (setting stet.historyRoundsPerFile). */
  | { type: "older"; agent: Agent; file: string; rounds: number; changes: number; hidden: number }
  /** `parent`: the changeset, group or part id the item is shown under; `file|<path>` under a file. */
  | { type: "item"; item: Item; parent: string };

/** How the trees group changes (settings stet.groupBy and stet.historyRoundsPerFile). */
export interface TreeView {
  /** By round (agent → round → group → change), or by file (agent → file → change). */
  groupBy: "round" | "file";
  /** History by file: the latest rounds shown per file (0: all of them). */
  roundsPerFile: number;
  /** How many more rounds a file shows in History (after *Show older rounds*). */
  more(agent: string, file: string): number;
}

export const ROUND_VIEW: TreeView = { groupBy: "round", roundsPerFile: 0, more: () => 0 };

/** The parent id of a change shown under its file. */
export const fileParent = (file: string) => `file|${file}`;

/**
 * An item or group id together with its project, as passed by CodeLens and hover links.
 * Ids like 12.3 or G1 are numbered per project, so an id alone is ambiguous with several projects open.
 */
export interface Ref {
  path: string;
  id: string;
}

export const isRef = (v: unknown): v is Ref => !!v && typeof v === "object" && typeof (v as Ref).path === "string" && typeof (v as Ref).id === "string";

/** A row of the panel or History, as VS Code passes it to a row's button or menu entry. */
export interface Row {
  project: { mainPath: string };
  node?: Node;
}

/**
 * What a command was given to act on:
 * - `row`: a row's button or menu entry, in the panel or History;
 * - `ref`: a change, group or part with its project, from a CodeLens or a hover link;
 * - `view`: a key pressed in the panel or History ("panel", "history"): that view's selection;
 * - `id`: an id alone ("12.3", "G1"), from a link or a test;
 * - `none`: the Command Palette or a key binding of the user's: the selection or the cursor.
 */
export type CommandTarget<R extends Row = Row> =
  | { kind: "row"; row: R }
  | { kind: "ref"; ref: Ref }
  | { kind: "view"; view: "panel" | "history" }
  | { kind: "id"; id: string }
  | { kind: "none" };

/** A command's argument as a `CommandTarget`. Anything else (a URI, a number) counts as none. */
export function commandTarget<R extends Row = Row>(arg: unknown): CommandTarget<R> {
  if (isRef(arg)) return { kind: "ref", ref: arg };
  if (arg === "panel" || arg === "history") return { kind: "view", view: arg };
  if (typeof arg === "string") return { kind: "id", id: arg };
  if (arg && typeof arg === "object" && "project" in arg) return { kind: "row", row: arg as R };
  return { kind: "none" };
}

/**
 * Whether a command came from the Review panel (a key there, or a row's button or menu), so the
 * focus stays there for the next change. From the palette or a key binding of the user's the
 * focus stays where it is.
 */
export const fromPanel = (arg: unknown): boolean => {
  const t = commandTarget(arg);
  return t.kind === "row" || (t.kind === "view" && t.view === "panel");
};

const num = (id: string) => Number(id.slice(1));

const byNum = (a: { id: string }, b: { id: string }) => num(a.id) - num(b.id);

const byId = (a: { id: string }, b: { id: string }) => compareItemIds(a.id, b.id);

/** Which changes a tree shows: the Review panel the open ones, the History view the decided ones. */
export type TreeMode = "review" | "history";

/** What the Review panel shows (filters by agent, file and status; search). */
export interface PanelFilter {
  agent?: string;
  file?: string;
  status?: "pending" | "needs_revision";
  /** Words to find in a change: its id, file, old and new text, the agent's note, the conversation. */
  text?: string;
}

export const filterIsEmpty = (f: PanelFilter | null | undefined): boolean => !f || (!f.agent && !f.file && !f.status && !f.text?.trim());

export function matchesFilter(i: Item, f: PanelFilter): boolean {
  if (f.agent && i.agent !== f.agent) return false;
  if (f.file && i.file !== f.file && i.oldFile !== f.file) return false;
  if (f.status && i.status !== f.status) return false;
  const q = f.text?.trim().toLowerCase();
  if (q) {
    const hay = [i.id, i.file, i.oldText, i.newText, i.note ?? "", i.draft ?? "", ...i.thread.map((t) => t.text)].join("\n").toLowerCase();
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
  }
  return true;
}

/** The filter in words, for the panel's message: "agent claude-1 · main.tex · “estimator”". */
export function filterText(f: PanelFilter): string {
  return [
    ...(f.agent ? [`agent ${f.agent}`] : []),
    ...(f.file ? [f.file] : []),
    ...(f.status ? [f.status === "pending" ? "waiting for you" : "waiting for the agent"] : []),
    ...(f.text?.trim() ? [`“${f.text.trim()}”`] : []),
  ].join(" · ");
}

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
    /** Shown changes only (what decisions act on is not filtered). */
    public filter: PanelFilter | null = null,
    readonly profile = profileByName,
    readonly effect: (item: Item) => string | null = itemEffect,
    /** How the tree groups changes; read on each call, so a setting's change shows at the next redraw. */
    readonly view: () => TreeView = () => ROUND_VIEW,
  ) {
    for (const i of snap.items) this.items.set(i.id, i);
    for (const g of snap.groups) this.groups.set(g.id, g);
  }

  /** Whether a node is shown under the filter: a change that matches it, or anything holding one. */
  private keeps(node: Node): boolean {
    const f = this.filter;
    if (filterIsEmpty(f)) return true;
    if (node.type === "item") return matchesFilter(node.item, f!);
    if (node.type === "note") {
      const q = f!.text?.trim().toLowerCase();
      return (
        !f!.status &&
        (!f!.agent || node.note.agent === f!.agent) &&
        (!f!.file || node.note.file === f!.file) &&
        (!q || [node.note.body, node.note.text, ...node.note.thread.map((t) => t.text)].join("\n").toLowerCase().includes(q))
      );
    }
    return this.allChildren(node).some((c) => this.keeps(c));
  }

  children(node?: Node): Node[] {
    const all = this.allChildren(node);
    return filterIsEmpty(this.filter) ? all : all.filter((c) => this.keeps(c));
  }

  visible(i: Item): boolean {
    return this.mode === "history" ? !isLiveItem(i) : isLiveItem(i);
  }

  /** Visible members of a group (atomic groups never show: their members are merged). */
  members(g: Group): Item[] {
    if (g.kind === "atomic") return [];
    return g.items
      .map((id) => this.items.get(id))
      .filter((i): i is Item => !!i && this.visible(i))
      .sort(byId);
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
      .filter(
        (i) =>
          !i.groups.some((gid) => {
            const g = this.groups.get(gid);
            return g && g.kind !== "atomic";
          }),
      )
      .sort(byId);
  }

  private csVisible(cs: Changeset): boolean {
    return this.groupsOf(cs).length > 0 || this.ungrouped(cs).length > 0;
  }

  private allChildren(node?: Node): Node[] {
    if (!node) {
      return this.snap.agents
        .filter(
          (a) =>
            (this.mode === "review" && a.state === "active") ||
            this.snap.items.some((i) => i.agent === a.id && this.visible(i)) ||
            this.resolvedNotes(a.id).length > 0,
        )
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((agent) => ({ type: "agent", agent }));
    }
    switch (node.type) {
      case "agent":
        return [
          ...this.openNotes(node.agent.id).map((note): Node => ({ type: "note", note })),
          // Resolved notes, with their replies, in History (they vanished from VS Code): in one row
          // of their own, which folds away like a round.
          ...(this.resolvedNotes(node.agent.id).length ? [{ type: "notes", agent: node.agent } as Node] : []),
          ...(this.view().groupBy === "file"
            ? this.filesOf(node.agent.id).map((file): Node => ({ type: "file", agent: node.agent, file }))
            : this.roundsOf(node.agent.id)),
        ];
      case "file":
        return this.fileChildren(node.agent, node.file);
      case "older":
        return [];
      case "note":
        return [];
      case "notes":
        return this.resolvedNotes(node.agent.id).map((note): Node => ({ type: "note", note }));
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

  /** An agent's rounds with something to show, the latest first. */
  private roundsOf(agent: string): Node[] {
    return this.snap.changesets
      .filter((c) => c.agent === agent && this.csVisible(c))
      .sort((a, b) => num(b.id) - num(a.id))
      .map((changeset): Node => ({ type: "changeset", changeset }));
  }

  /** The files an agent's shown changes are in, by path. */
  filesOf(agent: string): string[] {
    return [...new Set(this.snap.items.filter((i) => i.agent === agent && this.visible(i)).map((i) => i.file))].sort((a, b) => a.localeCompare(b));
  }

  /** An agent's shown changes to a file, in all rounds. */
  inFile(agent: string, file: string): Item[] {
    return this.snap.items.filter((i) => i.agent === agent && i.file === file && this.visible(i));
  }

  /**
   * A file's changes: in review, all of them in the order they come in the file; in History, those
   * of its latest rounds (stet.historyRoundsPerFile), the latest first, then a row for the older ones.
   */
  private fileChildren(agent: Agent, file: string): Node[] {
    const items = this.inFile(agent.id, file);
    const inOrder = (xs: Item[]) =>
      [...xs].sort((a, b) => (a.kind === "modify" ? a.range.start : -1) - (b.kind === "modify" ? b.range.start : -1) || byId(a, b));
    const node = (item: Item): Node => ({ type: "item", item, parent: fileParent(file) });
    if (this.mode === "review") return inOrder(items).map(node);
    const rounds = [...new Set(items.map((i) => i.changeset))].sort((a, b) => num(b) - num(a));
    const per = this.view().roundsPerFile;
    const shown = per ? per + this.view().more(agent.id, file) : rounds.length;
    const out = rounds.slice(0, shown).flatMap((cs) => inOrder(items.filter((i) => i.changeset === cs)).map(node));
    const older = rounds.slice(shown);
    if (!older.length) return out;
    const step = Math.min(per || 3, older.length);
    return [
      ...out,
      {
        type: "older",
        agent,
        file,
        rounds: step,
        changes: items.filter((i) => older.slice(0, step).includes(i.changeset)).length,
        hidden: older.length,
      },
    ];
  }

  /** The round of a change, as the panel says it: "round 3". */
  roundText(item: Item): string {
    return `round ${roundOf(item.changeset)}`;
  }

  /**
   * Of `ids` (changes in `file`), those accepted or rejected with nothing outside the file: no
   * part of their move or linked group (or part) is in another file.
   */
  standAlone(ids: string[], file: string): string[] {
    return this.standAloneIn(ids, (r) => r.file === file);
  }

  /** Of `ids`, those decided with nothing but changes `inside` (a file's, a group's). */
  standAloneIn(ids: string[], inside: (it: Item) => boolean): string[] {
    return ids.filter((id) => this.linkedRest([id]).every(inside));
  }

  /** Resolved notes for an agent, shown in History only. */
  resolvedNotes(agent: string): Note[] {
    return this.mode === "history" ? this.snap.notes.filter((n) => n.agent === agent && n.state === "resolved").sort(byNum) : [];
  }

  /** Open notes for an agent, shown in the Review panel only. */
  openNotes(agent: string): Note[] {
    return this.mode === "review" ? this.snap.notes.filter((n) => n.agent === agent && n.state === "open").sort(byNum) : [];
  }

  liveCount(pred: (i: Item) => boolean): number {
    return this.snap.items.filter((i) => isLiveItem(i) && pred(i)).length;
  }

  /**
   * "3 pending · 1 awaiting revision" for the open changes matching `pred`: those waiting for the
   * agent's revision are not yours to review, as in the badge.
   */
  openText(pred: (i: Item) => boolean): string {
    const pending = this.snap.items.filter((i) => i.status === "pending" && pred(i)).length;
    const revising = this.snap.items.filter((i) => i.status === "needs_revision" && pred(i)).length;
    return [`${pending} pending`, ...(revising ? [`${revising} awaiting revision`] : [])].join(" · ");
  }

  /** How the decided changes matching `pred` were decided, e.g. "5 accepted · 2 rejected". */
  outcome(pred: (i: Item) => boolean): string {
    const counts = new Map<ItemStatus, number>();
    for (const i of this.snap.items) if (!isLiveItem(i) && pred(i)) counts.set(i.status, (counts.get(i.status) ?? 0) + 1);
    const order: ItemStatus[] = ["accepted", "rejected", "stale", "withdrawn", "superseded"];
    return order
      .filter((st) => counts.has(st))
      .map((st) => `${counts.get(st)} ${STATUS_TEXT[st]}`)
      .join(" · ");
  }

  item(id: string): Item | undefined {
    return this.items.get(id.toUpperCase());
  }

  group(id: string): Group | undefined {
    return this.groups.get(id.toUpperCase());
  }

  /** Live items that are decided with `ids` (core's rule: their moves, their linked groups or parts), excluding `ids` themselves. */
  linkedRest(ids: string[]): Item[] {
    return linkedRest(ids, { item: (id) => this.item(id), group: (id) => this.group(id) });
  }

  /** Pending items in other parts of the linked groups of `ids`: neither `ids` nor what `linkedRest` adds. */
  otherParts(ids: string[]): Item[] {
    const rest = new Set([...ids, ...this.linkedRest(ids).map((i) => i.id)]);
    const out = new Map<string, Item>();
    for (const id of ids) {
      for (const gid of this.item(id)?.groups ?? []) {
        const g = this.groups.get(gid);
        if (g?.kind !== "linked") continue;
        for (const m of g.items) {
          const mi = this.items.get(m);
          if (mi && isLiveItem(mi) && !rest.has(mi.id)) out.set(mi.id, mi);
        }
      }
    }
    return [...out.values()].sort(byId);
  }

  /** The other items of an item's move that are still pending. */
  private moveRest(item: Item | undefined): Item[] {
    return item
      ? moveOthers(item)
          .map((o) => this.items.get(o))
          .filter((o): o is Item => !!o && isLiveItem(o))
      : [];
  }

  /** An item and the rest of its move, if it is part of one (spec §6.4.7): decided together. */
  withMove(item: Item): string[] {
    return [item.id, ...this.moveRest(item).map((o) => o.id)];
  }

  /** The other items of an item's move, in their order (moved-out ones first). */
  others(item: Item): Item[] {
    return moveOthers(item)
      .map((o) => this.items.get(o))
      .filter((o): o is Item => !!o);
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

/**
 * `j` / `k`: the row of the next (dir 1) or previous (-1) change after row `cur` of the panel's
 * rows (`isItem` tells changes from rounds, groups, …); from no row, the first or last change.
 * -1 if there is none that way.
 */
export function nextItemIndex(isItem: boolean[], cur: number, dir: 1 | -1): number {
  if (cur < 0) {
    const i = dir > 0 ? isItem.indexOf(true) : isItem.lastIndexOf(true);
    return i;
  }
  for (let i = cur + dir; i >= 0 && i < isItem.length; i += dir) if (isItem[i]) return i;
  // Already at the last (first) change: stay on it.
  return isItem[cur] ? cur : -1;
}

/**
 * The active agents behind the user's latest text. The check runs a little after each refresh;
 * until then an agent archived meanwhile was still named in the status bar.
 */
export function behindAgents(snap: Pick<Snapshot, "agents" | "syncNeeded">): string[] {
  return snap.agents.filter((a) => a.state === "active" && snap.syncNeeded.has(a.id)).map((a) => a.id);
}

/**
 * Replies of the agent in a thread after its first `seen` entries: what the reviewer hasn't seen
 * yet (replies arrived without a sign).
 */
export function unreadReplies(thread: readonly { author: string }[], seen: number): number {
  return thread.slice(seen).filter((e) => e.author === "agent").length;
}

/** Changes in document order: by project, file and line, then id (`stet.navigationOrder`: "document"). */
export function documentOrder<T extends { project: string; file: string; line: number; id: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file) || a.line - b.line || compareItemIds(a.id, b.id));
}

/**
 * Agent-written titles, rationales and replies as the panel, hovers, pickers and notifications
 * show them: titles on one line, and control, direction and invisible characters as visible
 * markers. They reached labels and hovers raw, so a change could show reordered compared with what
 * is applied. The changes' own text is left as it is.
 */
export function shownAgentText(s: { changesets: Changeset[]; groups: Group[]; items: Item[]; notes: Note[] }) {
  const line = (t: string) => noLinks(t).replace(/\s+/g, " ").trim();
  const thread = <T extends { thread: { text: string }[] }>(x: T): T => ({ ...x, thread: x.thread.map((t) => ({ ...t, text: noLinks(t.text) })) });
  return {
    changesets: s.changesets.map((cs) => ({ ...cs, title: line(cs.title), ...(cs.rationale ? { rationale: noLinks(cs.rationale) } : {}) })),
    groups: s.groups.map((g) => ({
      ...g,
      title: line(g.title),
      ...(g.rationale ? { rationale: noLinks(g.rationale) } : {}),
      ...(g.parts ? { parts: g.parts.map((p) => ({ ...p, title: line(p.title) })) } : {}),
    })),
    items: s.items.map((i) => ({ ...thread(i), ...(i.note ? { note: noLinks(i.note) } : {}) })),
    notes: s.notes.map(thread),
  };
}

/**
 * The `p=` query of Stet's own documents (diffs, the Review file, the edit tab): the project's
 * folder, encoded once. `URLSearchParams` decodes it once on the way back, so a folder named
 * `50% done` or holding `%20` comes back as it is.
 */
export function projectQuery(mainPath: string): string {
  return `p=${encodeURIComponent(mainPath)}`;
}

/** The project folder in a `projectQuery`. */
export function projectOfQuery(query: string): string {
  return new URLSearchParams(query).get("p") ?? "";
}

/** "Which one?" was cancelled (Escape): nothing to act on, and nothing more to ask or say. */
export interface Cancelled {
  cancelled: true;
}
export const CANCELLED: Cancelled = { cancelled: true };
export const isCancelled = (v: unknown): v is Cancelled => v === CANCELLED;

/**
 * What a command acts on, when it isn't given a change: the panel's selection if the user picked
 * there last, else the change at the cursor (`atCursor`, which may ask "which one?"), else the
 * panel's selection. Escape in "which one?" decides nothing: `CANCELLED`, not the panel's
 * selection, which may be a change in another file.
 */
export async function chooseTarget<T>(
  selected: T | undefined,
  lastPick: "panel" | "editor",
  atCursor: () => Promise<T | Cancelled | undefined>,
): Promise<T | Cancelled | undefined> {
  if (selected && lastPick !== "editor") return selected;
  const here = await atCursor();
  return isCancelled(here) ? here : (here ?? selected);
}
