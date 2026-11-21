/** PDF previews: setting them up, the extra fonts, and opening the preview panel. */
import { documentProfile, foldPath, hasPreview, profileByName } from "@stet/core";
import * as vscode from "vscode";
import type { StetExtension } from "./extension.js";
import { previewNotice, previewPlace } from "./preview.js";
import type { Project } from "./project.js";

export class PreviewCommands {
  constructor(private readonly ext: StetExtension) {}

  /** Say once what PDF previews need here (nothing when they work). Never sets anything up unasked. */
  async checkPreviews(p: Project): Promise<void> {
    try {
      // A language without previews (Typst): nothing to tell at startup, and no preview entries
      // (test report 5e4c6af, B3, B8 and accessibility).
      const doc = documentProfile(await p.stet.config());
      if (!doc.typesetter) {
        if (!this.noPreviews.has(foldPath(p.mainPath)))
          this.ext.output.appendLine(`PDF previews in ${p.name}: Stet has no PDF previews for ${doc.name} projects yet.`);
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

  /** Projects in a language Stet has no PDF previews for (Typst), by key. */
  noPreviews = new Set<string>();

  /** Build the preview image: downloads packages, so only on the user's click. */
  async setupPreview(p?: Project): Promise<void> {
    p ??= await this.ext.setupWizard.pickProject();
    if (!p) return;
    const project = p;
    // Said at once, without a progress note about downloads (test report 5e4c6af, B3).
    const doc = documentProfile(await project.stet.config());
    if (!doc.typesetter)
      return void vscode.window.showInformationMessage(
        `Stet has no PDF previews for ${doc.name} projects yet, so there is nothing to set up in ${project.name}.`,
      );
    const r = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title:
          (await project.stet.previewStatus(true)).toolSource === "image"
            ? "Stet: building the PDF preview image with its own TeX Live (about 1 GB, this takes a while)…"
            : "Stet: building the PDF preview image (downloads Debian, Perl and Poppler)…",
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

  /** Projects asked about the extra fonts in this session (asked once each). */
  private askedExtras = new Set<string>();

  /** A preview misses files the extra fonts may bring: ask once whether to install them. */
  async offerExtras(p: Project, files: string[]): Promise<void> {
    if (this.askedExtras.has(p.mainPath)) return;
    this.askedExtras.add(p.mainPath);
    const install = "Install (about 2 GB)";
    const pick = await vscode.window.showInformationMessage(
      `Stet: a PDF preview in ${p.name} needs ${files.join(", ")}, which the preview's TeX doesn't have. Its extra fonts may (dsfont, bbm, bbold and many more). Install them?`,
      install,
      "Not now",
    );
    if (pick === install) await this.runExtras(p);
  }

  /** The panel's button: ask before downloading, then install. */
  async installExtras(p: Project): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      "Install TeX's extra fonts for PDF previews?",
      { modal: true, detail: "Podman downloads Debian's texlive-fonts-extra (about 2 GB) into a second preview image. Previews then use that image." },
      "Install",
    );
    if (ok === "Install") await this.runExtras(p);
  }

  private async runExtras(p: Project): Promise<void> {
    const r = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Stet: adding TeX's extra fonts to the PDF preview image (about 2 GB, this takes a while)…" },
      () => p.stet.setupPreview({ extras: true }).catch((e: any) => ({ ok: false, log: String(e?.message ?? e), status: undefined })),
    );
    if (r.ok) void vscode.window.showInformationMessage("Stet: extra fonts installed; previews are built again with them.");
    else {
      this.ext.output.appendLine(r.log);
      void vscode.window
        .showErrorMessage("Stet: adding the extra fonts failed. Details are in the Stet output.", "Show output")
        .then((c) => c && this.ext.output.show());
    }
    this.ext.preview.refresh();
  }

  /** Open the PDF preview of a change. */
  async showPreview(arg: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    // `p` on a Typst change opened an empty preview panel (test report 5e4c6af, B8).
    if (t.item.kind !== "modify" || !hasPreview(t.item.file))
      return void vscode.window.showInformationMessage(
        `Stet has no PDF preview for ${t.item.id}: ${t.item.kind !== "modify" ? "it is not a text change" : `there are no PDF previews for ${profileByName(t.item.file).name} files yet`}.`,
      );
    if (previewPlace() === "off")
      return void vscode.window.showInformationMessage("PDF previews are off (setting stet.pdfPreviews, or View options in the Stet panel).");
    this.ext.preview.show(t);
  }
}
