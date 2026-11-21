/** Results of what the user did, said so that a screen reader reads them out too. */
import * as vscode from "vscode";

/** Whether VS Code is set up for a screen reader (`editor.accessibilitySupport`). */
export const screenReader = (): boolean => vscode.workspace.getConfiguration("editor").get<string>("accessibilitySupport") === "on";

/**
 * A result, in the status bar for a few seconds; for a screen reader also as a notification, which
 * it reads out: status-bar messages are not. Every result goes through here.
 */
export function announce(text: string, ms = 5000): void {
  vscode.window.setStatusBarMessage(text, ms);
  if (screenReader()) void vscode.window.showInformationMessage(text.replace(/\$\([\w-]+\)\s*/g, ""));
}
