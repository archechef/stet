/** PDF previews (§14): whether they can be built here, the container image, and the preview of a change. */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { validateConfig } from "../config.js";
import { notFound } from "../errors.js";
import { documentProfile, type LanguageProfile } from "../lang/index.js";
import { type Item, isLive, linkedRest } from "../model.js";
import { imbalance, type ProfileOf } from "../parts.js";
import {
  detectPreviewEnv,
  PreviewBuilder,
  type PreviewChange,
  type PreviewEnv,
  type PreviewRequest,
  type PreviewResult,
  setupPreviewImage,
} from "../preview.js";
import type { Stet } from "../service.js";
import { sha256 } from "../text.js";

/**
 * The fewest changes of `pool` (same file, nearest first) that close what `item` opens, or open
 * what it closes (braces, environments, math). Empty if it is balanced or none complete it.
 */
export function completing(item: Item, pool: Item[], profileOf: ProfileOf): Item[] {
  const parity = profileOf(item.file).parts?.parity ?? [];
  let acc = imbalance(item, profileOf);
  const norm = (v: number[]) => v.reduce((n, x, k) => n + (parity.includes(k) ? x % 2 : Math.abs(x)), 0);
  if (!norm(acc)) return [];
  const out: Item[] = [];
  const near = pool.filter((p) => p.file === item.file).sort((a, b) => Math.abs(a.range.start - item.range.start) - Math.abs(b.range.start - item.range.start));
  for (const p of near) {
    const next = acc.map((x, k) => x + imbalance(p, profileOf)[k]!);
    if (norm(next) >= norm(acc)) continue;
    out.push(p);
    acc = next;
    if (!norm(acc)) return out;
  }

  return [];
}

/** Why a project in this language has no PDF previews. */
export function noPreviews(doc: LanguageProfile): string {
  return doc.id === "typst" ? "Stet has no PDF previews for Typst projects yet. Everything else works as usual." : `Stet has no PDF previews for ${doc.name}.`;
}

export class Previews {
  constructor(private readonly stet: Stet) {}

  /** No builder for a language without previews. */
  private previews: { env: PreviewEnv; builder: PreviewBuilder | null } | null = null;

  /** What PDF previews can use here, and what is missing. Never installs or downloads anything. */
  async previewStatus(recheck = false): Promise<PreviewEnv> {
    if (!this.previews || recheck) {
      const cfg = (await this.stet.config()).preview;
      const doc = documentProfile(await this.stet.config());
      const env = doc.typesetter ? await detectPreviewEnv(cfg, doc.typesetter) : { status: "unavailable" as const, isolation: null, message: noPreviews(doc) };
      this.previews = { env, builder: doc.typesetter ? new PreviewBuilder(this.stet.repo, join(this.stet.store.root, "previews"), cfg, env, doc) : null };
    }
    return this.previews.env;
  }

  /** Build the container image previews run in. It downloads packages: call it only on the user's request. */
  async setupPreview(opts: { extras?: boolean } = {}): Promise<{ ok: boolean; log: string; status: PreviewEnv }> {
    const doc = documentProfile(await this.stet.config());
    const r = doc.typesetter ? await setupPreviewImage((await this.stet.config()).preview, doc.typesetter, opts) : { ok: false, log: noPreviews(doc) };
    if (r.ok && opts.extras) {
      // From now on the image with the extra fonts.
      await this.stet.store.withLock(async () => {
        const cfg = await this.stet.config();
        await this.stet.store.saveConfig(validateConfig({ ...cfg, preview: { ...cfg.preview, texExtras: true } }));
      });
    }
    // Previews built before (failed ones included) were made with the old image.
    if (r.ok) await rm(join(this.stet.store.root, "previews"), { recursive: true, force: true });
    return { ...r, status: await this.previewStatus(true) };
  }

