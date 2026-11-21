/**
 * The Typst profile: what Stet knows about Typst source (markup, code and maths modes, headings,
 * labels and references, `#let` definitions, files read in). No PDF previews yet: Typst has no
 * SyncTeX to find a change on the page.
 *
 * `@key` is a reference or a citation by what the project defines: a `<key>` label in a .typ file
 * makes it a reference, an entry in a bibliography a citation key. So `@key` counts as a use of
 * both kinds, and a group forms only with the definition of the kind it is (spec §6.0).
 */
import type { Item } from "../model.js";
import { tokenizeWords, type Token, type TokenType } from "../tokenizer.js";
import { LABEL } from "./latex.js";
import type { DefinitionRules, IncludeRules, LanguageProfile, PartRules, ReferenceRules, SyntaxRules } from "./profile.js";

// ---------------------------------------------------------------------------
// Tokens

const WORD = /[\p{L}\p{N}\p{M}]/u;
const WORD_INNER = /[-']/;
const IDENT_START = /[\p{L}_]/u;
const IDENT = /[\p{L}\p{N}_-]/u;
/** Label names: `<sec:intro>`, `@fig:plot-1`. */
const KEY = "[\\p{L}\\p{N}_](?:[\\p{L}\\p{N}_:.-]*[\\p{L}\\p{N}_])?";
const LABEL_AT = new RegExp(`^<${KEY}>`, "u");
const REF_AT = new RegExp(`^@${KEY}`, "u");

/** Keywords that start a statement running to the end of the line (`#let x = 1`). */
const STATEMENTS = new Set(["let", "set", "show", "import", "include", "if", "for", "while", "return", "context", "break", "continue"]);

/** What the text at a point is: markup, code, or maths; and what ends it. */
interface Frame {
  mode: "markup" | "code" | "math";
  /** The character that closes it: "]", ")", "}", "$"; "\n" for a statement (`#let …`); null at the top. */
  close: string | null;
}

/**
 * Typst tokens: words, markup and calls (`#emph`, headings `=`, list markers), brackets (all of
 * `[ ]` and, in code, `( )` and `{ }`), maths delimiters `$`, labels `<a>` and references `@a`
 * (one token each), comments, whitespace, punctuation. Raw text and strings are words and
 * punctuation only: nothing in them is markup.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const stack: Frame[] = [{ mode: "markup", close: null }];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  const push = (type: TokenType, end: number) => {
    tokens.push({ type, text: text.slice(i, end), start: i });
    i = end;
  };
  /** Words and punctuation only, for raw text and strings. */
  const plain = (end: number) => {
    for (const t of tokenizeWords(text.slice(i, end))) tokens.push({ ...t, start: t.start + i });
    i = end;
  };
  const lineStart = () => /(^|\n)[ \t]*$/.test(text.slice(Math.max(0, i - 200), i));
  const word = (from: number, chars: RegExp, inner: RegExp | null) => {
    let j = from + 1;
    while (j < text.length) {
      const d = text[j]!;
      if (chars.test(d)) j++;
      else if (inner?.test(d) && j + 1 < text.length && chars.test(text[j + 1]!)) j += 2;
      else break;
    }
    return j;
  };
  /** Whitespace; a newline ends a statement whose brackets are closed. */
  const space = () => {
    let j = i;
    let newlines = 0;
    while (j < text.length && /\s/.test(text[j]!)) {
      if (text[j] === "\n") newlines++;
      j++;
    }
    if (newlines && top().close === "\n") stack.pop();
    push(newlines >= 2 ? "parbreak" : "ws", j);
  };
  const comment = (): boolean => {
    if (text.startsWith("//", i) && !/[a-z]:$/i.test(text.slice(Math.max(0, i - 8), i))) {
      let j = text.indexOf("\n", i);
      if (j === -1) j = text.length;
      push("comment", j);
      return true;
    }
    if (text.startsWith("/*", i)) {
      const j = text.indexOf("*/", i + 2);
      push("comment", j === -1 ? text.length : j + 2);
      return true;
    }
    return false;
  };
  const open = (mode: Frame["mode"], close: string) => {
    push(mode === "math" ? "math" : "lbrace", i + 1);
    stack.push({ mode, close });
  };
  /** A closing bracket: closes its frame (and any statement left open inside it), else is text. */
  const closing = (c: string): boolean => {
    const k = stack.findLastIndex((f) => f.close === c);
    if (k <= 0 || stack.slice(k + 1).some((f) => f.close !== "\n")) return false;
    stack.length = k;
    push("rbrace", i + 1);
    return true;
  };
  /** `#name` (with `.field` chains), then a call's brackets right after it, or a statement. */
  const hash = () => {
    const c = text[i + 1];
    if (c && IDENT_START.test(c)) {
      let j = word(i + 1, IDENT, null);
      const name = text.slice(i + 1, j);
      if (STATEMENTS.has(name)) {
        push("cmd", j);
        stack.push({ mode: "code", close: "\n" });
        return;
      }
      while (text[j] === "." && text[j + 1] && IDENT_START.test(text[j + 1]!)) j = word(j + 1, IDENT, null);
      push("cmd", j);
      if (text[i] === "(") open("code", ")");
      return;
    }
    if (c === "(" || c === "{" || c === "[") {
      push("punct", i + 1);
      if (c === "(") open("code", ")");
      else if (c === "{") open("code", "}");
      else open("markup", "]");
      return;
    }
    push("punct", i + 1);
  };
  const raw = () => {
    let n = 0;
    while (text[i + n] === "`") n++;
    if (n >= 3) {
      const fence = "`".repeat(n);
      const end = text.indexOf(fence, i + n);
      if (end === -1) return push("punct", i + n);
      push("punct", i + n);
      plain(end);
      push("punct", end + n);
      return;
    }
    if (n === 2) return push("punct", i + 2); // empty raw text
    const end = text.indexOf("`", i + 1);
    if (end === -1) return push("punct", i + 1);
    push("punct", i + 1);
    plain(end);
    push("punct", end + 1);
  };
  const string = () => {
    let j = i + 1;
    while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
    push("punct", i + 1);
    plain(Math.min(j, text.length));
    if (text[i] === '"') push("punct", i + 1);
  };

  while (i < text.length) {
    const f = top();
    const c = text[i]!;
    if (/\s/.test(c)) {
      space();
      continue;
    }
    if ((c === "/" && comment()) || (c === "]" && closing("]"))) continue;
    if (f.mode === "math") {
      if (c === "$") {
        push("math", i + 1);
        stack.pop();
      } else if (c === "\\") push(text[i + 1] === undefined || /\s/.test(text[i + 1]!) ? "cmd" : "punct", text[i + 1] && !/\s/.test(text[i + 1]!) ? i + 2 : i + 1);
      else if (c === "#") hash();
      else if (c === '"') string();
      else if (WORD.test(c)) push("word", word(i, WORD, WORD_INNER));
      else push("punct", i + 1);
      continue;
    }
    if (f.mode === "code") {
      if ((c === ")" || c === "}") && closing(c)) continue;
      if (c === "(") open("code", ")");
      else if (c === "{") open("code", "}");
      else if (c === "[") open("markup", "]");
      else if (c === "$") open("math", "$");
      else if (c === '"') string();
      else if (c === "<" && LABEL_AT.test(text.slice(i, i + 200))) push("cmd", i + LABEL_AT.exec(text.slice(i, i + 200))![0].length);
      else if (c === ";" || c === ",") {
        // A separator of arguments, table cells and statements: a unit ends there (`endsUnit`).
        push("cmd", i + 1);
        if (c === ";" && f.close === "\n") stack.pop();
      } else if (IDENT_START.test(c) || WORD.test(c)) push("word", word(i, /[\p{L}\p{N}\p{M}_]/u, /-/));
      else push("punct", i + 1);
      continue;
    }
    // Markup.
    const at = text.slice(i, i + 200);
    if (lineStart() && /^=+[ \t]/.test(at)) push("cmd", i + /^=+/.exec(at)![0].length);
    else if (lineStart() && /^[-+/][ \t]/.test(at)) push("cmd", i + 1);
    else if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) push("cmd", i + 1); // a forced line break
      else if (next === "u" && text[i + 2] === "{") push("punct", Math.max(i + 3, text.indexOf("}", i) + 1));
      else push("punct", i + 2);
    } else if (c === "#") hash();
    else if (c === "$") open("math", "$");
    else if (c === "[") open("markup", "]");
    else if (c === "`") raw();
    else if (c === "<" && LABEL_AT.test(at)) push("cmd", i + LABEL_AT.exec(at)![0].length);
    else if (c === "@" && !(i > 0 && /[\p{L}\p{N}_"]/u.test(text[i - 1]!)) && REF_AT.test(at)) push("cmd", i + REF_AT.exec(at)![0].length);
    else if (WORD.test(c)) push("word", word(i, WORD, WORD_INNER));
    else push("punct", i + 1);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Structure

/** Calls that make a block of their own (`#figure(…)`), and statements. */
const BLOCKS = "let|set|show|import|include|if|for|while|figure|table|grid|block|align|pagebreak|colbreak|v|outline|bibliography|heading|list|enum|terms|columns|place|page|title";
const BLOCK_CMD = new RegExp(`^#(?:${BLOCKS})$`);

/** Headings (`=`), list and term markers, and block calls start a structure. */
const isBoundary = (t: Token): boolean => t.type === "cmd" && (/^(=+|[-+/])$/.test(t.text) || BLOCK_CMD.test(t.text));

/** A line of brackets closing a block, maybe with its label: `] <thm:main>`, `)`. */
const CLOSER = String.raw`[\])}]+[ \t]*(?:<[^>\s]+>)?[ \t]*$`;
/** A line opening a block: `#figure(`, `#block[`, `#figure(kind: "x")[`. */
const OPENER = String.raw`#[\p{L}_][\p{L}\p{N}_.-]*(?:\([^\n]*\))?[\[(][ \t]*$`;

/** A line that starts a structure: a paragraph may follow it directly. */
const STRUCTURE_LINE = new RegExp(String.raw`^\s*(?:=+\s|[-+/]\s|#(?:${BLOCKS})\b|${CLOSER}|\$[ \t]*$|<[^>\s]+>[ \t]*$)`, "u");

/** Headings and block bounds: a structure line that is a piece of its own. */
const SECTION_LINE = new RegExp(String.raw`^[ \t]*(?:=+[ \t]|#(?:figure|table|grid|block|align|columns|place|if|for|while)\b|${CLOSER})`, "u");

const isStructureOnly = (t: string) => !t.trim().includes("\n") && new RegExp(String.raw`^\s*(?:=+\s+\S[^\n]*|${OPENER}|${CLOSER})\s*$`, "u").test(t);

const isEnvironmentBound = (t: string) => new RegExp(String.raw`^\s*(?:${OPENER}|${CLOSER})`, "u").test(t.trim());

/** Code without what can't hold brackets: escapes, comments, raw text, strings. */
const codeOf = (s: string) =>
  s
    .replace(/\\./g, "")
    .replace(/(`{3,})[\s\S]*?\1|`[^`\n]*`/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

/** How a line changes the nesting of brackets: `[ ]`, `( )`, `{ }`. */
function lineNesting(line: string): number[] {
  const c = codeOf(line);
  const n = (ch: string) => c.split(ch).length - 1;
  return [n("[") - n("]"), n("(") - n(")"), n("{") - n("}")];
}

/**
 * A whole block, as the name of what it is: `#figure(…)[…] <x>` → "figure", a display formula
 * `$ … $` (on lines of its own) → "equation". Else null.
 */
function environmentOf(text: string): string | null {
  const t = text.trim();
  if (/^\$\s*\n[\s\S]*\n\s*\$(?:\s*<[^>\s]+>)?$/.test(t) && (t.match(/\$/g) ?? []).length === 2) return "equation";
  const m = /^#([\p{L}_][\p{L}\p{N}_-]*)(?=[[(])/u.exec(t);
  if (!m) return null;
  const c = codeOf(t);
  let j = m[0].length;
  let groups = 0;
  while (j < c.length && "[(".includes(c[j]!)) {
    let depth = 0;
    for (; j < c.length; j++) {
      if ("[({".includes(c[j]!)) depth++;
      else if ("])}".includes(c[j]!) && --depth === 0) break;
    }
    if (depth !== 0) return null;
    j++;
    groups++;
  }
  const rest = c.slice(j).trim();
  return groups && (!rest || /^<[^>\s]+>$/.test(rest)) && t.includes("\n") ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Maths, labels and references: taken whole

/** Token spans [open, close] of maths: `$ … $` pairs (inline or display). */
function mathSpans(toks: Token[]): [number, number][] {
  const spans: [number, number][] = [];
  let open = -1;
  toks.forEach((t, i) => {
    if (t.type === "math") {
      if (open < 0) open = i;
      else {
        spans.push([open, i]);
        open = -1;
      }
    }
  });
  return spans;
}

const isKeyToken = (t: Token) => t.type === "cmd" && /^[<@]/.test(t.text);

/**
 * Labels and references are single tokens, each a key of its own; a label passed to `ref` or
 * `cite` alone is taken with the call (`#ref(<a>)`, as `\ref{a}` in LaTeX).
 */
function keySpans(toks: Token[]): [number, number][] {
  return toks.flatMap((t, i): [number, number][] => {
    if (!isKeyToken(t)) return [];
    const call = toks[i - 2];
    if (toks[i - 1]?.text === "(" && toks[i + 1]?.text === ")" && call && /^#?(?:ref|cite)$/.test(call.text)) return [[i - 2, i + 1]];
    return [[i, i]];
  });
}

const WHOLE_KEY = new RegExp(String.raw`^\s*(?:@${KEY}|<${KEY}>|#(?:ref|cite)\(<${KEY}>\))\s*$`, "u");

/** Is this edit a whole label or reference (`<a>` → `<b>`, `@a` → `@b`)? */
function isKeyEdit(oldText: string, newText: string): boolean {
  const whole = (t: string) => WHOLE_KEY.test(t);
  return (whole(oldText) || !oldText.trim()) && (whole(newText) || !newText.trim()) && (whole(oldText) || whole(newText));
}

/** Raw text (in backticks): its spaces are content. */
function verbatim(text: string): (t: Token) => boolean {
  const spans = [...text.matchAll(/(`{3,})[\s\S]*?\1|`[^`\n]+`/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  if (!spans.length) return () => false;
  return (t) => spans.some(([a, b]) => t.start > a && t.start < b - 1);
}

export const TYPST_SYNTAX: SyntaxRules = {
  tokenize,
  isBoundary,
  mathSpans,
  keySpans,
  isKeyEdit,
  verbatim,
  // Forced line breaks, alignment points in maths, and the separators of code (arguments, table
  // cells, statements: `,` and `;` as "cmd" tokens) end a "sentence" too.
  endsUnit: (t) => t.text === "\\" || t.text === "&" || (t.type === "cmd" && (t.text === "," || t.text === ";")),
  sentenceEnd: /[.?!][)\]}'"’”$*_]*$/,
  structureLine: STRUCTURE_LINE,
  sectionLine: SECTION_LINE,
  isStructureOnly,
  environmentOf,
  describeBlock: (name) => name,
  isEnvironmentBound,
  lineNesting,
  isCommand: (w) => /^#[\p{L}_]/u.test(w),
  // As LaTeX's: maths anywhere near (`$2n$` is the symbols 2 and n).
  inMath: (t) => /(?<!\\)\$/.test(t),
};

// ---------------------------------------------------------------------------
// Keys: labels defined by `<a>`; `@a` refers to a label or cites a bibliography entry

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const count = (keys: Iterable<string>) => {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
};

/**
 * Text where keys count: without escapes, raw text, comments, and strings in code (after `#`, `(`,
 * `,`, `:`, `=`, …). A comment about `<intro>` was taken into a rename, and `#"see @intro"` counted
 * as a reference (test report 5e4c6af, B2). Quotes in markup are text, and keys in them count.
 */
const keyText = (s: string) =>
  s
    .replace(/\\./g, "")
    .replace(/(`{3,})[\s\S]*?\1|`[^`\n]*`/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/([#(,:={;+]\s*)"(?:[^"\\\n]|\\.)*"/g, '$1""');

/** Labels `text` defines: `<a>` after markup, not a label value passed to a function (`#ref(<a>)`). */
function labelsDefined(text: string): Map<string, number> {
  const c = keyText(text);
  const keys: string[] = [];
  for (const m of c.matchAll(new RegExp(`<(${KEY})>`, "gu"))) {
    const before = c.slice(0, m.index).trimEnd();
    if (/[(,:]$/.test(before) || /\bshow$/.test(before)) continue;
    keys.push(m[1]!);
  }
  return count(keys);
}

/** References `@a` (not in a string such as an import's "@preview/…", nor an e-mail address). */
const atRefs = (t: string) => [...t.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_"/])@(${KEY})`, "gu"))].map((m) => m[1]!);
/** Label values passed to `ref` or `cite`: `#ref(<a>)`, `#cite(<a>, form: "prose")`. */
const passed = (t: string, fn: string) => [...t.matchAll(new RegExp(`\\b${fn}\\(\\s*<(${KEY})>`, "gu"))].map((m) => m[1]!);

function used(kind: "label" | "citation", text: string): Map<string, number> {
  const t = keyText(text);
  return count([...atRefs(t), ...passed(t, kind === "label" ? "ref" : "cite")]);
}

/** Keys counted in two windows that share their context: what the item stops and starts having. */
function diffCounts(o: Map<string, number>, n: Map<string, number>): { removed: string[]; added: string[] } {
  return {
    removed: [...o].filter(([k, c]) => c > (n.get(k) ?? 0)).map(([k]) => k),
    added: [...n].filter(([k, c]) => c > (o.get(k) ?? 0)).map(([k]) => k),
  };
}

const references: ReferenceRules = {
  // `@a` to a missing label, or a citation missing from the bibliography, stops the build.
  strict: true,
  // `<a>` defines labels; citation keys are defined by the bibliography's own profile (BibTeX
  // now; a Hayagriva profile would define them the same way).
  definitions: (it: Item) => {
    const { before, after } = it.context;
    const { removed, added } = diffCounts(labelsDefined(before + it.oldText + after), labelsDefined(before + it.newText + after));
    return [{ kind: LABEL, removed, added, fresh: false }];
  },
  uses: (kind, oldWin, newWin) => diffCounts(used(kind, oldWin), used(kind, newWin)),
};

// ---------------------------------------------------------------------------
// Names defined with `#let`, used as `#name`, in maths, or in code

const LET = /(?:^|#|[;{]\s*)let\s+([\p{L}_][\p{L}\p{N}_-]*)/gmu;
/** Lines of code: statements, and a block's `} else {`. */
const CODE_LINE = /^[ \t]*(?:#(?:let|set|show|if|for|while|import|return|context)\b|\}?[ \t]*else\b|(?:let|return)\s).*$/gm;

const definitions: DefinitionRules = {
  kinds: ["let"],
  definedIn: (t) => ({ let: new Set([...codeOf(t).matchAll(LET)].map((m) => m[1]!)) }),
  usesIn: (t, name) => {
    const n = esc(name);
    if (new RegExp(`#${n}(?![\\p{L}\\p{N}_-])`, "u").test(t)) return true;
    const bare = new RegExp(`(?<![\\p{L}\\p{N}_.-])${n}(?![\\p{L}\\p{N}_-]|\\s*=[^=>])`, "u");
    const code = codeOf(t);
    const maths = [...code.matchAll(/\$[^$]*\$/g)].map((m) => m[0]);
    const lines = [...code.matchAll(CODE_LINE)].map((m) => m[0].replace(/#?let\s+[\p{L}_][\p{L}\p{N}_-]*/gu, ""));
    return [...maths, ...lines].some((s) => bare.test(s));
  },
  noun: () => "definition",
  written: (name) => `#${name}`,
  described: (name) => `#${name}`,
};

// ---------------------------------------------------------------------------
// Files read in

const INCLUDES = /#?\b(?:include|import)\s+"([^"@][^"]*)"|\b(?:image|bibliography|read|json|csv|yaml|toml|xml|cbor)\(\s*"([^"]+)"/g;

const includes: IncludeRules = {
  filesIn: (text) => {
    const out = new Map<string, number>();
    const c = text.replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const m of c.matchAll(INCLUDES)) {
      const ref = (m[1] ?? m[2]!).trim();
      if (ref) out.set(ref, (out.get(ref) ?? 0) + 1);
    }
    return out;
  },
  names: (ref, file) => {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^(\.\/)+/, "");
    const [r, f] = [norm(ref), norm(file)];
    return f === r || f.endsWith("/" + r);
  },
};

// ---------------------------------------------------------------------------
// Parts of linked groups

/** Changes whose dependants Stet can't see: imports, set and show rules, included files. */
const GLOBAL = /#(?:import|include|set|show)\b/;

/** How a text nests `[ ]`, `( )`, `{ }`, and `$` (counted). */
function balance(s: string): number[] {
  const c = codeOf(s);
  const n = (ch: string) => c.split(ch).length - 1;
  return [n("[") - n("]"), n("(") - n(")"), n("{") - n("}"), n("$") % 2];
}

const parts: PartRules = { global: (t) => GLOBAL.test(t), balance, parity: [3] };

// ---------------------------------------------------------------------------

export const TYPST: LanguageProfile = {
  id: "typst",
  name: "Typst",
  files: "typ",
  defaultFiles: ["*.typ"],
  extensions: /\.typ$/i,
  fence: "typst",
  document: true,
  outputOf: (source) => (/\.typ$/i.test(source) ? source.replace(/\.typ$/i, ".pdf") : null),
  agentTerms: {
    location: 'main.typ:12 "suggestion"',
    linked: "a `#let` definition and its uses, an opening `[` or `(` and its closing one in different edits",
    compiles: "in Typst a reference to a missing label or citation key is an error, as is an unknown variable or function",
    reference: "a `<label>` with its `@` references",
    dependencies: "a label or `#let` name and its uses, the same symbol renamed, brackets split across changes",
  },
  syntax: TYPST_SYNTAX,
  references,
  definitions,
  includes,
  parts,
};
