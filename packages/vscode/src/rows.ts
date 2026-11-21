/** What the panel's rows say: labels, descriptions, spoken text and menus. No `vscode` import. */
import {
  type Changeset,
  canUndo,
  changeSummary,
  type Group,
  hasPreview,
  type Item,
  isAccepted,
  isLiveItem,
  itemEffect,
  moveChangesOf,
  moveFrom,
  movesOut,
  moveTo,
  NOTIFY_TRIGGER_TEXT,
  NOTIFY_TRIGGERS,
  notifyMode,
  notifyTriggers,
  numberInRound,
  oneLine,
  paragraphChange,
  partId,
  plural,
  profileByName,
  roundOf,
  spokenChange,
  summaryTexts,
} from "@stet/core";
import { NOTIFY_PICKS } from "./common.js";
import { itemMarkdown } from "./markdown.js";
import { behindAgents, type Node, type TreeModel } from "./model.js";
import { esc, fence, fitLabel, STATUS_TEXT } from "./text.js";

/** How a change is numbered in the panel: 3 for 12.3 (its round shows 12), the full id for old ones. */
export const shortId = (id: string): string => String(numberInRound(id) ?? id);

/** Words a list of move changes touches (the longer side of each). */
const changedCount = (cs: { was: string; now: string }[]) => cs.reduce((n, c) => n + Math.max(words(c.was), words(c.now)), 0);

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Title of a change's More… list: its id, then its label without the number again ("1.1: 1 …"). */
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
        const [o, nw] = changeSummary(...summaryTexts(it), it.oldText && it.newText ? 28 : 50);
        const breaks = paragraphChange(it.oldText, it.newText);
        const revises = (breaks ? `  · ${breaks}` : "") + (it.supersedes ? `  · revises ${it.supersedes}` : "");
        if (!it.oldText) return `${n}  + “${nw}”${revises}`;
        if (!it.newText) return `${n}  − “${o}”${revises}`;
        return `${n}  “${o}” → “${nw}”${revises}`;
      }
  }
}

/** Label of a round (changeset): its number and the agent's title. */
export const roundLabel = (cs: Changeset): string => `Round ${roundOf(cs.id)}: ${fitLabel(cs.title, 40)}`;

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

/** "💬 3 (1 new)", for a row's description; "" without messages. */
export function threadText(count: number, unread: number): string {
  return count ? `💬 ${count}${unread ? ` (${unread} new)` : ""}` : "";
}

/**
 * A change as a screen reader reads it: what, where and its state in words, with no symbols or
 * colour (decorations aren't read).
 */
export function itemSpoken(it: Item, line?: number, unread = 0): string {
  const where = `in ${it.file}${line && it.kind === "modify" ? ` line ${line}` : ""}`;
  // As the row says it: "revision requested", your wording,
  // the conversation.
  const extra = [
    ...(it.draft !== undefined && isLiveItem(it) ? ["your wording"] : []),
    ...(it.thread.length ? [`${plural(it.thread.length, "message")}${unread ? `, ${unread} new` : ""}`] : []),
  ];
  const state = [STATUS_TEXT[it.status], ...extra].join(", ");
  if (it.kind !== "modify") return `Change ${it.id}, ${it.kind.replace("-", " ")} ${where}, ${state}`;
  // What it says: your wording if you have one, or the text it was accepted with.
  const text = isAccepted(it) ? it.resolution.appliedText : isLiveItem(it) ? (it.draft ?? it.newText) : it.newText;
  const [o, n] = changeSummary(it.oldText, text, 60);
  const breaks = paragraphChange(it.oldText, text);
  const what = breaks
    ? `${breaks}, “${o}” to “${n}”`
    : (spokenChange(it.oldText, text, profileByName(it.file).spoken) ??
      (!it.oldText ? `insert “${n}”` : !text ? `delete “${o}”` : `replace “${o}” with “${n}”`));
  return `Change ${it.id}, ${what}, ${where}, ${state}${it.supersedes ? `, revises ${it.supersedes}` : ""}`;
}

/** A change that can't be found in your file any more: what its row and hover say, and what to do. */
export const LOST_TEXT = "can't be found in your file";

export const LOST_NEXT =
  "You edited this text or the text around it since it was proposed, so Stet can't tell where it goes. Reject it, or ask the agent for a revision against your current text.";

