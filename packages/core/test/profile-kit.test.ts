/**
 * The built-in profiles are written as a local profile would be: they use only the profile kit
 * (`lang/kit.ts`) and the profile types, so bundled as modules and imported, they review
 * changes as they do built in.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LATEX, type LanguageProfile, LEAN, TYPST } from "../src/lang/index.js";
import { KIT_SPECIFIER } from "../src/lang/load.js";
import type { Stet } from "../src/service.js";
import { edit, LABELLED, outsideDir, setup, write } from "./helpers.js";

const LANG = join(__dirname, "..", "src", "lang");
/** esbuild, the bundler the extension's build uses (it is the extension package's dependency). */
const { build } = createRequire(join(__dirname, "..", "..", "vscode", "package.json"))("esbuild") as {
  build(options: Record<string, unknown>): Promise<{ outputFiles: { text: string }[]; metafile: { inputs: Record<string, unknown> } }>;
};

/** What each built-in profile file may import besides the kit, the profile types and node: modules: its own language's files. */
const FAMILY: Record<string, string[]> = {
  "latex.ts": ["./latex-preview.js"],
  "latex-preview.ts": [],
  "bibtex.ts": ["./latex.js"],
  "typst.ts": [],
  "lean.ts": [],
  "plain.ts": [],
};

describe("the built-in profiles", () => {
  it("import only the kit, the profile types and node: modules", () => {
    for (const [file, family] of Object.entries(FAMILY)) {
      const source = readFileSync(join(LANG, file), "utf8");
      const imports = [...source.matchAll(/^(import(?: type)?)\b[^;]*?from "([^"]+)";/gms)].map((m) => ({ type: m[1] === "import type", from: m[2]! }));
      expect(imports.length, file).toBeGreaterThan(0);
      for (const { type, from } of imports) {
        const ok = from === "./kit.js" || from.startsWith("node:") || family.includes(from) || (type && from === "./profile.js");
        expect(ok, `${file} imports ${type ? "types " : ""}from ${from}`).toBe(true);
      }
    }
  });
});

/** A built-in profile bundled as a local profile module under another id, the kit left to Stet. */
async function bundled(profile: LanguageProfile, file: string, id: string): Promise<{ path: string; inputs: string[] }> {
  const dir = outsideDir();
  const out = await build({
    stdin: {
      contents: `import { ${exportName(profile)} as p } from "./${file.replace(/\.ts$/, ".js")}";
export const apiVersion = 1;
export default { ...p, id: ${JSON.stringify(id)}, name: "Imported " + p.name, files: ${JSON.stringify(id)} };
`,
      resolveDir: LANG,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    metafile: true,
    absWorkingDir: LANG,
    logLevel: "silent",
    plugins: [
      {
        name: "profile-kit",
        setup(b: { onResolve(o: { filter: RegExp }, f: () => { path: string; external: boolean }): void }) {
          b.onResolve({ filter: /^\.\/kit\.js$/ }, () => ({ path: KIT_SPECIFIER, external: true }));
        },
      },
    ],
  });
  write(dir, `${id}.mjs`, out.outputFiles[0]!.text);
  // Paths relative to the profiles' folder (absWorkingDir).
  return { path: join(dir, `${id}.mjs`), inputs: Object.keys(out.metafile.inputs).map((p) => p.replace(/\\/g, "/")) };
}

const exportName = (p: LanguageProfile) => ({ latex: "LATEX", typst: "TYPST", lean: "LEAN" })[p.id]!;

/** The same agent's edits in a project, reviewed by the built-in profile or the imported copy of it. */
async function review(
  profile: LanguageProfile,
  files: Record<string, string>,
  edits: [file: string, from: string, to: string][],
  imported?: { path: string; id: string },
) {
  const { stet } = await setup(files);
  if (imported) await useImported(stet, profile, imported);
  const { worktree } = await stet.newAgent("a");
  for (const [file, from, to] of edits) edit(worktree, file, from, to);
  const r = await stet.submit("a", { title: "Revise" });
  const cfg = await stet.config();
  return {
    profiles: [...new Set(Object.keys(files).map((f) => stet.profile(cfg, f).id))],
    items: r.items.map((i) => [i.file, i.oldText, i.newText]),
    groups: r.groups.map((g) => [g.kind, g.title, g.items.length, g.parts?.length ?? 0]),
  };
}

/** The imported copy takes the built-in's files, and is the project's language. */
async function useImported(stet: Stet, profile: LanguageProfile, imported: { path: string; id: string }) {
  await stet.importProfile(imported.path, { use: true });
  await stet.store.withLock(async () => {
    const cfg = await stet.config();
    await stet.store.saveConfig({ ...cfg, files: { ...cfg.files, [profile.files!]: [], [imported.id]: [...profile.defaultFiles!] } });
  });
}

const CASES: { profile: LanguageProfile; file: string; files: Record<string, string>; edits: [string, string, string][] }[] = [
  {
    profile: LATEX,
    file: "latex.ts",
    files: { "main.tex": LABELLED },
    edits: [
      ["main.tex", "\\label{sec:intro}", "\\label{sec:introduction}"],
      ["main.tex", "\\ref{sec:intro}", "\\ref{sec:introduction}"],
      ["main.tex", "the problem of reviewing", "the task of reviewing"],
    ],
  },
  {
    profile: TYPST,
    file: "typst.ts",
    files: { "main.typ": "= Introduction <sec:intro>\n\nIn this work we study the problem of reviewing changes.\n\nAs @sec:intro shows, it is hard.\n" },
    edits: [
      ["main.typ", "<sec:intro>", "<sec:introduction>"],
      ["main.typ", "@sec:intro shows", "@sec:introduction shows"],
      ["main.typ", "the problem of reviewing", "the task of reviewing"],
    ],
  },
  {
    profile: LEAN,
    file: "lean.ts",
    files: {
      "Basic.lean": "def double (n : Nat) : Nat := 2 * n\n\ntheorem double_eq (n : Nat) : double n = n + n := by\n  unfold double\n  omega\n",
      "Uses.lean": "import Basic\n\ntheorem double_two : double 2 = 4 := by\n  rw [double_eq]\n",
    },
    edits: [
      ["Basic.lean", "theorem double_eq (n", "theorem double_eq_add (n"],
      ["Uses.lean", "rw [double_eq]", "rw [double_eq_add]"],
    ],
  },
];

describe("a built-in profile bundled as a module and imported", () => {
  for (const c of CASES) {
    it(`reviews ${c.profile.name} changes as the built-in one does, with the kit of the Stet that runs it`, async () => {
      const id = `imported-${c.profile.id}`;
      const { path, inputs } = await bundled(c.profile, c.file, id);
      // Nothing of Stet's in the bundle: only the language's own files.
      expect(
        inputs
          .filter((p) => p !== "<stdin>")
          .every((p) => !p.startsWith("..") && [c.file, ...FAMILY[c.file]!.map((f) => f.replace(/^\.\//, "").replace(/\.js$/, ".ts"))].includes(p)),
      ).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`from "${KIT_SPECIFIER}"`);

      const builtIn = await review(c.profile, c.files, c.edits);
      const imported = await review(c.profile, c.files, c.edits, { path, id });
      expect(builtIn.profiles).toEqual([c.profile.id]);
      expect(imported.profiles).toEqual([id]);
      expect(imported.items).toEqual(builtIn.items);
      expect(imported.groups).toEqual(builtIn.groups);
      expect(builtIn.groups.some(([kind]) => kind === "linked")).toBe(true);
    });
  }
});
