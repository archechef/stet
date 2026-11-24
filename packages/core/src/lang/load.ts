import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import * as nodeModule from "node:module";
import { basename, dirname, join } from "node:path";
import type { StetConfig } from "../config.js";
import { StetError } from "../errors.js";
import { PROFILES, projectProfiles } from "./index.js";
import * as kit from "./kit.js";
import type { LanguageProfile } from "./profile.js";

const modulePrefix = "data:text/javascript;stet-profile=1;base64,";
/** What a profile module imports the kit as (`kit.ts`). */
export const KIT_SPECIFIER = "@stet/profile-kit";
const kitGlobal = Symbol.for("stet.profile-kit.1");
/**
 * The kit, as a module profile modules import: this Stet's own helpers, handed over through a
 * global, so a bundled Stet (the CLI, the extension) needs no file of it.
 */
const kitModule = `data:text/javascript;stet-profile-kit=1;base64,${Buffer.from(
  `const kit = globalThis[Symbol.for("stet.profile-kit.1")];\n${Object.keys(kit)
    .map((name) => `export const ${name} = kit.${name};`)
    .join("\n")}\n`,
).toString("base64")}`;
let hooksRegistered = false;
type InstalledProfile = LanguageProfile & { files: string };

export function profileModuleName(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex") + ".mjs";
}

export async function profileDirectory(storeRoot: string, create = false): Promise<string> {
  const root = join(await realpath(dirname(storeRoot)), basename(storeRoot));
  if ((await realpath(root)) !== root) throw new StetError("Stet's profile store must be a local directory.");
  const directory = join(root, "profiles");
  if (create) await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory) throw new StetError("Stet's profiles directory must be inside its store.");
  return directory;
}

/** Load installed, self-contained profiles from the shared local store. */
export async function loadProjectProfiles(cfg: StetConfig, storeRoot: string): Promise<void> {
  if (cfg.profileModules === undefined) return;
  const names = cfg.profileModules;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string" || !/^[a-f0-9]{64}\.mjs$/.test(name)))
    throw new StetError("profileModules must contain installed module names. Run stet profile import to install a profile.");
  const profiles = [...PROFILES];
  cfg[projectProfiles] = profiles;
  if (!names.length) return;
  const directory = await profileDirectory(storeRoot);
  for (const name of names) {
    const path = join(directory, name);
    let source: Buffer;
    try {
      const resolved = await realpath(path);
      if (dirname(resolved) !== directory || resolved !== path) throw new Error("expected a regular module inside the profiles directory");
      source = await readFile(resolved);
    } catch (error) {
      throw new StetError(`Could not read installed language profile '${name}': ${error instanceof Error ? error.message : String(error)}`);
    }
    if (profileModuleName(source) !== name) throw new StetError(`Installed profile '${name}' has changed. Reimport the original file.`);
    addProfile(cfg, profiles, await readProfile(source, name));
  }
}

export async function readProfile(source: Buffer, name: string): Promise<InstalledProfile> {
  if (!hooksRegistered) {
    if (typeof nodeModule.registerHooks !== "function")
      throw new StetError("Local profiles require a Node runtime with module hooks (Node 22.15 or later in the Node 22 series).");
    (globalThis as Record<symbol, unknown>)[kitGlobal] = kit;
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (context.parentURL?.startsWith(modulePrefix)) {
          if (specifier === KIT_SPECIFIER) return { url: kitModule, shortCircuit: true };
          if (!specifier.startsWith("node:"))
            throw new Error(`Profile modules must bundle their dependencies. Only node: imports and ${KIT_SPECIFIER} are allowed.`);
        }
        return nextResolve(specifier, context);
      },
    });
    hooksRegistered = true;
  }
  let module: { apiVersion?: unknown; default?: LanguageProfile };
  try {
    module = await import(modulePrefix + source.toString("base64"));
  } catch (error) {
    throw new StetError(`Could not import language profile '${name}': ${error instanceof Error ? error.message : String(error)}`);
  }
  const profile = module.default;
  const invalid = (reason: string) => new StetError(`Invalid language profile '${name}': ${reason}.`);
  if (module.apiVersion !== 1) throw invalid("expected apiVersion = 1");
  if (
    !profile ||
    typeof profile.id !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(profile.id) ||
    typeof profile.files !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(profile.files) ||
    Object.hasOwn(Object.prototype, profile.files) ||
    typeof profile.name !== "string" ||
    !profile.name.trim() ||
    typeof profile.fence !== "string" ||
    !/^[a-z0-9_+.-]*$/i.test(profile.fence) ||
    typeof profile.document !== "boolean" ||
    !(profile.extensions instanceof RegExp) ||
    profile.extensions.global ||
    profile.extensions.sticky ||
    !Array.isArray(profile.defaultFiles) ||
    !profile.defaultFiles.length ||
    profile.defaultFiles.some((pattern) => typeof pattern !== "string")
  )
    throw invalid("expected id, files, name, fence, document, extensions and defaultFiles");
  if (
    profile.fileEffects !== undefined &&
    (!Array.isArray(profile.fileEffects) ||
      profile.fileEffects.some(
        (rule) =>
          !(rule?.path instanceof RegExp) ||
          rule.path.global ||
          rule.path.sticky ||
          typeof rule.reason !== "string" ||
          !rule.reason.trim() ||
          /[\r\n]/.test(rule.reason),
      ))
  )
    throw invalid("fileEffects must contain path regexes without global or sticky flags and nonempty, single-line reasons");
  // Its own settings: defaults and a check, for grouping and for its typesetter's previews.
  for (const [what, s] of [
    ["groupingSettings", profile.groupingSettings],
    ["typesetter.settings", profile.typesetter?.settings],
  ] as const) {
    if (s !== undefined && (!s || typeof s.defaults !== "object" || s.defaults === null || Array.isArray(s.defaults) || typeof s.check !== "function"))
      throw invalid(`${what} must have a defaults object and a check function`);
  }
  return profile as InstalledProfile;
}

export function addProfile(cfg: StetConfig, profiles: LanguageProfile[], profile: InstalledProfile): void {
  const invalid = (reason: string) => new StetError(`Invalid language profile '${profile.id}': ${reason}.`);
  if (profile.id === "plain" || profiles.some((p) => p.id === profile.id || p.files === profile.files))
    throw invalid(`duplicate profile id or file key ('${profile.id}', '${profile.files}')`);

  if (Object.hasOwn(cfg.files, profile.files)) {
    const patterns = cfg.files[profile.files];
    if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string"))
      throw invalid(`files.${profile.files} must be an array of patterns`);
  }
  profiles.push(profile);
}
