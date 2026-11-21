import { randomBytes } from "node:crypto";
import {
  changeSummary,
  describeFeedback,
  firstLines,
  type Item,
  type ItemStatus,
  inlineDiff,
  itemEffect,
  lineDiff,
  moveFrom,
  movesOut,
  moveTo,
  type Note,
  type NotifyMode,
  oneLine,
  paragraphChange,
  printable,
  profileByName,
  SHOWN_LINES,
  type StetEvent,
  summaryTexts,
} from "@stet/core";

// Output helpers

let color = !!process.stdout.isTTY && !process.env.NO_COLOR;

/** Colours on or off for what follows (main sets it from where the output goes). */
export function useColor(on: boolean): void {
  color = on;
}
export const colored = (): boolean => color;
/**
 * Stet's own colour codes are written as markers with a random tag and become escape sequences
 * only in `forTerminal`, after every control character from agent text is gone: agent text could
 * otherwise carry Stet's own colours (security report 5e4c6af, S10).
 */
const TAG = randomBytes(8).toString("hex");
const sgr = (code: string) => `\uE000${TAG}${code}\uE001`;
const OWN_SGR = new RegExp(`\uE000${TAG}([0-9;]+)\uE001`, "g");
export const c = (code: string) => (s: string) => (color ? `${sgr(code)}${s}${sgr("0")}` : s);
export const red = c("31"),
  green = c("32"),
  yellow = c("33"),
  dim = c("2"),
  bold = c("1"),
  cyan = c("36");

/**
 * Text for the terminal: Stet's own colour codes stay, every other control character goes (agent
 * text could otherwise carry escape sequences that rewrite or hide what the reviewer sees).
 */
export function forTerminal(s: string): string {
  return printable(s).replace(OWN_SGR, (_, code: string) => `\x1b[${code}m`);
}

/** A status in words ("needs revision", not needs_revision), coloured. */
export const statusColor = (st: ItemStatus) => {
  const s = st.replace(/_/g, " ");
  return st === "accepted"
    ? green(s)
    : st === "rejected" || st === "stale"
      ? red(s)
      : st === "needs_revision"
        ? yellow(s)
        : st === "pending"
          ? cyan(s)
          : dim(s);
};

/** A stored time (UTC) in the local time zone, to the minute. */
export const localTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const sizeOf = (n: number) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function itemSummary(it: Item, line?: number): string {
  // A file that takes effect (a latexmkrc, .gitattributes, AGENTS.md…): flagged (security report 5e4c6af, S12).
  const effect = itemEffect(it);
  return itemLine(it, line) + (effect ? yellow(` ⚠ takes effect: ${effect}`) : "");
}

export function itemLine(it: Item, line?: number): string {
  const where = `${it.file}${line ? `:${line}` : ""}`;
  if (it.kind !== "modify") {
    const text = it.kind === "delete-file" ? it.oldText : it.newText;
    const size = it.kind === "binary" ? "" : dim(` (${sizeOf(Buffer.byteLength(text, "utf8"))})`);
    // A rename that also changes the text says so (it showed as a plain rename).
    const edited = it.kind === "rename-file" && it.oldText !== it.newText ? " and edited" : "";
    return `${bold(it.id)} ${statusColor(it.status)} ${it.kind}${edited} ${where}${it.oldFile ? ` (from ${it.oldFile})` : ""}${size}`;
  }
  if (it.move) {
    // Half of a move (spec §6.4.7): decided with its other half.
    const how = it.move.changed ? yellow(`${it.move.changed} word(s) changed on the way`) : "word for word";
    const move = movesOut(it)
      ? `${red(`moved out: "${oneLine(it.oldText, 40)}"`)} ${dim(`→ ${moveTo(it.move).join(", ")}`)}`
      : `${green(`moved in: "${oneLine(it.newText, 40)}"`)} ${dim(`← ${moveFrom(it.move).join(", ")},`)} ${how}`;
    return `${bold(it.id)} ${statusColor(it.status)} ${dim(where)}  ${move}`;
  }
  const [o, n] = changeSummary(...summaryTexts(it), it.oldText && it.newText ? 30 : 50);
  const change = !it.oldText ? green(`+ "${n}"`) : !it.newText ? red(`- "${o}"`) : `${red(`"${o}"`)} → ${green(`"${n}"`)}`;
  // A revision says what it revises (the reviewer's request is in `stet show`).
  const revises = it.supersedes ? dim(` (revises ${it.supersedes})`) : "";
  // A paragraph split, joined, or its break moved past a sentence: said in words.
  const breaks = paragraphChange(it.oldText, it.newText);
  return `${bold(it.id)} ${statusColor(it.status)} ${dim(where)}  ${breaks ? `${breaks}: ` : ""}${change}${revises}`;
}

