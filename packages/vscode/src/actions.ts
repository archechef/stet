/**
 * The actions on a change, in one place: their names, icons, keys and order. The CodeLens, the
 * hover, the More… list and the editor's Quick Fix menu (Ctrl+.) all take them from here, so a
 * change offers the same actions under the same names wherever you meet it.
 */
import { canUndo, type Item, isLiveItem, type LanguageProfile, movesOut, oneLine, plural, profileHasPreview } from "@stet/core";
import type { Ref, TreeModel } from "./model.js";
import { linkTitle } from "./text.js";

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
 * The links under a change's hover: each action's command link, its detail as the link's tooltip,
 * kept to one line and escaped so that text from an agent in it can't end the link or add one.
 */
export function actionRow(actions: readonly ChangeAction[]): string {
  const link = (a: ChangeAction) => `command:${a.command}?${encodeURIComponent(JSON.stringify(a.args))}`;
  return actions.map((a) => `[${withIcon(a)}](${link(a)}${a.detail ? ` "${linkTitle(a.detail)}"` : ""})`).join(" · ");
}

/** One answer to "what to accept with this change": the changes it takes, and whether that breaks a linked group. */
export interface AcceptChoice {
  label: string;
  detail: string;
  ids: string[];
  overrideLinked: boolean;
}

/**
 * What Accept asks when `item` is in a linked group with other pending changes: its part (or the
 * group's linked changes), the whole group, or this change only, the recommended one first. Null
 * when there is nothing to ask (a change alone, or a move: its halves always go together). Every
 * Accept of such a change asks, wherever it is clicked: one click on a label's part used to leave
 * its \refs dangling, and Edit & accept took 57 changes along unasked.
 */
export function acceptQuestion(model: TreeModel, item: Item): { title: string; choices: AcceptChoice[] } | null {
  const own = model.withMove(item);
  const unit = [...own, ...model.linkedRest(own).map((i) => i.id)];
  const g = model.linkedGroup(item);
  const others = g
    ? model
        .members(g)
        .filter((m) => isLiveItem(m) && !unit.includes(m.id))
        .map((m) => m.id)
    : [];
  if (unit.length === own.length && !others.length) return null;
  const part = model.partOf(item);
  const n = (k: number) => `${plural(k, "change")}`;
  const choices: AcceptChoice[] = [];
  // One set of phrases wherever Accept is offered: "Accept part 1 of 2",
  // "Accept all of G1", "Accept only 1.10 (breaks G1)".
  if (unit.length > own.length) {
    choices.push({
      label: part
        ? `${partPhrase(part)} (${n(unit.length)})`
        : g && !others.length
          ? `Accept all of ${g.id} (${n(unit.length)})`
          : `Accept the whole move (${n(unit.length)})`,
      detail: `${unit.join(", ")} go together.${others.length ? ` The other parts of ${g!.id} stay pending.` : ""}`,
      ids: unit,
      overrideLinked: false,
    });
  }
  if (g && others.length) {
    choices.push({
      label: `Accept all of ${g.id} (${n(unit.length + others.length)})`,
      detail: `“${oneLine(g.title, 80)}”, every part at once.`,
      ids: [...unit, ...others],
      overrideLinked: false,
    });
  }
  const breaks = unit.length > own.length;
  choices.push({
    label: breaks
      ? `Accept only ${own.join(" + ")} (breaks ${g?.id ?? "the move"})`
      : `Accept only ${own.join(" + ")}${part ? ` (${partPhrase(part).replace(/^Accept /, "")})` : ""}`,
    detail: breaks
      ? onlyDetail(model.profile(item.file))
      : `The other parts of ${g!.id} stay pending: the document is inconsistent until they are accepted too.`,
    ids: own,
    overrideLinked: breaks,
  });
  const linked = [...unit, ...others].filter((id) => !own.includes(id));
  return {
    title: `${own.join(" + ")} ${own.length > 1 ? "are" : "is"} linked with ${linked.join(", ")} (${g?.id ?? "a move"} “${oneLine(g?.title ?? "", 80)}”)`,
    choices,
  };
}

/** "Accept part 1 of 2 “title”". */
function partPhrase(part: { group: { parts?: { title: string }[] | undefined }; index: number }): string {
  return `Accept part ${part.index + 1} of ${part.group.parts!.length} “${oneLine(part.group.parts![part.index]!.title, 80)}”`;
}

/** What accepting only a linked change does: breaks its group, and in Typst the build. */
function onlyDetail(profile: LanguageProfile): string {
  const strict = !!profile.references?.strict;
  return `Breaks the linked group; the agent is asked to repair the document${strict ? ". Until then it may not compile" : ""}.`;
}

/**
 * Accept, as the change must be decided: a change alone, a move with its other half, or a linked
 * change, which asks what to take along (`acceptQuestion`). The label says which.
 */
