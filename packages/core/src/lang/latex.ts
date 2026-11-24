/**
 * The LaTeX profile: what Stet knows about LaTeX source (tokens, structure, maths, labels,
 * citations, macros, included files). Its PDF previews are in `latex-preview.ts`.
 */
import { CITATION, LABEL } from "./kit.js";
import { LATEX_TYPESETTER } from "./latex-preview.js";
import type { DefinitionRules, IncludeRules, Item, LanguageProfile, PartRules, ReferenceRules, SyntaxRules, Token, TokenType } from "./profile.js";

// ---------------------------------------------------------------------------
// Tokens (spec §6.2 step 2)

const WORD = /[\p{L}\p{N}\p{M}]/u;
const WORD_INNER = /[-']/;

/** LaTeX-aware tokens: words, commands, braces, maths delimiters, comments, whitespace, punctuation. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (type: TokenType, end: number) => {
    tokens.push({ type, text: text.slice(i, end), start: i });
    i = end;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      let j = i;
      let newlines = 0;
      while (j < text.length && /\s/.test(text[j]!)) {
        if (text[j] === "\n") newlines++;
        j++;
      }
      push(newlines >= 2 ? "parbreak" : "ws", j);
    } else if (c === "%") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = text.length;
      push("comment", j);
    } else if (c === "\\") {
      const next = text[i + 1];
      if (next === undefined) push("punct", i + 1);
      else if (/[A-Za-z@]/.test(next)) {
        let j = i + 1;
        while (j < text.length && /[A-Za-z@]/.test(text[j]!)) j++;
        if (text[j] === "*") j++; // starred variants: \section*
        push("cmd", j);
      } else if ("()[]".includes(next)) push("math", i + 2);
      else push("cmd", i + 2); // \%, \&, \\, \, ...
    } else if (c === "{") push("lbrace", i + 1);
    else if (c === "}") push("rbrace", i + 1);
    else if (c === "$") push("math", text[i + 1] === "$" ? i + 2 : i + 1);
    else if (WORD.test(c)) {
      let j = i + 1;
      while (j < text.length) {
        const d = text[j]!;
        if (WORD.test(d)) j++;
        else if (WORD_INNER.test(d) && j + 1 < text.length && WORD.test(text[j + 1]!)) j += 2;
        else break;
      }
      push("word", j);
    } else push("punct", i + 1);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Structure

const BOUNDARY_CMDS = new Set([
  "\\begin",
  "\\end",
  "\\item",
  "\\par",
  "\\part",
  "\\chapter",
  "\\section",
  "\\subsection",
  "\\subsubsection",
  "\\paragraph",
  "\\subparagraph",
]);

const isBoundary = (t: Token): boolean => t.type === "cmd" && BOUNDARY_CMDS.has(t.text.replace(/\*$/, ""));

/** A line that starts a LaTeX structure (section, environment, item): a paragraph may follow it directly. */
const STRUCTURE_LINE =
  /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end|item|label|caption|maketitle|noindent|medskip|bigskip|smallskip|par)\b/;

/** Sectioning commands and environment bounds: a structure line that is a piece of its own. */
const SECTION_LINE = /^[ \t]*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end)\b/;

/** A single sectioning or environment line, such as `\section{Results}` or `\end{proof}`. */
const isStructureOnly = (t: string) =>
  /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|begin|end)\*?\s*(?:\[[^\]]*\])?\{[^\n]*\}[^\n]*\s*$/.test(t) &&
  !t.trim().includes("\n");

/** `\begin{x} … \end{x}`, whole: "x". */
function environmentOf(text: string): string | null {
  const t = text.trim();
  const env = /^\\begin\s*\{([^}]+)\}/.exec(t)?.[1];
  if (env && new RegExp(`\\\\end\\s*\\{${env.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}$`).test(t)) return env;
  return null;
}

