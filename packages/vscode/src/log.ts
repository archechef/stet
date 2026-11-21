/**
 * Stet's output channel (View → Output → Stet), where failures the extension handles without a
 * message (a check skipped, a fallback taken, a project that didn't open) are kept, so they can be
 * found when something looks wrong.
 */
import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;
/** The last message per kind of failure: a check that fails on every refresh is noted once. */
const last = new Map<string, string>();

export const output = (): vscode.OutputChannel => (channel ??= vscode.window.createOutputChannel("Stet"));

/** Empty the channel (for `stet doctor`'s report); failures seen before are noted again. */
export function clearOutput(): void {
  output().clear();
  last.clear();
}

/** The text of a thrown value. */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Note a failure that is handled: `what` failed, because of `e`. Noted again only when it changes. */
export function warn(what: string, e: unknown): void {
  const text = errorText(e);
  if (last.get(what) === text) return;
  last.set(what, text);
  output().appendLine(`[${new Date().toLocaleTimeString()}] ${what}: ${text}`);
}
