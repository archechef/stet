/**
 * PDF previews of Typst documents: where markers can go in the source, the document to compile,
 * Typst's diagnostics, and (where `typst` is installed, as in the dev container) finding changes
 * on the page with the markers.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { defaultConfig, validateConfig } from "../src/config.js";
import { TYPST } from "../src/lang/index.js";
import type { RunIsolated } from "../src/lang/profile.js";
import {
  detectRoot,
  errorsOf,
  excerpt,
  inDefinition,
  markerSpots,
  missingFiles,
  parsePositions,
  plainWords,
  scan,
  TYPST_CONTAINERFILE,
  TYPST_TYPESETTER,
  TYPST_VERSION,
  typstPackageDirs,
  withMarkers,
} from "../src/lang/typst-preview.js";

const TS = TYPST_TYPESETTER;

/** Where markers go on the (0-based) lines of `text`, as the text that follows each. */
const spotsOn = (text: string, first: number, last = first) => markerSpots(text, first, last).map((at) => text.slice(at, at + 12).split("\n")[0]);

describe("Typst previews: where markers go", () => {
  const DOC = [
    "#set page(width: 300pt)", // 0
    "#let name = [Stet]", // 1
    "= Introduction <intro>", // 2
    "Some text in a paragraph", // 3
    "  that goes on here.", // 4
    "", // 5
    "- a list item", // 6
    "+ an enumerated one", // 7
    "#figure(", // 8
    "  rect(width: 10pt),", // 9
    "  caption: [A caption.],", // 10
    ") <fig>", // 11
    "$ x + y", // 12
    "  = z $", // 13
    "```python", // 14
    "print(1)", // 15
    "```", // 16
    "// a comment", // 17
    "#show heading: it => [", // 18
    "  Shown at #it.body", // 19
    "]", // 20
    "#if true [", // 21
    "  Shown here", // 22
    "]", // 23
    "Text with (brackets) and #emph[emphasis].", // 24
  ].join("\n");

  it("at a line's text, after a heading's or a list's markup", () => {
    expect(spotsOn(DOC, 2)).toEqual(["Introduction"]);
    expect(spotsOn(DOC, 3, 4)).toEqual(["Some text in", "that goes on"]);
    expect(spotsOn(DOC, 6, 7)).toEqual(["a list item", "an enumerate"]);
    expect(spotsOn(DOC, 24)).toEqual(["Text with (b", "emphasis]."]);
  });

  it("right after a `[` in code, and before a call or an equation that starts a line", () => {
    expect(spotsOn(DOC, 10)).toEqual(["A caption.],"]);
    expect(spotsOn(DOC, 8)).toEqual(["#figure("]);
    expect(spotsOn(DOC, 12)).toEqual(["$ x + y"]);
  });

  it("finds code, maths and raw text by the markup just before them", () => {
    expect(spotsOn(DOC, 9)).toEqual(["#figure("]);
    expect(spotsOn(DOC, 13)).toEqual(["$ x + y"]);
    expect(spotsOn(DOC, 15)).toEqual(["```python"]);
  });

  it("puts none in definitions, rules and comments, which show nothing where they are", () => {
    for (const line of [0, 1, 17, 18, 19, 20]) expect(spotsOn(DOC, line), `line ${line}`).toEqual([]);
    // Content shown where it is, as an `#if`'s, has them.
    expect(spotsOn(DOC, 22)).toEqual(["Shown here"]);
    expect(inDefinition(DOC, DOC.indexOf("width: 300pt"))).toBe(true);
    expect(inDefinition(DOC, DOC.indexOf("Shown at"))).toBe(true);
    expect(inDefinition(DOC, DOC.indexOf("Some text"))).toBe(false);
    expect(inDefinition(DOC, DOC.indexOf("Shown here"))).toBe(false);
  });

  it("never before a label, a closing bracket, or a list's marker", () => {
    const t = "Text\n<label>\n]\n- item\n#emph[- inner]\n#strong[<x> y]";
    expect(scan(t).points.map((p) => t.slice(p.at).split("\n")[0])).toEqual(["Text", "item", "#emph[- inner]", "inner]", "#strong[<x> y]"]);
    // Brackets in markup are text: after one is markup still.
    expect(scan("A [b] c").points.map((p) => p.at)).toEqual([0, 3]);
  });

  it("a marker ends with `;`, so text after it stays text", () => {
    const t = "A (b) [c] .d";
    const out = withMarkers(t, [0, 2]);
    expect(out).toBe("#context[#metadata((n: 0, pos: here().position()))<stet-at>];A #context[#metadata((n: 1, pos: here().position()))<stet-at>];(b) [c] .d");
  });

  it("reads where `typst eval` says the markers are", () => {
    const out = JSON.stringify([
      { n: 1, pos: { page: 2, x: "35.71pt", y: "88.5pt" } },
      { n: 0, pos: { page: 1, x: "10pt", y: "20pt" } },
      { n: "x", pos: {} },
    ]);
    expect(parsePositions(out)).toEqual([
      { n: 1, page: 2, x: 35.71, y: 88.5 },
      { n: 0, page: 1, x: 10, y: 20 },
    ]);
    expect(parsePositions("not json")).toEqual([]);
  });
});

