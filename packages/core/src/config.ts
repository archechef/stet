/** Repository configuration (spec §11). */
import { StetError } from "./errors.js";
import { DOCUMENT_LANGUAGES, documentProfile, type FilePatterns, PROFILES } from "./lang/index.js";
import { DEFAULT_PREVIEW, PREVIEW_ISOLATIONS, PREVIEW_TEX, type PreviewConfig } from "./preview/env.js";

export { matchesAny } from "./lang/index.js";

export interface SplitConfig {
  mergeGap: number;
  rewriteRatio: number;
  ignoreReflow: boolean;
  abbreviations: string[];
}

export interface GroupingConfig {
  autoRepeatMin: number;
  autoDetect: ("repeat" | "label" | "cite" | "macro" | "input")[];
  refCommands: string[];
  citeCommands: string[];
  /**
   * Moves (spec §6.4.7): a passage deleted in one place and inserted in another is shown as one
   * move if it has at least `minWords` words and is a sentence or more, or a whole paragraph or
   * environment. One changed word per 10 words (at least one) still counts as a move, with the
   * changes shown; `maxChangedWords`, if set, caps that. A passage moved and changed more than
   * that is a deletion and an insertion, linked.
   */
  moves: { enabled: boolean; minWords: number; maxChangedWords: number | null };
}

export const SHARE_MODES = ["manual", "saved", "committed"] as const;
export type ShareMode = (typeof SHARE_MODES)[number];

export const AUTO_COMMIT = ["on-finish", "when-clean", "never"] as const;

export interface StetConfig {
  mainBranch: string;
  /** How to run the `stet` CLI; recorded by `stet init` for hooks and MCP configs. */
  cli?: { command: string; args: string[]; env?: Record<string, string> };
  /** Install git hooks that block merges/pushes of agent branches (spec §9). */
  guardHooks: boolean;
  agentBranchPrefix: string;
  worktreeRoot: string;
  /**
   * When accepted changes are committed: "on-finish" (default) in one commit when the user
   * finishes the review; "when-clean" after every accept whose files had no other uncommitted
   * edits. "never" is the old name of "on-finish".
   */
  autoCommit: (typeof AUTO_COMMIT)[number];
  /**
   * Which of the user's own edits agents see (spec §7.3): "manual" (default) the saved files as of
   * the user's last *Share my edits* (`stet share`); "saved" the saved files whenever an agent
   * looks; "committed" only committed text. Accepted changes always reach agents.
   */
  shareEdits: ShareMode;
  split: SplitConfig;
  grouping: GroupingConfig;
  /** Which files each language profile is for: `tex`, `bib`, `typ`, `lean` (spec §6.1). */
  files: FilePatterns;
  /**
   * The language the project is written in ("latex", "typst", "lean"): detected from its files at setup.
   * Agents' examples and PDF previews follow it (spec §6.0).
   */
  language: string;
  /** PDF previews of changes (spec §14). */
  preview: PreviewConfig;
  /** The largest file an agent can propose, in MB: a 60 MB file went into the store whole. */
  maxFileMB: number;
}

export function defaultConfig(mainBranch: string): StetConfig {
  return {
    mainBranch,
    agentBranchPrefix: "stet/",
    guardHooks: true,
    worktreeRoot: "../{repo}.stet",
    autoCommit: "on-finish",
    shareEdits: "manual",
    split: {
      mergeGap: 2,
      rewriteRatio: 0.5,
      ignoreReflow: true,
      abbreviations: [
        "e.g.",
        "i.e.",
        "et al.",
        "Fig.",
        "Figs.",
        "Eq.",
        "Eqs.",
        "Sec.",
        "cf.",
        "vs.",
        "resp.",
        "Thm.",
        "Def.",
        "Prop.",
        "Lem.",
        "Ref.",
        "Refs.",
      ],
    },
    grouping: {
      autoRepeatMin: 3,
      autoDetect: ["repeat", "label", "cite", "macro", "input"],
      refCommands: ["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref", "vref", "Vref"],
      citeCommands: ["cite", "citep", "citet", "citealp", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "footcite"],
      moves: { enabled: true, minWords: 7, maxChangedWords: null },
    },
    // Which files each language profile is for (spec §6.1).
    files: Object.fromEntries(PROFILES.flatMap((p) => (p.files ? [[p.files, [...(p.defaultFiles ?? [])]]] : []))) as FilePatterns,
    language: "latex",
    preview: { ...DEFAULT_PREVIEW },
    maxFileMB: 20,
  };
}

