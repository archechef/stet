/**
 * Stet's VS Code settings (`stet.*`): their keys, values and defaults in one place. `package.json`
 * declares them for VS Code's settings page; `test/settings.test.ts` checks that the two agree.
 */
import { SHARE_MODES } from "@stet/core";
import * as vscode from "vscode";

export const NAVIGATION_ORDERS = ["panel", "document"] as const;
export const LONG_MODES = ["expanded", "collapsed", "hover"] as const;
export const NEW_TEXT_STYLES = ["auto", "highlighted", "wrapping"] as const;
export const RUNTIME_MODES = ["auto", "node", "vscode"] as const;
export const PREVIEW_PLACES = ["both", "hover", "panel", "off"] as const;
export const GROUP_BY = ["round", "file"] as const;

/** The values a setting with a fixed list of them may take. */
export const CHOICES = {
  navigationOrder: NAVIGATION_ORDERS,
  longChanges: LONG_MODES,
  newTextStyle: NEW_TEXT_STYLES,
  runtime: RUNTIME_MODES,
  shareEdits: SHARE_MODES,
  pdfPreviews: PREVIEW_PLACES,
  groupBy: GROUP_BY,
} as const;

type Choice<K extends keyof typeof CHOICES> = (typeof CHOICES)[K][number];

export type Settings = {
  autoAdvance: boolean;
  navigationOrder: Choice<"navigationOrder">;
  codeLens: boolean;
  diffShowsProposals: boolean;
  inlineChanges: boolean;
  longChanges: Choice<"longChanges">;
  /** Characters of proposed text shown inline per change; 0: no limit of Stet's own. */
  inlineTextLength: number;
  newTextStyle: Choice<"newTextStyle">;
  runtime: Choice<"runtime">;
  shareEdits: Choice<"shareEdits">;
  pdfPreviews: Choice<"pdfPreviews">;
  /** The Review panel and History: changes by round, or by file. */
  groupBy: Choice<"groupBy">;
  /** History by file: the latest rounds shown per file; 0: all. */
  historyRoundsPerFile: number;
};

export const DEFAULTS: Readonly<Settings> = {
  autoAdvance: true,
  navigationOrder: "panel",
  codeLens: true,
  diffShowsProposals: false,
  inlineChanges: true,
  longChanges: "collapsed",
  inlineTextLength: 0,
  newTextStyle: "auto",
  runtime: "auto",
  shareEdits: "manual",
  pdfPreviews: "both",
  groupBy: "round",
  historyRoundsPerFile: 3,
};

/** The settings that are on or off (View options toggles them). */
export type Toggle = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

/**
 * A setting's value, for `scope` (a file, for settings per folder) or the window. A value VS Code
 * would only warn about in settings.json (a misspelt choice, a string for a switch) counts as unset.
 */
export function setting<K extends keyof Settings>(key: K, scope?: vscode.Uri): Settings[K] {
  const v: unknown = vscode.workspace.getConfiguration("stet", scope).get(key);
  return valid(key, v) ? v : DEFAULTS[key];
}

function valid<K extends keyof Settings>(key: K, v: unknown): v is Settings[K] {
  const choices: readonly unknown[] | undefined = key in CHOICES ? CHOICES[key as keyof typeof CHOICES] : undefined;
  if (choices) return choices.includes(v);
  // Numbers are counts: whole and not negative.
  if (typeof DEFAULTS[key] === "number") return typeof v === "number" && Number.isInteger(v) && v >= 0;
  return typeof v === typeof DEFAULTS[key];
}
