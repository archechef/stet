/** Text an agent wrote, as Stet shows it and puts it into commit messages. */
import { describe, expect, it } from "vitest";
import { oneLine, printable } from "../src/text.js";
import { PAPER, setup } from "./helpers.js";

describe("invisible characters (security review 2026-11-19)", () => {
  it("shows terminal escapes, direction overrides and invisible characters in agent text as markers", () => {
    // Shown, not dropped: dropped, the file still got them unseen (security report 5e4c6af, S11).
    const evil = "fine\u001b[2J\u001b]0;pwned\u0007 text\u202e txet\u2066";
    expect(printable(evil)).toBe("fine⟨U+001B⟩[2J⟨U+001B⟩]0;pwned⟨U+0007⟩ text⟨U+202E⟩ txet⟨U+2066⟩");
    expect(oneLine("a\u001b[31mred\nb")).toBe("a⟨U+001B⟩[31mred b");
    expect(printable("line\nbreak\ttab")).toBe("line\nbreak\ttab");
    expect(printable("\\ref{a\u200b} \u00ad\ufeff\u{e0041}")).toBe("\\ref{a⟨U+200B⟩} ⟨U+00AD⟩⟨U+FEFF⟩⟨U+E0041⟩");
    // A lone CR is the line break TeX and Markdown see; a terminal would print over the line (S10).
    expect(printable("shown\rhidden\r\nnext")).toBe("shown\nhidden\nnext");
  });
});

describe("commit messages", () => {
  it("agent titles reach commit messages on one line, without control characters (security report 5e4c6af, S13)", async () => {
    const { stet } = await setup({ "main.tex": PAPER });
    const msg = await stet.commitMessage([], "Fix\u001b[2J it\nnow");
    expect(msg.subject).toBe("Fix⟨U+001B⟩[2J it now");
  });
});