describe("Typst previews: the document", () => {
  const files = (o: Record<string, string>) => new Map(Object.entries(o));

  it("is main.typ, the configured root, or the one file nothing reads in", () => {
    expect(detectRoot(files({ "main.typ": "", "other.typ": "" }), null)).toBe("main.typ");
    expect(detectRoot(files({ "a.typ": "", "b.typ": "" }), "b.typ")).toBe("b.typ");
    expect(detectRoot(files({ "a.typ": "" }), "missing.typ")).toBeNull();
    expect(detectRoot(files({ "paper.typ": '#import "template.typ": *\n#include "ch/one.typ"', "template.typ": "", "ch/one.typ": "" }), null)).toBe(
      "paper.typ",
    );
    expect(detectRoot(files({ "a.typ": "", "b.typ": "" }), null)).toBeNull(); // two candidates: ask
    expect(detectRoot(files({ "-x.typ": "" }), null)).toBeNull();
  });

  it("compiles to stet-build, and only its PDF is a build's output", () => {
    expect(TS.outputs("chapters/main.typ")).toEqual(["stet-build/main.pdf"]);
  });

  it("has its own image setting, checked", () => {
    const cfg = defaultConfig("main");
    expect(cfg.preview.typstImage).toBe("localhost/stet-preview-typst:1");
    expect(() => validateConfig({ ...cfg, preview: { ...cfg.preview, typstImage: "bad image" } })).toThrow(/typstImage/);
  });

  it("builds its image from Typst's release, checked against its checksum", () => {
    expect(TYPST_CONTAINERFILE).toContain(`/download/v${TYPST_VERSION}/typst-\${t}-unknown-linux-musl.tar.xz`);
    expect(TYPST_CONTAINERFILE).toMatch(/amd64\) t=x86_64; sum=[0-9a-f]{64} ;;/);
    expect(TYPST_CONTAINERFILE).toContain("sha256sum -c -");
    expect(TYPST_CONTAINERFILE).toContain("poppler-utils");
  });

  it("knows where Typst keeps packages on each system", () => {
    expect(typstPackageDirs("linux", {}, "/home/u")).toEqual({ cache: "/home/u/.cache/typst/packages", local: "/home/u/.local/share/typst/packages" });
    expect(typstPackageDirs("linux", { XDG_CACHE_HOME: "/c" }, "/home/u").cache).toBe("/c/typst/packages");
    expect(typstPackageDirs("darwin", {}, "/Users/u").cache).toBe("/Users/u/Library/Caches/typst/packages");
    expect(typstPackageDirs("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "C:\\Users\\u").cache).toBe(
      "C:\\Users\\u\\AppData\\Local\\typst\\packages",
    );
  });
});

describe("Typst previews: diagnostics and words", () => {
  const LOG = [
    "main.typ:14:5: error: label `<missing>` does not exist in the document",
    "main.typ:3:1: warning: unknown font family: inria",
    "error: failed to load file",
  ].join("\n");

  it("compares errors without their line numbers, warnings left out", () => {
    expect(errorsOf(LOG)).toEqual(["main.typ: label `<missing>` does not exist in the document", "failed to load file"]);
    expect(errorsOf("main.typ:30:5: error: label `<missing>` does not exist in the document")).toEqual(errorsOf(LOG).slice(0, 1));
    expect(excerpt(`compiling\n${LOG}`)).toBe(LOG);
  });

  it("names the packages Typst couldn't find or download", () => {
    const log = [
      "main.typ:1:8: error: failed to download package (https://packages.typst.org/preview/cetz-0.3.1.tar.gz: Dns Failed: resolve dns name)",
      "main.typ:2:8: error: package not found (searched for @local/mytemplate:0.1.0)",
      "main.typ:3:7: error: file not found (searched at /work/x.png)",
    ].join("\n");
    expect(missingFiles(log)).toEqual(["@preview/cetz:0.3.1", "@local/mytemplate:0.1.0"]);
    expect(TS.installHint({ status: "ready", isolation: "container", message: "" }, false)).toMatch(/Typst package cache/);
  });

  it("takes the words markup typesets, not code, labels or maths", () => {
    expect(plainWords('= The Method <sec>\nWe use $x^2$ and @ref, see #emph[this] and #link("https://x.org")[here].')).toEqual([
      "the",
      "method",
      "we",
      "use",
      "and",
      "see",
      "this",
      "and",
      "here",
    ]);
    expect(plainWords("#figure(rect(), caption: [A box.]) // note\n#set text(size: 11pt)\n- An item `code`")).toEqual(["box", "an", "item", "code"]);
  });
});

