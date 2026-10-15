/** Repository configuration (spec §11). */
import { StetError } from "./errors.js";

export interface SplitConfig {
  mergeGap: number;
  rewriteRatio: number;
  ignoreReflow: boolean;
  abbreviations: string[];
}

export interface GroupingConfig {
  autoRepeatMin: number;
  autoDetect: ("repeat" | "label" | "cite")[];
  refCommands: string[];
  citeCommands: string[];
}

export type ShareMode = "manual" | "saved" | "committed";
export const SHARE_MODES: readonly ShareMode[] = ["manual", "saved", "committed"];

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
  autoCommit: "on-finish" | "when-clean" | "never";
  /**
   * Which of the user's own edits agents see (spec §7.3): "manual" (default) the saved files as of
   * the user's last *Share my edits* (`stet share`); "saved" the saved files whenever an agent
   * looks; "committed" only committed text. Accepted changes always reach agents.
   */
  shareEdits: ShareMode;
  split: SplitConfig;
  grouping: GroupingConfig;
  files: { tex: string[]; bib: string[] };
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
      abbreviations: ["e.g.", "i.e.", "et al.", "Fig.", "Figs.", "Eq.", "Eqs.", "Sec.", "cf.", "vs.", "resp.", "Thm.", "Def.", "Prop.", "Lem.", "Ref.", "Refs."],
    },
    grouping: {
      autoRepeatMin: 3,
      autoDetect: ["repeat", "label", "cite"],
      refCommands: ["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref", "vref", "Vref"],
      citeCommands: ["cite", "citep", "citet", "citealp", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "footcite"],
    },
    files: {
      tex: ["*.tex", "*.sty", "*.cls", "*.ltx", "*.dtx"],
      bib: ["*.bib"],
    },
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
const REF_NAME = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\/-]+$/;

/** Reject settings that would be unsafe or break Stet (bad branch names, workspaces inside the project). */
export function validateConfig(cfg: StetConfig): StetConfig {
  const bad = (what: string) => {
    throw new StetError(`Invalid Stet setting in .git/stet/config.json: ${what}.`);
  };
  if (!REF_NAME.test(cfg.mainBranch)) bad(`mainBranch '${cfg.mainBranch}'`);
  if (!REF_NAME.test(cfg.agentBranchPrefix) || !cfg.agentBranchPrefix.endsWith("/")) bad(`agentBranchPrefix '${cfg.agentBranchPrefix}' (use a plain name ending in '/', e.g. 'stet/')`);
  if (typeof cfg.worktreeRoot !== "string" || !cfg.worktreeRoot) bad("worktreeRoot");
  if (!["on-finish", "when-clean", "never"].includes(cfg.autoCommit)) bad(`autoCommit '${cfg.autoCommit}'`);
  if (!SHARE_MODES.includes(cfg.shareEdits)) bad(`shareEdits '${cfg.shareEdits}' (use ${SHARE_MODES.join(", ")})`);
  return cfg;
}

/** Match a repo path's basename against simple `*.ext` patterns. */
export function matchesAny(path: string, patterns: string[]): boolean {
  const base = path.split("/").pop() ?? path;
  return patterns.some((p) => {
    const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
    return re.test(base);
  });
}
