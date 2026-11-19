import { describe, expect, it } from "vitest";
import { defaultConfig, validateConfig } from "../src/config.js";
import { applyChanges, containerArgs, cropRegion, DEFAULT_PREVIEW, detectEngine, detectPreviewEnv, detectRoot, errorsOf, excerpt, parseSynctex } from "../src/preview.js";
import { edit, PAPER, setup, write } from "./helpers.js";

describe("preview: the document", () => {
  it("finds the document to compile", () => {
    const doc = "\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n";
    expect(detectRoot(new Map([["main.tex", doc], ["intro.tex", "Intro."]]), null)).toBe("main.tex");
    expect(detectRoot(new Map([["paper.tex", doc], ["sections/a.tex", doc]]), null)).toBe("paper.tex");
    expect(detectRoot(new Map([["a.tex", doc], ["b.tex", doc]]), null)).toBeNull(); // two candidates: ask
    expect(detectRoot(new Map([["a.tex", doc], ["b.tex", doc]]), "b.tex")).toBe("b.tex");
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
    expect(cropRegion([{ page: 3, h: 0, v: 100, W: 1, H: 7 }, { page: 4, h: 0, v: 700, W: 1, H: 7 }], { width: 612, height: 792 })!.h).toBeLessThan(300);
  });

  it("picks the error out of a LaTeX log", () => {
    const log = "This is pdfTeX\n(./main.tex\n./main.tex:5: Undefined control sequence.\nl.5 \\foo\n\nmore";
    expect(excerpt(log)).toMatch(/^\.\/main\.tex:5: Undefined control sequence\./);
  });
});

describe("preview: isolation", () => {
  it("runs builds in a container with no network, no privileges and a read-only TeX", () => {
    const env = { status: "ready" as const, isolation: "container" as const, message: "", texBin: "/tl/2026/bin/x86_64-linux", texMount: "/tl" };
    const a = containerArgs(env, "localhost/stet-preview:1", "/cache/abc/base/src", "stet-preview-1", ["latexmk", "main.tex"]);
    for (const flag of ["--rm", "--network=none", "--read-only", "--userns=keep-id", "--cap-drop=ALL", "--security-opt=no-new-privileges"]) expect(a).toContain(flag);
    // Exactly two mounts: TeX read-only, the build folder.
    const vols = a.flatMap((x, i) => (x === "--volume" ? [a[i + 1]] : []));
    expect(vols).toEqual(["/tl:/tl:ro", "/cache/abc/base/src:/work"]);
    // TeX may read and write only the build folder, and no shell escape.
    for (const v of ["openin_any=p", "openout_any=p", "shell_escape=f", "HOME=/tmp"]) expect(a).toContain(v);
    expect(a.slice(-3)).toEqual(["localhost/stet-preview:1", "latexmk", "main.tex"]);
  });

  it("says what is missing instead of installing anything", async () => {
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const env = await detectPreviewEnv(DEFAULT_PREVIEW);
      expect(env.status).toBe("unavailable");
      expect(env.message).toMatch(/latexmk/);
      expect(env.fix).toMatch(/TeX Live/);
    } finally {
      process.env.PATH = path;
    }
    expect((await detectPreviewEnv({ ...DEFAULT_PREVIEW, enabled: false })).message).toMatch(/switched off/);
  });

  it("accepts only safe settings", () => {
    const cfg = (pv: object) => validateConfig({ ...defaultConfig("main"), preview: { ...DEFAULT_PREVIEW, ...pv } });
    expect(cfg({ rootFile: "paper/main.tex" }).preview.rootFile).toBe("paper/main.tex");
    for (const rootFile of ["../outside.tex", "/etc/main.tex", "-shell-escape.tex", "main.pdf", "a;b.tex"]) expect(() => cfg({ rootFile })).toThrow(/preview.rootFile/);
    expect(() => cfg({ engine: "pdflatex -shell-escape" })).toThrow(/preview.engine/);
    expect(() => cfg({ isolation: "none" })).toThrow(/preview.isolation/);
    expect(() => cfg({ image: "x; rm -rf /" })).toThrow(/preview.image/);
    expect(() => cfg({ timeout: 0 })).toThrow(/preview.timeout/);
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
  const ch = (from: string, to: string, file = "main.tex") => ({ file, baseText: base, eol: "lf" as const, range: { start: at(from), end: at(from) + from.length }, newText: to });

  it("applies the changes of a file together and finds the shown one in the result", () => {
    const r = applyChanges([ch("A.", "Proof text."), ch("\\begin{proof}\n", ""), ch("\\end{proof}\n", "")], 0)!;
    expect(r.files.get("main.tex")).toBe("Proof text.\nB.\n");
    expect(r.start).toBe(0);
    const s = applyChanges([ch("\\begin{proof}", "\\begin{proof}[Sketch]"), ch("B.", "C.")], 1)!;
    expect(s.files.get("main.tex")!.slice(s.start, s.start + 2)).toBe("C.");
    expect(applyChanges([ch("A.", "x"), ch("A.\n", "y")], 0)).toBeNull(); // overlapping
  });

  it("compares errors without their line numbers", () => {
    expect(errorsOf("./main.tex:3344: LaTeX Error: \\begin{proof} on input line 3274 ended by \\end{document}.\n! Undefined control sequence.\nl.17 We conclude that the method is \\newword")).toEqual([
      "LaTeX Error: \\begin{proof} on input line # ended by \\end{document}.",
      "Undefined control sequence. @ We conclude that the method is \\newword",
    ]);
    // The same message at two places is two errors.
    expect(new Set(errorsOf("! Undefined control sequence.\nl.3 a \\x\n! Undefined control sequence.\nl.9 b \\y")).size).toBe(2);
  });
});
