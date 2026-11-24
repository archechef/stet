/**
 * The Lean 4 profile: Lean source is reviewed by declaration. A proof is code, and accepting half
 * of the changes to one leaves it broken, so the changed lines of one declaration (a theorem with
 * its proof, a definition, with its doc comment and attributes) are one change. Changes to
 * different declarations stay separate.
 *
 * A declaration renamed, added or removed is linked with the changes that start or stop using
 * it, and a new or deleted module with the `import` that reads it: in Lean either alone is an
 * error. Names are matched by their last component (`foo` in `MyProject.foo`, `h.foo`), since
 * `namespace`, `open` and dot notation decide the rest, which the text alone doesn't tell. No PDF
 * previews.
 */
import { makeEdit, splitLineHunks } from "./kit.js";
import type { DefinitionRules, Edit, IncludeRules, LanguageProfile } from "./profile.js";

/** Modifiers before a declaration keyword. */
const MODIFIERS = "(?:(?:private|protected|noncomputable|partial|unsafe|nonrec|scoped|local)\\s+)*";
/** Keywords that start a declaration or a command of their own at the start of a line. */
const KEYWORDS = [
  "theorem",
  "lemma",
  "def",
  "abbrev",
  "instance",
  "structure",
  "class",
  "inductive",
  "coinductive",
  "example",
  "axiom",
  "opaque",
  "macro",
  "macro_rules",
  "syntax",
  "notation",
  "infix",
  "infixl",
  "infixr",
  "prefix",
  "postfix",
  "elab",
  "elab_rules",
  "attribute",
  "variable",
  "universe",
  "open",
  "export",
  "namespace",
  "section",
  "end",
  "set_option",
  "initialize",
  "deriving",
  "mutual",
  "import",
];
/** A line that starts a declaration or command: a keyword, `#eval`-style commands, attributes, doc comments. */
const HEAD = new RegExp(`^(?:(?:@\\[[^\\]\\n]*\\]\\s*)*${MODIFIERS}(?:${KEYWORDS.join("|")})(?![\\w'.!?])|#[a-z_]+\\b|/--|/-!|@\\[)`);
/** A line of attributes only (`@[simp]`): it belongs to the declaration below it. */
const ATTRIBUTES_ONLY = /^@\[[^\]\n]*\]\s*$/;

/**
 * The first line of each declaration or command in `lines` (indexes), by Lean's layout: they start
 * at the beginning of a line, outside comments. A doc comment or an attribute line starts the
 * declaration it stands above, not one of its own.
 */
export function declarationStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let depth = 0; // block comments `/- … -/` nest
  let inDoc = false; // in a doc comment, which documents the declaration below it
  let prefix = false; // the previous line belongs to the declaration below it
  for (const [i, line] of lines.entries()) {
    const head = depth === 0 && HEAD.test(line);
    if (head && !prefix) starts.push(i);
    if (depth === 0 && line.startsWith("/--")) inDoc = true;
    depth = Math.max(0, depth + commentDepthChange(line, depth));
    if (inDoc) {
      prefix = true;
      if (depth === 0) inDoc = false;
    } else prefix = head && ATTRIBUTES_ONLY.test(line);
  }
  return starts;
}

/**
 * How a line changes the nesting of block comments, `depth` deep at its start: `/-` opens one,
 * `-/` closes one. Outside comments, a line comment (`--`) ends the line and strings don't count.
 */
function commentDepthChange(line: string, depth: number): number {
  let d = 0;
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    const next = line[i + 1];
    const code = depth + d === 0;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (code && c === '"') inString = true;
    else if (code && c === "-" && next === "-") break;
    else if (c === "/" && next === "-") {
      d++;
      i++;
    } else if (c === "-" && next === "/" && depth + d > 0) {
      d--;
      i++;
    }
  }
  return d;
}

const linesOf = (text: string) => text.split(/(?<=\n)/);

/** The declaration (index into `starts`) line `line` is in; -1 before the first. */
function declarationAt(starts: number[], line: number): number {
  let k = -1;
  for (const s of starts) {
    if (s > line) break;
    k++;
  }
  return k;
}

/** The line `offset` is on. */
const lineAt = (text: string, offset: number) => {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1 && i < offset; i = text.indexOf("\n", i + 1)) n++;
  return n;
};

/**
 * Changed lines, joined per declaration: two changes are one when they touch the same declaration
 * in the old text or in the new one. A new declaration, a deleted one, and changes to different
 * declarations stay apart.
 */
