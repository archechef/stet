/**
 * Language profiles: everything Stet knows about one document language (LaTeX, BibTeX, …), so
 * that the rest of Stet is about text, paragraphs, sentences and changes, not about LaTeX.
 *
 * A profile is a set of optional sections. Without one, Stet falls back to what works for any
 * text: without `syntax`, changes are whole changed lines; without `references`, no rename groups;
 * without `typesetter`, no PDF previews.
 */
import type { GroupingConfig } from "../config.js";
import type { DoctorCheck } from "../doctor.js";
import type { Item } from "../model.js";
import type { PreviewConfig, PreviewEnv } from "../preview/env.js";
import type { Edit } from "../split.js";
import type { Token } from "../tokenizer.js";

// The types of Stet's own that profiles use: a profile imports types from here only, and values
// from the kit (`kit.ts`).
export type { GroupingConfig } from "../config.js";
export type { DoctorCheck } from "../doctor.js";
export type { Item } from "../model.js";
export type { PreviewConfig, PreviewEnv } from "../preview/env.js";
export type { Edit } from "../split.js";
export type { Token, TokenType } from "../tokenizer.js";

/** Which files a profile is for: patterns of the config's `files.<key>`. */
export type FilesKey = string;

export interface FileEffect {
  /** Matches a repository-relative path with forward slashes. */
  path: RegExp;
  /** What takes effect after accepting the change, shown to the reviewer. */
  reason: string;
}

export interface LanguageProfile {
  /** "latex", "bibtex", "plain". */
  id: string;
  /** For people: "LaTeX". */
  name: string;
  /** The config's file patterns that select this profile (`files.tex`); none: the fallback. */
  files?: FilesKey;
  /** Their default: `*.tex`, `*.sty`, …. */
  defaultFiles?: string[];
  /** File names the front ends recognise without the config (for code blocks, previews). */
  extensions: RegExp;
  /** Language of fenced code blocks showing this text ("latex"); "" for none. */
  fence: string;
  /** A file of the document itself: new ones are part of the user's tree when Stet snapshots it. */
  document: boolean;
  /**
   * What a build leaves next to the sources, as .gitignore patterns offered at setup: file names
   * (`*.aux`), offered when such files are there, or folders (`.lake/`), offered with the language's files.
   */
  buildFiles?: string[];
  fileEffects?: readonly FileEffect[];
  /** The output a build makes of a source file (main.tex → main.pdf), offered at setup too. */
  outputOf?: (source: string) => string | null;
  /**
   * Examples in this language for agents (their instructions, the MCP tools' descriptions). A
   * profile with these is a language a project can be written in (`language` in the config).
   */
  agentTerms?: AgentTerms;
  /** Token-level splitting into sentences and paragraphs (spec §6.2). */
  syntax?: SyntaxRules;
  /** Splitting by the file's own units (BibTeX entries); null falls back to lines. */
  splitUnits?: (oldText: string, newText: string) => Edit[] | null;
  references?: ReferenceRules;
  definitions?: DefinitionRules;
  includes?: IncludeRules;
  parts?: PartRules;
  typesetter?: Typesetter;
  /**
   * Its own `grouping.*` settings (LaTeX: `refCommands` and `citeCommands`, the commands that
   * refer to a label or cite a key, which its `references.uses` reads): their defaults, and what
   * is wrong with their values (one message per setting; none when all are fine).
   */
  groupingSettings?: { defaults: Record<string, unknown>; check(grouping: GroupingConfig): string[] };
  /** How its labels and references read aloud (screen readers), for `spokenChange`. */
  spoken?: SpokenRules;
}

/** Examples in a language, for what agents are told (markdown). */
export interface AgentTerms {
  /** A location with a snippet: `main.tex:12 "suggestion"`. */
  location: string;
  /** Edits that break the document unless accepted together: "a macro or environment definition and its uses, …". */
  linked: string;
  /** What may and may not be left behind by a part accepted alone: "warnings such as undefined references are fine; an undefined macro is not". */
  compiles: string;
  /** A part that can be accepted alone: "a `\label` with its references". */
  reference: string;
  /** What Stet sees depending on each other: "a label or macro and its uses, …, braces or environments split across changes". */
  dependencies: string;
}

