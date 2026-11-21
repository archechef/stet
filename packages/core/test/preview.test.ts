import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, validateConfig } from "../src/config.js";
import { LATEX } from "../src/lang/index.js";
import {
  detectEngine,
  detectRoot,
  errorsOf,
  excerpt,
  LATEX_TYPESETTER,
  missingFiles,
  parseSynctex,
  plainWords,
  previewExtrasContainerfile,
} from "../src/lang/latex-preview.js";
import { applyChanges, cropRegion, insideDir, PreviewBuilder } from "../src/preview/builder.js";
import { containerArgs, DEFAULT_PREVIEW, detectPreviewEnv } from "../src/preview/env.js";
import { changeMarks, findWords, findWordsIn, markRuns, parseWords, wordDiff } from "../src/preview/words.js";
import { edit, PAPER, setup, write } from "./helpers.js";

describe("preview: the document", () => {
  it("finds the document to compile", () => {
    const doc = "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";
    expect(
      detectRoot(
        new Map([
          ["main.tex", doc],
          ["intro.tex", "Intro."],
        ]),
        null,
      ),
    ).toBe("main.tex");
    expect(
      detectRoot(
        new Map([
          ["paper.tex", doc],
          ["sections/a.tex", doc],
        ]),
        null,
      ),
    ).toBe("paper.tex");
    expect(
      detectRoot(
        new Map([
          ["a.tex", doc],
          ["b.tex", doc],
        ]),
        null,
      ),
    ).toBeNull(); // two candidates: ask
    expect(
      detectRoot(
        new Map([
          ["a.tex", doc],
          ["b.tex", doc],
        ]),
        "b.tex",
      ),
    ).toBe("b.tex");
    expect(detectRoot(new Map([["a.tex", doc]]), "missing.tex")).toBeNull();
  });

  it("picks the engine from a magic comment or the packages", () => {
    expect(detectEngine("% !TEX program = xelatex\n\\documentclass{article}")).toBe("xelatex");
    expect(detectEngine("%!TEX TS-program = LuaLaTeX\n")).toBe("lualatex");
    expect(detectEngine("\\usepackage[no-math]{fontspec}")).toBe("lualatex");
    expect(detectEngine("\\usepackage{amsmath}")).toBe("pdflatex");
  });
});

