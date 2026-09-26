/** Applying items to a set of files (working copy or git tree). */
import { anchor, type Span } from "./anchor.js";
import type { Item } from "./model.js";
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
}

/** Locate every item in `view`. Items that can't be located are reported as failed. */
export async function locate(items: Item[], view: FileView, opts: ApplyOptions) {
  const located: { item: Item; span: Span }[] = [];
  const failed: { item: Item; reason: string }[] = [];
  for (const item of items) {
    if (item.kind !== "modify") {
      located.push({ item, span: { start: 0, end: 0 } });
      continue;
    }
    const f = await view.read(item.file);
    if (!f) {
      failed.push({ item, reason: `${item.file} no longer exists` });
      continue;
    }
    const span = anchor(item, f.text, await opts.refText(item));
    if (span) located.push({ item, span });
    else failed.push({ item, reason: "the surrounding text changed; the change can't be located" });
  }
  return { located, failed };
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

  const current = async (path: string): Promise<FileChange | undefined> =>
    changes.has(path) ? changes.get(path) : ((await view.read(path)) ?? undefined);
  const exists = async (path: string) => (changes.has(path) ? changes.get(path) !== null : (await view.blobId(path)) !== null);
  const textOf = (item: Item) => opts.overrides?.get(item.id) ?? item.newText;

  // Whole-file items first.
  for (const { item } of located.filter((l) => l.item.kind !== "modify")) {
    const fail = (reason: string) => failed.push({ item, reason });
    if (item.kind === "binary") {
      const cur = changes.has(item.file) ? undefined : await view.blobId(item.file);
      if (cur !== (item.oldBlob ?? null)) fail(`${item.file} changed since the proposal was made`);
      else {
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
    list.sort((a, b) => a.span.start - b.span.start || a.item.id.localeCompare(b.item.id));
    const kept: typeof list = [];
    for (const l of list) {
      const clash = kept.find((k) => overlaps(k.span, l.span) || (k.span.start === l.span.start && k.span.end === l.span.end));
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
