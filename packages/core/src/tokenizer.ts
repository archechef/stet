/**
 * Tokens of a document's text (spec §6.2 step 2): each language profile's tokenizer makes them
 * (LaTeX's is in `lang/latex.ts`). The kinds are the language's own, mapped to these.
 */

export type TokenType =
  | "word"
  | "cmd" // markup: \emph, \section
  | "lbrace" // a group: {
  | "rbrace" // }
  | "math" // a maths delimiter: $, $$, \( \) \[ \]
  | "comment"
  | "ws"
  | "parbreak" // whitespace containing >= 2 newlines
  | "punct";

export interface Token {
  type: TokenType;
  text: string;
  /** Offset of the token in the tokenized string. */
  start: number;
}

const WORD = /[\p{L}\p{N}\p{M}]/u;
const WORD_INNER = /[-']/;

/** Tokens of any text, for languages without a tokenizer of their own: words, whitespace, punctuation. */
export function tokenizeWords(text: string): Token[] {
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
    } else if (WORD.test(c)) {
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

/** Whitespace-ish tokens that don't carry content. */
export function isBlank(t: Token): boolean {
  return t.type === "ws" || t.type === "parbreak";
}
