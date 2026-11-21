/**
 * Text as the extension shows it: escaped for Markdown, cut to fit a row or inline, line breaks
 * and positions. No `vscode` import.
 */
import { type InlineDiff, type Item, type ItemStatus, inlineDiff, oneLine, printable, profileByName } from "@stet/core";

export { oneLine };

/** A change's status in words. */
export const STATUS_TEXT: Record<ItemStatus, string> = {
  pending: "pending",
  needs_revision: "revision requested",
  accepted: "accepted",
  rejected: "rejected",
  withdrawn: "withdrawn",
  superseded: "superseded",
  stale: "stale",
};

/**
 * A label cut to `max` characters at a word, with "…": long agent names and round titles pushed
 * the counts and line numbers out of a narrow panel. Tooltips keep it whole.
 */
export function fitLabel(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}

/**
 * Text for a notification: VS Code turns `[text](command:…)` in one into a working link, so agent
 * text in it must not keep that form.
 */
export const noLinks = (s: string): string => printable(s).replace(/\]\s*\(/g, "] (");

/** Short text for ghost-text decorations (no newlines, bounded length). */
export function ghostText(s: string, max = 80): string {
  // Whitespace alone (a paragraph split or joined) would be invisible: shown as ¶ and ␣.
  if (s && !s.trim())
    return s
      .replace(/\r?\n[ \t]*\r?\n\s*/g, "¶")
      .replace(/\r?\n/g, "↵")
      .replace(/[ \t]/g, "␣");
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

/**
 * The words around a change on its line, for editing it in an input box: the box holds
 * `pre + text + post` with the change selected, so its bounds are visible and the words next to
 * it aren't typed twice ("relies on a simplea simple idea"). At most
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

/** Whether inline text can show `s` in full: one line, at most `max` characters. */
export const fitsInline = (s: string, max = 80): boolean => !/[\r\n]/.test(s) && s.length <= max;

/** Markdown fenced block that is safe for any content. */
export function fence(text: string, lang = ""): string {
  // Agent text: a lone CR would end a line for Markdown inside the fence, and direction overrides
  // would reorder what is shown.
  text = printable(text);
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

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

type Pos = { line: number; character: number };

/**
 * Of changes located in a file, the one a command at `pos` means: the one the cursor is in, else
 * the nearest on its line, not the line's first, which may be another change in the same
 * paragraph.
 */
export function changeAt<T extends { range: { start: Pos; end: Pos } }>(located: T[], pos: Pos): T | undefined {
  const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  const inside = (r: { start: Pos; end: Pos }) => before(r.start, pos) && before(pos, r.end);
  const gap = (r: { start: Pos; end: Pos }) =>
    inside(r)
      ? 0
      : 1 +
        Math.min(
          r.start.line === pos.line ? Math.abs(r.start.character - pos.character) : Infinity,
          r.end.line === pos.line ? Math.abs(r.end.character - pos.character) : Infinity,
        );
  return located
    .filter((l) => inside(l.range) || l.range.start.line === pos.line || l.range.end.line === pos.line)
    .sort((a, b) => gap(a.range) - gap(b.range))[0];
}

/**
 * The changes the cursor is inside of, when there are several (overlapping changes of two agents):
 * commands ask which one rather than pick one silently. Empty otherwise.
 */
export function changesAt<T extends { range: { start: Pos; end: Pos } }>(located: T[], pos: Pos): T[] {
  const before = (a: Pos, b: Pos) => a.line < b.line || (a.line === b.line && a.character <= b.character);
  const inside = located.filter((l) => before(l.range.start, pos) && before(pos, l.range.end));
  return inside.length > 1 ? inside : [];
}

/** Escape agent-written text for Markdown, so it cannot add links or formatting. */
export const esc = (s: string) => printable(s).replace(/[\\`*_{}[\]()#+\-.!|<>~=:]/g, "\\$&");

/**
 * A link's tooltip in trusted Markdown: one line, its quotes and backslashes escaped. A blank line
 * in a group title used to end the link, and the rest became trusted Markdown with Stet's command
 * links in it.
 */
export const linkTitle = (s: string) => oneLine(s, 400).replace(/["\\]/g, "\\$&");

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
