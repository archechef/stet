/** Review documents of a file, and your wording of a change (drafts) saved from them. */
import { captureContext } from "../anchor.js";
import { notFound, StetError } from "../errors.js";
import { type Item, isLive } from "../model.js";
import { mapReviewEdits, type ReviewChange, type ReviewDocument, reviewDocument } from "../review.js";
import type { Stet } from "../service.js";
import { toLf } from "../text.js";

export class Drafts {
  constructor(private readonly stet: Stet) {}

  /**
   * `text` (the reviewer's current text of `file`, LF) with every pending change to it applied, in
   * the reviewer's wording where they have one, and where each change is in the result. `only`:
   * just these changes (the review of one change, with what accepting it takes along).
   */
  async reviewOf(file: string, text: string, only?: string[]): Promise<ReviewDocument & { items: Item[] }> {
    const items = (await this.stet.store.items()).filter((i) => i.file === file && i.kind === "modify" && isLive(i.status) && (!only || only.includes(i.id)));
    const changes: ReviewChange[] = [];
    const unplaced: string[] = [];
    for (const it of items) {
      const span = await this.stet.anchorItem(it, text);
      if (span) changes.push({ id: it.id, start: span.start, end: span.end, text: it.draft ?? it.newText });
      else unplaced.push(it.id);
    }
    const doc = reviewDocument(text, changes);
    return { ...doc, skipped: [...doc.skipped, ...unplaced], items };
  }

  /**
   * The reviewer saved the review document `doc` as `edited`: their edits become their wording for
   * those changes, which stay pending. Returns the changes whose wording changed, or an error.
   */
  async saveReview(doc: ReviewDocument, edited: string): Promise<{ changed: string[] } | { error: string }> {
    const mapped = mapReviewEdits(doc, toLf(edited));
    if ("error" in mapped) return mapped;
    return this.stet.store.withLock(async () => {
      // Changes that grew over words reworded next to them: the same change, written wider
      // (old and new text both take in those words), if the words are as the change's base has them.
      const wider = new Map<string, Item>();
      for (const [id, g] of mapped.grown) {
        const it = await this.stet.store.getItem(id);
        if (!it || !isLive(it.status)) continue;
        const r = doc.regions.find((x) => x.id === id)!;
        const before = doc.content.slice(r.start - g.before, r.start);
        const after = doc.content.slice(r.end, r.end + g.after);
        const ref = await this.stet.refText(it);
        const { start, end } = it.range;
        if (
          it.kind !== "modify" ||
          it.move ||
          ref === undefined ||
          ref.slice(start - before.length, start) !== before ||
          ref.slice(end, end + after.length) !== after
        ) {
          return { error: `You reworded text next to ${id} that you changed yourself since: edit that in your file itself, or only ${id}'s own words here.` };
        }
        const range = { start: start - before.length, end: end + after.length };
        wider.set(id, {
          ...it,
          range,
          oldText: before + it.oldText + after,
          newText: before + it.newText + after,
          context: captureContext(ref, range.start, range.end),
        });
      }
      const changed: string[] = [];
      for (const [id, text] of mapped.texts) {
        const it = wider.get(id) ?? (await this.stet.store.getItem(id));
        if (!it || !isLive(it.status)) continue;
        const shown = it.draft ?? it.newText;
        if (text === shown && !wider.has(id)) continue;
        if (text === it.newText) delete it.draft;
        else it.draft = text;
        await this.stet.store.putItem(it);
        changed.push(id);
      }
      return { changed };
    });
  }

  /**
   * The reviewer's wording for a pending change, without accepting it (accepting later uses it).
   * The agent's own text drops the wording. Returns whether anything changed.
   */
  async setDraft(id: string, text: string): Promise<boolean> {
    return this.stet.store.withLock(async () => {
      const it = await this.stet.store.getItem(id.toUpperCase());
      if (!it) throw notFound(`Unknown change '${id}'.`);
      if (it.kind !== "modify") throw new StetError(`${it.id} changes a whole file; it can only be accepted or rejected.`);
      if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status} already; there is no wording to change.`);
      const lf = toLf(text);
      if (lf === (it.draft ?? it.newText)) return false;
      if (lf === it.newText) delete it.draft;
      else it.draft = lf;
      await this.stet.store.putItem(it);
      return true;
    });
  }

  /** Drop the reviewer's wording for a change: the agent's text again. */
  async clearDraft(id: string): Promise<void> {
    await this.stet.store.withLock(async () => {
      const it = await this.stet.store.getItem(id.toUpperCase());
      if (!it || it.draft === undefined) return;
      delete it.draft;
      await this.stet.store.putItem(it);
    });
  }
}
