/** In-editor review: inline decorations, CodeLens actions, hovers, and diff documents. */
import * as vscode from "vscode";
import { moveChanges, moveOthers, movesOut, moveTexts, partId, partIndexOf, type Item } from "@stet/core";
import { diffBlock, fence, ghostText, isLive, itemDiff, LineIndex, moveNote, positionIn, STATUS_TEXT, toLf, type Ref, type TreeModel } from "./model.js";
import type { Project } from "./project.js";

export interface Located {
  item: Item;
  range: vscode.Range;
}

export interface Host {
  projectFor(uri: vscode.Uri): Project | undefined;
  model(p: Project): TreeModel;
  readonly onDidChange: vscode.Event<void>;
  /** The PDF preview of a change as hover Markdown, if previews are shown in hovers (starts building it if needed). */
  previewHover?(p: Project, item: Item): string | undefined;
}

/** Where pending items sit in open documents (cached per document version). */
export class Locator {
  private cache = new Map<string, { version: number; gen: number; located: Promise<Located[]> }>();
  private gen = 0;

  constructor(private host: Host) {
    host.onDidChange(() => this.gen++);
  }

  locate(doc: vscode.TextDocument): Promise<Located[]> {
    const key = doc.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === doc.version && hit.gen === this.gen) return hit.located;
    const located = this.compute(doc);
    this.cache.set(key, { version: doc.version, gen: this.gen, located });
    return located;
  }

  private async compute(doc: vscode.TextDocument): Promise<Located[]> {
    const p = this.host.projectFor(doc.uri);
    const rel = p?.relPath(doc.uri);
    if (!p || !rel) return [];
    const items = p.snapshot.items.filter((i) => isLive(i) && i.kind === "modify" && i.file === rel);
    if (!items.length) return [];
    const lf = toLf(doc.getText());
    const idx = new LineIndex(lf);
    const out: Located[] = [];
    for (const item of items) {
      const span = await p.stet.locateInText(item, lf).catch(() => null);
      if (!span) continue;
      const a = idx.position(span.start);
      const b = idx.position(span.end);
      out.push({ item, range: new vscode.Range(a.line, a.character, b.line, b.character) });
    }
    return out.sort((x, y) => x.range.start.compareTo(y.range.start));
  }

  forget(doc: vscode.TextDocument): void {
    this.cache.delete(doc.uri.toString());
  }
}

/**
 * How much new text is shown inline after a change. With word wrap on, inline text wraps with the
 * line, so a longer single-line proposal fits; without it, long text would run off the screen.
 */
export function inlineMax(uri: vscode.Uri): number {
  return wraps(uri) && usesHints(uri) ? 2000 : 80;
}

/**
 * VS Code settings that break inline proposals with word wrap, for a document: they are inlay
 * hints, which VS Code cuts after `editor.inlayHints.maximumLength` characters per line (Stet's
 * default for LaTeX files is no limit, but the user's own value wins) or hides unless a key is held.
 */
export function inlineProblems(doc: vscode.TextDocument): { key: string; message: string; setting: string; value: unknown }[] {
  if (!usesHints(doc.uri)) return [];
  const ed = vscode.workspace.getConfiguration("editor", { uri: doc.uri, languageId: doc.languageId });
  const out: { key: string; message: string; setting: string; value: unknown }[] = [];
  const max = ed.get<number>("inlayHints.maximumLength", 43);
  if (max > 0) {
    out.push({
      key: "maximumLength",
      message: `VS Code shows at most ${max} characters of inline text per line in ${doc.languageId} files (editor.inlayHints.maximumLength), so longer proposals are cut off instead of wrapping.`,
      setting: "inlayHints.maximumLength",
      value: 0,
    });
  }
  const enabled = ed.get<string>("inlayHints.enabled", "on");
  if (enabled !== "on") {
    out.push({
      key: "enabled",
      message: `VS Code's inline hints are set to “${enabled}” in ${doc.languageId} files (editor.inlayHints.enabled), so proposed text ${enabled === "off" ? "isn't shown" : "only shows while you hold Ctrl+Alt"} with word wrap on.`,
      setting: "inlayHints.enabled",
      value: "on",
    });
  }
  return out;
}

const wraps = (uri: vscode.Uri) => vscode.workspace.getConfiguration("editor", uri).get<string>("wordWrap", "off") !== "off";

/**
 * How new text is drawn (setting stet.newTextStyle). Decorations can be coloured (green) but are
 * ignored by word wrap; inlay hints wrap with the line but take the theme's inlay hint colour
 * (made green by Stet: Highlight proposed text). "auto" picks by the word wrap setting.
 */
export function usesHints(uri: vscode.Uri): boolean {
  const style = vscode.workspace.getConfiguration("stet").get<string>("newTextStyle", "auto");
  return style === "wrapping" || (style === "auto" && wraps(uri));
}

