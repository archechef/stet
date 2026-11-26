/**
 * The Markdown profile (CommonMark with GitHub's extensions: tables, task lists, footnotes,
 * `$…$` maths). Prose is reviewed word by word and sentence by sentence, as in LaTeX; code spans
 * and fenced code keep their spaces, and maths, link targets, inline HTML and URLs stay whole.
 *
 * Keys are labels of three sorts, told apart by how they are written: a heading's anchor
 * (`#getting-started`, GitHub's slug of its text) with the links to it (`[see](#getting-started)`,
 * `other.md#getting-started`), a reference definition (`[docs]: https://…`) with the links that
 * use it (`[the docs][docs]`), and a footnote (`[^1]: …`) with its marks (`[^1]`). Nothing stops
 * Markdown from rendering, so none of these is strict: a broken link is a warning, not an error.
 *
 * Front ends that render Markdown themselves (VS Code) show a change rendered: no PDF, no
 * typesetter.
 */
import { tokenizeWords } from "./kit.js";
import { markdownSides } from "./markdown-render.js";
import type { IncludeRules, Item, KeyKind, LanguageProfile, PartRules, ReferenceRules, SyntaxRules, Token, TokenType } from "./profile.js";

// ---------------------------------------------------------------------------
// Tokens

const WORD = /[\p{L}\p{N}\p{M}]/u;
const WORD_INNER = /[-'’]/;
/** A fence opening or closing fenced code: three or more backticks or tildes, indented three spaces at most. */
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const HEADING = /^#{1,6}(?=[ \t]|$)/;
/** A thematic break (`---`, `* * *`): the whole line. */
const THEMATIC = /^(?:([-*_])[ \t]*)(?:\1[ \t]*){2,}(?=\n|$)/;
const SETEXT = /^=+[ \t]*(?=\n|$)/;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t]|\n|$)/;
const TASK_BOX = /^\[[ xX]\](?=[ \t])/;
/** A table's delimiter row: `| --- | :-: |`. */
const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*(?=\n|$)/;
/** A reference definition (`[docs]: https://… "Title"`), or a footnote's start (`[^1]:`). */
const REF_DEFINITION = /^\[(?!\^)[^\]\n]+\]:[^\n]*/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]\s]+\]:/;
const FOOTNOTE_REF = /^\[\^[^\]\s]+\](?!:)/;
const AUTOLINK = /^<(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/;
const HTML_TAG = /^<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/;
const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>]*[^\s<>.,;:!?'")\]*_~]/;
const PUNCTUATION = /[!-/:-@[-`{-~]/;

/** Where a line starts: only indentation and blockquote markers before `i`. */
const atLineStart = (text: string, i: number) => /(?:^|\n)[ \t>]*$/.test(text.slice(Math.max(0, i - 200), i));

/**
 * The end of a link's text from its `[` at `open` (the offset of its `]`), and the end of its
 * target after it (`(…)` or `[…]`); null when it isn't a link (`[sic]`).
 */
function linkAt(text: string, open: number): { close: number; end: number } | null {
  let depth = 0;
  let j = open;
  for (; j < text.length; j++) {
    const c = text[j]!;
    if (c === "\\") j++;
    else if (c === "`") {
      const n = /^`+/.exec(text.slice(j))![0].length;
      const end = text.indexOf("`".repeat(n), j + n);
      if (end > 0) j = end + n - 1;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) break;
    else if (c === "\n" && /^\n[ \t]*(?:\n|$)/.test(text.slice(j))) return null;
  }
  if (j >= text.length) return null;
  const after = text[j + 1];
  if (after === "(") {
    let d = 0;
    for (let k = j + 1; k < text.length; k++) {
      const c = text[k]!;
      if (c === "\\") k++;
      else if (c === "(") d++;
      else if (c === ")" && --d === 0) return { close: j, end: k + 1 };
      else if (c === "\n" && /^\n[ \t]*(?:\n|$)/.test(text.slice(k))) return null;
    }
    return null;
  }
  if (after === "[") {
    const m = /^\[[^\]\n]*\]/.exec(text.slice(j + 1));
    return m ? { close: j, end: j + 1 + m[0].length } : null;
  }
  return null;
}

