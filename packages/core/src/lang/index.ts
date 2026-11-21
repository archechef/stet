/**
 * The language profiles Stet knows, and which one a file gets: the first whose config patterns
 * (`files.tex`, `files.bib`, `files.typ`) match it, else plain text.
 */
import { BIBTEX } from "./bibtex.js";
import { LATEX } from "./latex.js";
import { PLAIN } from "./plain.js";
import { TYPST } from "./typst.js";
import type { FilesKey, LanguageProfile } from "./profile.js";

export type { LanguageProfile } from "./profile.js";
export { BIBTEX, LATEX, PLAIN, TYPST };

/** Every profile with files of its own, in the order they are tried. */
export const PROFILES: readonly LanguageProfile[] = [LATEX, BIBTEX, TYPST];

/** File patterns per profile (the config's `files`). */
export type FilePatterns = Record<FilesKey, string[]>;

/** Match a repo path's basename against simple `*.ext` patterns. */
export function matchesAny(path: string, patterns: string[]): boolean {
  const base = path.split("/").pop() ?? path;
  return patterns.some((p) => {
    const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
    return re.test(base);
  });
}

/** The profile of a file, by the config's patterns. */
export function profileFor(path: string, files: FilePatterns): LanguageProfile {
  return PROFILES.find((p) => p.files && matchesAny(path, files[p.files])) ?? PLAIN;
}

/** Languages a project can be written in (the config's `language`): profiles with examples for agents. */
export const DOCUMENT_LANGUAGES: readonly LanguageProfile[] = PROFILES.filter((p) => p.agentTerms);

/**
 * The language the project is written in: the config's `language` (detected at setup), LaTeX
 * when it names none. Agents' examples and PDF previews follow it.
 */
export function documentProfile(cfg?: { language?: string }): LanguageProfile {
  return DOCUMENT_LANGUAGES.find((p) => p.id === (cfg?.language ?? LATEX.id)) ?? LATEX;
}

/**
 * The language of a project, by its files (relative paths): the one language among them with
 * files of its own, else LaTeX (a project with .tex and .typ files, or neither, is LaTeX).
 */
export function detectLanguage(paths: string[], files: FilePatterns): string {
  const found = DOCUMENT_LANGUAGES.filter((p) => p.files && paths.some((f) => matchesAny(f, files[p.files!] ?? p.defaultFiles ?? [])));
  return found.length === 1 ? found[0]!.id : LATEX.id;
}

/** Does a change to this file have a PDF preview (by its name alone, for front ends)? */
export function hasPreview(path: string): boolean {
  return !!profileByName(path).typesetter?.source.test(path);
}

/** The profile of a file by its name alone (front ends, which don't read the config). */
export function profileByName(path: string): LanguageProfile {
  return PROFILES.find((p) => p.extensions.test(path)) ?? PLAIN;
}

/**
 * A .gitignore for the build files in a folder, by its files (relative paths): every profile's
 * build files, and the outputs of its sources that are there (`/main.pdf` next to `main.tex`, not
 * every PDF: figures are PDFs too). Empty if the folder has none.
 */
export function buildIgnores(paths: string[]): string[] {
  const have = new Set(paths.map((p) => p.toLowerCase()));
  const out: string[] = [];
  for (const prof of PROFILES) {
    const patterns = prof.buildFiles ?? [];
    if (paths.some((p) => matchesAny(p, patterns))) out.push(...patterns.filter((pat) => paths.some((p) => matchesAny(p, [pat]))));
    for (const p of paths) {
      const o = prof.outputOf?.(p);
      if (o && have.has(o.toLowerCase())) out.push("/" + paths.find((x) => x.toLowerCase() === o.toLowerCase())!);
    }
  }
  return [...new Set(out)];
}
