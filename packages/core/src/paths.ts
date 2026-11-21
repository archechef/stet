/** Comparing file system paths the way the platform does (Windows: either slash, any case). */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

/** Whether something exists at `p` (following links). */
export const pathExists = (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  );

/** An absolute path in canonical form for comparisons: forward slashes, no trailing slash, lower case on Windows. */
export function foldPath(p: string): string {
  const s = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

export const samePath = (a: string, b: string): boolean => foldPath(a) === foldPath(b);

/** Whether `child` is `parent` or lies below it. */
export function isInside(child: string, parent: string): boolean {
  const c = foldPath(child);
  const p = foldPath(parent);
  return c === p || c.startsWith(p + "/");
}
