/**
 * Checks of the records read from the store (`.git/stet/{items,groups,agents,changesets,notes}`).
 * A file that parses but lacks a field the code relies on, or holds one of the wrong type (edited by
 * hand, cut short, written by another program), would otherwise fail far from where it was read,
 * or pass a wrong value along. Only fields every Stet version has written are required, so older
 * stores pass; fields added since are optional and checked when present.
 */
import { AGENT_KINDS, GROUP_KINDS, ITEM_STATUSES } from "./model.js";

/** What is wrong with a value: the path of the field, or null when it is fine. */
type Check = (v: unknown, at: string) => string | null;

const is =
  (test: (v: unknown) => boolean, what: string): Check =>
  (v, at) =>
    test(v) ? null : `${at || "record"}: not ${what}`;

const str = is((v) => typeof v === "string", "text");
const bool = is((v) => typeof v === "boolean", "true or false");
const int = is((v) => Number.isInteger(v), "a whole number");
const oneOf = (values: readonly unknown[]) => is((v) => values.includes(v), `one of ${values.join(", ")}`);
const or =
  (a: Check, b: Check): Check =>
  (v, at) =>
    a(v, at) && b(v, at);
const nil = is((v) => v === null, "null");
const orNull = (c: Check) => or(nil, c);
const list =
  (c: Check): Check =>
  (v, at) => {
    if (!Array.isArray(v)) return `${at}: not a list`;
    for (let i = 0; i < v.length; i++) {
      const p = c(v[i], `${at}[${i}]`);
      if (p) return p;
    }
    return null;
  };

/** An object with `required` fields and, when present, `optional` ones. */
const shape =
  (required: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
  (v, at) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return `${at || "record"}: not an object`;
    const o = v as Record<string, unknown>;
    const field = (k: string) => (at ? `${at}.${k}` : k);
    for (const [k, c] of Object.entries(required)) {
      const p = k in o ? c(o[k], field(k)) : `${field(k)}: missing`;
      if (p) return p;
    }
    for (const [k, c] of Object.entries(optional)) {
      const p = o[k] !== undefined ? c(o[k], field(k)) : null;
      if (p) return p;
    }
    return null;
  };

const range = shape({ start: int, end: int });
const context = shape({ before: str, after: str });
const thread = list(shape({ at: str, author: oneOf(["user", "agent"]), text: str }));
const ids = list(str);

const ITEM = shape(
  {
    id: str,
    agent: str,
    changeset: str,
    file: str,
    kind: oneOf(["modify", "add-file", "delete-file", "rename-file", "binary"]),
    baseCommit: str,
    range,
    oldText: str,
    newText: str,
    context,
    fingerprint: str,
    note: orNull(str),
    groups: ids,
    status: oneOf(ITEM_STATUSES),
    resolution: orNull(shape({ appliedText: str, edited: bool, committed: orNull(str) }, { headBlob: orNull(str) })),
    supersedes: orNull(str),
    conflictsWith: ids,
    history: list(shape({ at: str, status: oneOf(ITEM_STATUSES), by: oneOf(["user", "agent", "stet"]) }, { note: str, decision: str, staleBy: str })),
    thread,
  },
  { oldFile: str, oldBlob: orNull(str), newBlob: orNull(str), shownText: shape({ old: orNull(str), new: orNull(str) }), draft: str },
);

const GROUP = shape(
  {
    id: str,
    agent: str,
    changeset: str,
    kind: oneOf(GROUP_KINDS),
    title: str,
    rationale: orNull(str),
    source: oneOf(["agent", "commit", "auto"]),
    items: ids,
    state: oneOf(["open", "resolved", "broken"]),
  },
  { parts: list(shape({ title: str, items: ids })) },
);

const AGENT = shape({
  id: str,
  kind: oneOf(AGENT_KINDS),
  branch: str,
  worktree: str,
  baseCommit: str,
  lastTip: str,
  replayedAt: str,
  feedbackCursor: int,
  createdAt: str,
  state: oneOf(["active", "archived"]),
});

const CHANGESET = shape({ id: str, agent: str, title: str, rationale: str, submittedAt: str, items: ids, groups: ids });

const NOTE = shape({
  id: str,
  agent: str,
  file: str,
  text: str,
  range,
  context,
  body: str,
  createdAt: str,
  state: oneOf(["open", "resolved"]),
  deliveredAt: orNull(str),
  thread,
});

export type RecordKind = "agents" | "changesets" | "groups" | "items" | "notes";

const CHECKS: Record<RecordKind, Check> = { items: ITEM, groups: GROUP, agents: AGENT, changesets: CHANGESET, notes: NOTE };

/** What is wrong with a record of `kind` as read from disk ("range.end: not a whole number"), or null. */
export const recordProblem = (kind: RecordKind, v: unknown): string | null => CHECKS[kind](v, "");
