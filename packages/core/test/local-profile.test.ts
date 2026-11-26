import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { itemEffect } from "../src/effects.js";
import { documentProfile } from "../src/lang/index.js";
import { forgetLibraryProfile, libraryDirectory, readLibrary } from "../src/lang/library.js";
import { Stet } from "../src/service.js";
import { FAKE_CLI, git, outsideDir, read, setup, write } from "./helpers.js";

it("loads a local profile from the shared store and keeps it scoped to its repository", async () => {
  const file = "proof.custom";
  const before = "old first\nkeep\nold last\n";
  const after = "new first\nkeep\nnew last\n";
  const moduleDir = outsideDir();
  const profileFile = "local proof.mjs";
  const buildFile = "tools/build.proof.js";
  const reason = "the proof runner executes this build script";
  const source = `
    export const apiVersion = 1;
    export default {
      id: "local-proof",
      name: "Local Proof",
      files: "proof",
      defaultFiles: ["*.proof"],
      extensions: /\\.proof$/,
      fence: "proof",
      document: true,
      fileEffects: [
        { path: /^tools\\/build\\.proof\\.js$/, reason: ${JSON.stringify(reason)} },
        { path: /latexmkrc$/, reason: "a local rule overlapping a built-in rule" },
      ],
      agentTerms: {
        location: 'proof.custom:1 "suggestion"',
        linked: "a proof and its uses",
        compiles: "a missing proof is an error",
        reference: "a proof with its uses",
        dependencies: "proofs and their uses",
      },
      splitUnits(oldText, newText) {
        return [{ start: 0, end: oldText.length, newStart: 0, newEnd: newText.length, oldText, newText }];
      },
    };
  `;
  const { stet, repo } = await setup({ [file]: before, [profileFile]: source, [buildFile]: "build();\n" });
  const config = (profileModules: string[]) =>
    write(
      stet.storeRoot,
      "config.json",
      JSON.stringify({
        mainBranch: "master",
        language: "local-proof",
        profileModules,
        files: { proof: ["*.custom"] },
      }),
    );
  expect((await stet.importProfile(join(repo, profileFile))).id).toBe("local-proof");
  const installed = (await stet.config()).profileModules!;
  expect(installed).toHaveLength(1);
  expect(read(stet.storeRoot, `profiles/${installed[0]}`)).toBe(source);
  config(installed);
  const cfg = await stet.config();
  expect(documentProfile(cfg).name).toBe("Local Proof");
  expect(stet.profile(cfg, file).id).toBe("local-proof");
  expect(stet.profile(cfg, "ignored.proof").id).toBe("plain");
  expect(stet.profile(cfg, buildFile).id).toBe("plain");
  expect(itemEffect({ file: ".latexmkrc" }, cfg)).toMatch(/latexmk runs it/);
  await stet.setCli(FAKE_CLI);
  const { worktree } = await stet.newAgent("a", { kind: "claude-code" });
  expect(read(worktree, "CLAUDE.local.md")).toContain("Local Proof");
  const agentStet = await Stet.open(worktree);
  expect(agentStet.profile(await agentStet.config(), file).id).toBe("local-proof");
  write(worktree, file, after);
  const { items } = await agentStet.submit("a", { title: "Revise proof" });
  expect(items.map((item) => item.newText)).toEqual([after]);
  git(worktree, "mv", buildFile, "tools/old-build.js");
  const renamed = await agentStet.submit("a", { title: "Rename the build script" });
  expect(renamed.items).toHaveLength(1);
  expect(renamed.items[0]?.oldFile).toBe(buildFile);
  const ids = renamed.items.map((item) => item.id);
  await expect(stet.checkAccept(ids)).rejects.toThrow(reason);
  await expect(stet.accept(ids)).rejects.toThrow(reason);
  expect(read(repo, buildFile)).toBe("build();\n");
  await stet.accept(ids, { confirmEffects: true });
  expect(read(repo, "tools/old-build.js")).toBe("build();\n");
  await stet.sync("a");
  const changedSource = 'throw new Error("The source was changed");';
  write(worktree, profileFile, changedSource);
  const revision = await agentStet.submit("a", { title: "Replace original profile source" });
  await stet.accept(revision.items.map((item) => item.id));
  expect(read(repo, profileFile)).toBe(changedSource);
  expect(documentProfile(await stet.config()).id).toBe("local-proof");

  const other = (await setup({ [file]: "old\n" })).stet;
  expect(other.profile(await other.config(), file).id).toBe("plain");

  const dependency = pathToFileURL(join(repo, profileFile)).href;
  write(moduleDir, "dependent.mjs", `import ${JSON.stringify(dependency)};`);
  await expect(stet.importProfile(join(moduleDir, "dependent.mjs"))).rejects.toThrow("must bundle their dependencies");
  expect((await stet.config()).profileModules).toEqual(installed);

  config([join(repo, profileFile)]);
  await expect(stet.config()).rejects.toThrow("installed module names");
  config(installed);
  write(stet.storeRoot, `profiles/${installed[0]}`, 'throw new Error("The copy was changed");');
  await expect(stet.config()).rejects.toThrow("has changed");
});

