/** One-line summaries of changes, and how they are read out. */
import { describe, expect, it } from "vitest";
import { profileByName } from "../src/lang/index.js";
import { LATEX } from "../src/lang/latex.js";
import { TYPST } from "../src/lang/typst.js";
import type { Item } from "../src/model.js";
import { changeSummary, spokenChange, summaryTexts } from "../src/text.js";
import { makeItem } from "./helpers.js";

const item = (oldText: string, newText: string, extra: Partial<Item> = {}) => makeItem(oldText, newText, { file: "main.typ", ...extra });

describe("change summaries (test report v0.14, B4, UX)", () => {
  it("show where two long texts differ, and whitespace", async () => {
    const { changeSummary } = await import("../src/text.js");
    const [o, n] = changeSummary(
      "\\begin{equation} r = \\frac{\\ln(N_t) - \\ln(N_0)}{t}, \\label{eq:growth} \\end{equation}",
      "\\begin{equation} r = \\frac{\\ln N_t - \\ln N_0}{t}, \\label{eq:growth} \\end{equation}",
    );
    expect(o).not.toBe(n);
    expect(o).toContain("\\ln(N_t)");
    expect(n).toContain("\\ln N_t");
    expect(changeSummary(" ", "~")).toEqual(["␣", "~"]);
    expect(changeSummary(" ", "\n\n")).toEqual(["␣", "¶"]);
    expect(changeSummary("short", "text")).toEqual(["short", "text"]);
  });
});

describe("short changes and spoken maths (decisions on the 5e4c6af reports)", () => {
  it("summaries: the words around a short change, and a call's name", () => {
    const it = item("80", "90", { context: { before: '#image("a.png", width: ', after: "%)\n" } });
    expect(summaryTexts(it)).toEqual(["width: 80%", "width: 90%"]);
    const [o, n] = changeSummary("See #cite(<linikos1986>) here.", 'See #cite(<linikos1986>, form: "prose") here.', 40);
    expect(o.startsWith("#cite(") || o.startsWith("…#cite(")).toBe(true);
    expect(n).toContain("form:");
  });

  it("spoken maths: only what differs, labels and references in words", () => {
    const typst = TYPST.spoken;
    expect(spokenChange("$norm(x - hat(x)) <= C eps^2$", "$norm(x - hat(x)) <= C eps^3$", typst)).toBe(
      "in the formula norm(x - hat(x)) <= C eps^2: 2 becomes 3",
    );
    expect(spokenChange("see @fig:plot", "see @fig:error", typst)).toBe("replace see reference to fig:plot with see reference to fig:error");
    expect(spokenChange("plain words", "other words", typst)).toBeNull();
  });

  it("spells out labels and references as the file's language writes them (code quality report 6a517ae, language leaks)", () => {
    expect(spokenChange("see \\ref{a}", "see \\ref{b}", LATEX.spoken)).toBe("replace see reference to a with see reference to b");
    // In LaTeX an email address is no reference, and in a plain text file nothing is spelled out.
    expect(spokenChange("mail a@b.org", "mail c@d.org", LATEX.spoken)).toBeNull();
    expect(spokenChange("see \\ref{a}", "see \\ref{b}", profileByName("notes.txt").spoken)).toBeNull();
  });
});