/** How text is cut into tokens, units that stay whole, and structure (spec §6.2). */
export interface SyntaxRules {
  tokenize(text: string): Token[];
  /** A token that starts a structure (a heading, an environment's bound, a list item). */
  isBoundary(t: Token): boolean;
  /** Token spans [first, last] taken whole: maths. */
  mathSpans(toks: Token[]): [number, number][];
  /** Token spans [first, last] of key arguments (`\label{a}`): whole, and never merged with neighbours. */
  keySpans(toks: Token[], braces: Map<number, number>): [number, number][];
  /** Is this edit a whole key argument (`\label{a}` → `\label{b}`)? */
  isKeyEdit(oldText: string, newText: string): boolean;
  /** Which tokens of `text` are in text whose spaces are content (verbatim). */
  verbatim(text: string): (t: Token) => boolean;
  /** Tokens besides full stops that end a "sentence": table cells, forced line breaks, statements. */
  endsUnit(t: Token): boolean;
  /** A word that ends a sentence (with closing brackets, quotes or maths after the stop). */
  sentenceEnd: RegExp;
  /** A line that starts a structure: a paragraph may begin right after it, or end right before it. */
  structureLine: RegExp;
  /** A line that is a piece of its own in a run of new text: a heading, an environment's bound. */
  sectionLine: RegExp;
  /** A single line that is only structure, such as `\section{Results}` or `\end{proof}`. */
  isStructureOnly(text: string): boolean;
  /** The environment `text` is, whole (`\begin{proof} … \end{proof}` → "proof"), else null. */
  environmentOf(text: string): string | null;
  /** What a move's title calls a whole block of `environmentOf`'s name: "proof environment" (the default). */
  describeBlock?(name: string): string;
  /** Does `text` open or close an environment (rather than being a heading)? */
  isEnvironmentBound(text: string): boolean;
  /** How a line changes the nesting a run can't be cut inside: one count per kind (environments, braces, …). */
  lineNesting(line: string): number[];
  /** A token that names a command or other markup (`\alpha`), for replacements of symbols. */
  isCommand(text: string): boolean;
  /** Whether text ending here is inside maths (where `2n` is the symbols 2 and n). */
  inMath(textBefore: string): boolean;
}

/** A kind of key that is defined in one place and referred to in others: labels, citation keys. */
export interface KeyKind {
  id: "label" | "citation";
  /** In titles: "label", "citation key". */
  noun: string;
  /** Group a new key with the changes that start using it ("Add reference knuth"), with this title. */
  addTitle?: (key: string) => string;
}

export interface KeyChange {
  kind: KeyKind;
  removed: string[];
  added: string[];
  /** The change defines keys only, none before (a new bibliography entry). */
  fresh: boolean;
}

/** Labels, citation keys and other keys defined in one place and used in others (spec §6.4). */
export interface ReferenceRules {
  /**
   * A use of a key that is not defined is an error (Typst), not a warning that prints "??"
   * (LaTeX): a key's definition and its uses are then never in separately acceptable parts.
   */
  strict?: boolean;
  /** The keys an item stops and starts defining. */
  definitions(it: Item): KeyChange[];
  /** The keys of `kind` an item stops and starts using, from its old and new text in context. */
  uses(kind: KeyKind["id"], oldWin: string, newWin: string, cfg: GroupingConfig): { removed: string[]; added: string[] };
}

/** Macros, environments, styles: defined once, used elsewhere; a use without its definition is an error. */
export interface DefinitionRules {
  kinds: readonly string[];
  /** What `text` defines, by kind. */
  definedIn(text: string): Record<string, Set<string>>;
  usesIn(text: string, name: string, kind: string): boolean;
  /** In titles: "macro", "environment". */
  noun(kind: string): string;
  /** As written: `\est`. */
  written(name: string, kind: string): string;
  /** In sentences: `\est`, "the environment proof". */
  described(name: string, kind: string): string;
}

/** Files the text reads in (`\input`, `\includegraphics`). */
export interface IncludeRules {
  /** The files `text` reads in, as written, counted. */
  filesIn(text: string): Map<string, number>;
  /** Whether `ref` as written names `file` (an extension may be left out). */
  names(ref: string, file: string): boolean;
}