/** How a line changes the nesting of environments, braces and display maths (`\[ \]`), outside comments. */
function lineNesting(line: string): number[] {
  const code = line.replace(/\\[{}$%]/g, "").replace(/%.*$/, "");
  return [
    (code.match(/\\begin\s*\{/g) ?? []).length - (code.match(/\\end\s*\{/g) ?? []).length,
    (code.match(/\{/g) ?? []).length - (code.match(/\}/g) ?? []).length,
    (code.match(/\\\[/g) ?? []).length - (code.match(/\\\]/g) ?? []).length,
  ];
}

// ---------------------------------------------------------------------------
// Maths and key arguments: taken whole

const MATH_ENVS = /^(equation|align|alignat|gather|multline|flalign|eqnarray|math|displaymath|dmath)\*?$/;

/** Token index spans [a, b] (inclusive) of math content, including delimiters. */
function mathSpans(toks: Token[]): [number, number][] {
  const spans: [number, number][] = [];
  let open: { i: number; text: string } | null = null;
  const closer: Record<string, string> = { $: "$", $$: "$$", "\\(": "\\)", "\\[": "\\]" };
  const envStack: { i: number; name: string }[] = [];
  const envName = (i: number): string | null => {
    let k = i + 1;
    while (k < toks.length && toks[k]!.type === "ws") k++;
    if (toks[k]?.type !== "lbrace") return null;
    let name = "";
    for (k++; k < toks.length && toks[k]!.type !== "rbrace"; k++) name += toks[k]!.text;
    return k < toks.length ? name : null;
  };
  const envEnd = (i: number): number => {
    let k = i + 1;
    while (k < toks.length && toks[k]!.type !== "rbrace") k++;
    return Math.min(k, toks.length - 1);
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (open) {
      if (t.type === "math" && t.text === closer[open.text]) {
        spans.push([open.i, i]);
        open = null;
      } else if (t.type === "parbreak") open = null; // unbalanced: give up on this span
      continue;
    }
    if (t.type === "math" && closer[t.text]) open = { i, text: t.text };
    else if (t.type === "cmd" && (t.text === "\\begin" || t.text === "\\end")) {
      const name = envName(i);
      if (!name || !MATH_ENVS.test(name)) continue;
      if (t.text === "\\begin") envStack.push({ i, name });
      else {
        const k = envStack.findLastIndex((e) => e.name === name);
        if (k !== -1) {
          spans.push([envStack[k]!.i, envEnd(i)]);
          envStack.length = k;
        }
      }
    }
  }
  return spans;
}

/** Commands whose argument is an identifier that is only meaningful as a whole. */
const KEY_ARG_CMDS =
  /^\\(label|[cCvV]?ref|eqref|pageref|autoref|nameref|cite\w*|\w*cite|nocite|input|include|includegraphics|usepackage|documentclass|bibliography|bibliographystyle|begin|end)\*?$/;

/** Token spans [cmd, closing brace] of key arguments such as \label{sec:intro} or \cite[p.~3]{knuth}. */
function keySpans(toks: Token[], braces: Map<number, number>): [number, number][] {
  const spans: [number, number][] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.type !== "cmd" || !KEY_ARG_CMDS.test(toks[i]!.text)) continue;
    let k = i + 1;
    while (toks[k]?.type === "ws") k++;
    while (toks[k]?.text === "[") {
      while (k < toks.length && toks[k]!.text !== "]" && toks[k]!.type !== "parbreak") k++;
      k++;
      while (toks[k]?.type === "ws") k++;
    }
    if (toks[k]?.type !== "lbrace") continue;
    const close = braces.get(k);
    if (close !== undefined && close > k) spans.push([i, close]);
  }
  return spans;
}

/** Is this edit a whole key argument such as `\label{a}` → `\label{b}`? */
export function isKeyEdit(oldText: string, newText: string): boolean {
  const whole = (t: string) => {
    const m = /^\s*(\\[A-Za-z@]+\*?)(?:\[[^\]]*\])*\{[^{}]*\}\s*$/.exec(t);
    return !!m && KEY_ARG_CMDS.test(m[1]!);
  };
  return (whole(oldText) || !oldText.trim()) && (whole(newText) || !newText.trim()) && (whole(oldText) || whole(newText));
}

