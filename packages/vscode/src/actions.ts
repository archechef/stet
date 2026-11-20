/**
 * The actions on a change, in one place: their names, icons, keys and order. The CodeLens, the
 * hover, the More… list and the editor's Quick Fix menu (Ctrl+.) all take them from here, so a
 * change offers the same actions under the same names wherever you meet it.
 */
import { moveOthers, movesOut, partId, type Item } from "@stet/core";
import { isLive, type Ref, type TreeModel } from "./model.js";

export interface ChangeAction {
  /** Shown text, without icon. */
  label: string;
  /** A codicon name. */
  icon: string;
  command: string;
  args: unknown[];
  /** The key that does the same in the Stet panel. */
  key?: string;
  /** One line on what it does (the More… list). */
  detail?: string;
  /** Decide, talk, view, or other: where separators go. */
  tier: "decide" | "talk" | "view" | "other";
}

/** "$(check) Accept": an action's label with its icon, for CodeLens, hovers and lists. */
export const withIcon = (a: Pick<ChangeAction, "icon" | "label">): string => `$(${a.icon}) ${a.label}`;

/**
 * Accept, as the change must be decided: a change alone, a move with its other half, or a linked
 * change with its group (or its part of a large group). The label says which.
 */
export function acceptAction(model: TreeModel, mainPath: string, item: Item): ChangeAction {
  const ref = (id: string): Ref => ({ path: mainPath, id });
  const rest = model.linkedRest([item.id]);
  const base = { icon: "check", key: "a", tier: "decide" as const };
  if (item.move && rest.every((r) => moveOthers(item).includes(r.id))) {
    return { ...base, label: "Accept move", command: "stet.accept", args: [ref(item.id)], detail: "Removes the passage from its old place and inserts it at the new one." };
  }
  const part = model.partOf(item);
  const unit = part ? partId(part.group.id, part.index) : model.linkedGroup(item)?.id;
  if (!rest.length || !unit) return { ...base, label: "Accept", command: "stet.accept", args: [ref(item.id)], detail: "Applies the change to your file." };
  const n = rest.length + 1;
  return {
    ...base,
    label: part ? `Accept part ${part.index + 1} of ${part.group.parts!.length} (${n} changes)` : `Accept all ${n} linked`,
    command: "stet.acceptGroup",
    args: [ref(unit)],
    detail: `${[item.id, ...rest.map((r) => r.id)].join(", ")} belong together: accepting only some would break the document.`,
  };
}

/** Every action on `item`, in the order they're shown everywhere. */
export function changeActions(model: TreeModel, mainPath: string, item: Item, opts: { previews?: boolean } = {}): ChangeAction[] {
  const ref = (id: string): Ref => ({ path: mainPath, id });
  const r = [ref(item.id)];
  const out: ChangeAction[] = [];
  const live = isLive(item);
  const modify = item.kind === "modify";
  if (live) {
    const accept = acceptAction(model, mainPath, item);
    out.push(accept);
    if (accept.command === "stet.acceptGroup") {
      out.push({ label: `Accept only ${item.id}`, icon: "check", command: "stet.acceptOnly", args: r, tier: "decide", detail: "Breaks the linked group; the agent is asked to repair the document." });
    }
    out.push({ label: item.move ? "Reject move…" : "Reject…", icon: "close", key: "r", command: "stet.reject", args: r, tier: "decide", detail: "With an optional reason, which the agent gets." });
    if (modify && !item.move) out.push({ label: "Edit & accept…", icon: "edit", key: "e", command: "stet.edit", args: r, tier: "decide", detail: "Change the wording, then accept it. The agent sees your version." });
    out.push({ label: "Revise…", icon: "sync", key: "v", command: "stet.revise", args: r, tier: "decide", detail: "Tell the agent what to change; the change stays open until it resubmits." });
  }
  out.push({ label: "Comment…", icon: "comment", key: "c", command: "stet.comment", args: r, tier: "talk", detail: "A message about the change; the agent can reply." });
  out.push({ label: "Diff", icon: "diff", key: "d", command: "stet.showDiff", args: r, tier: "view", detail: "Your file with and without this change, side by side; edit the proposed side to change its wording." });
  if (modify && /\.tex$/i.test(item.file) && opts.previews !== false) {
    out.push({ label: "PDF preview", icon: "file-pdf", key: "p", command: "stet.preview", args: r, tier: "view", detail: "The compiled page with the change, after and before." });
  }
  if (live && modify) out.push({ label: "Review file", icon: "diff-multiple", key: "f", command: "stet.reviewFile", args: r, tier: "view", detail: "All pending changes of this file in one editable diff." });
  if (item.move) {
    const other = model.others(item).find((o) => movesOut(o) !== movesOut(item));
    if (other) out.push({ label: movesOut(item) ? "Go to destination" : "Go to source", icon: movesOut(item) ? "arrow-down" : "arrow-up", command: "stet.showItem", args: [ref(other.id)], tier: "view" });
  }
  if (live && item.draft !== undefined) {
    out.push({ label: "Use agent's wording", icon: "discard", command: "stet.clearDraft", args: r, tier: "other", detail: "Drops the wording you gave it in Review file." });
  }
  // Undoable: a rejection, or an accept not committed yet.
  if (item.status === "rejected" || (item.status === "accepted" && !!item.resolution && !item.resolution.committed)) {
    out.push({ label: "Undo", icon: "discard", key: "u", command: "stet.undo", args: r, tier: "other", detail: item.status === "accepted" ? "Takes the change out of your file; it is pending again." : "The change is pending again." });
  }
  return out;
}
