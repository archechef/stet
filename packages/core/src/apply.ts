/** Applying items to a set of files (working copy or git tree). */
import { anchorNear, type Neighbour, type Span } from "./anchor.js";
import { compareItemIds as compareIds, type Item } from "./model.js";
import type { Eol } from "./text.js";

export interface TextFile {
  text: string;
  eol: Eol;
}

/** Access to the files items are applied to. */
export interface FileView {
  read(path: string): Promise<TextFile | null>;
  /** Git blob id of the file's current content, or null if absent. */
  blobId(path: string): Promise<string | null>;
}

export type FileChange = TextFile | { blob: string } | null;

export interface ApplyResult {
  changes: Map<string, FileChange>;
  applied: { item: Item; span: Span; text: string }[];
  failed: { item: Item; reason: string }[];
}

export interface ApplyOptions {
  /** Text of the item's file at its base commit (used for anchoring). */
  refText(item: Item): Promise<string | undefined>;
  /** Replacement texts that override `newText` (edited accepts). */
  overrides?: Map<string, string>;
  /** Changes accepted from the item's base, to locate it when they changed its surroundings. */
  neighbours?(item: Item): Promise<Neighbour[]>;
}

/** Locate every item in `view`. Items that can't be located are reported as failed. */
export async function locate(items: Item[], view: FileView, opts: ApplyOptions) {
  const located: { item: Item; span: Span }[] = [];
  const failed: { item: Item; reason: string }[] = [];
  // Read each file once, however many of its items are located.
  const files = new Map<string, Promise<TextFile | null>>();
  const read = (p: string) => {
    if (!files.has(p)) files.set(p, view.read(p));
    return files.get(p)!;
  };
  for (const item of items) {
    if (item.kind !== "modify") {
      located.push({ item, span: { start: 0, end: 0 } });
      continue;
    }
    const f = await read(item.file);
    if (!f) {
      failed.push({ item, reason: `${item.file} no longer exists` });
      continue;
    }
    const span = anchorNear(item, f.text, await opts.refText(item), opts.neighbours ? await opts.neighbours(item) : []);
    if (span) located.push({ item, span });
    else failed.push({ item, reason: "the surrounding text changed; the change can't be located" });
  }
  keepInsertionOrder(located);
  return { located, failed };
}

/**
 * Whether two changes compete for the same text: like `overlaps`, except that insertions at one
 * spot don't (they go in one after the other, such as entries appended to a .bib file).
 */
export function conflicts(a: Span, b: Span): boolean {
  if (a.start === a.end && b.start === b.end) return false;
  return overlaps(a, b) || (a.start === b.start && a.end === b.end);
}

/**
 * Insertions made at one spot (same file, base and offset) keep their order: a later one (in item
 * order) never lands before an earlier one, which may have found its place after text that is
 * new in the target. Changes the spans in `located` in place.
 */
function keepInsertionOrder(located: { item: Item; span: Span }[]): void {
  const spots = new Map<string, { item: Item; span: Span }[]>();
  for (const l of located) {
    const it = l.item;
    if (it.kind !== "modify" || it.oldText !== "" || l.span.start !== l.span.end) continue;
    const key = `${it.file}\0${it.baseCommit}\0${it.range.start}`;
    spots.set(key, [...(spots.get(key) ?? []), l]);
  }
  for (const list of spots.values()) {
    list.sort((a, b) => compareIds(a.item.id, b.item.id));
    for (let k = 1; k < list.length; k++) {
      const at = Math.max(list[k]!.span.start, list[k - 1]!.span.start);
      list[k]!.span = { start: at, end: at };
    }
  }
}

export function overlaps(a: Span, b: Span): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

export async function applyItems(items: Item[], view: FileView, opts: ApplyOptions): Promise<ApplyResult> {
  const changes = new Map<string, FileChange>();
  const applied: ApplyResult["applied"] = [];
  const { located, failed } = await locate(items, view, opts);

  const current = async (path: string): Promise<FileChange | undefined> => (changes.has(path) ? changes.get(path) : ((await view.read(path)) ?? undefined));
  const exists = async (path: string) => (changes.has(path) ? changes.get(path) !== null : (await view.blobId(path)) !== null);
  const textOf = (item: Item) => opts.overrides?.get(item.id) ?? item.newText;

  // Whole-file items first.
  for (const { item } of located.filter((l) => l.item.kind !== "modify")) {
    const fail = (reason: string) => failed.push({ item, reason });
    if (item.kind === "binary") {
      // A renamed binary: the source must be unchanged and the destination free; the source goes away.
      const src = item.oldFile ?? item.file;
      const cur = changes.has(src) ? undefined : await view.blobId(src);
      if (cur !== (item.oldBlob ?? null)) fail(`${src} changed since the proposal was made`);
      else if (item.oldFile && (await exists(item.file))) fail(`${item.file} already exists`);
      else {
        if (item.oldFile) changes.set(item.oldFile, null);
        changes.set(item.file, item.newBlob ? { blob: item.newBlob } : null);
        applied.push({ item, span: { start: 0, end: 0 }, text: "" });
      }
      continue;
    }
    if (item.kind === "add-file") {
      if (await exists(item.file)) fail(`${item.file} already exists`);
      else {
        const text = textOf(item);
        changes.set(item.file, { text, eol: "lf" });
        applied.push({ item, span: { start: 0, end: 0 }, text });
      }
      continue;
    }
    const src = item.kind === "rename-file" ? item.oldFile! : item.file;
    const cur = await current(src);
    if (!cur || !("text" in cur) || cur.text !== item.oldText) {
      fail(`${src} changed since the proposal was made`);
      continue;
    }
    if (item.kind === "delete-file") {
      changes.set(src, null);
      applied.push({ item, span: { start: 0, end: 0 }, text: "" });
    } else {
      if (await exists(item.file)) {
        fail(`${item.file} already exists`);
        continue;
      }
      const text = textOf(item);
      changes.set(src, null);
      changes.set(item.file, { text, eol: cur.eol });
      applied.push({ item, span: { start: 0, end: 0 }, text });
    }
  }

  // Text edits, per file, from the end backwards so offsets stay valid.
  const byFile = new Map<string, { item: Item; span: Span }[]>();
  for (const l of located.filter((l) => l.item.kind === "modify")) {
    const list = byFile.get(l.item.file) ?? [];
    list.push(l);
    byFile.set(l.item.file, list);
  }
  for (const [path, list] of byFile) {
    const cur = await current(path);
    if (!cur || !("text" in cur)) {
      for (const { item } of list) failed.push({ item, reason: `${path} no longer exists` });
      continue;
    }
    // At one offset, insertions come before a change starting there, and in item order: applied
    // from the end backwards, they then end up in that order, ahead of the change.
    const empty = (s: Span) => (s.start === s.end ? 0 : 1);
    list.sort((a, b) => a.span.start - b.span.start || empty(a.span) - empty(b.span) || compareIds(a.item.id, b.item.id));
    const kept: typeof list = [];
    for (const l of list) {
      const clash = kept.find((k) => conflicts(k.span, l.span));
      if (clash) failed.push({ item: l.item, reason: `overlaps ${clash.item.id}` });
      else kept.push(l);
    }
    let text = cur.text;
    for (const l of [...kept].reverse()) {
      const t = textOf(l.item);
      text = text.slice(0, l.span.start) + t + text.slice(l.span.end);
      applied.push({ item: l.item, span: l.span, text: t });
    }
    changes.set(path, { text, eol: cur.eol });
  }
  return { changes, applied, failed };
}
