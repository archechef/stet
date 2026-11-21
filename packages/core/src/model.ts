/** Persistent data model (spec §5). */

export const AGENT_KINDS = ["claude-code", "codex", "other"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const isAgentKind = (s: string): s is AgentKind => (AGENT_KINDS as readonly string[]).includes(s);

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
  /** Which kinds of news wake it. Absent: all of them. */
  notifyOn?: NotifyTrigger[];
  /** The tool settings Stet last wrote into its workspace (file → SHA-256): checked at each MCP server start. */
  toolConfigs?: Record<string, string>;
}

/**
 * How an agent hears about the reviewer's activity through its inbox (`stet watch`):
 * - `now`: as soon as it happens;
 * - `batched`: once the reviewer has paused for a while, all at once (not after every click);
 * - `off`: not at all, until switched on again (then everything since arrives).
 */
export const NOTIFY_MODES = ["now", "batched", "off"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];
export const notifyMode = (a: Agent): NotifyMode => a.notify ?? "batched";

/**
 * Kinds of news that can wake a watching agent, each switched on or off per agent. Kinds left
 * out don't wake it, but the agent still finds them when it next checks.
 */
export const NOTIFY_TRIGGERS = ["accepted", "rejected", "revision", "comment", "note", "document", "save"] as const;
export type NotifyTrigger = (typeof NOTIFY_TRIGGERS)[number];
export const NOTIFY_TRIGGER_TEXT: Record<NotifyTrigger, string> = {
  accepted: "Accepted changes",
  rejected: "Rejected changes",
  revision: "Revision requests",
  comment: "Comments and replies",
  note: "New notes",
  document: "Commits and shared edits",
  save: "Saves (when agents see your saved edits)",
};
export const notifyTriggers = (a: Agent): NotifyTrigger[] => a.notifyOn ?? [...NOTIFY_TRIGGERS];

/** Which kind of news a feedback event is. */
export function triggerOf(e: { type: EventType; data?: Record<string, unknown> }): NotifyTrigger {
  switch (e.type) {
    case "accepted":
    case "group_partial":
      return "accepted";
    case "rejected":
    case "repeat_rejected":
    case "group_broken":
      return "rejected";
    case "revision_requested":
      return "revision";
    case "reopened":
      return e.data?.was === "accepted" ? "accepted" : e.data?.was === "rejected" ? "rejected" : "document";
    case "stale":
      return "document";
    default:
      return "comment"; // comment, note_comment, note_resolved, note_reopened
  }
}

export const GROUP_KINDS = ["atomic", "linked", "related"] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];
export const isGroupKind = (s: string): s is GroupKind => (GROUP_KINDS as readonly string[]).includes(s);
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
  /** Stet's own remark on the round, for the reviewer (a very large submit). */
  stetNote?: string;
}

export type ItemKind = "modify" | "add-file" | "delete-file" | "rename-file" | "binary";