/** A reply or note on several lines, indented, so it can't pass for thread lines of its own (security report 5e4c6af, S10). */
export const indented = (t: string) => printable(t).replace(/\n/g, "\n    ");

/** `full`: whole files, not their first lines. */
export function itemDiff(it: Item, full = false): string {
  if (it.kind === "binary") {
    // Text with bytes that aren't UTF-8: shown, the bytes marked (security report 5e4c6af, S7).
    if (!it.shownText) return dim("(binary file)");
    const { shown, more } = firstLines(lineDiff(it.shownText.old ?? "", it.shownText.new ?? ""), full ? Infinity : SHOWN_LINES);
    return [
      dim("(not UTF-8 text: bytes that aren't UTF-8 are shown as ⟨0x..⟩; accepting writes the file byte for byte)"),
      ...shown.map((l) => (l.startsWith("+ ") ? green(l) : l.startsWith("- ") ? red(l) : dim(l))),
      ...(more ? [dim(`  … ${more} more lines (stet show ${it.id} --full shows them all)`)] : []),
    ].join("\n");
  }
  if (it.kind !== "modify") {
    const lines: string[] = [];
    // Whole files with --full; else the first lines of each side, and how many more there are
    // (security report 5e4c6af, S8: the rest was cut without a word).
    const side = (text: string, mark: (s: string) => string, sign: string) => {
      const { shown, more } = firstLines(text.split("\n"), full ? Infinity : SHOWN_LINES);
      lines.push(...shown.map((l) => mark(sign + l)));
      if (more) lines.push(dim(`  … ${more} more lines (stet show ${it.id} --full shows them all)`));
    };
    if (it.oldText) side(it.oldText, red, "- ");
    if (it.newText) side(it.newText, green, "+ ");
    return lines.join("\n");
  }
  // Context up to the line boundary, without a cut-off partial word.
  const before = (it.context.before.split("\n").pop() ?? "").replace(/^\S*\s/, "…");
  const after = (it.context.after.split("\n")[0] ?? "").replace(/\s\S*$/, "…");
  const del = (t: string) => (t ? (color ? c("31;9")(t) : `[-${t}-]`) : "");
  const ins = (t: string) => (t ? (color ? c("32;4")(t) : `{+${t}+}`) : "");
  if (paragraphChange(it.oldText, it.newText)) {
    // Only the paragraph breaks changed: those, made visible, in the text (not all of it twice).
    const shown = (t: string) =>
      t
        .replace(/\n[ \t]*\n\s*/g, "¶")
        .replace(/\n/g, "↵")
        .replace(/[ \t]/g, "␣");
    const d = inlineDiff(it.oldText, it.newText, profileByName(it.file).syntax?.tokenize);
    let out = "";
    let pos = 0;
    for (const { at, text } of d.inserted) {
      const [a] = d.removed.find(([, b]) => b === at) ?? [at];
      out += it.oldText.slice(pos, a) + del(shown(it.oldText.slice(a, at))) + ins(shown(text));
      pos = at;
    }
    return dim(before) + out + it.oldText.slice(pos) + dim(after);
  }
  return dim(before) + del(it.oldText) + ins(it.newText) + dim(after);
}

// ---------------------------------------------------------------------------

/** Feedback as the agents see it, with colored labels and the CLI's reply command. */
export const describeEvent = (e: StetEvent) =>
  describeFeedback(e, {
    label: (t, tone) => ({ good: green, bad: red, warn: yellow, info: cyan })[tone](t.toLowerCase()),
    reply: (id) => `stet reply ${id} -m "..."`,
  });

export const noteReply = (id: string) => `stet reply ${id} -m "..."`;

export const NOTIFY_TEXT: Record<NotifyMode, string> = {
  now: "notified right away (a watching agent wakes at each decision)",
  batched: "notified when you pause (a watching agent wakes once you have stopped for a while)",
  off: "not notified (it hears about your decisions when it next checks)",
};

export const missingText = (missing: { item: Item; reason: string }[]) =>
  `! Agents don't get ${missing.length === 1 ? "this accepted change" : "these accepted changes"}: ` +
  missing.map((m) => `${m.item.id} (${m.reason})`).join(", ") +
  ". Finish the review (`stet commit`) or share your edits (`stet share`) to pass them on.";

export function noteSummary(n: Note): string {
  const tag = n.state === "resolved" ? dim(" [resolved]") : n.deliveredAt ? "" : dim(" [not delivered yet]");
  return `${bold(n.id)} for ${n.agent} on ${n.file}${tag}: ${oneLine(n.body, 80)}${n.thread.length ? dim(` (${n.thread.length} repl${n.thread.length === 1 ? "y" : "ies"})`) : ""}`;
}
