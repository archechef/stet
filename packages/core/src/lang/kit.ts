/**
 * The profile kit: what language profiles may use of Stet besides their types (`profile.ts`).
 * The built-in profiles use nothing else, so a profile written outside Stet can do all they do.
 *
 * A local profile module imports it as `@stet/profile-kit` and leaves it out of its bundle
 * (`esbuild --external:@stet/profile-kit`): Stet hands the module the kit of the Stet that runs
 * it, so the module never carries a copy that falls behind (`load.ts`). The kit only grows within
 * a profile `apiVersion`.
 */
import type { KeyKind } from "./profile.js";

export { buildImage, containerRuntime, detectPreviewEnv, popplerMissing, runProgram, which } from "../preview/env.js";
export { normWord } from "../preview/words.js";
export { makeEdit, splitLineHunks } from "../split.js";
export { tokenizeWords } from "../tokenizer.js";

/**
 * Kinds of keys several languages share: a key is matched across languages by its kind (a `.bib`
 * entry defines the citation key a LaTeX `\cite` or a Typst `@key` uses).
 */
export const LABEL: KeyKind = { id: "label", noun: "label" };
export const CITATION: KeyKind = { id: "citation", noun: "citation key", addTitle: (key) => `Add reference ${key}` };
