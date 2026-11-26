/**
 * The rendered preview of a Markdown change: the block around it, before and after, with the
 * changed text marked. VS Code's own Markdown renderer makes the HTML (preview.ts); this module
 * picks the Markdown to render and marks it, without `vscode`, so it is tested on its own.
 *
 * The marks are two private-use characters around the changed text, put where they don't change
 * what the Markdown means (after a heading's `#`, a list marker or a table's first `|`, around a
 * link rather than between its text and its target). The page's script turns them into
 * highlights in the rendered text, and they are taken out of attributes (a link's URL) here.
 */

/** Where a change starts and ends in the Markdown, and in the rendered HTML's text. */
export const MARK_OPEN = "";
export const MARK_CLOSE = "";

/** At most this many lines are shown each way from the change. */
const MAX_LINES = 30;

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const MATH_FENCE = /^[ \t]*\$\$[ \t]*$/;
/** Lines that are markup only: fences, breaks, a table's delimiter row, reference definitions, HTML blocks. */
const MARKUP_LINE =
  /^[ \t]{0,3}(?:`{3,}|~{3,}|\$\$[ \t]*$|([-*_])(?:[ \t]*\1){2,}[ \t]*$|=+[ \t]*$|\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$|\[[^\]\n]+\]:|<)/;
/** A line's block markup, which marks go after: quotes, list markers and task boxes, heading hashes, a table's first pipe. */
const LEADING_MARKUP = /^[ \t]*(?:>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+|\|[ \t]*)*/;

/** Fenced code and `$$` blocks, as [first, last] lines; an unclosed fence runs to the end. */
function verbatimBlocks(lines: string[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]!);
    if (f) {
      const close = new RegExp(`^[ \\t]{0,3}${f[1]![0] === "`" ? "`" : "~"}{${f[1]!.length},}[ \\t]*$`);
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j]!)) j++;
      out.push([i, Math.min(j, lines.length - 1)]);
      i = j;
    } else if (MATH_FENCE.test(lines[i]!)) {
      let j = i + 1;
      while (j < lines.length && !MATH_FENCE.test(lines[j]!)) j++;
      if (j < lines.length) {
        out.push([i, j]);
        i = j;
      }
    }
  }
  return out;
}

/** Line starts of `text` (offsets). */
const lineStarts = (text: string) => [0, ...[...text.matchAll(/\n/g)].map((m) => m.index! + 1)];
const lineAt = (starts: number[], offset: number) => {
  let k = 0;
  while (k + 1 < starts.length && starts[k + 1]! <= offset) k++;
  return k;
};

/**
 * The block of `text` around [start, end): the paragraph, list, table or code block it is in (a
 * change in blank lines: the paragraphs on both sides), at most MAX_LINES lines each way, never
 * cutting fenced code. Offsets [a, b), from a line's start to a line's end.
 */
export function blockAround(text: string, start: number, end: number): [number, number] {
  const starts = lineStarts(text);
  const lines = text.split("\n");
  const blank = (i: number) => !lines[i]!.trim();
  let first = lineAt(starts, start);
  let last = lineAt(starts, Math.max(start, end - 1));
  let allBlank = true;
  for (let i = first; i <= last; i++) if (!blank(i)) allBlank = false;
  // Blank lines at the change's edges belong to no paragraph.
  if (!allBlank) {
    while (blank(first)) first++;
    while (blank(last)) last--;
  }
  let s = first;
  let e = last;
  if (allBlank) {
    while (s > 0 && blank(s)) s--;
    while (e < lines.length - 1 && blank(e)) e++;
  }
  while (s > 0 && !blank(s - 1) && first - s < MAX_LINES) s--;
  while (e < lines.length - 1 && !blank(e + 1) && e - last < MAX_LINES) e++;
  for (const [fs, fe] of verbatimBlocks(lines)) {
    if (fs <= e && fe >= s) {
      s = Math.min(s, fs);
      e = Math.max(e, fe);
    }
  }
  return [starts[s]!, starts[e]! + lines[e]!.length];
}

/**
 * `source` with the marks around [a, b), line by line: after each line's block markup, and not in
 * lines that are markup only or in `$$` maths (where they would change what it shows). A link's
 * target is marked with its text.
 */
export function markRange(source: string, a: number, b: number): string {
  if (b <= a) return source;
  // A link's target alone (`(a.md)` → `(b.md)`): the link, from its `[`.
  if (source[a - 1] === "]" && /[([]/.test(source[a] ?? "")) {
    let depth = 0;
    for (let k = a - 1; k >= 0; k--) {
      if (source[k] === "]") depth++;
      else if (source[k] === "[" && --depth === 0) {
        a = source[k - 1] === "!" ? k - 1 : k;
        break;
      }
    }
  }
  // A link's text in its brackets: with its target.
  if (source[b - 1] === "]") {
    const target = /^(?:\([^)\n]*\)|\[[^\]\n]*\])/.exec(source.slice(b));
    if (target) b += target[0].length;
  }
  const starts = lineStarts(source);
  const lines = source.split("\n");
  const verbatim = verbatimBlocks(lines);
  const inBlock = (i: number) => verbatim.find(([s, e]) => i >= s && i <= e);
  const at: [number, string][] = [];
  for (let i = lineAt(starts, a); i <= lineAt(starts, b - 1); i++) {
    const line = lines[i]!;
    const block = inBlock(i);
    // Fences and `$$` themselves, and maths between `$$`s: left as they are.
    if (block && (i === block[0] || i === block[1] || MATH_FENCE.test(lines[block[0]]!))) continue;
    if (!block && (!line.trim() || MARKUP_LINE.test(line))) continue;
    let s = Math.max(a, starts[i]!);
    const e = Math.min(b, starts[i]! + line.length);
    if (!block && s === starts[i]) s += LEADING_MARKUP.exec(line)![0].length;
    if (s >= e) continue;
    at.push([s, MARK_OPEN], [e, MARK_CLOSE]);
  }
  let out = source;
  for (const [k, m] of at.reverse()) out = out.slice(0, k) + m + out.slice(k);
  return out;
}

/** The reference definitions of a text (`[docs]: https://…`): a link in the block that uses one needs it. */
export const referenceDefinitions = (text: string) => [...text.matchAll(/^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:[^\n]*$/gm)].map((m) => m[0].trim());

/**
 * The Markdown to render for a change of [start, end) of `text` (the file as it is) to `newText`:
 * the block around it before and after, marked, with the file's reference definitions.
 */
export function markdownSides(text: string, start: number, end: number, newText: string): { before: string; after: string } {
  const after = text.slice(0, start) + newText + text.slice(end);
  const side = (t: string, s: number, e: number) => {
    const [a, b] = blockAround(t, s, e);
    const defs = referenceDefinitions(t);
    return markRange(t.slice(a, b), s - a, e - a) + (defs.length ? `\n\n${defs.join("\n")}\n` : "\n");
  };
  return { before: side(text, start, end), after: side(after, start, start + newText.length) };
}

/** Marks taken out of the HTML's tags (a link's URL, an image's alt text), written as they are or percent-encoded. */
export function cleanTags(html: string): string {
  return html.replace(/<[^>]*>/g, (tag) => tag.replace(/[]|%EE%80%8[01]/gi, ""));
}

/**
 * Images of the rendered HTML from the project's files: `resolve` gives a relative source's
 * webview URI, or null to leave it out. Other sources (URLs, `data:`) are dropped: the page loads
 * nothing from the network.
 */
export function localImages(html: string, resolve: (path: string) => string | null): string {
  return html.replace(/(<img\b[^>]*?\ssrc=)(["'])([^"']*)\2/gi, (_m, head: string, q: string, src: string) => {
    let path: string | null = null;
    if (src && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
      try {
        path = decodeURI(src.replace(/[?#].*$/, "").replace(/&amp;/g, "&"));
      } catch {
        path = null;
      }
    }
    const uri = path ? resolve(path) : null;
    return `${head}${q}${uri ? uri.replace(/"/g, "%22") : ""}${q}`;
  });
}
