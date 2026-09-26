import { describe, expect, it } from "vitest";
import { tokenize } from "../src/tokenizer.js";

const types = (s: string) => tokenize(s).map((t) => `${t.type}:${t.text}`);

describe("tokenize", () => {
  it("splits words, commands, braces and punctuation", () => {
    expect(types("Hello \\emph{world}.")).toEqual(["word:Hello", "ws: ", "cmd:\\emph", "lbrace:{", "word:world", "rbrace:}", "punct:."]);
  });

  it("keeps hyphenated words and apostrophes together", () => {
    expect(types("state-of-the-art isn't")).toEqual(["word:state-of-the-art", "ws: ", "word:isn't"]);
  });

  it("recognizes math delimiters, comments and paragraph breaks", () => {
    expect(types("$x$ \\[y\\] % note\n\nNext")).toEqual([
      "math:$", "word:x", "math:$", "ws: ", "math:\\[", "word:y", "math:\\]", "ws: ", "comment:% note", "parbreak:\n\n", "word:Next",
    ]);
  });

  it("handles starred commands and control symbols", () => {
    expect(types("\\section*{A} 50\\%")).toEqual(["cmd:\\section*", "lbrace:{", "word:A", "rbrace:}", "ws: ", "word:50", "cmd:\\%"]);
  });

  it("records offsets", () => {
    expect(tokenize("ab  cd").map((x) => x.start)).toEqual([0, 2, 4]);
  });
});