export function splitLean(oldText: string, newText: string): Edit[] {
  const hunks = splitLineHunks(oldText, newText);
  if (hunks.length < 2) return hunks;
  const oldStarts = declarationStarts(linesOf(oldText));
  const newStarts = declarationStarts(linesOf(newText));
  const where = (e: Edit) => ({
    old: e.end > e.start ? declarationAt(oldStarts, lineAt(oldText, e.start)) : null,
    new: e.newEnd > e.newStart ? declarationAt(newStarts, lineAt(newText, e.newStart)) : null,
    // The last line it touches, for changes spanning several declarations.
    oldLast: e.end > e.start ? declarationAt(oldStarts, lineAt(oldText, e.end - 1)) : null,
    newLast: e.newEnd > e.newStart ? declarationAt(newStarts, lineAt(newText, e.newEnd - 1)) : null,
  });
  const out: Edit[] = [];
  let cur = hunks[0]!;
  let at = where(cur);
  for (const h of hunks.slice(1)) {
    const w = where(h);
    const same = (at.oldLast !== null && at.oldLast === w.old) || (at.newLast !== null && at.newLast === w.new);
    if (same) {
      cur = makeEdit(oldText, newText, cur.start, h.end, cur.newStart, h.newEnd);
      at = { old: at.old, new: at.new, oldLast: w.oldLast ?? at.oldLast, newLast: w.newLast ?? at.newLast };
    } else {
      out.push(cur);
      cur = h;
      at = w;
    }
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Declarations and their uses; modules and their imports

/** A Lean name: letters (any script), digits, `_`, `'`, `!`, `?`, subscripts, with `.` between components. */
const NAME = String.raw`[\p{L}_][\p{L}\p{N}_'!?\u2080-\u209c\u1d62-\u1d6a]*(?:\.[\p{L}_][\p{L}\p{N}_'!?\u2080-\u209c\u1d62-\u1d6a]*)*`;
/** The name a declaration defines (`theorem foo`, `private def Nat.bar`); not `instance : …` or `example`. */
const DECLARED = new RegExp(
  `^[ \\t]*(?:@\\[[^\\]\\n]*\\]\\s*)*${MODIFIERS}(?:theorem|lemma|def|abbrev|instance|structure|class|inductive|coinductive|axiom|opaque)\\s+(${NAME})`,
  "gmu",
);
/** A name in code (`foo`, `MyProject.foo`, `h.foo`, `@foo`, `.foo`), not the end of another one. */
const USED = new RegExp(`(?<![\\p{L}\\p{N}_'!?])${NAME}`, "gu");
/** An import of a module (`import Mathlib.Tactic`, `public import A.B`). */
const IMPORT = new RegExp(`^[ \\t]*(?:(?:public|private|meta)\\s+)*import\\s+(?:all\\s+)?(${NAME})`, "gmu");

/** Code without comments and strings: names in them are neither declared nor used. */
export function codeOf(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "-") {
      depth++;
      i++;
      out += "  ";
      continue;
    }
    if (depth > 0) {
      if (c === "-" && next === "/") {
        depth--;
        i++;
        out += "  ";
      } else out += c === "\n" ? "\n" : " ";
      continue;
    }
    if (c === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      out += " ".repeat(stop - i);
      i = stop - 1;
      continue;
    }
    if (c === "'" && next === '"' && text[i + 2] === "'") {
      out += "   "; // the character '"'
      i += 2;
      continue;
    }
    if (c === '"') {
      // To the closing quote; an unclosed string stops at the end of its line, which stays.
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(text[j] === '"' ? j + 1 : j, text.length);
      out += " ".repeat(end - i);
      i = end - 1;
      continue;
    }
    out += c;
  }
  return out;
}

const lastPart = (name: string) => name.slice(name.lastIndexOf(".") + 1);

const definitions: DefinitionRules = {
  kinds: ["decl"],
  definedIn: (text) => ({ decl: new Set([...codeOf(text).matchAll(DECLARED)].map((m) => m[1]!)) }),
  usesIn: (text, name) => {
    const code = codeOf(text);
    const want = lastPart(name);
    const heads = new Set([...code.matchAll(DECLARED)].map((m) => m.index! + m[0].length - m[1]!.length));
    return [...code.matchAll(USED)].some((m) => !heads.has(m.index!) && lastPart(m[0]) === want);
  },
  noun: () => "declaration",
  written: (name) => name,
  described: (name) => `the declaration ${name}`,
};

const includes: IncludeRules = {
  filesIn: (text) => {
    const out = new Map<string, number>();
    for (const m of codeOf(text).matchAll(IMPORT)) out.set(m[1]!, (out.get(m[1]!) ?? 0) + 1);
    return out;
  },
  // `import A.B` reads `A/B.lean`, below the project or one of its source folders.
  names: (ref, file) => {
    const path = `${ref.replace(/\./g, "/")}.lean`;
    return file === path || file.endsWith(`/${path}`);
  },
};

export const LEAN: LanguageProfile = {
  id: "lean",
  name: "Lean",
  files: "lean",
  defaultFiles: ["*.lean"],
  extensions: /\.lean$/i,
  fence: "lean",
  document: true,
  // Lake's build folder, with the project's dependencies (Mathlib) checked out in it.
  buildFiles: [".lake/"],
  agentTerms: {
    location: 'MyProject/Basic.lean:12 "simp only"',
    linked: "a definition or lemma and the proofs that start using it, a declaration renamed and its uses",
    compiles: "in Lean every use of a missing or renamed declaration is an error, and every proof must still check",
    reference: "a new lemma with the proofs that use it",
    dependencies: "a declaration and the changes that start or stop using it, a new module and its `import`, changes to one declaration",
  },
  splitUnits: splitLean,
  definitions,
  includes,
};