/** What the parts of linked groups must respect (spec §6.4.6). */
export interface PartRules {
  /** A change others may depend on unseen: a package, a class, an included file. */
  global(text: string): boolean;
  /** Counts a change opens and closes (braces, environments, maths): one number per kind. */
  balance(text: string): number[];
  /** Kinds counted modulo 2 (`$`, which opens and closes alike). */
  parity: readonly number[];
}

/** Where text is on a page: in PDF points from the top-left corner, spanning h..h+W and v-H..v (v is the baseline). */
export interface SourceBox {
  page: number;
  h: number;
  v: number;
  W: number;
  H: number;
}

/** Runs a program of a build, isolated (in the preview's container, or as a restricted process), in `work`. */
export type RunIsolated = (work: string, cmd: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Compiling the document to PDF for previews (spec §14). */
/** A language's labels, references and formulas in words, for screen readers. */
export interface SpokenRules {
  /** Whether a text has a formula ("$…$"). */
  maths: RegExp;
  /** Whether a text has a label or a reference. */
  keys: RegExp;
  /** Labels and references spelled out: "\\ref{a}" → " reference to a ". */
  words(text: string): string;
}

export interface Typesetter {
  /** In messages: "LaTeX" ("LaTeX reported an error"). */
  name: string;
  /** The program that reads the document, in messages about isolation: "TeX" ("TeX can't read your files"). */
  program: string;
  /** Files whose text changes have a preview, and what they are called (".tex files"). */
  source: RegExp;
  sourceName: string;
  /** An example root file, for the message when Stet can't tell which one it is. */
  rootHint: string;
  /**
   * Its own `preview.*` settings (LaTeX: `tex`, `texImage`, `texExtras`, `texExtrasImage`): their
   * defaults, and what is wrong with their values (one message per setting; none when all are fine).
   */
  settings?: { defaults: Record<string, unknown>; check(preview: PreviewConfig): string[] };
  /** The engines `preview.engine` may name besides "auto" ("pdflatex", …). */
  engines: readonly string[];
  /** The tool chain: installed, or the container with it. Never installs anything. */
  detect(cfg: PreviewConfig, opts: { podman?: string | null }): Promise<PreviewEnv>;
  /** Build the previews' container image (downloads: only on the user's request). */
  setupImage(cfg: PreviewConfig, opts: { extras?: boolean }): Promise<{ ok: boolean; log: string; settings?: Record<string, unknown> }>;
  /** Checks for `stet doctor`; `which` gives a program's version output, or null. */
  doctor(which: (cmd: string, args: string[]) => Promise<string | null>): Promise<DoctorCheck[]>;
  /** Environment variables of every build, with the build's home folder (in a container, or a process). */
  buildEnv(env: PreviewEnv, home: string, container: boolean): Record<string, string>;
  /** The document to compile among `files` (source files below the project, with their text), or null. */
  detectRoot(files: Map<string, string>, cfg: PreviewConfig): string | null;
  /** Compile `root` in `work`: the PDF (absolute path) or null, and the log. */
  compile(run: RunIsolated, work: string, root: string, cfg: PreviewConfig): Promise<{ pdf: string | null; log: string }>;
  /** Files of an earlier build (relative to `work`) that must not pass for this one's. */
  outputs(root: string): string[];
  /** Whether text at `offset` has no place on the page (LaTeX: the root's preamble). */
  noSpot(text: string, offset: number, isRoot: boolean): boolean;
  /** Where source lines of `file` are on the page; null if they typeset nothing there. */
  locate(run: RunIsolated, work: string, pdfRel: string, file: string, lines: number[]): Promise<SourceBox[] | null>;
  /** The errors of a log, without what a change shifts (line numbers). */
  errorsOf(log: string): string[];
  /** Files a build couldn't find (packages, fonts). */
  missingFiles(log: string): string[];
  /** The part of a log that says what went wrong. */
  excerpt(log: string): string;
  /** The words the source typesets, roughly, normalised as the page's words are (`normWord`). */
  plainWords(source: string): string[];
  /** Where a missing file isn't: "your TeX installation (tlmgr install …)". */
  installHint(env: PreviewEnv, extras: boolean): string;
}
