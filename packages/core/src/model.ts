/** Persistent data model (spec §5). */

export type AgentKind = "claude-code" | "codex" | "other";

export interface Agent {
  id: string;
  kind: AgentKind;
  branch: string;
  worktree: string;
  /** Review base commit the agent branch was last replayed onto. */
  baseCommit: string;
  /** Agent branch tip as of the last submit or replay. */
  lastTip: string;
  /** When the agent branch was last rebuilt (resolved items before this are gone from it). */
  replayedAt: string;
  feedbackCursor: number;
  createdAt: string;
  state: "active" | "archived";
  /** Set when the reviewer archives the agent. */
  archived?: { at: string; withdrawn: string[]; worktreeRemoved: boolean };
  /** When the agent's inbox gets news (it wakes an agent running `stet watch`). Absent: "batched". */
  notify?: NotifyMode;
}

/**
 * How an agent hears about the reviewer's activity through its inbox (`stet watch`):
 * - `now`: as soon as it happens;
 * - `batched`: once the reviewer has paused for a while, all at once (not after every click);
 * - `off`: not at all, until switched on again (then everything since arrives).
 */
export type NotifyMode = "now" | "batched" | "off";
export const NOTIFY_MODES: readonly NotifyMode[] = ["now", "batched", "off"];
export const notifyMode = (a: Agent): NotifyMode => a.notify ?? "batched";

export type GroupKind = "atomic" | "linked" | "related";
export type GroupSource = "agent" | "commit" | "auto";

export interface Group {
  id: string;
  agent: string;
  changeset: string;
  kind: GroupKind;
  title: string;
  rationale: string | null;
  source: GroupSource;
  items: string[];
  /**
   * Linked groups only: pieces that can each be accepted or rejected on their own (spec §6.4.6).
   * They partition `items`. Absent when the group is one unit.
   */
  parts?: GroupPart[];
  state: "open" | "resolved" | "broken";
}

/** Part of a linked group: accepting it alone keeps the document compiling and blocks no other part. */
export interface GroupPart {
  title: string;
  items: string[];
}

/** Id of the k-th part (0-based) of a group: G3.2 is part 2 of G3. */
export const partId = (groupId: string, k: number): string => `${groupId}.${k + 1}`;

/** G3.2 → { group: "G3", index: 1 }; null for anything else. */
export function parsePartId(id: string): { group: string; index: number } | null {
  const m = /^(G\d+)\.(\d+)$/i.exec(id.trim());
  return m && Number(m[2]) >= 1 ? { group: m[1]!.toUpperCase(), index: Number(m[2]) - 1 } : null;
}

/** Index of the part of `g` that holds `itemId`, or -1. */
export const partIndexOf = (g: Group, itemId: string): number => g.parts?.findIndex((p) => p.items.includes(itemId)) ?? -1;

/**
 * The items `itemId` must be accepted with in group `g`: its part, the whole group for a linked
 * group without parts, or just itself for other kinds.
 */
export function linkedUnit(g: Group, itemId: string): string[] {
  if (g.kind !== "linked") return [itemId];
  const k = partIndexOf(g, itemId);
  return k >= 0 ? g.parts![k]!.items : g.items;
}

export interface Changeset {
  id: string;
  agent: string;
  title: string;
  rationale: string;
  submittedAt: string;
  items: string[];
  groups: string[];
}

export type ItemKind = "modify" | "add-file" | "delete-file" | "rename-file" | "binary";

export type ItemStatus =
  | "pending"
  | "needs_revision"
  | "accepted"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "stale";

export const LIVE_STATUSES: readonly ItemStatus[] = ["pending", "needs_revision"];
export const isLive = (s: ItemStatus) => LIVE_STATUSES.includes(s);

export interface ThreadEntry {
  at: string;
  author: "user" | "agent";
  text: string;
}

export interface Item {
  id: string;
  agent: string;
  changeset: string;
  file: string;
  /** For rename-file: the previous path. */
  oldFile?: string;
  kind: ItemKind;
  baseCommit: string;
  range: { start: number; end: number };
  oldText: string;
  newText: string;
  /** For binary items: blob ids (null = file absent). */
  oldBlob?: string | null;
  newBlob?: string | null;
  context: { before: string; after: string };
  fingerprint: string;
  note: string | null;
  groups: string[];
  status: ItemStatus;
  resolution: {
    appliedText: string;
    edited: boolean;
    committed: string | null;
    /**
     * The file's blob in main HEAD when the item was accepted (null: absent). Once HEAD's file
     * differs, the user has committed it, with this change or their later edits of it.
     * Missing for items accepted before 0.6.1 (and after an interrupted accept).
     */
    headBlob?: string | null;
  } | null;
  supersedes: string | null;
  conflictsWith: string[];
  history: { at: string; status: ItemStatus; by: "user" | "agent" | "stet"; note?: string }[];
  thread: ThreadEntry[];
  /** Part of a move (spec §6.4.7), on every item of it: they are accepted or rejected together. */
  move?: MoveInfo;
  /**
   * The reviewer's last attempt to accept it failed (it could not be applied). Rejecting it then
   * says nothing about the change itself, so it does not count for repeat detection.
   */
  acceptFailed?: { at: string; reason: string };
}