/** The end of inline maths opened by `$` at `i` (after its closing `$`), or -1. GitHub's rules: no space inside the `$`s, no digit after. */
function inlineMathEnd(text: string, i: number): number {
  if (!text[i + 1] || /\s|\$/.test(text[i + 1]!)) return -1;
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j]!;
    if (c === "\\") j++;
    else if (c === "\n" && /^\n[ \t]*(?:\n|$)/.test(text.slice(j))) return -1;
    else if (c === "$" && !/\s/.test(text[j - 1]!) && !/\d/.test(text[j + 1] ?? "")) return j + 1;
  }
  return -1;
}

/**
 * Markdown tokens: words; markup (headings `#`, list markers, `>`, fences, table pipes, task
 * boxes, HTML tags, link targets, URLs, reference definitions: "cmd"); a link's text in brackets
 * (`[`/`![` and `]`); maths delimiters `$`/`$$`; HTML comments; whitespace; punctuation (emphasis,
 * the backticks of code). Code is words and punctuation only. `code`, if given, receives the
 * offsets of code's contents, whose spaces are content.
 */
export function tokenize(text: string, code?: [number, number][]): Token[] {
  const tokens: Token[] = [];
  /** Links open around `i`: where their text closes, and their target ends. */
  const links: { close: number; end: number }[] = [];
  let i = 0;
  const push = (type: TokenType, end: number) => {
    tokens.push({ type, text: text.slice(i, end), start: i });
    i = end;
  };
  /** Words and punctuation only (code); `cmds`: backslash commands too (maths). */
  const plain = (end: number, cmds = false) => {
    if (!cmds) code?.push([i, end]);
    const s = text.slice(i, end);
    const base = i;
    let k = 0;
    const words = (to: number) => {
      for (const t of tokenizeWords(s.slice(k, to))) tokens.push({ ...t, start: t.start + base + k });
      k = to;
    };
    if (cmds)
      for (const m of s.matchAll(/\\(?:[a-zA-Z]+|[^\s])/g)) {
        words(m.index);
        tokens.push({ type: "cmd", text: m[0], start: base + m.index });
        k = m.index + m[0].length;
      }
    words(s.length);
    i = end;
  };
  const lineEnd = (from: number) => {
    const j = text.indexOf("\n", from);
    return j === -1 ? text.length : j;
  };
  /** A fenced code block from its opening fence at `i`: the fence lines are markup, the rest (with the line breaks) code. */
  const fenced = (fence: string) => {
    const close = new RegExp(`\\n[ \\t]{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*(?=\\n|$)`, "g");
    close.lastIndex = lineEnd(i);
    const m = close.exec(text);
    push("cmd", lineEnd(i));
    const contentEnd = m ? m.index + 1 : text.length;
    if (i < contentEnd) plain(contentEnd);
    if (m) push("cmd", lineEnd(i));
  };
  const word = () => {
    let j = i + 1;
    while (j < text.length) {
      const d = text[j]!;
      if (WORD.test(d)) j++;
      else if (WORD_INNER.test(d) && j + 1 < text.length && WORD.test(text[j + 1]!)) j += 2;
      else break;
    }
    push("word", j);
  };

  while (i < text.length) {
    const link = links[links.length - 1];
    if (link && i >= link.close) {
      if (i === link.close) {
        push("rbrace", i + 1);
        push("cmd", link.end);
      }
      links.pop();
      continue;
    }
    /** Nothing reads past the end of the link's text it is in. */
    const limit = link ? link.close : text.length;
    const c = text[i]!;
    if (/\s/.test(c)) {
      let j = i;
      let newlines = 0;
      while (j < text.length && /\s/.test(text[j]!)) {
        if (text[j] === "\n") newlines++;
        j++;
      }
      push(newlines >= 2 ? "parbreak" : "ws", j);
      continue;
    }
    const at = text.slice(i, Math.min(i + 300, limit));
    if (atLineStart(text, i)) {
      const fence = link ? null : FENCE.exec(at);
      if (fence) {
        fenced(fence[1]!);
        continue;
      }
      const m =
        HEADING.exec(at) ??
        THEMATIC.exec(at) ??
        SETEXT.exec(at) ??
        (text.slice(i, lineEnd(i)).includes("|") ? DELIMITER_ROW.exec(at) : null) ??
        REF_DEFINITION.exec(at) ??
        FOOTNOTE_DEFINITION.exec(at) ??
        LIST_MARKER.exec(at);
      if (m) {
        push("cmd", i + m[0].length);
        continue;
      }
      if (c === ">") {
        push("cmd", i + 1);
        continue;
      }
    }
    const prev = tokens[tokens.length - 1];
    const prevMarker = prev?.type === "ws" ? tokens[tokens.length - 2] : undefined;
    if (c === "[" && prevMarker?.type === "cmd" && LIST_MARKER.test(prevMarker.text) && TASK_BOX.test(at)) {
      push("cmd", i + 3);
      continue;
    }
    if (c === "\\") {
      if (text[i + 1] === "\n")
        push("cmd", i + 1); // a hard line break
      else push("punct", PUNCTUATION.test(text[i + 1] ?? "") ? i + 2 : i + 1);
      continue;
    }
    if (c === "`") {
      const n = /^`+/.exec(at)![0].length;
      const end = new RegExp(`(?<!\`)\`{${n}}(?!\`)`, "g");
      end.lastIndex = i + n;
      const m = end.exec(text);
      if (!m || m.index + n > limit || /\n[ \t]*\n/.test(text.slice(i, m.index))) {
        push("punct", i + n);
        continue;
      }
      push("punct", i + n);
      plain(m.index);
      push("punct", m.index + n);
      continue;
    }
    if (c === "<") {
      if (at.startsWith("<!--")) {
        const end = text.indexOf("-->", i + 4);
        push("comment", end === -1 ? text.length : end + 3);
        continue;
      }
      const m = AUTOLINK.exec(at) ?? HTML_TAG.exec(at);
      if (m) {
        push("cmd", i + m[0].length);
        continue;
      }
    }
    if (c === "$") {
      if (text[i + 1] === "$") {
        const end = text.indexOf("$$", i + 2);
        if (end !== -1 && end + 2 <= limit && !/\n[ \t]*\n/.test(text.slice(i, end))) {
          push("math", i + 2);
          plain(end, true);
          push("math", end + 2);
          continue;
        }
      } else {
        const end = inlineMathEnd(text, i);
        if (end !== -1 && end <= limit) {
          push("math", i + 1);
          plain(end - 1, true);
          push("math", end);
          continue;
        }
      }
      push("punct", text[i + 1] === "$" ? i + 2 : i + 1);
      continue;
    }
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const open = c === "!" ? i + 1 : i;
      const fn = FOOTNOTE_REF.exec(at);
      if (c === "[" && fn) {
        push("cmd", i + fn[0].length);
        continue;
      }
      const l = linkAt(text, open);
      if (l && (!link || l.end <= link.close)) {
        push("lbrace", open + 1);
        links.push(l);
        continue;
      }
    }
    if ((c === "h" || c === "w") && !(i > 0 && WORD.test(text[i - 1]!))) {
      const m = BARE_URL.exec(at);
      if (m) {
        push("cmd", i + m[0].length);
        continue;
      }
    }
    if (c === "|" && /^[ \t>]*\|/.test(text.slice(text.lastIndexOf("\n", i - 1) + 1))) {
      push("cmd", i + 1); // a table's cell separator
      continue;
    }
    if (WORD.test(c)) word();
    else push("punct", i + 1);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Structure

const FENCE_LINE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;
const MATH_LINE = /^[ \t]*\$\$[ \t]*$/;
const HEADING_LINE = /^[ \t]{0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_LINE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** Markup that starts a structure at the start of a line: headings, list items, quotes, fences, rows, breaks. */
const isBoundary = (t: Token): boolean =>
  t.type === "cmd" && (/^(?:#{1,6}|[-*+]|\d{1,9}[.)]|>|`{3,}.*|~{3,}.*|\[\^?[^\]]+\]:.*)$/.test(t.text) || THEMATIC.test(t.text));

/** A line that starts a structure: a heading, a list item, a quote, a fence, a table row, a break, a definition, HTML. */
const STRUCTURE_LINE =
  /^[ \t]*(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|>|`{3,}|~{3,}|\||(?:([-*_=])[ \t]*)(?:\1[ \t]*){2,}$|\[\^?[^\]\n]+\]:|<\/?[a-zA-Z]|\$\$[ \t]*$)/;

/** Headings, fences, display maths' bounds and breaks: pieces of their own in a run of new text. */
const SECTION_LINE = /^[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|`{3,}|~{3,}|\$\$[ \t]*$|([-*_])(?:[ \t]*\1){2,}[ \t]*$)/;

const isStructureOnly = (t: string) => {
  const s = t.trim();
  return !s.includes("\n") && (HEADING_LINE.test(s) || FENCE_LINE.test(s) || THEMATIC_LINE.test(s) || MATH_LINE.test(s));
};

const isEnvironmentBound = (t: string) => {
  const s = t.trim();
  return FENCE_LINE.test(s) || MATH_LINE.test(s);
};

/** HTML elements that make a block of their own (`<details> … </details>`), counted by `lineNesting`. */
const HTML_BLOCKS = "details|div|table|figure|blockquote|section|aside|center|dl|ol|ul|pre|picture";

/**
 * How a line changes nesting: fences (counted modulo 2: the same line opens and closes), display
 * maths `$$` on a line of its own (modulo 2), and HTML blocks.
 */
function lineNesting(line: string): number[] {
  const tags = (re: RegExp) => [...line.matchAll(re)].length;
  return [
    FENCE_LINE.test(line) ? 1 : 0,
    MATH_LINE.test(line.replace(/\n$/, "")) ? 1 : 0,
    tags(new RegExp(`<(?:${HTML_BLOCKS})\\b[^>]*(?<!/)>`, "gi")) - tags(new RegExp(`</(?:${HTML_BLOCKS})\\s*>`, "gi")),
  ];
}

/** A whole block, by what it is: fenced code → "code block", `$$ … $$` on lines of their own → "equation". Else null. */
function environmentOf(text: string): string | null {
  const t = text.trim();
  const fence = /^(`{3,}|~{3,})[^\n]*\n/.exec(t);
  if (fence) {
    const close = new RegExp(`\\n[ \\t]*${fence[1]![0] === "`" ? "`" : "~"}{${fence[1]!.length},}$`);
    return close.test(t) && !new RegExp(`\\n[ \\t]*${fence[1]![0] === "`" ? "`" : "~"}{3,}[^\\n]*\\n`).test(t.slice(fence[0].length - 1)) ? "code block" : null;
  }
  if (/^\$\$[ \t]*\n[\s\S]*\n[ \t]*\$\$$/.test(t) && (t.match(/\$\$/g) ?? []).length === 2) return "equation";
  return null;
}

// ---------------------------------------------------------------------------
// Maths, link targets and keys: taken whole

/** Token spans [open, close] of maths: `$ … $` and `$$ … $$` pairs. */
function mathSpans(toks: Token[]): [number, number][] {
  const spans: [number, number][] = [];
  let open = -1;
  toks.forEach((t, i) => {
    if (t.type !== "math") return;
    if (open < 0) open = i;
    else {
      spans.push([open, i]);
      open = -1;
    }
  });
  return spans;
}

/** Link targets (`(url)`, `[ref]`), footnote marks and definitions, reference definitions: one token each. */
const isKeyToken = (t: Token) => t.type === "cmd" && /^[[(]/.test(t.text) && !TASK_BOX.test(`${t.text} `);

const keySpans = (toks: Token[]): [number, number][] => toks.flatMap((t, i): [number, number][] => (isKeyToken(t) ? [[i, i]] : []));

const WHOLE_KEY = /^\s*(?:\([^\n]*\)|\[[^\]\n]*\](?::[^\n]*)?)\s*$/;

/** Is this edit a whole link target or key (`(#intro)` → `(#introduction)`, `[^1]` → `[^2]`)? */
function isKeyEdit(oldText: string, newText: string): boolean {
  const whole = (t: string) => WHOLE_KEY.test(t);
  return (whole(oldText) || !oldText.trim()) && (whole(newText) || !newText.trim()) && (whole(oldText) || whole(newText));
}

/** Code spans and fenced code: their spaces are content. */
function verbatim(text: string): (t: Token) => boolean {
  const spans: [number, number][] = [];
  tokenize(text, spans);
  if (!spans.length) return () => false;
  return (t) => spans.some(([a, b]) => t.start >= a && t.start < b);
}

export const MARKDOWN_SYNTAX: SyntaxRules = {
  tokenize: (text) => tokenize(text),
  isBoundary,
  mathSpans,
  keySpans,
  isKeyEdit,
  verbatim,
  // Table cells and hard line breaks end a "sentence" too.
  endsUnit: (t) => t.type === "cmd" && (t.text === "|" || t.text === "\\"),
  sentenceEnd: /[.?!][)\]}'"’”*_`$]*$/,
  structureLine: STRUCTURE_LINE,
  sectionLine: SECTION_LINE,
  isStructureOnly,
  environmentOf,
  describeBlock: (name) => name,
  isEnvironmentBound,
  lineNesting,
  nestingParity: [0, 1],
  isCommand: (w) => /^(?:<\/?[a-zA-Z]|&#?\w+;$|\\[a-zA-Z])/.test(w),
  inMath: (t) => /(?<!\\)\$/.test(t),
};

// ---------------------------------------------------------------------------
// Keys: headings' anchors, reference definitions, footnotes

const count = (keys: Iterable<string>) => {
  const out = new Map<string, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
};

/** Text without code (fenced code, code spans) and HTML comments: nothing in them is a heading or a link. */
function withoutCode(text: string): string {
  const spans: [number, number][] = [];
  tokenize(text, spans);
  let out = text;
  for (const [a, b] of [...spans].reverse()) out = out.slice(0, a) + out.slice(a, b).replace(/[^\n]/g, " ") + out.slice(b);
  return out.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The text a heading shows, without its markup: links and images by their text, code by its contents. */
const shownText = (s: string) =>
  s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*~`]/g, "")
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=[^\p{L}\p{N}]|$)/gu, "$1")
    .replace(/\\(.)/g, "$1");

/** A heading's anchor, as GitHub makes it: its text in lower case, without punctuation, spaces as hyphens. */
export function anchorOf(heading: string): string {
  return shownText(heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const label = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Labels `text` defines: `#anchor` for each heading (and HTML `id`), `[label]` for reference definitions, `[^1]` for footnotes. */
function labelsDefined(text: string): Map<string, number> {
  const c = withoutCode(text);
  const keys: string[] = [];
  const lines = c.split("\n");
  for (const [k, line] of lines.entries()) {
    const atx = /^[ \t]{0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) keys.push(`#${anchorOf(atx[1]!)}`);
    // A setext heading: a line of text underlined with `=` or `-`.
    const next = lines[k + 1];
    if (next !== undefined && /^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(next) && line.trim() && !STRUCTURE_LINE.test(line) && !(lines[k - 1] ?? "").trim())
      keys.push(`#${anchorOf(line)}`);
    const def = /^[ \t]{0,3}\[([^\]\n]+)\]:/.exec(line);
    if (def) keys.push(def[1]!.startsWith("^") ? `[${def[1]}]` : `[${label(def[1]!)}]`);
  }
  for (const m of c.matchAll(/<[a-zA-Z][^>]*\s(?:id|name)\s*=\s*["']([^"']+)["']/g)) keys.push(`#${m[1]}`);
  return count(keys);
}

/** Labels `text` uses: `#anchor` links (in this file or another), reference links, footnote marks. */
function labelsUsed(text: string): Map<string, number> {
  const c = withoutCode(text);
  const keys: string[] = [];
  for (const m of c.matchAll(/\]\(\s*<?[^)\s#>]*#([^)\s>]+)>?(?:\s+["'(][^)]*)?\)/g)) keys.push(`#${decode(m[1]!)}`);
  for (const m of c.matchAll(/\shref\s*=\s*["'][^"'#]*#([^"']+)["']/g)) keys.push(`#${decode(m[1]!)}`);
  for (const m of c.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) keys.push(`[^${m[1]}]`);
  // `[text][ref]`, `[ref][]` and `[ref]` (a shortcut: whatever a definition defines).
  for (const m of c.matchAll(/(?<![\]\\])\[((?:[^\]\n\\]|\\.)+)\](?:\[([^\]\n]*)\])?(?![(:[])/g)) {
    if (m[1]!.startsWith("^")) continue;
    const ref = m[2] ? m[2] : m[1]!;
    if (ref.trim() && !/^[ xX]$/.test(ref)) keys.push(`[${label(ref)}]`);
  }
  return count(keys);
}

function diffCounts(o: Map<string, number>, n: Map<string, number>): { removed: string[]; added: string[] } {
  return {
    removed: [...o].filter(([k, c]) => c > (n.get(k) ?? 0)).map(([k]) => k),
    added: [...n].filter(([k, c]) => c > (o.get(k) ?? 0)).map(([k]) => k),
  };
}

/** The three sorts of labels, named in groups' titles ("Rename heading anchor #a → #b"); their keys tell them apart. */
const ANCHOR: KeyKind = { id: "label", noun: "heading anchor" };
const LINK_DEFINITION: KeyKind = { id: "label", noun: "link definition" };
const FOOTNOTE: KeyKind = { id: "label", noun: "footnote" };
const kindOf = (key: string) => (key.startsWith("#") ? ANCHOR : key.startsWith("[^") ? FOOTNOTE : LINK_DEFINITION);

const references: ReferenceRules = {
  definitions: (it: Item) => {
    const { before, after } = it.context;
    const { removed, added } = diffCounts(labelsDefined(before + it.oldText + after), labelsDefined(before + it.newText + after));
    return [ANCHOR, LINK_DEFINITION, FOOTNOTE]
      .map((kind) => ({ kind, removed: removed.filter((k) => kindOf(k) === kind), added: added.filter((k) => kindOf(k) === kind), fresh: false }))
      .filter((c) => c.removed.length || c.added.length);
  },
  uses: (kind, oldWin, newWin) => (kind === "label" ? diffCounts(labelsUsed(oldWin), labelsUsed(newWin)) : { removed: [], added: [] }),
};

// ---------------------------------------------------------------------------
// Files: images, links to the project's own files

/** A link's destination without its title, angle brackets, fragment and query. */
const destination = (s: string) => {
  const t = s.trim();
  const d = t.startsWith("<") ? t.slice(1, t.indexOf(">") === -1 ? undefined : t.indexOf(">")) : t.split(/\s+/)[0]!;
  return decode(d.replace(/[#?].*$/, ""));
};
/** A file of the project, not a URL, an e-mail address or a fragment alone. */
const isLocal = (d: string) => !!d && !/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(d);

const includes: IncludeRules = {
  filesIn: (text) => {
    const out = new Map<string, number>();
    const add = (d: string) => {
      if (isLocal(d)) out.set(d, (out.get(d) ?? 0) + 1);
    };
    const c = withoutCode(text);
    for (const m of c.matchAll(/\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g)) add(destination(m[1]!));
    for (const m of c.matchAll(/^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:[ \t]*(\S+)/gm)) add(destination(m[1]!));
    for (const m of c.matchAll(/<(?:img|source|a)\b[^>]*\s(?:src|href|srcset)\s*=\s*["']([^"'\s]+)/gi)) add(destination(m[1]!));
    return out;
  },
  names: (ref, file) => {
    const norm = (p: string) =>
      p
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/^(?:\.\.?\/)+/, "");
    const [r, f] = [norm(ref), norm(file)];
    return !!r && (f === r || f.endsWith("/" + r));
  },
};

// ---------------------------------------------------------------------------
// Parts of linked groups

/** How a text nests: link brackets, maths delimiters (counted), fences (counted). */
function balance(s: string): number[] {
  const toks = tokenize(s);
  const n = (f: (t: Token) => boolean) => toks.filter(f).length;
  return [
    n((t) => t.type === "lbrace") - n((t) => t.type === "rbrace"),
    n((t) => t.type === "math") % 2,
    n((t) => t.type === "cmd" && FENCE_LINE.test(t.text)) % 2,
  ];
}

const parts: PartRules = { global: () => false, balance, parity: [1, 2] };

// ---------------------------------------------------------------------------

export const MARKDOWN: LanguageProfile = {
  id: "markdown",
  name: "Markdown",
  files: "md",
  defaultFiles: ["*.md", "*.markdown"],
  extensions: /\.(?:md|markdown)$/i,
  fence: "markdown",
  document: true,
  // A README or a changelog is in almost every project: Markdown is a project's language when it has no other.
  incidental: true,
  renderer: "markdown",
  renderSource: markdownSides,
  agentTerms: {
    location: 'README.md:12 "suggestion"',
    linked: "a heading and the `#anchor` links to it, a reference link and its `[label]: url` definition, a new image and the `![](…)` that shows it",
    compiles: "nothing stops Markdown from rendering, but a link to a missing heading, definition or file is broken",
    reference: "a heading with the `#anchor` links to it",
    dependencies:
      "a heading and the links to its anchor, a reference definition or footnote and its uses, a file and the links to it, code fences split across changes",
  },
  syntax: MARKDOWN_SYNTAX,
  references,
  includes,
  parts,
  spoken: {
    maths: /(?<!\\)\$/,
    keys: /\]\(#|\[\^|\]\[/,
    words: (t) =>
      t
        .replace(/\[\^([^\]\s]+)\](?!:)/g, " footnote $1 ")
        .replace(/\]\(#([^)\s]+)\)/g, "] (link to section $1)")
        .replace(/\]\[([^\]\n]+)\]/g, "] (link $1)"),
  },
};
