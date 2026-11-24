/**
 * Files that take effect once accepted: a build, git, an editor or an AI agent runs or reads them.
 * They are flagged in review, and accepting one needs an explicit confirmation.
 */
import type { StetConfig } from "./config.js";
import { profilesFor } from "./lang/index.js";

const EFFECTS: [RegExp, string][] = [
  [/(^|\/)\.?latexmkrc$/i, "latexmk runs it as Perl code when the document is built"],
  [/(^|\/)\.gitattributes$/i, "git applies the filters and diff drivers it names"],
  [/(^|\/)\.gitmodules$/i, "git fetches the submodules it names"],
  [/^\.vscode\//i, "VS Code runs its tasks and applies its settings in this folder"],
  [/^\.(claude|codex|cursor)\/|^\.mcp\.json$/i, "it configures AI agent tools, which can run programs"],
  [/(^|\/)(CLAUDE|AGENTS)(\.local|\.override)?\.md$/i, "AI agents read it as instructions"],
  [/^\.github\/workflows\//i, "GitHub runs it as a workflow"],
  [/(^|\/)\.envrc$/i, "direnv runs it when you enter the folder"],
  [/^\.devcontainer\//i, "dev containers are built and run from it"],
  [/(^|\/)(GNUmakefile|[Mm]akefile)$/, "make runs its commands"],
  [/(^|\/)lakefile\.(lean|toml)$/, "Lake runs it when the Lean project is built, and fetches the packages it names"],
  [/(^|\/)lean-toolchain$/, "elan downloads and runs the Lean version it names"],
  [/(^|\/)lake-manifest\.json$/, "Lake fetches the package versions it lists"],
];

/** What accepting a change to `path` sets off, or null for an ordinary file. */
export function effectOf(path: string, cfg?: StetConfig): string | null {
  const p = path.replace(/\\/g, "/");
  const builtIn = EFFECTS.find(([re]) => re.test(p));
  if (builtIn) return builtIn[1];
  for (const profile of profilesFor(cfg)) {
    const rule = profile.fileEffects?.find(({ path }) => path.test(p));
    if (rule) return rule.reason;
  }
  return null;
}

/** The effect of an item (its file, or the file it renames), or null. */
export function itemEffect(it: { file: string; oldFile?: string | undefined }, cfg?: StetConfig): string | null {
  return effectOf(it.file, cfg) ?? (it.oldFile ? effectOf(it.oldFile, cfg) : null);
}