describe("preview: the region", () => {
  const out = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:out.pdf
Page:2
x:150.0
y:300.0
h:133.7
v:300.0
W:343.7
H:6.9
before:
offset:0
middle:
after:
Output:out.pdf
Page:2
x:150.0
y:312.0
h:133.7
v:312.0
W:343.7
H:6.9
SyncTeX result end
`;

  it("reads SyncTeX's boxes", () => {
    expect(parseSynctex(out)).toEqual([
      { page: 2, h: 133.7, v: 300, W: 343.7, H: 6.9 },
      { page: 2, h: 133.7, v: 312, W: 343.7, H: 6.9 },
    ]);
    expect(parseSynctex("SyncTeX result begin\nSyncTeX result end\n")).toEqual([]);
  });

  it("shows the lines of the change across the page width, with context, inside the page", () => {
    const r = cropRegion(parseSynctex(out), { width: 612, height: 792 })!;
    expect(r.page).toBe(2);
    expect([r.x, r.w]).toEqual([0, 612]);
    expect(r.y).toBeLessThan(300 - 8);
    expect(r.y + r.h).toBeGreaterThan(312);
    const top = cropRegion([{ page: 1, h: 0, v: 10, W: 10, H: 7 }], { width: 612, height: 792 })!;
    expect(top.y).toBe(0);
    expect(top.h).toBeGreaterThanOrEqual(110);
    expect(cropRegion([], { width: 1, height: 1 })).toBeNull();
    // Boxes on another page than the first are left out.
    expect(
      cropRegion(
        [
          { page: 3, h: 0, v: 100, W: 1, H: 7 },
          { page: 4, h: 0, v: 700, W: 1, H: 7 },
        ],
        { width: 612, height: 792 },
      )!.h,
    ).toBeLessThan(300);
  });

  it("picks the error out of a LaTeX log", () => {
    const log = "This is pdfTeX\n(./main.tex\n./main.tex:5: Undefined control sequence.\nl.5 \\foo\n\nmore";
    expect(excerpt(log)).toMatch(/^\.\/main\.tex:5: Undefined control sequence\./);
  });
});

describe("preview: isolation", () => {
  it("runs builds in a container with no network, no privileges and a read-only TeX", () => {
    const env = {
      status: "ready" as const,
      isolation: "container" as const,
      message: "",
      bin: "/tl/2026/bin/x86_64-linux",
      mounts: [["/tl", "/tl"]] as [string, string][],
    };
    const tex = (e: typeof env | { status: "ready"; isolation: "container"; message: string; bin: string }) => LATEX_TYPESETTER.buildEnv(e, "/tmp", true);
    const a = containerArgs(env, "localhost/stet-preview:1", "/cache/abc/base/src", "stet-preview-1", ["latexmk", "main.tex"], tex(env));
    for (const flag of ["--rm", "--network=none", "--read-only", "--userns=keep-id", "--cap-drop=ALL", "--security-opt=no-new-privileges"])
      expect(a).toContain(flag);
    // Exactly two mounts: TeX read-only, the build folder.
    const vols = a.flatMap((x, i) => (x === "--volume" ? [a[i + 1]] : []));
    expect(vols).toEqual(["/tl:/tl:ro", "/cache/abc/base/src:/work"]);
    // With the image's own TeX (macOS): only the build folder is mounted.
    const ownEnv = { status: "ready" as const, isolation: "container" as const, message: "", bin: "/usr/bin" };
    const own = containerArgs(ownEnv, "localhost/stet-preview-tex:1", "/w", "n", ["latexmk"], tex(ownEnv));
    expect(own.flatMap((x, i) => (x === "--volume" ? [own[i + 1]] : []))).toEqual(["/w:/work"]);
    // TeX may read and write only the build folder, and no shell escape.
    for (const v of ["openin_any=p", "openout_any=p", "shell_escape=f", "HOME=/tmp"]) expect(a).toContain(v);
    expect(a.slice(-3)).toEqual(["localhost/stet-preview:1", "latexmk", "main.tex"]);
  });

  it("says what is missing instead of installing anything", async () => {
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      // A container needs Podman first: the image can bring its own TeX. (No Podman here even if
      // the machine has one: CI runners often do.)
      const env = await detectPreviewEnv(DEFAULT_PREVIEW, LATEX_TYPESETTER, { podman: null });
      expect(env.status).toBe("unavailable");
      // Each platform says what it needs: Podman, or (Windows, not supported yet) WSL2.
      expect(env.message).toMatch(process.platform === "win32" ? /Windows/ : /Podman/);
      expect(env.fix).toMatch(process.platform === "win32" ? /WSL2/ : /Install Podman/);
      // Without a container (the user's choice), their own TeX is needed.
      const proc = await detectPreviewEnv({ ...DEFAULT_PREVIEW, isolation: "process" }, LATEX_TYPESETTER);
      expect(proc.message).toMatch(/latexmk/);
      expect(proc.fix).toMatch(/TeX Live/);
    } finally {
      process.env.PATH = path;
    }
    expect((await detectPreviewEnv({ ...DEFAULT_PREVIEW, enabled: false }, LATEX_TYPESETTER)).message).toMatch(/switched off/);
  });

  it("accepts only safe settings", () => {
    const cfg = (pv: object) => validateConfig({ ...defaultConfig("main"), preview: { ...DEFAULT_PREVIEW, ...pv } });
    expect(cfg({ rootFile: "paper/main.tex" }).preview.rootFile).toBe("paper/main.tex");
    for (const rootFile of ["../outside.tex", "/etc/main.tex", "-shell-escape.tex", "main.pdf", "a;b.tex"])
      expect(() => cfg({ rootFile })).toThrow(/preview.rootFile/);
    expect(() => cfg({ engine: "pdflatex -shell-escape" })).toThrow(/preview.engine/);
    expect(cfg({ engine: "lualatex" }).preview.engine).toBe("lualatex");
    // The engines are the language's (code quality report 6a517ae, language leaks): Typst has none of LaTeX's.
    const typst = (pv: object) => validateConfig({ ...defaultConfig("main"), language: "typst", preview: { ...DEFAULT_PREVIEW, ...pv } });
    expect(typst({ engine: "auto" }).preview.engine).toBe("auto");
    expect(() => typst({ engine: "lualatex" })).toThrow(/preview.engine 'lualatex' \(auto\)/);
    expect(() => cfg({ isolation: "none" })).toThrow(/preview.isolation/);
    expect(() => cfg({ image: "x; rm -rf /" })).toThrow(/preview.image/);
    expect(() => cfg({ timeout: 0 })).toThrow(/preview.timeout/);
    expect(() => cfg({ tex: "mine" })).toThrow(/preview.tex/);
    expect(() => cfg({ texImage: "a b" })).toThrow(/preview.texImage/);
    expect(() => cfg({ texExtras: "yes" })).toThrow(/preview.texExtras/);
    expect(() => cfg({ texExtrasImage: "x;y" })).toThrow(/preview.texExtrasImage/);
  });
});

describe("preview: changes without a place on the page", () => {
  it("has no preview for changes outside .tex text, and says why when previews are unavailable", async () => {
    const { stet } = await setup({ "main.tex": PAPER, "refs.bib": "@misc{a, title={A}}\n" });
    const { worktree: wt } = await stet.newAgent("a");
    edit(wt, "refs.bib", "title={A}", "title={B}");
    write(wt, "notes.txt", "x\n");
    const { items } = await stet.submit("a", { title: "t" });
    for (const it of items) expect((await stet.preview(it.id)).status).toBe("no-spot");
    await expect(stet.preview("99.1")).rejects.toThrow(/Unknown item/);
  });
});

describe("preview: several changes at once", () => {
  const base = "\\begin{proof}\nA.\n\\end{proof}\nB.\n";
  const at = (s: string) => base.indexOf(s);
  const ch = (from: string, to: string, file = "main.tex") => ({
    file,
    baseText: base,
    eol: "lf" as const,
    range: { start: at(from), end: at(from) + from.length },
    newText: to,
  });

  it("applies the changes of a file together and finds the shown one in the result", () => {
    const r = applyChanges([ch("A.", "Proof text."), ch("\\begin{proof}\n", ""), ch("\\end{proof}\n", "")], 0)!;
    expect(r.files.get("main.tex")).toBe("Proof text.\nB.\n");
    expect(r.start).toBe(0);
    const s = applyChanges([ch("\\begin{proof}", "\\begin{proof}[Sketch]"), ch("B.", "C.")], 1)!;
    expect(s.files.get("main.tex")!.slice(s.start, s.start + 2)).toBe("C.");
    expect(applyChanges([ch("A.", "x"), ch("A.\n", "y")], 0)).toBeNull(); // overlapping
  });

  it("compares errors without their line numbers", () => {
    expect(
      errorsOf(
        "./main.tex:3344: LaTeX Error: \\begin{proof} on input line 3274 ended by \\end{document}.\n! Undefined control sequence.\nl.17 We conclude that the method is \\newword",
      ),
    ).toEqual([
      "LaTeX Error: \\begin{proof} on input line # ended by \\end{document}.",
      "Undefined control sequence. @ We conclude that the method is \\newword",
    ]);
    // The same message at two places is two errors.
    expect(new Set(errorsOf("! Undefined control sequence.\nl.3 a \\x\n! Undefined control sequence.\nl.9 b \\y")).size).toBe(2);
  });
});

describe("preview: missing packages", () => {
  it("names the files LaTeX couldn't find", () => {
    const log =
      "! LaTeX Error: File `dsfont.sty' not found.\nType X to quit or <RETURN> to proceed,\n! I can't find file `bbm.sty'.\n! LaTeX Error: File `dsfont.sty' not found.";
    expect(missingFiles(log)).toEqual(["dsfont.sty", "bbm.sty"]);
    expect(missingFiles("! Undefined control sequence.")).toEqual([]);
  });

  it("builds the extra fonts as a layer on the image with its own TeX", () => {
    const f = previewExtrasContainerfile("localhost/stet-preview-tex:1");
    expect(f).toMatch(/^FROM localhost\/stet-preview-tex:1$/m);
    expect(f).toMatch(/texlive-fonts-extra/);
    expect(DEFAULT_PREVIEW.texExtras).toBe(false); // the small image unless the user agrees
  });
});