/** Deep-merge a partial config over the defaults (arrays are replaced, not merged). */
export function mergeConfig(base: StetConfig, over: unknown): StetConfig {
  const merge = (a: any, b: any): any => {
    if (b === undefined) return a;
    if (Array.isArray(a) || typeof a !== "object" || a === null) return b;
    const out: any = { ...a };
    for (const k of Object.keys(b ?? {})) out[k] = merge(a[k], b[k]);
    return out;
  };
  return merge(base, over);
}

/**
 * The part of `cfg` that differs from the defaults (plus `mainBranch`). This is what gets saved,
 * so improved defaults reach existing repositories.
 */
export function configDelta(cfg: StetConfig): Partial<StetConfig> & { mainBranch: string } {
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const delta = (a: unknown, b: unknown): unknown => {
    if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
    if (!plain(a) || !plain(b)) return a;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a)) {
      const d = delta(a[k], b[k]);
      if (d !== undefined) out[k] = d;
    }
    return out;
  };
  return { ...(delta(cfg, defaultConfig(cfg.mainBranch)) as object), mainBranch: cfg.mainBranch };
}

/** Branch-like names from the config end up in git commands and hook scripts: allow only plain names. */
const REF_NAME = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]+$/;

/** Reject settings that would be unsafe or break Stet (bad branch names, workspaces inside the project). */
export function validateConfig(cfg: StetConfig): StetConfig {
  const bad = (what: string) => {
    throw new StetError(`Invalid Stet setting in .git/stet/config.json: ${what}.`);
  };
  if (!REF_NAME.test(cfg.mainBranch)) bad(`mainBranch '${cfg.mainBranch}'`);
  if (!REF_NAME.test(cfg.agentBranchPrefix) || !cfg.agentBranchPrefix.endsWith("/"))
    bad(`agentBranchPrefix '${cfg.agentBranchPrefix}' (use a plain name ending in '/', e.g. 'stet/')`);
  if (typeof cfg.worktreeRoot !== "string" || !cfg.worktreeRoot) bad("worktreeRoot");
  if (!AUTO_COMMIT.includes(cfg.autoCommit)) bad(`autoCommit '${cfg.autoCommit}' (${AUTO_COMMIT.join(", ")})`);
  if (!SHARE_MODES.includes(cfg.shareEdits)) bad(`shareEdits '${cfg.shareEdits}' (use ${SHARE_MODES.join(", ")})`);
  if (typeof cfg.maxFileMB !== "number" || !(cfg.maxFileMB > 0)) bad("maxFileMB (a number of megabytes)");
  if (!DOCUMENT_LANGUAGES.some((p) => p.id === cfg.language)) bad(`language '${cfg.language}' (${DOCUMENT_LANGUAGES.map((p) => p.id).join(" or ")})`);
  const pv = cfg.preview;
  if (typeof pv?.enabled !== "boolean") bad("preview.enabled (true or false)");
  // The root file becomes a command-line argument of the typesetter: a plain relative path of its own source files only.
  const ts = documentProfile(cfg).typesetter;
  if (
    pv.rootFile !== null &&
    (typeof pv.rootFile !== "string" || !/^(?!-)(?!.*\.\.)[\w./ -]+$/.test(pv.rootFile) || !ts?.source.test(pv.rootFile) || pv.rootFile.startsWith("/"))
  )
    bad(`preview.rootFile '${pv.rootFile}' (one of the document's ${ts?.sourceName ?? "source files"} relative to the project, or null)`);
  // The engines are the language's: LaTeX's mean nothing to Typst.
  const engines = ["auto", ...(ts?.engines ?? [])];
  if (!engines.includes(pv.engine)) bad(`preview.engine '${pv.engine}' (${engines.join(", ")})`);
  if (!PREVIEW_ISOLATIONS.includes(pv.isolation)) bad(`preview.isolation '${pv.isolation}' (${PREVIEW_ISOLATIONS.join(", ")})`);
  if (typeof pv.image !== "string" || !/^[a-z0-9][a-z0-9._/:@-]*$/i.test(pv.image)) bad(`preview.image '${pv.image}'`);
  if (typeof pv.texImage !== "string" || !/^[a-z0-9][a-z0-9._/:@-]*$/i.test(pv.texImage)) bad(`preview.texImage '${pv.texImage}'`);
  if (!PREVIEW_TEX.includes(pv.tex)) bad(`preview.tex '${pv.tex}' (${PREVIEW_TEX.join(", ")})`);
  if (typeof pv.texExtras !== "boolean") bad("preview.texExtras (true or false)");
  if (typeof pv.texExtrasImage !== "string" || !/^[a-z0-9][a-z0-9._/:@-]*$/i.test(pv.texExtrasImage)) bad(`preview.texExtrasImage '${pv.texExtrasImage}'`);
  if (typeof pv.timeout !== "number" || !(pv.timeout >= 5 && pv.timeout <= 3600)) bad("preview.timeout (seconds, 5 to 3600)");
  return cfg;
}
