/** Test data shared by the unit tests. */
import type { Item } from "@stet/core";

/** A pending change in group G1: “old” → “new” at the start of main.tex. */
export const makeItem = (id: string, extra: Partial<Item> = {}): Item => ({
  id,
  agent: "a",
  changeset: "C1",
  file: "main.tex",
  kind: "modify",
  baseCommit: "b",
  range: { start: 0, end: 1 },
  oldText: "old",
  newText: "new",
  context: { before: "", after: "" },
  fingerprint: "",
  note: null,
  groups: ["G1"],
  status: "pending",
  resolution: null,
  supersedes: null,
  conflictsWith: [],
  history: [],
  thread: [],
  ...extra,
});

/** The same, in main.typ and in no group. */
export const makeTypItem = (id: string, extra: Partial<Item> = {}): Item => makeItem(id, { file: "main.typ", groups: [], ...extra });