// ---------------------------------------------------------------------------
// Verbatim

/** Environments whose spaces are content: reflowing them changes the output. */
const VERBATIM =
  "verbatim\\*?|Verbatim\\*?|BVerbatim|LVerbatim|lstlisting|minted|alltt|comment|filecontents\\*?|verbatimtab|spverbatim|tcblisting|pycode|sageblock";
const VERBATIM_BEGIN = new RegExp(`\\\\begin\\s*\\{(?:${VERBATIM})\\}`, "g");
const VERBATIM_END = new RegExp(`\\\\end\\s*\\{(?:${VERBATIM})\\}`, "g");

/** Whether each token is inside a verbatim-like environment (a segment may start or end inside one). */
function verbatim(text: string): (t: Token) => boolean {
  const spans: [number, number][] = [];
  const begins = [...text.matchAll(VERBATIM_BEGIN)].map((m) => m.index! + m[0].length);
  const ends = [...text.matchAll(VERBATIM_END)].map((m) => m.index!);
  if (!begins.length && !ends.length) return () => false;
  let from: number | null = ends.length && (!begins.length || ends[0]! < begins[0]!) ? 0 : null;
  for (const [at, kind] of [...begins.map((b) => [b, 1] as const), ...ends.map((e) => [e, 0] as const)].sort((a, b) => a[0] - b[0])) {
    if (kind === 1 && from === null) from = at;
    else if (kind === 0 && from !== null) {
      spans.push([from, at]);
      from = null;
    }
  }
  if (from !== null) spans.push([from, text.length]);
  return (t) => spans.some(([a, b]) => t.start >= a && t.start < b);
}