describe("preview: finding a change's words on the page", () => {
  const xhtml = (lines: string[][]) =>
    `<doc><page width="612" height="792"><flow><block>` +
    lines
      .map(
        (ws, k) =>
          `<line>` +
          ws.map((w, i) => `<word xMin="${100 + i * 40}" yMin="${100 + k * 12}" xMax="${130 + i * 40}" yMax="${110 + k * 12}">${w}</word>`).join("") +
          `</line>`,
      )
      .join("") +
    `</block></flow></page></doc>`;

  it("rebuilds lines around maths: a superscript, or a line's halves out of order", () => {
    const word = (t: string, x: number, y0: number, y1: number) => `<word xMin="${x}" yMin="${y0}" xMax="${x + 8}" yMax="${y1}">${t}</word>`;
    const xml =
      `<doc><page width="612" height="792"><flow><block>` +
      `<line>${word("first", 100, 100, 109)}${word("line", 140, 100, 109)}</line>` +
      `<line>${word("t", 190, 111, 117)}</line>` +
      `<line>${word("and", 160, 112, 121)}${word("more", 200, 112, 121)}</line>` +
      `<line>${word("X", 100, 112, 121)}${word("then", 120, 112, 121)}</line>` +
      `</block></flow></page></doc>`;
    expect(parseWords(xml, 1).map((x) => x.text)).toEqual(["first", "line", "X", "then", "and", "t", "more"]);
  });

  it("reads the words in order and joins a word hyphenated at a line end", () => {
    const w = parseWords(
      xhtml([
        ["Sentence", "one", "repre-"],
        ["sentation", "ends."],
      ]),
      3,
    );
    expect(w.map((x) => x.text)).toEqual(["Sentence", "one", "representation", "ends."]);
    expect(w[0]!.page).toBe(3);
  });

  it("turns LaTeX into the words it typesets", () => {
    expect(plainWords("We \\emph{study} the $x^2$ case~\\cite{knuth} of reviewing % a comment\nchanges.")).toEqual([
      "we",
      "study",
      "the",
      "case",
      "of",
      "reviewing",
      "changes",
    ]);
  });

  // The same sentence twice: only the context tells which one changed.
  const page = parseWords(
    xhtml([
      ["Sentence", "12", "says", "something", "about", "reviewing"],
      ["changes.", "Sentence", "13", "now", "SAYS", "SOMETHING"],
      ["NEW", "about", "reviewing", "changes.", "Sentence", "14"],
      ["says", "something", "about", "reviewing", "changes."],
    ]),
    1,
  );

  it("finds the changed words by their context, across lines", () => {
    const f = findWords(page, ["changes", "sentence", "13"], ["now", "says", "something", "new"], ["about", "reviewing"], 1)!;
    expect(f.map((w) => w.text)).toEqual(["now", "SAYS", "SOMETHING", "NEW"]);
    expect(new Set(f.map((w) => w.y0)).size).toBe(2); // two lines
  });

  it("finds a deletion by the words around it", () => {
    const f = findWords(page, ["sentence", "14"], [], ["says", "something"], 1)!;
    expect(f.map((w) => w.text)).toEqual(["14", "says"]);
  });

  it("finds a long change from its first word, not just its end", () => {
    // A paragraph of 150 words rewritten: matched by its first and last 20 words, in a stretch of the page as long as it.
    const target = Array.from({ length: 150 }, (_, k) => `word${k}`);
    const lines = [["before", "one", "two"], ...Array.from({ length: 15 }, (_, l) => target.slice(l * 10, l * 10 + 10)), ["after", "three", "four"]];
    const f = findWordsIn(parseWords(xhtml(lines), 1), ["before", "one", "two"], target, ["after", "three", "four"], 1)!;
    expect([f.words[0]!.text, f.before?.text, f.after?.text]).toEqual(["word0", "two", "after"]);
  });

  it("gives up when the words aren't there", () => {
    expect(findWords(page, ["lorem"], ["ipsum", "dolor"], ["amet"], 1)).toBeNull();
  });
});