const PROOFS = (id: string, name: string, agentTerms = true) => `
  export const apiVersion = 1;
  export default {
    id: ${JSON.stringify(id)},
    name: ${JSON.stringify(name)},
    files: ${JSON.stringify(id)},
    defaultFiles: ["*.prf"],
    extensions: /\\.prf$/,
    fence: "prf",
    document: true,
    buildFiles: ["_out/", "*.prfc"],
    outputOf: (source) => (source.endsWith(".prf") ? source.slice(0, -4) + ".pdf" : null),
    ${
      agentTerms
        ? `agentTerms: {
      location: 'main.prf:1 "step"',
      linked: "a lemma and its uses",
      compiles: "a missing lemma is an error",
      reference: "a lemma with its uses",
      dependencies: "lemmas and their uses",
    },`
        : ""
    }
  };
`;

it("is made the project's language on import or later, and offers its build files for .gitignore", async () => {
  const dir = outsideDir();
  write(dir, "proofs.mjs", PROOFS("proofs", "Proofs"));
  write(dir, "notes.mjs", PROOFS("notes", "Notes", false));
  const { stet, repo } = await setup({ "main.prf": "a\n", ".gitignore": "*.prfc\n" });
  await stet.setCli(FAKE_CLI);
  const { worktree } = await stet.newAgent("a", { kind: "claude-code" });
  write(repo, "main.pdf", "%PDF");
  write(repo, "cache.prfc", "ignored already");

  const r = await stet.importProfile(join(dir, "proofs.mjs"));
  expect(r).toEqual({ id: "proofs", name: "Proofs", language: "latex", selectable: true, buildFiles: ["_out/", "/main.pdf"], library: true });
  expect(read(worktree, "CLAUDE.local.md")).not.toContain("Proofs");
  await stet.setLanguage("proofs");
  expect(documentProfile(await stet.config()).name).toBe("Proofs");
  expect(read(worktree, "CLAUDE.local.md")).toContain("Proofs"); // the agent's instructions follow

  expect(await stet.ignoreBuildFiles("proofs")).toEqual(["_out/", "/main.pdf"]);
  expect(read(repo, ".gitignore")).toBe("*.prfc\n\n# Build files of Proofs (written by Stet)\n_out/\n/main.pdf\n");
  expect(await stet.buildFilesToIgnore("proofs")).toEqual([]);
  expect(await stet.ignoreBuildFiles("proofs")).toEqual([]);

  // A profile without examples for agents can't be the language: nothing is installed.
  await expect(stet.importProfile(join(dir, "notes.mjs"), { use: true })).rejects.toThrow("can't be the project's language");
  await expect(stet.setLanguage("notes")).rejects.toThrow("Unknown language 'notes'");
  expect((await stet.config()).profileModules).toHaveLength(1);
  expect((await stet.importProfile(join(dir, "notes.mjs"))).selectable).toBe(false);

  // Selected in the same step as the import.
  await stet.setLanguage("latex");
  write(dir, "proofs.mjs", PROOFS("proofs", "Proofs 2"));
  const used = await stet.importProfile(join(dir, "proofs.mjs"), { use: true });
  expect(used).toMatchObject({ id: "proofs", name: "Proofs 2", language: "proofs" });
  expect(read(worktree, "CLAUDE.local.md")).toContain("Proofs 2");
  expect((await stet.config()).profileModules).toHaveLength(2);
});