export const LATEX_SYNTAX: SyntaxRules = {
  tokenize,
  isBoundary,
  mathSpans,
  keySpans,
  isKeyEdit,
  verbatim,
  // Line breaks and cells of tables, formulas and pseudocode end a "sentence" too, and so do the
  // statements of TikZ and other code (`;`).
  endsUnit: (t) => t.text === "\\\\" || t.text === "&" || t.text === ";",
  sentenceEnd: /[.?!][)\]}'"’”$]*$/,
  structureLine: STRUCTURE_LINE,
  sectionLine: SECTION_LINE,
  isStructureOnly,
  environmentOf,
  isEnvironmentBound: (t) => /\\(?:begin|end)\b/.test(t),
  lineNesting,
  isCommand: (w) => w.startsWith("\\"),
  inMath: (t) => /\$|\\\(|\\\[|\\begin\s*\{(?:equation|align|gather|multline)/.test(t),
};

// ---------------------------------------------------------------------------
// Keys defined in one place and referred to in others

export { CITATION, LABEL };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keys referenced by `\cmd[opt]{a,b}` for the given command names. */
function keyCounts(text: string, cmds: string[]): Map<string, number> {
  const re = new RegExp(`\\\\(?:${cmds.map(esc).join("|")})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)\\}`, "g");
  const out = new Map<string, number>();
  for (const m of text.matchAll(re)) for (const k of m[1]!.split(",")) if (k.trim()) out.set(k.trim(), (out.get(k.trim()) ?? 0) + 1);
  return out;
}

/**
 * Keys an item stops and starts referencing. Its two windows share their context (the original
 * text), so only the item's own text makes the counts differ: an unchanged `\ref{a}` nearby in
 * the context must not hide that this item replaces `a`.
 */
function keyChange(oldWin: string, newWin: string, cmds: string[]): { removed: string[]; added: string[] } {
  const o = keyCounts(oldWin, cmds);
  const n = keyCounts(newWin, cmds);
  return {
    removed: [...o].filter(([k, c]) => c > (n.get(k) ?? 0)).map(([k]) => k),
    added: [...n].filter(([k, c]) => c > (o.get(k) ?? 0)).map(([k]) => k),
  };
}

const references: ReferenceRules = {
  // \label defines labels; citation keys are defined in the bibliography (the BibTeX profile).
  definitions: (it: Item) => {
    const before = it.context.before;
    const after = it.context.after;
    const { removed, added } = keyChange(before + it.oldText + after, before + it.newText + after, ["label"]);
    return [{ kind: LABEL, removed, added, fresh: false }];
  },
  uses: (kind, oldWin, newWin, cfg) => keyChange(oldWin, newWin, (kind === "label" ? cfg.refCommands : cfg.citeCommands) as string[]),
};

/** LaTeX's own grouping settings: the commands that refer to a label, and that cite a key. */
const GROUPING_SETTINGS = {
  refCommands: ["ref", "eqref", "pageref", "autoref", "cref", "Cref", "nameref", "vref", "Vref"],
  citeCommands: ["cite", "citep", "citet", "citealp", "citeauthor", "citeyear", "parencite", "textcite", "autocite", "footcite"],
};

const checkGrouping = (g: Record<string, unknown>): string[] =>
  (["refCommands", "citeCommands"] as const).flatMap((k) => {
    const v = g[k];
    return Array.isArray(v) && v.every((c) => typeof c === "string" && /^[A-Za-z@]+$/.test(c))
      ? []
      : [`grouping.${k} (a list of command names without the backslash)`];
  });

// ---------------------------------------------------------------------------
// Macros, environments and TikZ styles: defined once, used elsewhere

const CMD_DEFS =
  /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|newrobustcmd|renewrobustcmd|DeclarePairedDelimiterX?|newlength|newsavebox)\*?\s*\{?\s*\\([A-Za-z@]+)/g;
const TEX_DEFS = /\\(?:def|gdef|edef|xdef|let|newif)\s*\\([A-Za-z@]+)/g;
const ENV_DEFS =
  /\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem|declaretheorem|newtcolorbox)\*?\s*\{([A-Za-z@*]+)\}/g;
/** TikZ styles: `\tikzset{name/.style=…}`, `name/.style={…}` in picture options, `\tikzstyle{name}=[…]`. */
const STYLE_DEFS = /(?:[{,[]\s*|^\s*)([A-Za-z][\w -]*?)\s*\/\.(?:style|append style)\b|\\tikzstyle\s*\{([^}]+)\}/gm;

const definitions: DefinitionRules = {
  kinds: ["cmd", "env", "style"],
  definedIn: (t) => {
    const out: Record<string, Set<string>> = { cmd: new Set(), env: new Set(), style: new Set() };
    for (const m of t.matchAll(CMD_DEFS)) out.cmd!.add(m[1]!);
    for (const m of t.matchAll(TEX_DEFS)) out.cmd!.add(m[1]!.startsWith("if") ? m[1]!.slice(2) : m[1]!);
    for (const m of t.matchAll(ENV_DEFS)) out.env!.add(m[1]!);
    for (const m of t.matchAll(STYLE_DEFS)) out.style!.add((m[1] ?? m[2]!).trim());
    return out;
  },
  usesIn: (t, name, kind) => {
    if (kind === "env") return new RegExp(`\\\\(?:begin|end)\\s*\\{${esc(name)}\\}`).test(t);
    if (kind === "style") return new RegExp(`[\\[,]\\s*${esc(name)}\\s*[,\\]]`).test(t);
    return new RegExp(`\\\\(?:if)?${esc(name)}(?![A-Za-z@])`).test(t);
  },
  noun: (kind) => ({ cmd: "macro", env: "environment", style: "TikZ style" })[kind] ?? kind,
  written: (name, kind) => (kind === "cmd" ? `\\${name}` : name),
  described: (name, kind) => (kind === "cmd" ? `\\${name}` : kind === "env" ? `the environment ${name}` : `the TikZ style ${name}`),
};

// ---------------------------------------------------------------------------
// Files read in

const INCLUDES =
  /\\(?:input|include|subfile|includegraphics|includepdf|includestandalone|lstinputlisting|verbatiminput|addbibresource|bibliography)\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g;

const includes: IncludeRules = {
  /** The files a text reads in (\input{chapters/a}, \includegraphics[..]{fig/b}, \bibliography{x,y}), counted. */
  filesIn: (text) => {
    const out = new Map<string, number>();
    for (const m of text.matchAll(INCLUDES)) {
      for (const p of m[1]!.split(",")) {
        const ref = p.trim();
        if (ref) out.set(ref, (out.get(ref) ?? 0) + 1);
      }
    }
    return out;
  },
  /** Whether `ref` (as written in \input, without extension or with a graphics path left out) names `file`. */
  names: (ref, file) => {
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    const [r, f] = [norm(ref), norm(file)];
    const stem = f.replace(/\.[A-Za-z0-9]+$/, "");
    return [f, stem].some((x) => x === r || x.endsWith("/" + r));
  },
};

// ---------------------------------------------------------------------------
// Parts of linked groups

/** Changes whose dependants Stet can't see: packages, classes, included files. */
const GLOBAL = /\\(?:usepackage|RequirePackage|documentclass|input|include|includeonly|usetikzlibrary|usepgfplotslibrary)(?![A-Za-z@])/;

/** How a text nests braces, environments, display math, inline math `\( \)`, and `$` (counted). */
function balance(s: string): number[] {
  const t = s.replace(/\\\\/g, "").replace(/\\[{}$]/g, "");
  const n = (re: RegExp) => (t.match(re) ?? []).length;
  return [n(/\{/g) - n(/\}/g), n(/\\begin\s*\{/g) - n(/\\end\s*\{/g), n(/\\\[/g) - n(/\\\]/g), n(/\\\(/g) - n(/\\\)/g), n(/\$/g) % 2];
}

export const LATEX_PARTS: PartRules = { global: (t) => GLOBAL.test(t), balance, parity: [4] };

// ---------------------------------------------------------------------------

export const LATEX: LanguageProfile = {
  id: "latex",
  name: "LaTeX",
  files: "tex",
  defaultFiles: ["*.tex", "*.sty", "*.cls", "*.ltx", "*.dtx"],
  extensions: /\.(tex|sty|cls|ltx|dtx)$/i,
  fence: "latex",
  document: true,
  buildFiles: [
    "*.aux",
    "*.log",
    "*.out",
    "*.toc",
    "*.lof",
    "*.lot",
    "*.fls",
    "*.fdb_latexmk",
    "*.synctex.gz",
    "*.synctex(busy)",
    "*.bbl",
    "*.blg",
    "*.bcf",
    "*.run.xml",
    "*.nav",
    "*.snm",
    "*.vrb",
    "*.xdv",
    "*.dvi",
  ],
  outputOf: (source) => (/\.tex$/i.test(source) ? source.replace(/\.tex$/i, ".pdf") : null),
  agentTerms: {
    location: 'main.tex:12 "suggestion"',
    linked: "a macro or environment definition and its uses, a `\\begin` and its `\\end` in different edits",
    compiles: "warnings such as undefined references are fine; an undefined macro is not",
    reference: "a `\\label` with its references",
    dependencies: "a label or macro and its uses, the same symbol renamed, braces or environments split across changes",
  },
  syntax: LATEX_SYNTAX,
  references,
  definitions,
  includes,
  parts: LATEX_PARTS,
  typesetter: LATEX_TYPESETTER,
  groupingSettings: { defaults: GROUPING_SETTINGS, check: checkGrouping },
  spoken: {
    maths: /\$/,
    keys: /\\(?:ref|label|eqref|cref|autoref)\{/,
    words: (t) => t.replace(/\\(?:ref|eqref|cref|autoref)\{([^}]*)\}/g, " reference to $1 ").replace(/\\label\{([^}]*)\}/g, " label $1 "),
  },
};