  /**
   * The region of the compiled paper where a change lands, before and after (as images in the
   * preview cache). Text changes in .tex files only; slow (it compiles), so callers show the
   * change first and the preview once it is ready.
   */
  async preview(id: string): Promise<PreviewResult> {
    const item = await this.stet.store.getItem(id.toUpperCase());
    if (!item) throw notFound(`Unknown item '${id}'.`);
    await this.previewStatus();
    const cfg = await this.stet.config();
    // Changes to the text of the document's own source files (the typesetter's: .tex files).
    const doc = documentProfile(cfg);
    if (!doc.typesetter) return { status: "no-spot", message: noPreviews(doc) };
    const isTex = (i: Item) => i.kind === "modify" && this.stet.profile(cfg, i.file) === doc && !!doc.typesetter?.source.test(i.file);
    if (!isTex(item))
      return { status: "no-spot", message: `Only changes to the text of ${doc.typesetter?.sourceName ?? "the document's source files"} have a PDF preview.` };
    const change = async (i: Item): Promise<PreviewChange | null> => {
      const t = await this.stet.textAt(i.baseCommit, i.file);
      return t && { file: i.file, baseText: t.text, eol: t.eol, range: i.range, newText: i.newText };
    };
    // Apply what accepting it would apply: one end of a move or of a linked part alone can leave
    // the document broken (\begin{proof} without its \end).
    const together = (list: Item[]) => list.filter((i) => i.id !== item.id && isTex(i) && i.baseCommit === item.baseCommit);
    const unit = isLive(item.status) ? together(linkedRest([item.id], await this.stet.lookup())) : [];
    const request = async (others: Item[], tag: string): Promise<PreviewRequest | null> => {
      const changes = [await change(item), ...(await Promise.all(others.map(change)))];
      if (changes.some((c) => !c)) return null;
      const sig = changes.map((c) => `${c!.file}:${c!.range.start}:${c!.range.end}:${c!.newText}`).join("\u0000");
      return { base: item.baseCommit, key: `${item.id}${tag}-${sha256(sig).slice(0, 12)}`, changes: changes as PreviewChange[], target: 0 };
    };
    const first = await request(unit, "");
    if (!first) return { status: "no-spot", message: `${item.file} isn't in the text this change was proposed against.` };
    const list = (xs: Item[]) => xs.map((i) => i.id).join(", ");
    // Tried in turn, until one compiles without new errors: the change with what is accepted with
    // it; plus the changes of its round that complete it (an environment opened in one change and
    // closed in another); its whole round. Else the best of them.
    const round = together((await this.stet.store.items()).filter((i) => i.changeset === item.changeset && isLive(i.status)));
    const pair = completing(
      item,
      round.filter((i) => !unit.includes(i)),
      (f) => this.stet.profile(cfg, f),
    );
    const tries: { others: Item[]; tag: string; note: (x: Item[]) => string }[] = [
      { others: unit, tag: "", note: (x) => `Shown together with ${list(x)}, which ${x.length === 1 ? "is" : "are"} accepted with it.` },
      ...(pair.length
        ? [
            {
              others: [...unit, ...pair],
              tag: "-pair",
              note: (x: Item[]) =>
                `On its own this change breaks the document, so it is shown with ${list(x)}, which complete${x.length === 1 ? "s" : ""} it. Accept them together.`,
            },
          ]
        : []),
      ...(round.length > unit.length + pair.length
        ? [
            {
              others: round,
              tag: "-round",
              note: (x: Item[]) => `On its own this change breaks the document, so it is shown with the rest of its round (${list(x)}).`,
            },
          ]
        : []),
    ];
    let best: { r: PreviewResult; note: string } | null = null;
    const errors = (x: PreviewResult) => (x.status === "ready" ? (x.warning?.count ?? 0) : Infinity);
    for (const t of tries) {
      const req = t === tries[0] ? first : await request(t.others, t.tag);
      if (!req) continue;
      const r = await this.previews!.builder!.preview(req);
      if (r.status !== "ready" && (r.status !== "failed" || r.cause !== "change")) return r; // the base itself, or no spot
      const note = t.others.length ? t.note(t.others) : "";
      if (!best || errors(r) < errors(best.r)) best = { r, note };
      if (r.status === "ready" && !r.warning) break;
    }
    const r = best!.r;
    if (r.status !== "ready") return tries.length > 1 ? { ...r, message: `${r.message} Not together with the other changes of its round either.` } : r;
    return best!.note ? { ...r, note: best!.note } : r;
  }

  /** Another page of a built preview (the page viewer scrolled on), or null. */
  async previewPage(base: string, key: string, version: "after" | "before", n: number): Promise<{ file: string; width: number; height: number } | null> {
    await this.previewStatus();
    return this.previews!.builder?.page(base, key, version, n) ?? null;
  }
}
