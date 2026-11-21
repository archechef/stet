/**
 * What there is to say about a change beyond its text, worked out once for every front end:
 * `stet show` renders it for the terminal, VS Code's hover as Markdown.
 */
import { itemEffect } from "./effects.js";
import { type Item, moveFrom, moveOthers, movesOut, moveTo } from "./model.js";
import { type MoveChange, moveChanges, moveTexts } from "./moves.js";
import { lineDiff } from "./text.js";

/** Lines of a whole file, or of a diff of one, shown before "… n more lines". */
export const SHOWN_LINES = 40;

/** The first `n` lines, and how many more there are. */
export function firstLines(lines: readonly string[], n = SHOWN_LINES): { shown: string[]; more: number } {
  return { shown: lines.slice(0, n), more: Math.max(0, lines.length - n) };
}

export interface ItemDescription {
  /** What the file does once accepted (a latexmkrc runs code, …); null for an ordinary file. */
  effect: string | null;
  /** The change this one revises, and the reviewer's last request there. */
  revises: { id: string; item: Item | undefined; asked: string | null } | null;
  /** The text your wording put in (`accepted`) or would put in; text changes only. */
  yours: { text: string; accepted: boolean } | null;
  /** Half of a move (spec §6.4.7), decided with its other half. */
  move: {
    from: string[];
    to: string[];
    /** This item removes the text (it doesn't insert it). */
    out: boolean;
    /** Files of the other items of the move, other than this one's. */
    otherFiles: string[];
    /** How many words changed on the way (0: word for word), and which; `changes` is empty when the other items are gone. */
    changed: number;
    changes: MoveChange[];
  } | null;
  /** The text of an added, deleted or renamed file, by lines (old and new side), for showing its first lines. */
  whole: { old: string[]; new: string[] } | null;
  /** A file that isn't UTF-8 text: its changed lines, the bytes that aren't UTF-8 shown as ⟨0x..⟩. */
  bytes: string[] | null;
}

/** `get` finds other items (what this one revises, the rest of its move); missing ones are left out. */
export function describeItem(item: Item, get: (id: string) => Item | undefined): ItemDescription {
  const prev = item.supersedes ? get(item.supersedes) : undefined;
  const asked = prev ? [...prev.thread].reverse().find((t) => t.author === "user") : undefined;
  const yours = item.status === "accepted" && item.resolution?.edited ? item.resolution.appliedText : item.draft;
  let move: ItemDescription["move"] = null;
  if (item.move) {
    const texts = moveTexts(item.move, get);
    move = {
      from: moveFrom(item.move),
      to: moveTo(item.move),
      out: movesOut(item),
      otherFiles: [
        ...new Set(
          moveOthers(item)
            .map((id) => get(id)?.file)
            .filter((f): f is string => !!f && f !== item.file),
        ),
      ],
      changed: item.move.changed,
      changes: texts ? moveChanges(texts.from, texts.to) : [],
    };
  }
  const lines = (t: string) => (t ? t.split("\n") : []);
  return {
    effect: itemEffect(item),
    revises: item.supersedes ? { id: item.supersedes, item: prev, asked: asked?.text ?? null } : null,
    yours: yours !== undefined && item.kind === "modify" ? { text: yours, accepted: item.status === "accepted" } : null,
    move,
    whole:
      item.kind === "add-file" || item.kind === "delete-file" || item.kind === "rename-file" ? { old: lines(item.oldText), new: lines(item.newText) } : null,
    bytes: item.kind === "binary" && item.shownText ? lineDiff(item.shownText.old ?? "", item.shownText.new ?? "") : null,
  };
}
