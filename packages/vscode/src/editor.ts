/** In-editor review: inline decorations, CodeLens actions, hovers, and diff documents. */
import * as vscode from "vscode";
import type { Item } from "@stet/core";
import { diffBlock, ghostText, isLive, LineIndex, STATUS_TEXT, toLf, type Ref, type TreeModel } from "./model.js";
import type { Project } from "./project.js";

export interface Located {
  item: Item;
  range: vscode.Range;
}

export interface Host {
  projectFor(uri: vscode.Uri): Project | undefined;
  model(p: Project): TreeModel;
  readonly onDidChange: vscode.Event<void>;
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

const cmd = (command: string, args: unknown[]) => `command:${command}?${encodeURIComponent(JSON.stringify(args))}`;

export class EditorIntegration implements vscode.CodeLensProvider, vscode.HoverProvider, vscode.Disposable {
  private readonly removed = vscode.window.createTextEditorDecorationType({
    textDecoration: "line-through",
    backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly inserted = vscode.window.createTextEditorDecorationType({
    after: {
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
      fontStyle: "italic",
      margin: "0 0 0 1px",
    },
    overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.modifiedForeground"),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private readonly lensChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensChanged.event;
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
      host.onDidChange(() => this.update()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.update()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.update(300);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("stet")) this.update();
      }),
    );
  }

  update(delay = 0): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.lensChanged.fire();
      for (const ed of vscode.window.visibleTextEditors) void this.decorate(ed);
    }, delay);
  }

  private async decorate(ed: vscode.TextEditor): Promise<void> {
    const on = vscode.workspace.getConfiguration("stet").get<boolean>("inlineChanges", true);
    const located = on ? await this.locator.locate(ed.document) : [];
    const removed: vscode.DecorationOptions[] = [];
    const inserted: vscode.DecorationOptions[] = [];
    for (const { item, range } of located) {
      if (!range.isEmpty) removed.push({ range });
      if (item.newText) {
        inserted.push({
          range: new vscode.Range(range.end, range.end),
          renderOptions: { after: { contentText: ghostText(item.newText), color: new vscode.ThemeColor("editorGhostText.foreground") } },
        });
      }
    }
    ed.setDecorations(this.removed, removed);
    ed.setDecorations(this.inserted, inserted);
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
      const rest = model.linkedRest([item.id]);
      const tag = item.status === "needs_revision" ? " (revision requested)" : "";
      lenses.push(
        new vscode.CodeLens(at, {
          title: rest.length ? `${item.id}${tag}: ✓ Accept all ${rest.length + 1} linked` : `${item.id}${tag}: ✓ Accept`,
          command: rest.length && linked ? "stet.acceptGroup" : "stet.accept",
          arguments: [ref(rest.length && linked ? linked.id : item.id)],
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
      md.isTrusted = { enabledCommands: ["stet.accept", "stet.acceptGroup", "stet.reject", "stet.edit", "stet.revise", "stet.comment", "stet.showDiff"] };
      md.supportHtml = false;
      md.appendMarkdown(itemMarkdown(item, model));
      md.appendMarkdown(
        `\n\n[✓ Accept](${cmd("stet.accept", [ref(item.id)])}) · [✗ Reject](${cmd("stet.reject", [ref(item.id)])}) · ` +
          `[✎ Edit](${cmd("stet.edit", [ref(item.id)])}) · [↻ Revise](${cmd("stet.revise", [ref(item.id)])}) · ` +
          `[💬 Comment](${cmd("stet.comment", [ref(item.id)])}) · [Diff](${cmd("stet.showDiff", [ref(item.id)])})`,
      );
      return md;
    });
    return new vscode.Hover(parts, hits[0]!.range);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.removed.dispose();
    this.inserted.dispose();
    this.lensChanged.dispose();
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
  }
  if (item.kind === "modify") lines.push(diffBlock(item.oldText, item.newText));
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

