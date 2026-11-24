import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { itemEffect } from "../src/effects.js";
import { documentProfile } from "../src/lang/index.js";
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
  expect(await stet.importProfile(join(repo, profileFile))).toBe("local-proof");
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