export const ITEM_STATUSES = ["pending", "needs_revision", "accepted", "rejected", "withdrawn", "superseded", "stale"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
/** Decided against: a linked group with such members is broken. */
export const DROPPED_STATUSES: readonly ItemStatus[] = ["rejected", "withdrawn", "stale"];

export const LIVE_STATUSES: readonly ItemStatus[] = ["pending", "needs_revision"];
export const isLive = (s: ItemStatus) => LIVE_STATUSES.includes(s);
/** Whether a change is still to be decided: pending, or waiting for the agent's revision. */
export const isLiveItem = (it: Pick<Item, "status">): boolean => isLive(it.status);
/** The changes of round `round` (a changeset id) still to be decided. */
export const pendingInRound = <T extends Pick<Item, "changeset" | "status">>(items: readonly T[], round: string): T[] =>
  items.filter((i) => i.changeset === round && isLive(i.status));

export interface ThreadEntry {
  at: string;
  author: "user" | "agent";
  text: string;
}

/**
 * One status change of an item. `decision`: the reviewer's accept or reject this came from, shared
 * by everything it decided (undone together). `staleBy`: the accepted item whose accept made this
 * one stale, so undoing that accept makes it pending again.
 */
export interface HistoryEntry {
  at: string;
  status: ItemStatus;
  by: "user" | "agent" | "stet";
  note?: string;
  decision?: string;
  staleBy?: string;
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
  /**
   * For binary items that are text with bytes that aren't UTF-8: the text, those bytes shown as
   * ⟨0xFF⟩, for review only (accepting writes the blob byte for byte). Security report 5e4c6af, S7.
   */
  shownText?: { old: string | null; new: string | null };
  context: { before: string; after: string };
  fingerprint: string;
  note: string | null;
  groups: string[];
  status: ItemStatus;
  resolution: {
    appliedText: string;
    edited: boolean;
    /** The commit on the main branch that holds it; null while it is only in the working copy. */
    committed: string | null;
    /** That commit holds your own version of the change (you edited it before committing by hand), not the change as accepted. */
    committedWithEdits?: true;
    /**
     * The file's blob in main HEAD when the item was accepted (null: absent). Once HEAD's file
     * differs, the user has committed it, with this change or their later edits of it.
     * Missing for items accepted before 0.6.1 (and after an interrupted accept).
     */
    headBlob?: string | null;
  } | null;
  supersedes: string | null;
  conflictsWith: string[];
  history: HistoryEntry[];
  thread: ThreadEntry[];
  /** Part of a move (spec §6.4.7), on every item of it: they are accepted or rejected together. */
  move?: MoveInfo;
  /**
   * The reviewer's last attempt to accept it failed (it could not be applied). Rejecting it then
   * says nothing about the change itself, so it does not count for repeat detection.
   */
  acceptFailed?: { at: string; reason: string };
  /**
   * The reviewer's own wording for a pending change, written in the file's review document: still
   * pending, and used when they accept it (as "Edit and accept" does). Absent: the agent's text.
   */
  draft?: string;
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
export const moveOthers = (it: Pick<Item, "id" | "move">): string[] => (it.move ? [...moveFrom(it.move), ...moveTo(it.move)].filter((i) => i !== it.id) : []);

/**
 * Whether Stet can undo the decision on a change: a rejection, a revision request, or an accept
 * not committed yet. A committed accept is in git's history; it is reverted with git.
 */
export const canUndo = (it: Pick<Item, "status" | "resolution">): boolean =>
  it.status === "rejected" || it.status === "needs_revision" || (it.status === "accepted" && !!it.resolution && !it.resolution.committed);

/** Items and groups by id, from the store or from a snapshot of it. */
export interface Lookup {
  item(id: string): Item | undefined;
  group(id: string): Group | undefined;
}

/**
 * The pending changes that are decided together with `ids`, not counting `ids`: the other ends of
 * their moves (part of a move alone drops or doubles the passage), and the rest of the linked
 * group, or of its part, of each of them (accepting part of a linked group can break the
 * document). Core refuses to decide `ids` without them unless told to; the front ends ask first.
 */
export function linkedRest(ids: readonly string[], look: Lookup): Item[] {
  const given = new Set(ids.map((i) => i.toUpperCase()));
  const live = (id: string) => {
    const it = look.item(id);
    return it && isLive(it.status) ? it : undefined;
  };
  // The changes themselves with the other ends of their moves, then their linked units.
  const unit = new Map<string, Item>();
  for (const id of given) {
    const it = look.item(id);
    if (!it) continue;
    unit.set(it.id, it);
    for (const o of moveOthers(it)) {
      const oi = live(o);
      if (oi) unit.set(oi.id, oi);
    }
  }
  const out = new Map<string, Item>();
  for (const it of unit.values()) {
    out.set(it.id, it);
    for (const gid of it.groups) {
      const g = look.group(gid);
      if (g?.kind !== "linked") continue;
      for (const m of linkedUnit(g, it.id)) {
        const mi = live(m);
        if (mi) out.set(mi.id, mi);
      }
    }
    for (const o of moveOthers(it)) {
      const oi = live(o);
      if (oi) out.set(oi.id, oi);
    }
  }
  return [...out.values()].filter((i) => !given.has(i.id.toUpperCase()) && isLive(i.status)).sort((a, b) => compareItemIds(a.id, b.id));
}

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

/** What an id names, as the reviewer types it: ids are case-insensitive and come back upper-case (items as they are). */
export type ParsedId =
  | { kind: "item"; id: string }
  | { kind: "group"; id: string }
  | { kind: "part"; id: string; group: string; index: number }
  | { kind: "round"; id: string }
  | { kind: "note"; id: string };

/**
 * G3 a group, G3.2 its second part, C12 a round (changeset), N4 a note; anything else is taken
 * for a change (12.3), which the store then finds or not.
 */
export function parseId(raw: string): ParsedId {
  const id = raw.trim();
  const up = id.toUpperCase();
  const part = parsePartId(id);
  if (part) return { kind: "part", id: up, ...part };
  if (/^G\d+$/.test(up)) return { kind: "group", id: up };
  if (/^C\d+$/.test(up)) return { kind: "round", id: up };
  if (isNoteId(id)) return { kind: "note", id: up };
  return { kind: "item", id };
}

/** An item as events describe it: where it is, and its text (cut at 400 characters). */
export interface ItemBrief {
  id: string;
  file: string;
  line: number;
  kind: ItemKind;
  oldText: string;
  newText: string;
}

/** A part of a linked group in a `group_partial` event, and how it was decided. */
export interface PartOutcome {
  id: string;
  title: string;
  outcome: ItemStatus;
  items: string[];
}

/** What an event is about, by its type. */
export type EventPayload =
  | { type: "items_submitted"; data: { changeset: string } }
  | { type: "accepted"; data: { item: ItemBrief; finalText?: string } }
  /** `acceptFailed`: why the reviewer's attempt to accept it failed, when they rejected it after that. */
  | { type: "rejected"; data: { item: ItemBrief; reason?: string; acceptFailed?: string } }
  | { type: "revision_requested"; data: { item: ItemBrief; comment: string } }
  /** The reviewer ("comment") or the agent ("reply") wrote in an item's thread. */
  | { type: "comment" | "reply"; data: { item: ItemBrief; text: string } }
  | { type: "stale"; data: { item: ItemBrief; reason: string; currentText?: string } }
  /** `previous`: the history note of the rejection it repeats. */
  | { type: "repeat_rejected"; data: { item: ItemBrief; previous?: string } }
  | { type: "group_broken"; data: { title: string; members: { id: string; status: ItemStatus; file: string }[] } }
  | { type: "group_partial"; data: { title: string; parts: PartOutcome[] } }
  | { type: "withdrawn"; data: { reason?: string } }
  /** Written by older versions only. */
  | { type: "superseded"; data?: Record<string, unknown> }
  | { type: "synced"; data: { base: string; stale: string[] } }
  | { type: "archived"; data: { worktreeRemoved: boolean } }
  | { type: "note_added" | "note_resolved" | "note_reopened"; data: { note: string; file: string } }
  /** The reviewer ("note_comment") or the agent ("note_reply") wrote in a delivered note's thread. */
  | { type: "note_comment" | "note_reply"; data: { note: string; file: string; text: string } }
  /** The reviewer undid a decision: the item is pending again. `was`: its status before. */
  | { type: "reopened"; data: { item: ItemBrief; was: ItemStatus } };

export type EventType = EventPayload["type"];

/** An event as written: its payload, and what it concerns. */
export type NewEvent = EventPayload & { agent: string; items?: string[]; group?: string };

/** An event in the store's log (`events.jsonl`). */
export type StetEvent = NewEvent & { seq: number; at: string };

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
  "note_reopened",
  "reopened",
];

export interface StoreState {
  schema: 1;
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
  /**
   * The user's saved files as of their last *Share my edits*, on top of main at `head`; `at`
   * (since 0.6.1) tells which accepted items it already holds.
   */
  shared?: { head: string; tree: string; at?: string } | null;
  /** The main branch's commit at the last check for accepted changes whose commit was dropped (`git reset`). */
  mainHead?: string;
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

/**
 * An item as stored by an older Stet, in today's shape: a commit made by hand was kept as
 * `external:<commit>`, and an item made stale by an accept said so only in its history note.
 * The store applies it to every item it reads.
 */
export function upgradeItem(it: Item): Item {
  const r = it.resolution;
  if (r?.committed?.startsWith("external:")) {
    r.committed = r.committed.slice("external:".length);
    r.committedWithEdits = true;
  }
  for (const h of it.history ?? []) {
    const by = h.status === "stale" && !h.staleBy ? h.note?.match(/^overlaps accepted (\S+)$/)?.[1] : undefined;
    if (by) h.staleBy = by;
  }
  return it;
}