export function acceptAction(model: TreeModel, mainPath: string, item: Item): ChangeAction {
  const ref = (id: string): Ref => ({ path: mainPath, id });
  const base = { icon: "check", key: "a", tier: "decide" as const, command: "stet.accept", args: [ref(item.id)] };
  const q = acceptQuestion(model, item);
  if (!q) {
    return item.move
      ? { ...base, label: "Accept move", detail: "Removes the passage from its old place and inserts it at the new one." }
      : { ...base, label: "Accept", detail: "Applies the change to your file." };
  }
  const part = model.partOf(item);
  const g = model.linkedGroup(item);
  const first = q.choices[0]!;
  const label = part
    ? `${partPhrase(part).replace(/ “.*”$/, "")}…`
    : first.ids.length > 1 && !first.overrideLinked
      ? g
        ? `Accept all of ${g.id}…`
        : "Accept move…"
      : "Accept…";
  return { ...base, label, detail: `${q.title}: asks which to accept.` };
}

/** Every action on `item`, in the order they're shown everywhere. */
export function changeActions(model: TreeModel, mainPath: string, item: Item, opts: { previews?: boolean; lost?: boolean } = {}): ChangeAction[] {
  const ref = (id: string): Ref => ({ path: mainPath, id });
  const r = [ref(item.id)];
  const out: ChangeAction[] = [];
  const live = isLiveItem(item);
  const modify = item.kind === "modify";
  if (live) {
    const accept = acceptAction(model, mainPath, item);
    out.push(accept);
    if (acceptQuestion(model, item)?.choices.some((c) => c.overrideLinked)) {
      out.push({
        label: `Accept only ${item.id} (breaks ${model.linkedGroup(item)?.id ?? "the move"})`,
        icon: "check",
        command: "stet.acceptOnly",
        args: r,
        tier: "decide",
        detail: onlyDetail(model.profile(item.file)),
      });
    }
    out.push({
      label: item.move ? "Reject move…" : "Reject…",
      icon: "close",
      key: "r",
      command: "stet.reject",
      args: r,
      tier: "decide",
      detail: "With an optional reason, which the agent gets.",
    });
    if (modify && !item.move)
      out.push({
        label: "Edit & accept…",
        icon: "edit",
        key: "e",
        command: "stet.edit",
        args: r,
        tier: "decide",
        detail: "Change the wording, then accept it. The agent sees your version.",
      });
    out.push({
      label: "Revise…",
      icon: "sync",
      key: "v",
      command: "stet.revise",
      args: r,
      tier: "decide",
      detail: "Tell the agent what to change; the change stays open until it resubmits.",
    });
    // Can't be found in your file: accepting can't work, so Reject and Revise come first.
    if (opts.lost) {
      const first = (label: string) => out.findIndex((a) => a.label.startsWith(label));
      const pick = [first("Reject"), first("Revise")].map((k) => out[k]!);
      for (const a of pick) out.splice(out.indexOf(a), 1);
      out.unshift(...pick);
      for (const a of out)
        if (a.label.startsWith("Accept") || a.label.startsWith("Edit & accept"))
          a.detail = `Can't work now: the change can't be found in your file. ${a.detail ?? ""}`.trim();
    }
  }
  out.push({
    label: "Comment…",
    icon: "comment",
    key: "c",
    command: "stet.comment",
    args: r,
    tier: "talk",
    detail: "A message about the change; the agent can reply.",
  });
  out.push({
    label: "Diff",
    icon: "diff",
    key: "d",
    command: "stet.showDiff",
    args: r,
    tier: "view",
    detail: "Your file with and without this change, side by side; edit the proposed side to change its wording.",
  });
  if (modify && profileHasPreview(model.profile(item.file), item.file) && opts.previews !== false) {
    out.push({
      label: "PDF preview",
      icon: "file-pdf",
      key: "p",
      command: "stet.preview",
      args: r,
      tier: "view",
      detail: "The compiled page with the change, after and before.",
    });
  }
  if (live && modify)
    out.push({
      label: "Review file",
      icon: "diff-multiple",
      key: "f",
      command: "stet.reviewFile",
      args: r,
      tier: "view",
      detail: "All pending changes of this file in one editable diff.",
    });
  if (item.move) {
    const other = model.others(item).find((o) => movesOut(o) !== movesOut(item));
    if (other)
      out.push({
        label: movesOut(item) ? "Go to destination" : "Go to source",
        icon: movesOut(item) ? "arrow-down" : "arrow-up",
        command: "stet.showItem",
        args: [ref(other.id)],
        tier: "view",
      });
  }
  if (live && item.draft !== undefined) {
    out.push({
      label: "Use agent's wording",
      icon: "discard",
      command: "stet.clearDraft",
      args: r,
      tier: "other",
      detail: "Drops the wording you gave it in Review file.",
    });
  }
  // A decided change whose decision Stet can still undo.
  if (!live && canUndo(item)) {
    out.push({
      label: "Undo",
      icon: "discard",
      key: "u",
      command: "stet.undo",
      args: r,
      tier: "other",
      detail: item.status === "accepted" ? "Takes the change out of your file; it is pending again." : "The change is pending again.",
    });
  }
  return out;
}
