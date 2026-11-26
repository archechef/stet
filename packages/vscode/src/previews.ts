/** Previews: setting PDF previews up, the extra fonts, rendering Markdown, and opening the preview panel. */
import { join } from "node:path";
import {
  documentProfile,
  foldPath,
  type Item,
  isLiveItem,
  type Missing,
  type PreviewResult,
  profileHasPreview,
  profileRenderer,
  type SetupAction,
} from "@stet/core";
import * as vscode from "vscode";
import type { StetExtension } from "./extension.js";
import { cleanTags } from "./markdownPreview.js";
import { previewNotice, previewPlace } from "./preview.js";
import type { RenderedResult } from "./previewPage.js";
import type { Project } from "./project.js";

type Target = { project: Project; item: Item };

/** Whether VS Code shows a change rendered (a text change in review, in a Markdown file). */
export function isRendered(p: Project, item: Item): boolean {
  return item.kind === "modify" && isLiveItem(item) && profileRenderer(p.profile(item.file)) === "markdown";
}

export class PreviewCommands {
  constructor(private readonly ext: StetExtension) {}

  /** Say once what PDF previews need here (nothing when they work). Never sets anything up unasked. */
  async checkPreviews(p: Project): Promise<void> {
    try {
      // A language without PDF previews (Lean, Markdown): nothing to tell at startup, and no preview entries.
      const doc = documentProfile(await p.stet.config());
      if (!doc.typesetter) {
        if (!this.noPreviews.has(foldPath(p.mainPath)))
          this.ext.output.appendLine(
            `PDF previews in ${p.name}: ${doc.renderer ? `${doc.name} projects have none; changes to ${doc.name} files show rendered in the preview panel.` : `Stet has no PDF previews for ${doc.name} projects yet.`}`,
          );
        this.noPreviews.add(foldPath(p.mainPath));
        void this.ext.onProjectChanged();
        return;
      }
      this.noPreviews.delete(foldPath(p.mainPath));
    } catch {
      /* the checks below say what is wrong */
    }
    if (previewPlace() === "off") return;
    try {
      const env = await p.stet.previewStatus();
      this.ext.output.appendLine(`PDF previews in ${p.name}: ${env.status}. ${env.message}`);
      if (await previewNotice(env, this.ext.ctx.globalState, p.name, foldPath(p.mainPath))) await this.setupPreview(p);
    } catch (e: any) {
      this.ext.output.appendLine(`PDF previews in ${p.name}: ${e?.message ?? e}`);
    }
  }

  /** Projects in a language Stet has no PDF previews for (Lean), by key. */
  noPreviews = new Set<string>();