/**
 * A change's row in the panel: its label, the line under it, what a screen reader says, and its
 * `contextValue` (see `contextValueOf`).
 * `found`: Stet located it in your file; `history`: shown in History, where that doesn't matter.
 */
export function itemRow(
  it: Item,
  model: TreeModel,
  place: { line: number; found: boolean },
  opts: { history: boolean; unread: number },
): { label: string; description: string; spoken: string; lost: boolean; contextValue: string } {
  const lost = !place.found && !opts.history;
  const description =
    `${lost ? "⚠ not found in " : ""}${it.file}${it.kind === "modify" && !lost ? `:${place.line}` : ""}` +
    `${it.status === "pending" ? "" : ` · ${STATUS_TEXT[it.status]}`}${it.draft !== undefined && isLiveItem(it) ? " · your wording" : ""}` +
    `${itemEffect(it) ? " · ⚠ takes effect" : ""}${it.thread.length ? ` · ${threadText(it.thread.length, opts.unread)}` : ""}`;
  return {
    label: itemLabel(it, model.get),
    description,
    spoken: itemSpoken(it, lost ? undefined : place.line, opts.unread) + (lost ? `, ${LOST_TEXT}` : ""),
    lost,
    contextValue: contextValueOf({ type: "item", item: it, parent: "" }, model),
  };
}

/**
 * The status bar item: counts as icons, and the same in words for its tooltip and for screen
 * readers, which would read the icons' numbers alone as "3 2".
 */
export function statusView(s: {
  pending: number;
  unread: number;
  uncommitted: number;
  /** Agents behind your latest text. */
  behind: string[];
  /** Projects whose saved edits agents don't see (named when there are several). */
  unshared: string[];
  missing: { id: string; reason: string }[];
  /** Each project's counts, when the window has several. */
  projects: { name: string; pending: number; uncommitted: number }[];
}): { text: string; tooltip: string; spoken: string } {
  const text =
    `$(checklist) ${s.pending}` +
    (s.unread ? ` $(comment-unresolved) ${s.unread}` : "") +
    (s.uncommitted ? ` $(git-commit) ${s.uncommitted}` : "") +
    (s.behind.length ? " $(sync)" : "") +
    (s.unshared.length ? " $(cloud-upload)" : "") +
    (s.missing.length ? " $(warning)" : "");
  const tip = [`Stet: ${plural(s.pending, "change")} to review`];
  if (s.unread) tip.push(`${s.unread} new repl${s.unread === 1 ? "y" : "ies"} from agents (marked in the panel; read when you go to the change or note)`);
  if (s.projects.length > 1) {
    for (const p of s.projects) tip.push(`  ${p.name}: ${p.pending} to review${p.uncommitted ? `, ${p.uncommitted} to commit` : ""}`);
  }
  if (s.uncommitted) tip.push(`${s.uncommitted} accepted, not committed yet (Finish review)`);
  if (s.unshared.length) tip.push(`Agents don't see your latest saved edits${s.projects.length > 1 ? ` in ${s.unshared.join(", ")}` : ""} (Share my edits)`);
  if (s.behind.length) tip.push(`Behind your latest text: ${s.behind.join(", ")}. Agents catch up the next time they sync with your text.`);
  for (const m of s.missing) tip.push(`Agents don't get accepted ${m.id}: ${m.reason}. Finish the review or share your edits.`);
  return { text, tooltip: tip.join("\n"), spoken: tip.join(". ") };
}

/**
 * A row's `contextValue`, which the `when` clauses of the panel's menus in `package.json` match
 * (`test/menus.test.ts` checks every clause against these):
 * - `agent.active.notify-<now|batched|off>`, `agent.archived`
 * - `note.open`, `note.resolved`
 * - `changeset.live`, `changeset.done` (live: it has changes waiting)
 * - `group.live.<kind>`, `group.done.<kind>` (kind: linked, related, atomic)
 * - `part.live`, `part.done`
 * - `item.live.<kind>[.pdf]`, `item.done.<kind>[.pdf][.undo]` (kind: the item's; `.pdf`: it has a
 *   PDF preview; `.undo`: its decision can still be undone)
 */