describe("the profile library", () => {
  it("keeps an imported profile for your other projects, which each get their own pinned copy", async () => {
    const dir = outsideDir();
    write(dir, "proofs.mjs", PROOFS("proofs", "Proofs"));
    const a = (await setup({ "main.prf": "a\n" })).stet;
    // Set up before the import (else setup takes Proofs from the library by itself).
    const { stet: b, repo: bRepo } = await setup({ "main.prf": "b\n" });
    expect((await a.importProfile(join(dir, "proofs.mjs"))).library).toBe(true);
    expect((await readLibrary()).map((e) => [e.id, e.name, e.defaultFiles, e.selectable])).toEqual([["proofs", "Proofs", ["*.prf"], true]]);

    // Another project uses it without the file: its own copy, and it is the language.
    expect(await b.profileLibrary()).toMatchObject([{ id: "proofs", installed: false, current: false }]);
    const used = await b.useProfile("proofs");
    expect(used).toMatchObject({ id: "proofs", language: "proofs", library: true });
    const pinned = (await b.config()).profileModules!;
    expect(read(b.storeRoot, `profiles/${pinned[0]}`)).toBe(PROOFS("proofs", "Proofs"));
    expect(await b.profileLibrary()).toMatchObject([{ id: "proofs", installed: true, current: true }]);

    // A newer version in the library doesn't change project b, which keeps its copy.
    write(dir, "proofs.mjs", PROOFS("proofs", "Proofs 2"));
    await a.importProfile(join(dir, "proofs.mjs"));
    expect((await readLibrary()).map((e) => e.name)).toEqual(["Proofs 2"]);
    expect(readdirSync(libraryDirectory()).filter((f) => f.endsWith(".mjs"))).toHaveLength(1); // the old version's module is gone
    expect(documentProfile(await b.config()).name).toBe("Proofs");
    expect(await b.profileLibrary()).toMatchObject([{ id: "proofs", installed: true, current: false }]);
    expect(read(bRepo, "main.prf")).toBe("b\n");

    // A library module that changed is refused; forgetting a profile leaves projects as they are.
    const [entry] = await readLibrary();
    write(libraryDirectory(), entry!.module, "throw new Error('changed')");
    await expect(b.useProfile("proofs")).rejects.toThrow("missing or has changed");
    expect(await forgetLibraryProfile("proofs")).toBe(true);
    expect(await readLibrary()).toEqual([]);
    await expect(b.useProfile("proofs")).rejects.toThrow("has no profile 'proofs'");
    expect(documentProfile(await b.config()).name).toBe("Proofs");
  });

  it("lets setup recognise its languages by their files", async () => {
    const dir = outsideDir();
    write(dir, "proofs.mjs", PROOFS("proofs", "Proofs"));
    await (await setup({ "x.prf": "x\n" })).stet.importProfile(join(dir, "proofs.mjs"));

    // A new project of .prf files: set up as Proofs, from the library.
    const repo = outsideDir();
    git(repo, "init", "-q", "-b", "master");
    git(repo, "config", "user.name", "T");
    git(repo, "config", "user.email", "t@example.com");
    write(repo, "a.prf", "a\n");
    write(repo, "b.prf", "b\n");
    write(repo, "notes.tex", "\\section{x}\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const seen = await Stet.inspectSetup(repo);
    expect(seen.languages).toEqual([
      ["proofs", 2],
      ["latex", 1],
    ]);
    expect(seen.names.proofs).toBe("Proofs");
    expect(seen.fromLibrary).toEqual(["proofs"]);
    const stet = await Stet.init(repo);
    expect((await stet.config()).language).toBe("proofs");
    expect(stet.profile(await stet.config(), "a.prf").id).toBe("proofs");

    // Chosen by name, or an unknown one.
    const other = (await setup({ "main.tex": "\\section{x}\n" })).repo;
    await expect(Stet.init(other, { language: "nope" })).rejects.toThrow(/Unknown language 'nope' \(latex or typst or lean or markdown or proofs\)/);
    expect((await (await Stet.init(other, { language: "proofs" })).config()).language).toBe("proofs");
  });
});

describe("a profile's own settings", () => {
  it("are filled in with their defaults and checked, and saved only when changed", async () => {
    const dir = outsideDir();
    write(
      dir,
      "keys.mjs",
      PROOFS("keys", "Keys").replace(
        "document: true,",
        `document: true,
    groupingSettings: {
      defaults: { keyCommands: ["use"] },
      check: (g) => (Array.isArray(g.keyCommands) ? [] : ["grouping.keyCommands (a list)"]),
    },`,
      ),
    );
    const { stet } = await setup({ "main.prf": "a\n" });
    await stet.importProfile(join(dir, "keys.mjs"), { use: true });
    const cfg = await stet.config();
    expect(cfg.grouping.keyCommands).toEqual(["use"]);
    expect(cfg.grouping.refCommands).toContain("cref"); // LaTeX's, declared by its profile
    expect(JSON.parse(read(stet.storeRoot, "config.json")).grouping).toBeUndefined();
    await stet.store.withLock(() => stet.store.saveConfig({ ...cfg, grouping: { ...cfg.grouping, keyCommands: "use" } }));
    await expect(stet.config()).rejects.toThrow("grouping.keyCommands (a list)");
    await stet.store.withLock(() => stet.store.saveConfig({ ...cfg, grouping: { ...cfg.grouping, refCommands: ["ref", "\\bad"] } }));
    await expect(stet.config()).rejects.toThrow("grouping.refCommands");
  });
});
