/**
 * File writes below a root folder that never follow links (symlinks, Windows junctions).
 * Lexical path checks are not enough: `alias/new.tex` is harmless as text but may lead
 * elsewhere if `alias` is a link. Like git, Stet does not write beyond a link.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isInside, samePath } from "./paths.js";

export class UnsafePathError extends Error {}

const lstatOrNull = (p: string) => lstat(p).catch((e) => (e.code === "ENOENT" || e.code === "ENOTDIR" ? null : Promise.reject(e)));

/** Remove a link itself (never its target). Directory links on Windows need rmdir. */
async function removeLink(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    await rmdir(p);
  }
}

export interface Target {
  /** Absolute path of the file. */
  path: string;
  /** Ancestor folders (below the root) that do not exist yet, outermost first. */
  missingDirs: string[];
  /** Whether the file exists (as a regular file). */
  exists: boolean;
}

/**
 * Check where `rel` lands below `root` without creating anything. Throws UnsafePathError if an
 * existing ancestor is a link or not a folder, if the file itself is a link or folder, or if the
 * real location is outside `root` or inside one of `forbidden`.
 * With `replaceLinks`, links on the way are allowed (the caller replaces them, see `prepare`).
 */
export async function inspect(root: string, rel: string, opts: { forbidden?: string[]; replaceLinks?: boolean } = {}): Promise<Target> {
  const parts = rel.split(/[\\/]/);
  const path = join(root, ...parts);
  if (!isInside(path, root) || samePath(path, root)) throw new UnsafePathError(`${rel} is not inside ${root}`);
  const missingDirs: string[] = [];
  let cur = root;
  for (const part of parts.slice(0, -1)) {
    cur = join(cur, part);
    if (missingDirs.length) {
      missingDirs.push(cur);
      continue;
    }
    const st = await lstatOrNull(cur);
    if (!st) missingDirs.push(cur);
    else if (st.isSymbolicLink()) {
      if (!opts.replaceLinks) throw new UnsafePathError(`${relative(root, cur)} is a link; Stet does not write through links`);
      missingDirs.push(cur);
    } else if (!st.isDirectory()) throw new UnsafePathError(`${relative(root, cur)} is a file, so ${rel} cannot be created`);
  }
  let exists = false;
  if (!missingDirs.length) {
    const st = await lstatOrNull(path);
    if (st?.isSymbolicLink()) {
      if (!opts.replaceLinks) throw new UnsafePathError(`${rel} is a link; Stet does not write through links`);
    } else if (st?.isDirectory()) throw new UnsafePathError(`${rel} is a folder`);
    else exists = !!st;
    // Existing ancestors are real folders; make sure their real location is where we think.
    const realParent = await realpath(dirname(path));
    const realRoot = await realpath(root);
    if (!isInside(realParent, realRoot)) throw new UnsafePathError(`${rel} resolves outside ${root}`);
    for (const f of opts.forbidden ?? []) if (isInside(join(realParent, "x"), await realpath(f).catch(() => f))) throw new UnsafePathError(`${rel} resolves into ${f}`);
  }
  return { path, missingDirs, exists };
}

/** Create the missing folders of a target (replacing links on the way if allowed). Returns the folders created. */
export async function prepare(root: string, t: Target): Promise<string[]> {
  const created: string[] = [];
  for (const d of t.missingDirs) {
    const st = await lstatOrNull(d);
    if (st?.isSymbolicLink()) await removeLink(d);
    else if (st?.isDirectory()) continue;
    await mkdir(d);
    created.push(d);
  }
  const realParent = await realpath(dirname(t.path));
  if (!isInside(realParent, await realpath(root))) throw new UnsafePathError(`${relative(root, t.path)} resolves outside ${root}`);
  return created;
}

/** Write a file by creating a new file next to it and renaming it over the destination (never writes through a link). */
export async function replaceFile(path: string, data: string | Buffer): Promise<void> {
  const st = await lstatOrNull(path);
  if (st?.isSymbolicLink()) await removeLink(path);
  const tmp = `${path}.stet-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data, { flag: "wx" });
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** `writeFile` below `root` that repairs links on the way instead of following them. */
export async function writeInside(root: string, rel: string, data: string | Buffer): Promise<void> {
  const t = await inspect(root, rel, { replaceLinks: true });
  await prepare(root, t);
  await replaceFile(t.path, data);
}

/**
 * Append to a file below `root` (created if missing), never through a link: a link on the way or
 * in the file's place is replaced. Appending keeps the file's identity, so a reader following it
 * (`tail -f`) sees the new lines.
 */
export async function appendInside(root: string, rel: string, data: string): Promise<void> {
  const t = await inspect(root, rel, { replaceLinks: true });
  await prepare(root, t);
  const st = await lstatOrNull(t.path);
  if (st?.isSymbolicLink()) await removeLink(t.path);
  // O_NOFOLLOW closes the gap between the check and the open where the platform has it.
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);
  const fh = await open(t.path, flags, 0o644);
  try {
    if (!(await fh.stat()).isFile()) throw new UnsafePathError(`${rel} is not a regular file`);
    if (data) await fh.appendFile(data, "utf8");
  } finally {
    await fh.close();
  }
}

/** Read a file below `root`, or null if it is missing or reached through a link. */
export async function readInside(root: string, rel: string): Promise<Buffer | null> {
  try {
    const t = await inspect(root, rel);
    return t.exists ? await readFile(t.path) : null;
  } catch {
    return null;
  }
}