export function contextValueOf(node: Node, model: TreeModel): string {
  switch (node.type) {
    case "agent":
      return node.agent.state === "active" ? `agent.active.notify-${notifyMode(node.agent)}` : "agent.archived";
    case "note":
      return node.note.state === "resolved" ? "note.resolved" : "note.open";
    case "changeset":
      return model.liveCount((i) => i.changeset === node.changeset.id) ? "changeset.live" : "changeset.done";
    case "group":
      return `group.${model.members(node.group).some(isLiveItem) ? "live" : "done"}.${node.group.kind}`;
    case "part":
      return model.partMembers(node.group, node.index).some(isLiveItem) ? "part.live" : "part.done";
    case "item": {
      const it = node.item;
      // ".pdf": the change has a PDF preview (not in a Typst file).
      const pdf = it.kind === "modify" && hasPreview(it.file) ? ".pdf" : "";
      return isLiveItem(it) ? `item.live.${it.kind}${pdf}` : `item.done.${it.kind}${pdf}${canUndo(it) ? ".undo" : ""}`;
    }
  }
}

/** A codicon, with a theme colour. */
export interface RowIcon {
  id: string;
  color?: string;
}

/** What a row of the Review panel or History shows: `ReviewTree` makes a `TreeItem` of it. */
export interface RowView {
  label: string;
  description: string;
  /** Markdown. */
  tooltip: string;
  icon: RowIcon;
  contextValue: string;
  expand: "none" | "expanded" | "collapsed";
  /** For screen readers, when the label and description don't say it in words. */
  spoken?: string;
}

/**
 * What the row of `node` shows. `history`: in History; `unread`: replies not read yet (its own, or
 * its agent's); `place`: where a change is in the working file (changes only).
 */
