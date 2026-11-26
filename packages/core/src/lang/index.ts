/**
 * The language profiles Stet knows, and which one a file gets: the first whose config patterns
 * (`files.tex`, `files.bib`, `files.typ`, `files.lean`, `files.md`) match it, else plain text.
 */
import { BIBTEX } from "./bibtex.js";
import { LATEX } from "./latex.js";
import { LEAN } from "./lean.js";
import { MARKDOWN } from "./markdown.js";
import { PLAIN } from "./plain.js";
import type { FilesKey, LanguageProfile } from "./profile.js";
import { TYPST } from "./typst.js";

export type { LanguageProfile } from "./profile.js";
export { BIBTEX, LATEX, LEAN, MARKDOWN, PLAIN, TYPST };

/** Every profile with files of its own, in the order they are tried. */
export const PROFILES: readonly LanguageProfile[] = [LATEX, BIBTEX, TYPST, LEAN, MARKDOWN];

/** File patterns per profile (the config's `files`). */
export type FilePatterns = Record<"tex" | "bib" | "typ" | "lean" | "md", string[]> & Partial<Record<FilesKey, string[]>>;

/** The language of a project that names none, and the fallback for one Stet doesn't know. */
export const DEFAULT_LANGUAGE = LATEX.id;

/** The typesetters' own preview settings, with their defaults (LaTeX's `tex`, `texImage`, …). */
export function previewDefaults(profiles: readonly LanguageProfile[]): Record<string, unknown> {
  return Object.assign({}, ...profiles.map((p) => p.typesetter?.settings?.defaults ?? {}));
}

/** The profiles' own grouping settings, with their defaults (LaTeX's `refCommands`, `citeCommands`). */
export function groupingDefaults(profiles: readonly LanguageProfile[]): Record<string, unknown> {
  return Object.assign({}, ...profiles.map((p) => p.groupingSettings?.defaults ?? {}));
}

export const projectProfiles = Symbol("projectProfiles");
type ProfileScope = { [projectProfiles]?: readonly LanguageProfile[] };

export function profilesFor(scope?: ProfileScope): readonly LanguageProfile[] {
  return scope?.[projectProfiles] ?? PROFILES;
}

/** Match a repo path's basename against simple `*.ext` patterns. */
export function matchesAny(path: string, patterns: string[]): boolean {
  const base = path.split("/").pop() ?? path;
  return patterns.some((p) => {
    const re = new RegExp(
      "^" +
        p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
      "i",
    );
    return re.test(base);
  });
}

/** The profile of a file, by the config's patterns. */
export function profileFor(path: string, files: FilePatterns, scope?: ProfileScope): LanguageProfile {
  return profilesFor(scope).find((p) => p.files && matchesAny(path, files[p.files] ?? p.defaultFiles ?? [])) ?? PLAIN;
}

/** Languages a project can be written in (the config's `language`): profiles with examples for agents. */
export function documentLanguages(scope?: ProfileScope): readonly LanguageProfile[] {
  return profilesFor(scope).filter((p) => p.agentTerms);
}

export const DOCUMENT_LANGUAGES = documentLanguages();

/**
 * The language the project is written in: the config's `language` (detected at setup), LaTeX
 * when it names none. Agents' examples and PDF previews follow it.
 */
export function documentProfile(cfg?: ProfileScope & { language?: string }): LanguageProfile {
  const languages = documentLanguages(cfg);
  return languages.find((p) => p.id === (cfg?.language ?? DEFAULT_LANGUAGE)) ?? languages.find((p) => p.id === DEFAULT_LANGUAGE)!;
}

/**
 * How many files of each document language a project has (relative paths), by language id;
 * languages without files left out, and incidental ones (Markdown: a README) when another has files.
 */
export function languageCounts(paths: string[], files: FilePatterns, scope?: ProfileScope): Record<string, number> {
  const out: Record<string, number> = {};
  const languages = documentLanguages(scope);
  for (const p of languages) {
    if (!p.files) continue;
    const n = paths.filter((f) => matchesAny(f, files[p.files!] ?? p.defaultFiles ?? [])).length;
    if (n) out[p.id] = n;
  }
  if (languages.some((p) => !p.incidental && out[p.id])) for (const p of languages) if (p.incidental) delete out[p.id];
  return out;
}

/**
 * The language of a project, by its files (relative paths): the one with the most files, LaTeX
 * on a tie or with none. A Typst thesis with one old .tex file was set up as LaTeX; a front end asks when there are both (`languageCounts`).
 */
export function detectLanguage(paths: string[], files: FilePatterns, scope?: ProfileScope): string {
  const counts = Object.entries(languageCounts(paths, files, scope)).sort((a, b) => b[1] - a[1]);
  if (!counts.length || (counts.length > 1 && counts[0]![1] === counts[1]![1] && counts.some(([id]) => id === DEFAULT_LANGUAGE))) return DEFAULT_LANGUAGE;
  return counts[0]![0];
}

/** Does a change to this file have a PDF preview (by its name alone, for front ends)? */
export function hasPreview(path: string): boolean {
  return profileHasPreview(profileByName(path), path);
}

export function profileHasPreview(profile: LanguageProfile, path: string): boolean {
  return !!profile.typesetter?.source.test(path);
}

/**
 * Whether a change to `path` (of `profile`) has a PDF preview in this project: one in a source file
 * of the project's own document language, which is what is compiled (a .typ file in a LaTeX
 * project has none). The service and the front ends ask this alike (core profile review db49f7d, 5).
 */
export function hasPdfPreview(cfg: (ProfileScope & { language?: string }) | undefined, profile: LanguageProfile, path: string): boolean {
  const doc = documentProfile(cfg);
  return profile.id === doc.id && !!doc.typesetter?.source.test(path);
}

/** How a front end renders changes to the profile's files itself (VS Code's Markdown), if it can. */
export function profileRenderer(profile: LanguageProfile): LanguageProfile["renderer"] | null {
  return profile.renderer ?? null;
}

/** The profile of a file by its name alone (front ends, which don't read the config). */
export function profileByName(path: string): LanguageProfile {
  return PROFILES.find((p) => p.extensions.test(path)) ?? PLAIN;
}

/**
 * A .gitignore for the build files in a folder, by its files (relative paths): every profile's
 * build files, and the outputs of its sources that are there (`/main.pdf` next to `main.tex`, not
 * every PDF: figures are PDFs too). Empty if the folder has none. `profiles`: the built-in ones,
 * or an imported profile's.
 */
export function buildIgnores(paths: string[], profiles: readonly LanguageProfile[] = PROFILES): string[] {
  const have = new Set(paths.map((p) => p.toLowerCase()));
  const out: string[] = [];
  for (const prof of profiles) {
    const patterns = prof.buildFiles ?? [];
    const folders = patterns.filter((pat) => pat.endsWith("/"));
    const names = patterns.filter((pat) => !pat.endsWith("/"));
    // A build folder: offered as soon as the language's files are there (before the first build).
    if (folders.length && paths.some((p) => matchesAny(p, prof.defaultFiles ?? []))) out.push(...folders);
    out.push(...names.filter((pat) => paths.some((p) => matchesAny(p, [pat]))));
    for (const p of paths) {
      const o = prof.outputOf?.(p);
      if (o && have.has(o.toLowerCase())) out.push("/" + paths.find((x) => x.toLowerCase() === o.toLowerCase())!);
    }
  }
  return [...new Set(out)];
}
