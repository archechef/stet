/**
 * Files that take effect once accepted: a build, git, an editor or an AI agent runs or reads them.
 * They are flagged in review, and accepting one needs an explicit confirmation (security report
 * 5e4c6af, S12).
 */
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
];

/** What accepting a change to `path` sets off, or null for an ordinary file. */
export function effectOf(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  return EFFECTS.find(([re]) => re.test(p))?.[1] ?? null;
}

/** The effect of an item (its file, or the file it renames), or null. */
export function itemEffect(it: { file: string; oldFile?: string | undefined }): string | null {
  return effectOf(it.file) ?? (it.oldFile ? effectOf(it.oldFile) : null);
}