/**
 * What to mark for a located item: only the parts that change. A whole formula may be one item,
 * but a changed exponent should not look like a rewritten equation.
 */
function marks(doc: vscode.TextDocument, item: Item, range: vscode.Range): { removed: vscode.Range[]; inserted: { at: vscode.Position; text: string }[] } {
  const here = toLf(doc.getText(range));
  // The located text is the item's old text; if not (e.g. while typing), mark the whole span.
  const d =
    here === item.oldText
      ? itemDiff(item)
      : { removed: here ? [[0, here.length] as [number, number]] : [], inserted: item.newText ? [{ at: here.length, text: item.newText }] : [] };
  const pos = (offset: number) => {
    const p = positionIn(range.start, here, offset);
    return new vscode.Position(p.line, p.character);
  };
  return {
    removed: d.removed.map(([a, b]) => new vscode.Range(pos(a), pos(b))),
    inserted: d.inserted.map((i) => ({ at: pos(i.at), text: i.text })),
  };
}

const cmd = (command: string, args: unknown[]) => `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;

export class EditorIntegration implements vscode.CodeLensProvider, vscode.HoverProvider, vscode.InlayHintsProvider, vscode.Disposable {
  private readonly removed = vscode.window.createTextEditorDecorationType({
    textDecoration: "line-through",
    color: new vscode.ThemeColor("stet.removedText.foreground"),
    backgroundColor: new vscode.ThemeColor("stet.removedText.background"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** New text as coloured decorations (when word wrap is off; see usesHints). */
  private readonly inserted = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor("stet.insertedText.foreground"),
      backgroundColor: new vscode.ThemeColor("stet.insertedText.background"),
    },
  });
  /** Where half of a move goes or comes from (instead of its text). */
  private readonly moveLabel = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorCodeLens.foreground"), fontStyle: "italic", margin: "0 0 0 1em" },
  });
  /** A move whose text changed on the way: the changes, in a warning colour so they're not missed. */
  private readonly moveChanged = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorWarning.foreground"), fontStyle: "italic", fontWeight: "bold", margin: "0 0 0 1em" },
  });
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
  private readonly hintsChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeInlayHints = this.hintsChanged.event;
  private disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private host: Host,
    private locator: Locator,
  ) {
    const selector: vscode.DocumentSelector = { scheme: "file" };
    this.disposables.push(
      vscode.languages.registerCodeLensProvider(selector, this),
      vscode.languages.registerHoverProvider(selector, this),
      // New text as inlay hints: unlike decoration text, they take part in word wrap.
      vscode.languages.registerInlayHintsProvider(selector, this),
      host.onDidChange(() => this.update()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.update(300);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("stet") || e.affectsConfiguration("editor.wordWrap")) this.update();
      }),
    );
  }

  update(delay = 0): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.lensChanged.fire();
      this.hintsChanged.fire();
      for (const ed of vscode.window.visibleTextEditors) void this.decorate(ed);
    }, delay);
  }

  private async decorate(ed: vscode.TextEditor): Promise<void> {
    const on = vscode.workspace.getConfiguration("stet").get<boolean>("inlineChanges", true);
    const located = on ? await this.locator.locate(ed.document) : [];
    // The moved-in half of a move shows a note instead of its text (see moveNote).
    const all = located.map(({ item, range }) => {
      const m = marks(ed.document, item, range);
      return item.move?.to === item.id ? { ...m, inserted: [] } : m;
    });
    ed.setDecorations(this.removed, all.flatMap((m) => m.removed.map((r) => ({ range: r }))));
    const max = inlineMax(ed.document.uri);
    ed.setDecorations(
      this.inserted,
      usesHints(ed.document.uri)
        ? []
        : all.flatMap((m) => m.inserted.map((i) => ({ range: new vscode.Range(i.at, i.at), renderOptions: { after: { contentText: ghostText(i.text, max) } } }))),
    );
    const notes = this.moveNotes(ed.document, located);
    const deco = (n: (typeof notes)[number]) => ({ range: new vscode.Range(n.at, n.at), renderOptions: { after: { contentText: n.text } } });
    ed.setDecorations(this.moveLabel, notes.filter((n) => !n.changed).map(deco));
    ed.setDecorations(this.moveChanged, notes.filter((n) => n.changed).map(deco));
  }

  /** Notes for the halves of moves in a document: after the moved-out passage, at the insertion point. */
  private moveNotes(doc: vscode.TextDocument, located: Located[]): { at: vscode.Position; text: string; changed: boolean }[] {
    const p = this.host.projectFor(doc.uri);
    if (!p) return [];
    const model = this.host.model(p);
    const lineOf = new Map(located.map((l) => [l.item.id, l.range.start.line + 1]));
    const out: { at: vscode.Position; text: string; changed: boolean }[] = [];
    for (const { item, range } of located) {
      const note = moveNote(item, model.get, (id) => lineOf.get(id) ?? null);
      if (!note) continue;
      // The moved-out passage usually ends with its line break: put the note on its last line of text.
      const last = range.end.character === 0 && range.end.line > range.start.line ? range.end.line - 1 : range.end.line;
      out.push({ at: movesOut(item) ? doc.lineAt(last).range.end : range.start, ...note });
    }
    return out;
  }

  /** The proposed new text, each part right where it goes (after the struck-through text it replaces). */
  async provideInlayHints(doc: vscode.TextDocument, range: vscode.Range): Promise<vscode.InlayHint[]> {
    if (!vscode.workspace.getConfiguration("stet").get<boolean>("inlineChanges", true) || !usesHints(doc.uri)) return [];
    const max = inlineMax(doc.uri);
    const hints: vscode.InlayHint[] = [];
    for (const { item, range: span } of await this.locator.locate(doc)) {
      if (!item.newText || item.move || !range.intersection(span)) continue;
      const tip = new vscode.MarkdownString(`**${item.id}** proposes:\n\n${fence(item.newText, "latex")}`);
      for (const ins of marks(doc, item, span).inserted) {
        if (!range.contains(ins.at)) continue;
        // Kind "parameter": its colour can be set apart from other hints (Stet: Highlight proposed text).
        const hint = new vscode.InlayHint(ins.at, ghostText(ins.text, max), vscode.InlayHintKind.Parameter);
        hint.tooltip = tip;
        hints.push(hint);
      }
    }
    return hints;
  }

  async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!vscode.workspace.getConfiguration("stet").get<boolean>("codeLens", true)) return [];
    const p = this.host.projectFor(doc.uri);
    if (!p) return [];
    const model = this.host.model(p);
    const lenses: vscode.CodeLens[] = [];
    const ref = (id: string): Ref => ({ path: p.mainPath, id });
    for (const { item, range } of await this.locator.locate(doc)) {
      const at = new vscode.Range(range.start, range.start);
      const linked = model.linkedGroup(item);
      const part = model.partOf(item);
      const rest = model.linkedRest([item.id]);
      const tag = item.status === "needs_revision" ? " (revision requested)" : "";
      // Linked changes are accepted together: the whole group, or the item's part of it.
      const unit = part ? partId(part.group.id, part.index) : linked?.id;
      if (item.move && rest.every((r) => moveOthers(item).includes(r.id))) {
        // A move on its own: one decision for all of it (the commands take the rest along).
        const other = model.others(item).find((o) => movesOut(o) !== movesOut(item));
        lenses.push(
          new vscode.CodeLens(at, { title: `${item.id}${tag}: ✓ Accept move`, command: "stet.accept", arguments: [ref(item.id)] }),
          new vscode.CodeLens(at, { title: "✗ Reject move", command: "stet.reject", arguments: [ref(item.id)] }),
          new vscode.CodeLens(at, { title: "↻ Revise", command: "stet.revise", arguments: [ref(item.id)] }),
          new vscode.CodeLens(at, { title: "💬 Comment", command: "stet.comment", arguments: [ref(item.id)] }),
          ...(other ? [new vscode.CodeLens(at, { title: movesOut(item) ? "↓ Go to destination" : "↑ Go to source", command: "stet.showItem", arguments: [ref(other.id)] })] : []),
        );
        continue;
      }
      const accept = !rest.length
        ? `${item.id}${tag}: ✓ Accept`
        : part
          ? `${item.id}${tag}: ✓ Accept part ${part.index + 1} of ${part.group.parts!.length} (${rest.length + 1} changes)`
          : `${item.id}${tag}: ✓ Accept all ${rest.length + 1} linked`;
      lenses.push(
        new vscode.CodeLens(at, {
          title: accept,
          command: rest.length && unit ? "stet.acceptGroup" : "stet.accept",
          arguments: [ref(rest.length && unit ? unit : item.id)],
        }),
        new vscode.CodeLens(at, { title: "✗ Reject", command: "stet.reject", arguments: [ref(item.id)] }),
        new vscode.CodeLens(at, { title: "✎ Edit", command: "stet.edit", arguments: [ref(item.id)] }),
        new vscode.CodeLens(at, { title: "↻ Revise", command: "stet.revise", arguments: [ref(item.id)] }),
        new vscode.CodeLens(at, { title: "💬 Comment", command: "stet.comment", arguments: [ref(item.id)] }),
      );
    }
    return lenses;
  }

  async provideHover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | undefined> {
    const p = this.host.projectFor(doc.uri);
    if (!p) return undefined;
    const hits = (await this.locator.locate(doc)).filter(({ range }) => range.contains(pos) || range.end.isEqual(pos));
    if (!hits.length) return undefined;
    const model = this.host.model(p);
    const ref = (id: string): Ref => ({ path: p.mainPath, id });
    const parts = hits.map(({ item }) => {
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ["stet.accept", "stet.acceptGroup", "stet.reject", "stet.edit", "stet.revise", "stet.comment", "stet.showDiff", "stet.preview"] };
      md.supportHtml = false;
      md.appendMarkdown(itemMarkdown(item, model));
      const pdf = this.host.previewHover?.(p, item);
      if (pdf) md.appendMarkdown(`\n\n${pdf}`);
      md.appendMarkdown(
        `\n\n[✓ Accept](${cmd("stet.accept", [ref(item.id)])}) · [✗ Reject](${cmd("stet.reject", [ref(item.id)])}) · ` +
          `[✎ Edit](${cmd("stet.edit", [ref(item.id)])}) · [↻ Revise](${cmd("stet.revise", [ref(item.id)])}) · ` +
          `[💬 Comment](${cmd("stet.comment", [ref(item.id)])}) · [Diff](${cmd("stet.showDiff", [ref(item.id)])}) · [PDF](${cmd("stet.preview", [ref(item.id)])})`,
      );
      return md;
    });
    return new vscode.Hover(parts, hits[0]!.range);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.removed.dispose();
    this.inserted.dispose();
    this.moveLabel.dispose();
    this.moveChanged.dispose();
    this.lensChanged.dispose();
    this.hintsChanged.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Escape agent-written text for Markdown, so it cannot add links or formatting. */
export const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");

/** Markdown description of an item (hover, tooltips). */
export function itemMarkdown(item: Item, model: TreeModel): string {
  const cs = model.snap.changesets.find((c) => c.id === item.changeset);
  const lines = [`**${item.id}** · ${esc(item.agent)} · ${STATUS_TEXT[item.status]}`];
  if (cs) lines.push(`*${esc(cs.title)}*${cs.rationale ? ` — ${esc(cs.rationale)}` : ""}`);
  if (item.note) lines.push(esc(item.note));
  for (const gid of item.groups) {
    const g = model.group(gid);
    if (g && g.kind !== "atomic") lines.push(`${g.kind === "linked" ? "🔗 linked" : "▣ related"}: ${esc(g.title)} (${g.items.join(", ")})${g.state === "broken" ? " ⚠ broken" : ""}`);
    const k = g ? partIndexOf(g, item.id) : -1;
    if (g && k >= 0) lines.push(`part ${k + 1} of ${g.parts!.length}: ${esc(g.parts![k]!.title)} (${g.parts![k]!.items.join(", ")})`);
  }
  if (item.move) {
    const out = movesOut(item);
    const files = [...new Set(model.others(item).map((o) => o.file).filter((f) => f !== item.file))];
    const from = (item.move.from instanceof Array ? item.move.from : [item.move.from]).join(", ");
    const to = (item.move.to instanceof Array ? item.move.to : [item.move.to]).join(", ");
    lines.push(`⇅ **Move**: ${from} remove${out ? " text here" : ""}, ${to} insert${out ? "" : " it here"}${files.length ? ` (also in ${files.map(esc).join(", ")})` : ""}. Accepting or rejecting one decides the whole move.`);
    const texts = moveTexts(item.move, model.get);
    const changes = texts ? moveChanges(texts.from, texts.to) : [];
    if (changes.length) {
      lines.push(`⚠ **Changed on the way (${item.move.changed} word${item.move.changed > 1 ? "s" : ""}):** ${changes.map((c) => `“${esc(c.was)}” → “${esc(c.now)}”`).join(", ")}`);
    } else lines.push("Word for word: the text arrives unchanged (spacing and line breaks aside).");
    lines.push(fence(out ? item.oldText : item.newText, "latex"));
  } else if (item.kind === "modify") lines.push(diffBlock(item.oldText, item.newText));
  else lines.push(`${item.kind} ${esc(item.file)}${item.oldFile ? ` (from ${esc(item.oldFile)})` : ""}`);
  const last = item.thread.slice(-3);
  if (last.length) lines.push(last.map((t) => `> **${t.author === "user" ? "You" : esc(item.agent)}:** ${esc(t.text)}`).join("\n>\n"));
  return lines.join("\n\n");
}

/** Read-only documents for `stet.showDiff`: `stet-diff:/<project>/<item>/<side>/<file>`. */
export class DiffContent implements vscode.TextDocumentContentProvider {
  constructor(private resolveSide: (uri: vscode.Uri) => Promise<string>) {}
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    return this.resolveSide(uri);
  }
}