/**
 * Passages moved within the submission: the `from` items delete them, the `to` items insert them
 * elsewhere. Usually one of each; several blocks that end up next to each other form one
 * insertion with several deletions (and blocks next to each other at the start, one deletion with
 * several insertions). Ids in text order: `from` as the blocks appear in the insertion, `to` as
 * they appear in the deletion. A single id (string) is how Stet 0.7.0 stored them.
 * `changed`: words that differ (0 = word for word; spacing and line breaks aside).
 */
export interface MoveInfo {
  from: string | string[];
  to: string | string[];
  changed: number;
}

const ids = (v: string | string[]) => (Array.isArray(v) ? v : [v]);
/** The items of a move that remove text. */
export const moveFrom = (m: MoveInfo): string[] => ids(m.from);
/** The items of a move that insert text. */
export const moveTo = (m: MoveInfo): string[] => ids(m.to);
/** Does the item remove text for its move (rather than insert it)? */
export const movesOut = (it: Pick<Item, "id" | "move">): boolean => !!it.move && moveFrom(it.move).includes(it.id);
/** The other items of an item's move (empty if it is none). */
export const moveOthers = (it: Pick<Item, "id" | "move">): string[] =>
  it.move ? [...moveFrom(it.move), ...moveTo(it.move)].filter((i) => i !== it.id) : [];

/**
 * A reviewer's note to one agent about a passage of the document (spec §7.8), e.g. "shorten this
 * paragraph". Delivered at the agent's next sync; afterwards a conversation like an item's.
 */
export interface Note {
  id: string;
  agent: string;
  file: string;
  /** The passage as the reviewer saw it (LF), with its surroundings, to find it again. */
  text: string;
  range: { start: number; end: number };
  context: { before: string; after: string };
  /** What the reviewer wrote. */
  body: string;
  createdAt: string;
  state: "open" | "resolved";
  /** When the agent received it (at a sync); null until then. */
  deliveredAt: string | null;
  /** Replies after the note itself. */
  thread: ThreadEntry[];
}

export const isNoteId = (id: string): boolean => /^N\d+$/i.test(id.trim());

export type EventType =
  | "items_submitted"
  | "accepted"
  | "rejected"
  | "revision_requested"
  | "comment"
  | "reply"
  | "stale"
  | "repeat_rejected"
  | "group_broken"
  | "group_partial"
  | "withdrawn"
  | "superseded"
  | "synced"
  | "archived"
  | "note_added"
  /** The reviewer wrote in a delivered note's thread. */
  | "note_comment"
  /** The agent replied to a note. */
  | "note_reply"
  | "note_resolved"
  /** The reviewer undid a decision: the item is pending again. */
  | "reopened";

export interface StetEvent {
  seq: number;
  at: string;
  type: EventType;
  agent: string;
  items?: string[];
  group?: string;
  data?: Record<string, unknown>;
}

/** Event types an agent receives from `feedback`. */
export const FEEDBACK_TYPES: readonly EventType[] = [
  "accepted",
  "rejected",
  "revision_requested",
  "comment",
  "stale",
  "repeat_rejected",
  "group_broken",
  "group_partial",
  "note_comment",
  "note_resolved",
  "reopened",
];

export interface StoreState {
  schema: 1;
  nextItem: number;
  nextChangeset: number;
  nextGroup: number;
  /** Absent in stores made before reviewer notes (2026-11-11): starts at 1. */
  nextNote?: number;
  nextEvent: number;
  /**
   * Cached review base: key identifies HEAD + uncommitted accepted items. `missing`: accepted,
   * uncommitted items it should hold but could not (absent when there are none).
   */
  base: { key: string; commit: string; missing?: { id: string; reason: string }[] } | null;
  /** The user's saved files as of their last *Share my edits*, on top of main at `head`. */
  /** The last *Share my edits*; `at` (since 0.6.1) tells which accepted items it already holds. */
  shared?: { head: string; tree: string; at?: string } | null;
}

// ---------------------------------------------------------------------------
// Item ids: "<round>.<n>", round = the changeset's number (one agent submission), n = the
// change within it, e.g. 12.3. Items created before 2026-10-21 have ids like S412.

/** The round (submission) number of a changeset id: C12 → 12. */
export const roundOf = (changesetId: string): number => Number(changesetId.slice(1));

/** The id of the n-th change of a round. */
export const itemId = (changesetId: string, n: number): string => `${roundOf(changesetId)}.${n}`;

/** The number of a change within its round (3 for 12.3), or null for old-style ids (S412). */
export function numberInRound(id: string): number | null {
  const m = /^\d+\.(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

/** Sort key of an item id: old-style ids first (in their order), then by round and number. */
function idKey(id: string): [number, number] {
  const m = /^(\d+)\.(\d+)$/.exec(id);
  if (m) return [Number(m[1]), Number(m[2])];
  const old = /^S(\d+)$/i.exec(id);
  return old ? [0, Number(old[1])] : [Number.MAX_SAFE_INTEGER, 0];
}

export function compareItemIds(a: string, b: string): number {
  const [ra, na] = idKey(a);
  const [rb, nb] = idKey(b);
  return ra - rb || na - nb || a.localeCompare(b);
}