// ---------------------------------------------------------------------------
// With Typst itself (the dev container has it).

const hasTypst = spawnSync("typst", ["--version"]).status === 0;

describe.skipIf(!hasTypst)("Typst previews: with Typst", () => {
  const dir = mkdtempSync(join(tmpdir(), "stet-typst-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  /** Runs a build's program in `work`, as a process. */
  const run: RunIsolated = async (work, cmd) => {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd: work, encoding: "utf8", env: { ...process.env, TYPST_PACKAGE_CACHE_PATH: join(dir, "pc") } });
    return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
  };
  const project = (files: Record<string, string>) => {
    const work = mkdtempSync(join(dir, "p-"));
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(dirname(join(work, f)), { recursive: true });
      writeFileSync(join(work, f), t);
    }
    return work;
  };
  const PAGE = "#set page(width: 300pt, height: 300pt, margin: 20pt)\n";

  it("compiles to stet-build, or reports Typst's errors", async () => {
    const work = project({ "main.typ": `${PAGE}Hello.\n` });
    const ok = await TS.compile(run, work, "main.typ", defaultConfig("main").preview);
    expect(ok.pdf).toBe(join(work, "stet-build/main.pdf"));
    const bad = project({ "main.typ": `${PAGE}See @nowhere.\n` });
    const failed = await TS.compile(run, bad, "main.typ", defaultConfig("main").preview);
    expect(failed.pdf).toBeNull();
    expect(errorsOf(failed.log)).toEqual(["main.typ: label `<nowhere>` does not exist in the document"]);
  });

  it("finds lines on the page, in an included file too, and leaves the build as it was", async () => {
    const chapter = "= Chapter\nFirst line of the chapter.\n\n#pagebreak()\nOn the second page.\n";
    const work = project({ "main.typ": `${PAGE}= Title\nIntro text.\n#include "ch/one.typ"\n`, "ch/one.typ": chapter });
    await TS.compile(run, work, "main.typ", defaultConfig("main").preview);
    const before = readdirSync(work).sort();
    const first = await TS.locate(run, work, "stet-build/main.pdf", "ch/one.typ", [2, 2], "main.typ");
    expect(first).toHaveLength(1);
    expect(first![0]).toMatchObject({ page: 1, h: 20 });
    const second = await TS.locate(run, work, "stet-build/main.pdf", "ch/one.typ", [5, 5], "main.typ");
    expect(second![0]!.page).toBe(2);
    expect(second![0]!.v).toBeLessThan(first![0]!.v); // near the top of page 2
    // A definition shows nothing; the files are as they were, the scratch copy gone.
    expect(await TS.locate(run, work, "stet-build/main.pdf", "main.typ", [1, 1], "main.typ")).toBeNull();
    expect(readdirSync(work).sort()).toEqual(before);
    expect(readFileSync(join(work, "ch/one.typ"), "utf8")).toBe(chapter);
  });

  it("finds an equation by the markup before it, and text in a caption", async () => {
    const work = project({
      "main.typ": `${PAGE}Text.\n\n#v(100pt)\n$ a + b\n  = c $\n\n#figure(rect(width: 20pt), caption: [The caption.])\n`,
    });
    await TS.compile(run, work, "main.typ", defaultConfig("main").preview);
    const eq = await TS.locate(run, work, "stet-build/main.pdf", "main.typ", [6, 6], "main.typ");
    expect(eq![0]!.v).toBeGreaterThan(100);
    const caption = await TS.locate(run, work, "stet-build/main.pdf", "main.typ", [8, 8], "main.typ");
    expect(caption![0]!.v).toBeGreaterThan(eq![0]!.v);
  });

  it("markers move nothing on the page", async () => {
    const text = `${PAGE}#set par(first-line-indent: 1em, justify: true)\n= Title\nA paragraph (with brackets) that runs on.\n\n- an item\n- another\n`;
    const work = project({ "main.typ": text, "marked.typ": withMarkers(text, markerSpots(text, 0, 7)) });
    execFileSync("typst", ["compile", "main.typ", "a.svg"], { cwd: work });
    execFileSync("typst", ["compile", "marked.typ", "b.svg"], { cwd: work });
    expect(markerSpots(text, 0, 7)).toHaveLength(4);
    expect(readFileSync(join(work, "b.svg"), "utf8")).toBe(readFileSync(join(work, "a.svg"), "utf8"));
  });
});

describe("Typst is the Typst profile's typesetter", () => {
  it("previews .typ files", () => {
    expect(TYPST.typesetter).toBe(TS);
    expect(TS.source.test("ch/one.typ")).toBe(true);
    expect(TS.noSpot("#let x = 1\nText.", 4, true)).toBe(true);
    expect(TS.noSpot("#let x = 1\nText.", 12, true)).toBe(false);
  });
});