  /** Build the preview image: downloads packages, so only on the user's click. */
  async setupPreview(p?: Project): Promise<void> {
    p ??= await this.ext.setupWizard.pickProject();
    if (!p) return;
    const project = p;
    // Said at once, without a progress note about downloads.
    const doc = documentProfile(await project.stet.config());
    if (!doc.typesetter)
      return void vscode.window.showInformationMessage(
        doc.renderer
          ? `${doc.name} projects have no PDF previews to set up: Stet shows changes to ${doc.name} files rendered, with VS Code's own renderer.`
          : `Stet has no PDF previews for ${doc.name} projects yet, so there is nothing to set up in ${project.name}.`,
      );
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Stet: building the PDF preview image${await project.stet.previewStatus(true).then(
          (s) => (s.download ? ` (downloads ${s.download}; this can take a while)` : ""),
          () => "",
        )}…`,
      },
      () => project.stet.setupPreview().catch((e: any) => ({ ok: false, log: String(e?.message ?? e), status: undefined })),
    );
    if (r.ok) void vscode.window.showInformationMessage(`Stet: ${r.status?.message ?? "PDF previews are set up."}`);
    else {
      this.ext.output.appendLine(r.log);
      void vscode.window
        .showErrorMessage("Stet: building the PDF preview image failed. Details are in the Stet output.", "Show output")
        .then((c) => c && this.ext.output.show());
    }
    this.ext.preview.refresh();
  }

  /** Projects asked about the typesetter's extras in this session (asked once each). */
  private askedExtras = new Set<string>();

  /**
   * A preview misses files the typesetter's setup action may bring (LaTeX: the extra fonts): ask
   * once whether to install it. Its texts are the typesetter's (core profile review db49f7d, 9).
   */
  async offerExtras(p: Project, missing: Missing): Promise<void> {
    const a = missing.action;
    if (!a || this.askedExtras.has(p.mainPath)) return;
    this.askedExtras.add(p.mainPath);
    const install = `Install (${a.download})`;
    const pick = await vscode.window.showInformationMessage(
      `Stet: a PDF preview in ${p.name} needs ${missing.files.join(", ")}, which the preview doesn't have. ${a.label[0]!.toUpperCase()}${a.label.slice(1)} may (${a.brings}). Install them?`,
      install,
      "Not now",
    );
    if (pick === install) await this.runExtras(p, a);
  }

  /** The panel's button: ask before downloading, then install. */
  async installExtras(p: Project): Promise<void> {
    const a = (await p.stet.previewSetupActions()).find((x) => x.bringsMissing);
    if (!a) return void vscode.window.showInformationMessage("This project's PDF previews have nothing to add.");
    const ok = await vscode.window.showWarningMessage(`Install ${a.label} for PDF previews?`, { modal: true, detail: a.detail }, "Install");
    if (ok === "Install") await this.runExtras(p, a);
  }

  private async runExtras(p: Project, a: SetupAction): Promise<void> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Stet: adding ${a.label} to the PDF preview image (${a.download}, this takes a while)…` },
      () => p.stet.setupPreview({ action: a.id }).catch((e: any) => ({ ok: false, log: String(e?.message ?? e), status: undefined })),
    );
    if (r.ok) void vscode.window.showInformationMessage(`Stet: ${a.label} installed; previews are built again with them.`);
    else {
      this.ext.output.appendLine(r.log);
      void vscode.window
        .showErrorMessage(`Stet: adding ${a.label} failed. Details are in the Stet output.`, "Show output")
        .then((c) => c && this.ext.output.show());
    }
    this.ext.preview.refresh();
  }

  /**
   * A Markdown change rendered by VS Code's Markdown renderer: the block around it in your file,
   * before and after, the changed text marked.
   */
  async renderMarkdown(t: Target): Promise<RenderedResult | PreviewResult> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(t.project.mainPath, t.item.file)));
    const hit = (await this.ext.locator.locate(doc)).find((l) => l.item.id === t.item.id);
    if (!hit) return { status: "unavailable", message: `Stet can't find ${t.item.id} in ${t.item.file} any more, so there is nothing to render.` };
    // The source to render is the profile's to say: the block around the change, marked.
    const source = t.project.profile(t.item.file).renderSource;
    if (!source) return { status: "unavailable", message: `Stet can't render changes to ${t.project.profile(t.item.file).name} files.` };
    const { before, after } = source(doc.getText(), doc.offsetAt(hit.range.start), doc.offsetAt(hit.range.end), t.item.newText);
    const render = async (markdown: string) => {
      const out = await vscode.commands.executeCommand<unknown>("markdown.api.render", markdown);
      if (typeof out !== "string") throw new Error("no HTML");
      return cleanTags(out);
    };
    try {
      const [b, a] = await Promise.all([render(before), render(after)]);
      return { status: "rendered", before: b, after: a };
    } catch {
      return {
        status: "unavailable",
        message: "VS Code's Markdown renderer isn't available, so Stet can't render this change.",
        fix: "Enable the built-in extension “Markdown Language Features”.",
      };
    }
  }

  /** Open the preview of a change: its PDF preview, or the change rendered (Markdown). */
  async showPreview(arg: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    // Rendered by VS Code: whatever the PDF previews' setting says.
    if (isRendered(t.project, t.item)) return void this.ext.preview.show(t);
    // `p` on a Typst change opened an empty preview panel.
    if (t.item.kind !== "modify" || !t.project.pdfPreview(t.item.file))
      return void vscode.window.showInformationMessage(
        `Stet has no ${profileRenderer(t.project.profile(t.item.file)) ? "rendered" : "PDF"} preview for ${t.item.id}: ${
          t.item.kind !== "modify"
            ? "it is not a text change"
            : profileRenderer(t.project.profile(t.item.file))
              ? "only changes in review are rendered"
              : profileHasPreview(t.project.profile(t.item.file), t.item.file)
                ? `this project compiles ${documentProfile(await t.project.stet.config()).name}, not ${t.project.profile(t.item.file).name}`
                : `there are no PDF previews for ${t.project.profile(t.item.file).name} files yet`
        }.`,
      );
    if (previewPlace() === "off")
      return void vscode.window.showInformationMessage("PDF previews are off (setting stet.pdfPreviews, or View options in the Stet panel).");
    this.ext.preview.show(t);
  }
}