describe("preview: marking the changed words", () => {
  const w = (text: string, x: number, y: number, page = 1) => ({ text, page, x0: x, y0: y, x1: x + 30, y1: y + 10 });
  const before = [w("we", 0, 0), w("study", 35, 0), w("the", 70, 0), w("problem.", 105, 0), w("It", 0, 12), w("scales.", 35, 12)];
  const after = [w("we", 0, 0), w("study", 35, 0), w("the", 70, 0), w("hard", 105, 0), w("TASK.", 140, 0), w("It", 0, 12), w("scales.", 35, 12)];

  it("marks inserted words in the new version and removed ones in the old", () => {
    const d = wordDiff(before, after);
    expect(d.inserted.map((x) => x.text)).toEqual(["hard", "TASK."]);
    expect(d.removed.map((x) => x.text)).toEqual(["problem."]);
    // A change of case is a change between two versions.
    expect(wordDiff([w("task", 0, 0)], [w("Task", 0, 0)]).inserted).toHaveLength(1);
  });

  it("compares words as typeset: punctuation counts, hyphens from reflowing don't", () => {
    // `k` → `k^2` before the equation number (2): the exponent is the change, not the number.
    const d = wordDiff([w("k.", 0, 0), w("(2)", 300, 0)], [w("k", 0, 0), w("2", 8, -3), w(".", 14, 0), w("(2)", 300, 0)]);
    expect(d.inserted.map((x) => x.text)).toEqual(["2"]);
    expect(wordDiff([w("However", 0, 0)], [w("However,", 0, 0)]).inserted).toHaveLength(1);
    expect(wordDiff([w("change-by-change", 0, 0)], [w("changeby-change", 0, 0)]).inserted).toHaveLength(0);
  });

  it("reads maths alike however the line is spaced or broken", () => {
    // pdftotext splits "p+i" by the spacing of the line.
    const spaced = wordDiff(
      [w("so", 0, 0), w("p+i", 20, 0), w("holds", 60, 0)],
      [w("so", 0, 0), w("p", 20, 0), w("+", 30, 0), w("i", 40, 0), w("holds", 60, 0)],
    );
    expect([spaced.inserted, spaced.removed]).toEqual([[], []]);
    // A formula that stays while the words around it change is not a change.
    const moved = wordDiff(
      [w("in", 0, 0), w("R", 10, 0), w("for", 20, 0), w("a", 40, 0), w("≥", 50, 0), w("0.", 60, 0), w("Let", 80, 0)],
      [w("for", 0, 0), w("every", 20, 0), w("a", 40, 0), w("≥", 50, 0), w("0.", 60, 0), w("Then", 80, 0)],
    );
    expect(moved.inserted.map((x) => x.text)).toEqual(["every", "Then"]);
    expect(moved.removed.map((x) => x.text)).toEqual(["in", "R", "Let"]);
  });

  describe("only where the changes are", () => {
    // "By (2) the bound holds. We add a NEW sentence here. See (3)." with (2)→(3) renumbered far off.
    const words = ["By", "(3)", "the", "bound", "holds.", "We", "add", "a", "NEW", "sentence", "here.", "See", "(4)."].map((t, i) => w(t, i * 40, 0));
    const differ = [words[1]!, words[8]!, words[12]!];
    const at = (...i: number[]) => i.map((k) => words[k]!);

    it("marks the differences between the context around a change, not consequences elsewhere", () => {
      const m = changeMarks(words, differ, [{ words: at(5, 6, 7, 8, 9, 10), around: false, before: words[4]!, after: words[11]! }]);
      expect(m.map((x) => x.text)).toEqual(["NEW"]);
    });

    it("marks a change the editor shows whole, but nothing next to it that didn't change", () => {
      const m = changeMarks(words, differ, [{ words: at(6, 7, 8), around: false, before: words[4]!, after: words[11]!, whole: true }]);
      expect(m.map((x) => x.text)).toEqual(["add", "a", "NEW"]);
    });

    it("marks a context word that differs (punctuation added to it)", () => {
      const m = changeMarks(words, [words[4]!], [{ words: at(4, 5), around: true, before: words[4]!, after: words[5]! }]);
      expect(m.map((x) => x.text)).toEqual(["holds."]);
    });

    it("marks every difference when no change could be found on the page", () => {
      expect(changeMarks(words, differ, [])).toEqual(differ);
    });
  });

  it("joins neighbouring marked words on a line, not across lines", () => {
    expect(markRuns([w("hard", 105, 0), w("TASK.", 140, 0)])).toEqual([{ x0: 105, y0: 0, x1: 170, y1: 10 }]);
    expect(markRuns([w("end", 140, 0), w("start", 0, 12)])).toHaveLength(2);
  });
});

