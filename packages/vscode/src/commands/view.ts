/** View options: Stet's settings switched from the panel, and the colours of proposed text. */
import * as vscode from "vscode";
import { announce } from "../announce.js";
import { usesHints } from "../editor.js";
import type { StetExtension } from "../extension.js";
import { offerContrastStyle } from "../questions.js";
import type { Settings } from "../settings.js";

/**
 * Green for Stet's proposed text in word-wrapped editors. Inlay hints can't be coloured per hint,
 * only per kind in the user's colour customizations; Stet's hints are of kind "parameter".
 */
const HIGHLIGHT: Record<string, string> = {
  "editorInlayHint.parameterForeground": "#2DA44E",
  "editorInlayHint.parameterBackground": "#2EA04326",
};
const HIGHLIGHT_PREVIOUS = "stet.highlightPrevious";

export class ViewOptions {
  constructor(private readonly ext: StetExtension) {}

  /**
   * In a High Contrast theme, proposed text drawn as an inlay hint (the wrapping style) has no
   * border and no colour, and screen readers skip it: offer once to use the highlighted style,
   * which has the border.
   */
  async offerContrastStyle(uri: vscode.Uri): Promise<void> {
    const memo = "stet.askedContrastStyle";
    const kind = vscode.window.activeColorTheme.kind;
    const highContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
    const ask = offerContrastStyle({
      highContrast,
      inProject: !!this.ext.projectFor(uri),
      wrapsWithLine: usesHints(uri),
      askedBefore: !!this.ext.ctx.globalState.get<boolean>(memo),
    });
    if (!ask) return;
    await this.ext.ctx.globalState.update(memo, true);
    const use = "Use the highlighted style";
    const pick = await vscode.window.showInformationMessage(
      // Neither style is read by screen readers (decorations aren't): said so, not implied.
      "In High Contrast themes, proposed text that wraps with the line has no border or colour of its own. Use the highlighted style instead, which has a border? (It doesn't wrap with the line.) Screen readers read neither style; the Stet panel and each change's hover say what it proposes.",
      use,
      "Keep wrapping",
    );
    if (pick === use) await this.setOption("newTextStyle", "highlighted");
  }

  /** Set one of Stet's settings from the panel's View options (where it is set already, or for the user). */
  async setOption<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    if (key === "shareEdits") return this.setShareOption(value as Settings["shareEdits"]);
    const conf = vscode.workspace.getConfiguration("stet");
    const i = conf.inspect(key);
    const target = i?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await conf.update(key, value, target);
  }

  /**
   * Share my edits, set from View options: for one project, which is asked for when the window has
   * several; set on its workspace folder, so another paper's agents don't see this one's drafts. The project's own config follows (`applyShareMode`).
   */
  private async setShareOption(value: Settings["shareEdits"]): Promise<void> {
    const p = await this.ext.setupWizard.pickProject();
    if (!p) return;
    const uri = vscode.Uri.file(p.mainPath);
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    const conf = vscode.workspace.getConfiguration("stet", uri);
    const target =
      folders.length > 1 && folder
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : folders.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    await conf.update("shareEdits", value, target);
    if (folders.length > 1) announce(`$(check) Share my edits: ${String(value)}, for ${p.name} only`, 4000);
  }

  private colorCustomizations(): Record<string, unknown> {
    return { ...(vscode.workspace.getConfiguration("workbench").inspect<Record<string, unknown>>("colorCustomizations")?.globalValue ?? {}) };
  }

  /** Whether proposed text is green in word-wrapped editors too (Stet's colours are set). */
  highlighted(): boolean {
    const cc = this.colorCustomizations();
    return Object.entries(HIGHLIGHT).every(([k, v]) => cc[k] === v);
  }

  async updateHighlightContext(): Promise<void> {
    await vscode.commands.executeCommand("setContext", "stet.highlighted", this.highlighted());
  }

  /** View options: green proposed text in word-wrapped editors, or back to the theme's colours. */
  async setHighlight(on: boolean): Promise<void> {
    const cc = this.colorCustomizations();
    if (on) {
      // Keep the user's own values for these keys, to restore them when switched off.
      const previous = Object.fromEntries(
        Object.keys(HIGHLIGHT)
          .filter((k) => k in cc && cc[k] !== HIGHLIGHT[k])
          .map((k) => [k, cc[k]]),
      );
      await this.ext.ctx.globalState.update(HIGHLIGHT_PREVIOUS, previous);
      Object.assign(cc, HIGHLIGHT);
    } else {
      for (const k of Object.keys(HIGHLIGHT)) delete cc[k];
      Object.assign(cc, this.ext.ctx.globalState.get<Record<string, unknown>>(HIGHLIGHT_PREVIOUS) ?? {});
      await this.ext.ctx.globalState.update(HIGHLIGHT_PREVIOUS, undefined);
    }
    await vscode.workspace
      .getConfiguration("workbench")
      .update("colorCustomizations", Object.keys(cc).length ? cc : undefined, vscode.ConfigurationTarget.Global);
    await this.updateHighlightContext();
    if (on) {
      void vscode.window.showInformationMessage(
        "Stet: proposed text is now green in word-wrapped editors too (without word wrap it always is). " +
          "This colours parameter-name hints in your user settings; other extensions' parameter hints turn green as well. Untick it in View options to undo.",
      );
    }
  }
}
