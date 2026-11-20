/**
 * The language profiles Stet knows, and which one a file gets: the first whose config patterns
 * (`files.tex`, `files.bib`) match it, else plain text.
 */
import { BIBTEX } from "./bibtex.js";
import { LATEX } from "./latex.js";
import { PLAIN } from "./plain.js";
import type { FilesKey, LanguageProfile } from "./profile.js";

export type { LanguageProfile } from "./profile.js";
export { BIBTEX, LATEX, PLAIN };

/** Every profile with files of its own, in the order they are tried. */
export const PROFILES: readonly LanguageProfile[] = [LATEX, BIBTEX];

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

/** The language previews compile: the first profile with a typesetter. */
export function documentProfile(): LanguageProfile {
  return PROFILES.find((p) => p.typesetter) ?? PLAIN;
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
