/**
 * The profile library: the profiles you imported, kept for you across projects (one folder per
 * user), so another project can use one without its file (`stet profile use`), and setup can
 * recognise its language by its files.
 *
 * A project still gets its own copy, pinned by hash in its store (`.git/stet/profiles/`): that is
 * the one Stet, the agents' tools and the MCP server load. So you and the agent split changes with
 * the same profile wherever the agent runs, and updating the library never changes a project.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StetError } from "../errors.js";
import { profileModuleName } from "./load.js";
import type { LanguageProfile } from "./profile.js";

/** A profile in the library, as its index describes it: enough to list it and recognise its files without running it. */
export interface LibraryProfile {
  /** Its module's file name, in the library and in a project's store: the hash of its content. */
  module: string;
  id: string;
  name: string;
  /** Its default file patterns (`*.prf`). */
  defaultFiles: string[];
  /** Whether it can be a project's language (it has examples for agents). */
  selectable: boolean;
  /** When it was imported (ISO time). */
  importedAt: string;
}

/**
 * The library's folder: `STET_PROFILE_LIBRARY`, else the user's data folder (Linux:
 * `~/.local/share/stet/profiles`, macOS: `~/Library/Application Support/stet/profiles`,
 * Windows: `%LOCALAPPDATA%\stet\profiles`).
 */
export function libraryDirectory(): string {
  const set = process.env.STET_PROFILE_LIBRARY;
  if (set) return set;
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "stet", "profiles");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "stet", "profiles");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "stet", "profiles");
}

const INDEX = "index.json";

const isEntry = (e: unknown): e is LibraryProfile => {
  const x = e as Partial<LibraryProfile> | null;
  return (
    !!x &&
    typeof x.module === "string" &&
    /^[a-f0-9]{64}\.mjs$/.test(x.module) &&
    typeof x.id === "string" &&
    /^[a-z][a-z0-9-]*$/.test(x.id) &&
    typeof x.name === "string" &&
    Array.isArray(x.defaultFiles) &&
    x.defaultFiles.every((p) => typeof p === "string") &&
    typeof x.selectable === "boolean" &&
    typeof x.importedAt === "string"
  );
};

/** The library's profiles, the latest import first; none when there is no library. */
export async function readLibrary(): Promise<LibraryProfile[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(libraryDirectory(), INDEX), "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(raw) ? raw.filter(isEntry) : [];
}

async function writeAtomic(path: string, data: string | Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Keep an imported profile in the library; it replaces an earlier version of the same id. False
 * when the library can't be written (the project's own copy is all that is needed).
 */
export async function addToLibrary(source: Buffer, profile: LanguageProfile): Promise<boolean> {
  try {
    const directory = libraryDirectory();
    await mkdir(directory, { recursive: true });
    const module = profileModuleName(source);
    await writeAtomic(join(directory, module), source);
    const before = await readLibrary();
    const entry: LibraryProfile = {
      module,
      id: profile.id,
      name: profile.name,
      defaultFiles: [...(profile.defaultFiles ?? [])],
      selectable: !!profile.agentTerms,
      importedAt: new Date().toISOString(),
    };
    const kept = before.filter((e) => e.id !== profile.id);
    await writeAtomic(join(directory, INDEX), `${JSON.stringify([entry, ...kept], null, 2)}\n`);
    await removeUnused(before, [entry, ...kept]);
    return true;
  } catch {
    return false;
  }
}

/** Take a profile out of the library (projects that use it keep their copy). False if it isn't there. */
export async function forgetLibraryProfile(id: string): Promise<boolean> {
  const before = await readLibrary();
  if (!before.some((e) => e.id === id)) return false;
  const kept = before.filter((e) => e.id !== id);
  await writeAtomic(join(libraryDirectory(), INDEX), `${JSON.stringify(kept, null, 2)}\n`);
  await removeUnused(before, kept);
  return true;
}

async function removeUnused(before: LibraryProfile[], after: LibraryProfile[]): Promise<void> {
  for (const old of before)
    if (!after.some((e) => e.module === old.module)) await rm(join(libraryDirectory(), old.module), { force: true }).catch(() => undefined);
}

/** The library's profile `id` and its module, checked against its hash. */
export async function libraryModule(id: string): Promise<{ entry: LibraryProfile; source: Buffer }> {
  const entry = (await readLibrary()).find((e) => e.id === id);
  if (!entry) throw new StetError(`Your profile library has no profile '${id}'. Import it once with \`stet profile import <file.mjs>\`.`);
  const source = await readFile(join(libraryDirectory(), entry.module)).catch(() => null);
  if (!source || profileModuleName(source) !== entry.module)
    throw new StetError(`The profile '${id}' in your library (${libraryDirectory()}) is missing or has changed. Import it again from its file.`);
  return { entry, source };
}
