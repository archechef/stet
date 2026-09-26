/** LaTeX-aware tokenizer (spec §6.2 step 2). */

export type TokenType =
  | "word"
  | "cmd"
  | "lbrace"
  | "rbrace"
  | "math" // $, $$, \( \) \[ \]
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

/** Whitespace-ish tokens that don't carry content. */
export function isBlank(t: Token): boolean {
  return t.type === "ws" || t.type === "parbreak";
}