describe("isolation and the image cache (security review 2026-11-19)", () => {
  it("runs previews only in the user's image, with limits, and never downloads one", () => {
    const env = {
      status: "ready" as const,
      isolation: "container" as const,
      message: "",
      bin: "/tl/bin",
      mounts: [["/tl", "/tl"]] as [string, string][],
      memoryLimit: true,
    };
    const args = containerArgs(env, "localhost/stet-preview:1", "/w", "n", ["latexmk"]);
    expect(args).toContain("--pull=never");
    expect(args.join(" ")).toMatch(/--ulimit fsize=\d+:\d+/);
    expect(args.join(" ")).toMatch(/--ulimit nofile=\d+:\d+/);
    expect(args).toContain("--memory=2g");
    expect(containerArgs({ ...env, memoryLimit: false }, "i", "/w", "n", ["x"])).not.toContain("--memory=2g");
  });

  it("trusts preview images only in the change's own cache folder, and only real commit names", async () => {
    expect(insideDir("/c/abc/items/1.1-x/after.png", "/c/abc/items/1.1-x")).toBe(true);
    expect(insideDir("/home/me/.ssh/id_ed25519", "/c/abc/items/1.1-x")).toBe(false);
    expect(insideDir("/c/abc/items/1.1-x/../../x.png", "/c/abc/items/1.1-x")).toBe(false);
    const { stet } = await setup({ "main.tex": PAPER });
    const ready = { status: "ready" as const, isolation: "container" as const, message: "", bin: "/tl/bin", mounts: [["/tl", "/tl"]] as [string, string][] };
    const b = new PreviewBuilder(stet.repo, join(stet.store.root, "previews"), DEFAULT_PREVIEW, ready, LATEX);
    const req = {
      base: "../../../../tmp",
      key: "1.1-abc",
      target: 0,
      changes: [{ file: "main.tex", baseText: PAPER, eol: "lf" as const, range: { start: 0, end: 1 }, newText: "x" }],
    };
    expect((await b.preview(req)).status).toBe("unavailable");
    expect((await b.preview({ ...req, base: "a".repeat(40), key: "../x" })).status).toBe("unavailable");
  });
});

describe("the document to compile", () => {
  it("a file named with a leading '-' is never taken as the document to compile (security report 5e4c6af, S18)", () => {
    const doc = "\\documentclass{article}\n\\begin{document}x\\end{document}\n";
    expect(detectRoot(new Map([["-pvc.tex", doc]]), null)).toBeNull();
    expect(detectRoot(new Map([["paper.tex", doc]]), null)).toBe("paper.tex");
  });
});
