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
  printable,
  changeSummary,
  paragraphChange,
  profileByName,
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

/**
 * Whether a command's argument means it came from the Review panel (a key there, or a row's
 * button or menu), so the focus stays there for the next change. From the palette or a key
 * binding of the user's the argument is undefined: the focus stays where it is (test report v0.16.0, B6).
 */
export const fromPanel = (arg: unknown): boolean => arg === "panel" || (!!arg && typeof arg === "object" && "project" in arg && !isRef(arg));

export const LIVE: readonly ItemStatus[] = ["pending", "needs_revision"];
export const isLive = (i: Item) => LIVE.includes(i.status);
const num = (id: string) => Number(id.slice(1));
const byNum = (a: { id: string }, b: { id: string }) => num(a.id) - num(b.id);
const byId = (a: { id: string }, b: { id: string }) => compareItemIds(a.id, b.id);

/** Which changes a tree shows: the Review panel the open ones, the History view the decided ones. */
export type TreeMode = "review" | "history";

/** What the Review panel shows (test report 2026-11-20: filters by agent, file and status; search). */
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
      return !f!.status && (!f!.agent || node.note.agent === f!.agent) && (!f!.file || node.note.file === f!.file) && (!q || [node.note.body, node.note.text, ...node.note.thread.map((t) => t.text)].join("\n").toLowerCase().includes(q));
    }
    return this.allChildren(node).some((c) => this.keeps(c));
  }

  children(node?: Node): Node[] {
    const all = this.allChildren(node);
    return filterIsEmpty(this.filter) ? all : all.filter((c) => this.keeps(c));
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

  private allChildren(node?: Node): Node[] {
    if (!node) {
      return this.snap.agents
        .filter((a) => (this.mode === "review" && a.state === "active") || this.snap.items.some((i) => i.agent === a.id && this.visible(i)) || this.resolvedNotes(a.id).length > 0)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((agent) => ({ type: "agent", agent }));
    }
    switch (node.type) {
      case "agent":
        return [
          ...this.openNotes(node.agent.id).map((note): Node => ({ type: "note", note })),
          // Resolved notes, with their replies, in History (test report v0.16.0: they vanished from VS Code).
          ...this.resolvedNotes(node.agent.id).map((note): Node => ({ type: "note", note })),
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

  /** Resolved notes for an agent, shown in History only. */
  resolvedNotes(agent: string): Note[] {
    return this.mode === "history" ? this.snap.notes.filter((n) => n.agent === agent && n.state === "resolved").sort(byNum) : [];
  }

  /** Open notes for an agent, shown in the Review panel only. */
  openNotes(agent: string): Note[] {
    return this.mode === "review" ? this.snap.notes.filter((n) => n.agent === agent && n.state === "open").sort(byNum) : [];
  }

  liveCount(pred: (i: Item) => boolean): number {
    return this.snap.items.filter((i) => isLive(i) && pred(i)).length;
  }

  /**
   * "3 pending · 1 awaiting revision" for the open changes matching `pred`: those waiting for the
   * agent's revision are not yours to review, as in the badge (test report v0.16.0, B14).
   */
  openText(pred: (i: Item) => boolean): string {
    const pending = this.snap.items.filter((i) => i.status === "pending" && pred(i)).length;
    const revising = this.snap.items.filter((i) => i.status === "needs_revision" && pred(i)).length;
    return [`${pending} pending`, ...(revising ? [`${revising} awaiting revision`] : [])].join(" · ");
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
          if (mi && isLive(mi) && !rest.has(mi.id)) out.set(mi.id, mi);
        }
      }
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

/** Title of a change's More… list: its id, then its label without the number again ("1.1: 1 …", test report v0.16.0, B13). */
export function actionsTitle(it: Item, get?: (id: string) => Item | undefined): string {
  return `${it.id}: ${itemLabel(it, get).slice(shortId(it.id).length).trim()}`;
}

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
      {
        const [o, nw] = changeSummary(it.oldText, it.newText, it.oldText && it.newText ? 28 : 50);
        const breaks = paragraphChange(it.oldText, it.newText);
        const revises = (breaks ? `  · ${breaks}` : "") + (it.supersedes ? `  · revises ${it.supersedes}` : "");
        if (!it.oldText) return `${n}  + “${nw}”${revises}`;
        if (!it.newText) return `${n}  − “${o}”${revises}`;
        return `${n}  “${o}” → “${nw}”${revises}`;
      }
  }
}

/** Label of a round (changeset): its number and the agent's title. */
/**
 * A label cut to `max` characters at a word, with "…": long agent names and round titles pushed
 * the counts and line numbers out of a narrow panel (test report 2026-11-20). Tooltips keep it whole.
 */
export function fitLabel(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

export const roundLabel = (cs: Changeset): string => `Round ${roundOf(cs.id)}: ${fitLabel(cs.title, 40)}`;

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
/**
 * Text for a notification: VS Code turns `[text](command:…)` in one into a working link, so agent
 * text in it must not keep that form (security report 5e4c6af, S4).
 */
export const noLinks = (s: string): string => printable(s).replace(/\]\s*\(/g, "] (");

export function ghostText(s: string, max = 80): string {
  // Whitespace alone (a paragraph split or joined) would be invisible: shown as ¶ and ␣.
  if (s && !s.trim()) return s.replace(/\r?\n[ \t]*\r?\n\s*/g, "¶").replace(/\r?\n/g, "↵").replace(/[ \t]/g, "␣");
  const t = printable(s).replace(/\n/g, " ⏎ ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** What changes inside an item (removed spans, inserted text), cached: computed on every redraw. */
const diffs = new Map<string, InlineDiff>();
export function itemDiff(item: Pick<Item, "oldText" | "newText" | "file">): InlineDiff {
  // Diffed by the tokens of the file's language (LaTeX: `\alpha` is one).
  const profile = profileByName(item.file);
  const syntax = profile.syntax;
  const key = profile.id + "\0" + item.oldText + "\0" + item.newText;
  let d = diffs.get(key);
  if (!d) {
    if (diffs.size > 500) diffs.clear();
    diffs.set(key, (d = inlineDiff(item.oldText, item.newText, syntax?.tokenize)));
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
/**
 * The words around a change on its line, for editing it in an input box: the box holds
 * `pre + text + post` with the change selected, so its bounds are visible and the words next to
 * it aren't typed twice (test report v0.16.0, D2: "relies on a simplea simple idea"). At most
 * about `max` characters each side, cut at a space.
 */
export function editFrame(item: Pick<Item, "context">, max = 60): { pre: string; post: string } {
  let pre = item.context.before.slice(item.context.before.lastIndexOf("\n") + 1);
  if (pre.length > max) {
    const cut = pre.indexOf(" ", pre.length - max);
    pre = cut < 0 ? "" : pre.slice(cut + 1).trimStart();
  }
  const nl = item.context.after.indexOf("\n");
  let post = nl < 0 ? item.context.after : item.context.after.slice(0, nl);
  if (post.length > max) {
    const cut = post.lastIndexOf(" ", max);
    post = cut < 0 ? "" : post.slice(0, cut).trimEnd();
  }
  return { pre, post };
}

/** The change's new wording in an edited `pre + text + post`, or null if the edit reaches the words around it. */
export function editedPart(frame: { pre: string; post: string }, value: string): string | null {
  if (value.length < frame.pre.length + frame.post.length || !value.startsWith(frame.pre) || !value.endsWith(frame.post)) return null;
  return value.slice(frame.pre.length, value.length - frame.post.length);
}

/** The button of Finish review's question that saves unsaved editors into the commit. */
export const FINISH_SAVE = "Save and commit";

/**
 * Finish review's question: which files are committed, which hold edits of yours that go along,
 * which have unsaved text (not committed unless saved), and that undo ends with the commit.
 */
export function finishQuestion(count: number, files: string[], yourEdits: string[], unsaved: string[], project = ""): { message: string; detail: string; buttons: string[] } {
  const list = (xs: string[]) => xs.join(", ");
  const detail = [`Files: ${list(files)}.`];
  if (yourEdits.length) detail.push(`Your own edits in ${list(yourEdits)} are committed too (Stet commits whole files).`);
  if (unsaved.length) detail.push(`${list(unsaved)} ${unsaved.length === 1 ? "has" : "have"} unsaved edits: “Commit” leaves them out, “${FINISH_SAVE}” saves them into the commit.`);
  detail.push("After the commit, Undo no longer takes these changes back (git revert can).");
  return { message: `Commit ${count} accepted change${count === 1 ? "" : "s"}${project ? ` in ${project}` : ""}?`, detail: detail.join("\n"), buttons: unsaved.length ? ["Commit", FINISH_SAVE] : ["Commit"] };
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
 * until then an agent archived meanwhile was still named in the status bar (test report v0.16.0, B11).
 */
export function behindAgents(snap: Pick<Snapshot, "agents" | "syncNeeded">): string[] {
  return snap.agents.filter((a) => a.state === "active" && snap.syncNeeded.has(a.id)).map((a) => a.id);
}

/**
 * Replies of the agent in a thread after its first `seen` entries: what the reviewer hasn't seen
 * yet (test report v0.16.0: replies arrived without a sign).
 */
export function unreadReplies(thread: readonly { author: string }[], seen: number): number {
  return thread.slice(seen).filter((e) => e.author === "agent").length;
}

/** "💬 3 (1 new)", for a row's description; "" without messages. */
export function threadText(count: number, unread: number): string {
  return count ? `💬 ${count}${unread ? ` (${unread} new)` : ""}` : "";
}

/** Changes in document order: by project, file and line, then id (`stet.navigationOrder`: "document"). */
export function documentOrder<T extends { project: string; file: string; line: number; id: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => a.project.localeCompare(b.project) || a.file.localeCompare(b.file) || a.line - b.line || compareItemIds(a.id, b.id));
}

/**
 * What to ask when several selected changes are linked with others not selected: take those
 * along (recommended), or decide only the selected ones, which breaks their linked groups.
 */
export function manyQuestion(
  verb: "Accept" | "Reject",
  count: number,
  rest: string[],
  /** Pending changes in other parts of their linked groups: asked about too (test report 5e4c6af, D2). */
  otherParts: string[] = [],
): { title: string; choices: { label: string; detail: string; withRest: boolean; withGroups?: boolean }[] } {
  const choices: { label: string; detail: string; withRest: boolean; withGroups?: boolean }[] = [];
  if (rest.length) choices.push({ label: `${verb} the ${count} selected and the ${rest.length} linked with them`, detail: "Linked changes belong together.", withRest: true });
  if (otherParts.length)
    choices.push({ label: `${verb} the ${count} selected and all ${otherParts.length + rest.length} other changes of their linked groups`, detail: "Every part at once.", withRest: true, withGroups: true });
  if (rest.length) choices.push({ label: `${verb} only the ${count} selected`, detail: "Breaks their linked groups; the agent is asked to repair the document.", withRest: false });
  else choices.push({ label: `${verb} only the ${count} selected`, detail: `The other parts of their linked groups (${otherParts.join(", ")}) stay pending: the document is inconsistent until they are accepted too.`, withRest: true });
  return { title: `The ${count} selected changes are linked with ${[...rest, ...otherParts].join(", ")}`, choices };
}

export const fitsInline = (s: string, max = 80): boolean => !/[\r\n]/.test(s) && s.length <= max;

/** The full new text of a proposal, for the editor's inline widget. Agent text: fenced, never rendered. */
export function proposalMarkdown(item: Item): string {
  const lang = profileByName(item.file).fence;
  return `*Proposed text, replacing the struck-through text above:*\n\n${fence(item.newText, lang)}`;
}

/** Markdown fenced block that is safe for any content. */
/** The reviewer's wording of a change, for hovers: the code block on lines of its own (test report v0.16.0, B12). */
export function draftMarkdown(item: Pick<Item, "draft" | "file">): string {
  return `✎ **Your wording** (from the review of this file), which Accept uses:\n\n${fence(item.draft ?? "", profileByName(item.file).fence)}`;
}

export function fence(text: string, lang = ""): string {
  // Agent text: a lone CR would end a line for Markdown inside the fence, and direction overrides
  // would reorder what is shown (security report 5e4c6af, S3 and S9).
  text = printable(text);
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A unified-style diff for hovers. */
export function diffBlock(oldText: string, newText: string): string {
  const lines = [
    ...(oldText ? printable(oldText).split("\n").map((l) => "- " + l) : []),
    ...(newText ? printable(newText).split("\n").map((l) => "+ " + l) : []),
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

type Pos = { line: number; character: number };

/**
 * Of changes located in a file, the one a command at `pos` means: the one the cursor is in, else
 * the nearest on its line, not the line's first, which may be another change in the same
 * paragraph (test report 2026-11-20, B8).
 */
export function changeAt<T extends { range: { start: Pos; end: Pos } }>(located: T[], pos: Pos): T | undefined {
  const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  const inside = (r: { start: Pos; end: Pos }) => before(r.start, pos) && before(pos, r.end);
  const gap = (r: { start: Pos; end: Pos }) =>
    inside(r) ? 0 : 1 + Math.min(r.start.line === pos.line ? Math.abs(r.start.character - pos.character) : Infinity, r.end.line === pos.line ? Math.abs(r.end.character - pos.character) : Infinity);
  return located.filter((l) => inside(l.range) || l.range.start.line === pos.line || l.range.end.line === pos.line).sort((a, b) => gap(a.range) - gap(b.range))[0];
}

/**
 * The changes the cursor is inside of, when there are several (overlapping changes of two agents):
 * commands ask which one rather than pick one silently (test report v0.16.0). Empty otherwise.
 */
export function changesAt<T extends { range: { start: Pos; end: Pos } }>(located: T[], pos: Pos): T[] {
  const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  const inside = located.filter((l) => before(l.range.start, pos) && before(pos, l.range.end));
  return inside.length > 1 ? inside : [];
}

/**
 * The buttons of the archive dialog, the safe one first (Enter takes it): archiving can't be
 * undone, and deleting the folder came first (test report 2026-11-20, D5). `unsubmitted`: files
 * the agent changed and didn't submit, named on the delete button.
 */
export function archiveChoices(unsubmitted: number): { keep: string; del: string; order: string[] } {
  const keep = "Archive, keep folder";
  const del = unsubmitted ? `Archive and delete folder, with ${unsubmitted} unsubmitted file${unsubmitted === 1 ? "" : "s"}` : "Archive and delete folder";
  return { keep, del, order: [keep, del] };
}

/**
 * The question to ask before deciding several changes at once, or null to go ahead. A round
 * always asks; a group or part asks unless it is linked (its changes must go together anyway).
 * Shift+A asked for a round only, and Shift+R never did (test report 2026-11-20).
 */
export function bulkQuestion(verb: "Accept" | "Reject", s: { count: number; what: string; changeset: boolean; linked: boolean }): string | null {
  if (s.count < 2 || (s.linked && !s.changeset)) return null;
  return `${verb} all ${s.count} changes of ${s.what}?`;
}

/** The question before dissolving a group, or null: a linked group's changes can then be decided apart, which can break the document. */
export function dissolveQuestion(g: { id: string; kind: string; title: string }): string | null {
  if (g.kind === "linked") return `Dissolve linked group ${g.id} “${g.title}”? Its changes can then be accepted one by one, which can break the document. This can't be undone.`;
  // A related group too: dissolving it can't be undone either (test report v0.16.0).
  if (g.kind === "related") return `Dissolve group ${g.id} “${g.title}”? Its changes are then listed one by one in their round. This can't be undone.`;
  return null;
}

/**
 * A change as a screen reader reads it: what, where and its state in words, with no symbols or
 * colour (decorations aren't read; test report 2026-11-20, accessibility).
 */
export function itemSpoken(it: Item, line?: number, unread = 0): string {
  const where = `in ${it.file}${line && it.kind === "modify" ? ` line ${line}` : ""}`;
  // As the row says it (test report v0.16.0, accessibility): "revision requested", your wording,
  // the conversation.
  const extra = [
    ...(it.draft !== undefined && isLive(it) ? ["your wording"] : []),
    ...(it.thread.length ? [`${it.thread.length} message${it.thread.length === 1 ? "" : "s"}${unread ? `, ${unread} new` : ""}`] : []),
  ];
  const state = [STATUS_TEXT[it.status], ...extra].join(", ");
  if (it.kind !== "modify") return `Change ${it.id}, ${it.kind.replace("-", " ")} ${where}, ${state}`;
  // What it says: your wording if you have one, or the text it was accepted with.
  const text = it.status === "accepted" && it.resolution ? it.resolution.appliedText : isLive(it) ? (it.draft ?? it.newText) : it.newText;
  const [o, n] = changeSummary(it.oldText, text, 60);
  const breaks = paragraphChange(it.oldText, text);
  const what = breaks
    ? `${breaks}, “${o}” to “${n}”`
    : !it.oldText ? `insert “${n}”` : !text ? `delete “${o}”` : `replace “${o}” with “${n}”`;
  return `Change ${it.id}, ${what}, ${where}, ${state}${it.supersedes ? `, revises ${it.supersedes}` : ""}`;
}

/** Escape agent-written text for Markdown, so it cannot add links or formatting. */
export const esc = (s: string) => printable(s).replace(/[\\`*_{}[\]()#+\-.!|<>~=:]/g, "\\$&");

/**
 * A link's tooltip in trusted Markdown: one line, its quotes and backslashes escaped. A blank line
 * in a group title used to end the link, and the rest became trusted Markdown with Stet's command
 * links in it (security report 5e4c6af, S2).
 */
export const linkTitle = (s: string) => oneLine(s, 400).replace(/["\\]/g, "\\$&");

/**
 * Agent-written titles, rationales and replies as the panel, hovers, pickers and notifications
 * show them: titles on one line, and control, direction and invisible characters as visible
 * markers. They reached labels and hovers raw, so a change could show reordered compared with what
 * is applied (security report 5e4c6af, S9). The changes' own text is left as it is.
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

/** A panel row's text as words: its symbols spelled out. */
export function spokenRow(s: string): string {
  return s
    .replace(/💬\s*(\d+)/g, (_, n: string) => `${n} message${n === "1" ? "" : "s"}`)
    .replace(/⚠\s*/g, "warning: ")
    .replace(/\s*·\s*/g, ", ")
    .replace(/[↻✎🔗▣⇅]\s*/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

