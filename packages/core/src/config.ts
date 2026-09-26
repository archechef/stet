/** Repository configuration (spec §11). */

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

export interface StetConfig {
  mainBranch: string;
  /** How to run the `stet` CLI; recorded by `stet init` for hooks and MCP configs. */
  cli?: { command: string; args: string[] };
  /** Install git hooks that block merges/pushes of agent branches (spec §9). */
  guardHooks: boolean;
  agentBranchPrefix: string;
  worktreeRoot: string;
  autoCommit: "when-clean" | "never";
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
    autoCommit: "when-clean",
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

/** Match a repo path's basename against simple `*.ext` patterns. */
export function matchesAny(path: string, patterns: string[]): boolean {
  const base = path.split("/").pop() ?? path;
  return patterns.some((p) => {
    const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
    return re.test(base);
  });
}