export function rowView(node: Node, model: TreeModel, f: { history: boolean; unread: number; place?: { line: number; found: boolean } }): RowView {
  const { history } = f;
  const snap = model.snap;
  const contextValue = contextValueOf(node, model);
  switch (node.type) {
    case "agent": {
      const a = node.agent;
      // An agent that hasn't proposed anything yet says what to do, not "0 pending".
      const fresh = !history && a.state === "active" && !snap.changesets.some((c) => c.agent === a.id);
      const parts = [history ? model.outcome((i) => i.agent === a.id) : fresh ? "no proposals yet" : model.openText((i) => i.agent === a.id)];
      const behind = behindAgents(snap).includes(a.id);
      if (behind) parts.push("behind your text");
      if (a.state === "archived") parts.push("archived");
      if (f.unread && !history) parts.push(`${f.unread} new repl${f.unread === 1 ? "y" : "ies"}`);
      const notify = notifyMode(a);
      if (a.state === "active" && notify === "off") parts.push("not notified");
      const triggers = notifyTriggers(a);
      const tooltip =
        `**${esc(a.id)}** (${a.kind})\n\nWorkspace: ${esc(a.worktree)}` +
        (fresh
          ? `\n\nOpen this folder in ${a.kind === "codex" ? "Codex" : a.kind === "claude-code" ? "the Claude desktop app (Code tab) or Claude Code" : "your agent"} and give it a task: its proposals appear here. *Open agent workspace…* (the folder button on the row) copies the path.`
          : "") +
        (behind ? "\n\nThe agent works on an older version of your text; it catches up the next time it syncs with your text." : "") +
        (a.state === "active"
          ? `\n\nNotifications: ${NOTIFY_PICKS.find((x) => x.mode === notify)!.label}` +
            (triggers.length < NOTIFY_TRIGGERS.length ? `, for ${triggers.map((t) => NOTIFY_TRIGGER_TEXT[t].toLowerCase()).join(", ") || "nothing"}` : "") +
            " (bell button). The megaphone wakes it now."
          : "");
      return {
        label: fitLabel(a.id, 28),
        description: parts.join(" · "),
        tooltip,
        icon: { id: a.kind === "codex" ? "terminal" : "hubot" },
        contextValue,
        expand: fresh && !model.children(node).length ? "none" : "expanded",
      };
    }
    case "note": {
      const nt = node.note;
      const replies = nt.thread.length ? ` · ${nt.thread.length} repl${nt.thread.length === 1 ? "y" : "ies"}${f.unread ? ` (${f.unread} new)` : ""}` : "";
      return {
        label: `${nt.id}  ${oneLine(nt.body, 50)}`,
        description: `${nt.file}${nt.deliveredAt ? "" : " · not delivered yet"}${replies}${nt.state === "resolved" ? " · resolved" : ""}`,
        tooltip:
          `**${nt.id}** note for ${esc(nt.agent)} on ${esc(nt.file)}${nt.deliveredAt ? "" : " (the agent receives it at its next sync)"}\n\n${esc(nt.body)}\n\n${fence(nt.text, profileByName(nt.file).fence)}` +
          nt.thread
            .slice(-3)
            .map((r) => `\n\n> **${r.author === "user" ? "You" : esc(nt.agent)}:** ${esc(r.text)}`)
            .join(""),
        icon: f.unread ? { id: "comment-unresolved", color: "notificationsInfoIcon.foreground" } : { id: "note" },
        contextValue,
        expand: "none",
      };
    }
    case "changeset": {
      const cs = node.changeset;
      return {
        label: roundLabel(cs),
        description: history ? model.outcome((i) => i.changeset === cs.id) : model.openText((i) => i.changeset === cs.id),
        tooltip: `**Round ${roundOf(cs.id)}** (${cs.id}) ${esc(cs.title)}\n\n${cs.stetNote ? `⚠ ${esc(cs.stetNote)}\n\n` : ""}${esc(cs.rationale)}\n\n*${new Date(cs.submittedAt).toLocaleString()}*`,
        icon: { id: "layers" },
        contextValue,
        // Old rounds stay closed in History, so it reads as a list of rounds.
        expand: history ? "collapsed" : "expanded",
      };
    }
    case "group": {
      const g = node.group;
      const move = model.isMove(g);
      return {
        label: groupLabel(g),
        description: groupDescription(g, model.members(g).length, move),
        tooltip:
          `**${g.id}** ${g.kind}${g.source === "auto" ? " (detected by Stet)" : ""}: ${esc(g.title)}` +
          (g.rationale ? `\n\n${esc(g.rationale)}` : "") +
          (g.kind === "linked"
            ? g.parts
              ? `\n\n${g.parts.length} parts: each can be accepted or rejected on its own; the changes within a part go together.`
              : "\n\nAccept or reject these together: accepting only some can break the document."
            : "") +
          (g.state === "broken" ? "\n\n⚠ Some members were resolved differently; the agent was asked to repair the document." : ""),
        icon:
          g.state === "broken"
            ? { id: "warning", color: "problemsWarningIcon.foreground" }
            : { id: move ? "arrow-swap" : g.kind === "linked" ? "link" : "symbol-namespace" },
        contextValue,
        expand: "expanded",
      };
    }
    case "part": {
      const g = node.group;
      const members = model.partMembers(g, node.index);
      return {
        label: partLabel(g, node.index),
        description: history ? model.outcome((i) => members.includes(i)) : `${members.length}`,
        tooltip:
          `**${partId(g.id, node.index)}** part ${node.index + 1} of ${g.parts?.length ?? 1} of ${g.id} “${esc(g.title)}”` +
          "\n\nAccept or reject this part on its own: the document still compiles without the other parts, " +
          "which stay acceptable. Its own changes go together.",
        icon: { id: "symbol-field" },
        contextValue,
        expand: "expanded",
      };
    }
    case "item": {
      const it = node.item;
      const row = itemRow(it, model, f.place ?? { line: 1, found: true }, { history, unread: f.unread });
      return {
        label: row.label,
        description: row.description,
        tooltip: (row.lost ? `⚠ **${LOST_TEXT}.** ${LOST_NEXT}\n\n` : "") + itemMarkdown(it, model),
        icon: row.lost
          ? { id: "warning", color: "problemsWarningIcon.foreground" }
          : f.unread
            ? { id: "comment-unresolved", color: "notificationsInfoIcon.foreground" }
            : itemIcon(it),
        contextValue,
        expand: "none",
        spoken: row.spoken,
      };
    }
  }
}

/** A change's icon by its status (and, while pending, its kind). */
function itemIcon(it: Item): RowIcon {
  switch (it.status) {
    case "pending":
      return {
        id: it.kind === "modify" ? "diff-modified" : it.kind === "add-file" ? "diff-added" : it.kind === "delete-file" ? "diff-removed" : "diff-renamed",
      };
    case "needs_revision":
      return { id: "sync", color: "problemsWarningIcon.foreground" };
    case "accepted":
      return { id: "check", color: "testing.iconPassed" };
    case "rejected":
      return { id: "close", color: "testing.iconFailed" };
    case "stale":
      return { id: "warning", color: "problemsWarningIcon.foreground" };
    default:
      return { id: "circle-slash" };
  }
}
