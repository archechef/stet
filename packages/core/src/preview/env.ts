/**
 * PDF previews of a change (spec §14): the region of the compiled paper where a change lands,
 * before and after. What compiles the document, and how a change is found on its pages, is the
 * language's typesetter (`Typesetter`, LaTeX's in `lang/latex-preview.ts`). The rest is here:
 * this file holds the settings, what previews need and how their programs run (isolation);
 * `builder.ts` the build cache and pages; `words.ts` the words on them.
 *
 * Compiling a proposal runs TeX on text an agent wrote, and TeX is a programming language. TeX's
 * own restrictions stop shell escape and writing outside the build folder, but not reading:
 * `\input{/etc/passwd}` or `\input{../../.ssh/id_ed25519}` puts the file into the PDF whatever
 * `openin_any` says (tested with TeX Live 2026). So:
 * - every program that touches the build (latexmk, TeX, BibTeX/Biber, SyncTeX, the PDF tools)
 *   runs in a rootless Podman container: no network, read-only system, no privileges, and only
 *   the build folder (read-write), TeX Live and the user's ~/texmf (read-only) mounted. There is
 *   nothing of the user's to read;
 * - shell escape is off, writes are restricted (`openout_any=p`), and latexmk ignores every rc
 *   file (they are Perl code);
 * - the project is exported with symbolic links as plain files, so no link leads out of it;
 * - without a container, previews are off unless the user chooses `isolation: "process"`, and
 *   then Stet says that TeX can read every file the user can.
 *
 * Previews are optional: without TeX (or the image), `previewStatus` says what is missing and
 * everything else in Stet works as before.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Typesetter } from "../lang/profile.js";

export const PREVIEW_ISOLATIONS = ["auto", "container", "process"] as const;

export const PREVIEW_TEX = ["auto", "host", "image"] as const;

export interface PreviewConfig {
  enabled: boolean;
  /** The document to compile, relative to the project; null: detected (`main.tex`, else the one top-level document). */
  rootFile: string | null;
  /**
   * `auto`, or one of the typesetter's `engines`. LaTeX's `auto`: from a `% !TEX program =` line,
   * else LuaLaTeX with fontspec/unicode-math, else pdfLaTeX.
   */
  engine: string;
  /**
   * `container` (what `auto` means): builds in a Podman container. `process`: as a normal process,
   * where TeX can read every file you can; only on your explicit choice.
   */
  isolation: (typeof PREVIEW_ISOLATIONS)[number];
  /** The container image with Perl and the PDF tools, for the user's own TeX (`stet preview setup` builds it). */
  image: string;
  /** Where TeX comes from: `auto` (the user's standalone TeX Live on Linux, else the image's), `host` or `image`. */
  tex: (typeof PREVIEW_TEX)[number];
  /** The container image with its own TeX Live, for macOS and Linux without a standalone TeX Live. */
  texImage: string;
  /**
   * Use the image with its own TeX plus Debian's extra fonts (dsfont, bbm, bbold, …), about 2 GB
   * more. Off by default; switched on when the user agrees to install them after a missing file.
   */
  texExtras: boolean;
  texExtrasImage: string;
  /** Seconds a build may take before it is stopped. */
  timeout: number;
}

export const DEFAULT_PREVIEW: PreviewConfig = {
  enabled: true,
  rootFile: null,
  engine: "auto",
  isolation: "auto",
  image: "localhost/stet-preview:1",
  tex: "auto",
  texImage: "localhost/stet-preview-tex:1",
  texExtras: false,
  texExtrasImage: "localhost/stet-preview-tex-extra:1",
  timeout: 120,
};

export type PreviewIsolation = "container" | "process";

export interface PreviewEnv {
  /** `ready`: previews can be built; `needs-setup`: the image must be built first; `unavailable`: something is missing. */
  status: "ready" | "needs-setup" | "unavailable";
  isolation: PreviewIsolation | null;
  /** What is missing or worth knowing, in a sentence. */
  message: string;
  /** How to fix it, if there is something to do. */
  fix?: string;
  /** The tools' folder (absolute, where they run: on this machine, or in the container): first on the PATH. */
  bin?: string;
  /** Folders mounted read-only into the container: [on this machine, in the container] (LaTeX: TeX Live, ~/texmf). */
  mounts?: [string, string][];
  /** Whether Podman can limit a container's memory here (needs the cgroup memory controller). */
  memoryLimit?: boolean;
  /** The Podman program, and the image builds run in; where the tools come from (the user's own, or the image's). */
  podman?: string;
  image?: string;
  toolSource?: "host" | "image";
  /** The image with its own TeX is the small one: the extra fonts can still be added. */
  extrasAvailable?: boolean;
}

/** Run a program (not isolated: for Podman itself and the like), with an optional timeout. */
export const runProgram = (cmd: string, args: string[], opts: { input?: string; timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      // Its own process group (POSIX), so a timeout also stops what it started (latexmk → TeX).
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e: any) {
      return resolve({ code: -1, stdout: "", stderr: String(e?.message ?? e) });
    }
    const kill = () => {
      try {
        if (process.platform !== "win32" && child!.pid) process.kill(-child!.pid, "SIGKILL");
        else child!.kill("SIGKILL");
      } catch {
        child!.kill("SIGKILL");
      }
    };
    const timer = opts.timeout ? setTimeout(kill, opts.timeout) : undefined;
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e.message) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });

/** Absolute path of `cmd` on the PATH, or null. */
export async function which(cmd: string): Promise<string | null> {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      if (existsSync(p)) return p;
      if (ext && existsSync(join(dir, cmd + ext))) return join(dir, cmd + ext);
    }
  }
  return null;
}

/** Podman: on the PATH, or where its installers put it (VS Code started from the Dock may lack those on its PATH). */
async function findPodman(): Promise<string | null> {
  if (process.platform === "win32") return null;
  const onPath = await which("podman");
  if (onPath) return onPath;
  for (const p of ["/opt/podman/bin/podman", "/opt/homebrew/bin/podman", "/usr/local/bin/podman", "/usr/bin/podman"]) if (existsSync(p)) return p;
  return null;
}

/** What previews can use here, by the document's typesetter. Never installs or downloads anything. */
export async function detectPreviewEnv(
  cfg: PreviewConfig,
  typesetter: Typesetter,
  /** `podman`: the Podman program to use, or null for none (tests: independent of what the machine has). */
  opts: { podman?: string | null } = {},
): Promise<PreviewEnv> {
  if (!cfg.enabled) return { status: "unavailable", isolation: null, message: "PDF previews are switched off (preview.enabled in .git/stet/config.json)." };
  return typesetter.detect(cfg, opts);
}

/** Build the image previews need here (the typesetter's). Downloads packages: only on the user's explicit request. */
export function setupPreviewImage(cfg: PreviewConfig, typesetter: Typesetter, opts: { extras?: boolean } = {}): Promise<{ ok: boolean; log: string }> {
  return typesetter.setupImage(cfg, opts);
}

/**
 * Podman, for builds in a container: the program and whether it can limit memory, or why it
 * can't be used. `program`: what the container keeps from the user's files ("TeX").
 */
export async function containerRuntime(opts: { podman?: string | null }, program: string): Promise<{ podman: string; memoryLimit: boolean } | PreviewEnv> {
  const trusted = `Or, for material you trust, set preview.isolation to "process" in .git/stet/config.json: ${program} can then read every file you can.`;
  const podman = opts.podman !== undefined ? opts.podman : await findPodman();
  if (!podman) {
    return {
      status: "unavailable",
      isolation: "container",
      message:
        process.platform === "win32"
          ? `PDF previews compile agents' text in a container, so ${program} can't read your files, and that isn't supported on Windows yet.`
          : `PDF previews compile agents' text in a container, so ${program} can't read your files, and Podman isn't installed.`,
      fix:
        (process.platform === "win32" ? "Use Stet in WSL2 for previews. " : "Install Podman (podman.io), then try again (in VS Code: reload the window). ") +
        trusted,
    };
  }
  // Podman answers only while its service runs: on macOS, its Linux machine.
  const info = await runProgram(podman, ["info", "--format", "{{.Host.CgroupControllers}}"], { timeout: 30_000 });
  if (info.code !== 0) {
    return {
      status: "unavailable",
      isolation: "container",
      message: `PDF previews run in a Podman container, but Podman doesn't answer${process.platform === "darwin" ? " (its machine isn't running)" : ""}.`,
      fix:
        process.platform === "darwin"
          ? "Start it with `podman machine start` (once: `podman machine init`), then try again (in VS Code: reload the window)."
          : `Check \`podman info\`: ${oneLineOf(info.stderr)}`,
    };
  }
  return { podman, memoryLimit: /\bmemory\b/.test(info.stdout) };
}

/** Builds as a normal process need Poppler's pdftoppm and pdfinfo on the PATH: why not, or null. */
export async function popplerMissing(): Promise<PreviewEnv | null> {
  if ((await which("pdftoppm")) && (await which("pdfinfo"))) return null;
  return {
    status: "unavailable",
    isolation: "process",
    message: "PDF previews need Poppler's pdftoppm and pdfinfo to show pages, and they aren't on the PATH.",
    fix: process.platform === "darwin" ? "Install Poppler (brew install poppler)." : "Install poppler-utils.",
  };
}

const oneLineOf = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Build a container image from a Containerfile, in an empty build context. */
export async function buildImage(podman: string, tag: string, containerfile: string): Promise<{ ok: boolean; log: string }> {
  // An empty build context with just the Containerfile (podman can't read it from a Node pipe).
  const dir = await mkdtemp(join(tmpdir(), "stet-preview-image-"));
  try {
    await writeFile(join(dir, "Containerfile"), containerfile);
    const r = await runProgram(podman, ["build", "--tag", tag, "--file", join(dir, "Containerfile"), dir], { timeout: 60 * 60_000 });
    return { ok: r.code === 0, log: (r.stdout + r.stderr).trim() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Arguments of `podman run` for one isolated command in `work`. Exported for tests. */
export function containerArgs(env: PreviewEnv, image: string, work: string, name: string, cmd: string[], extra: Record<string, string> = {}): string[] {
  const vars = { PATH: `${env.bin}:/usr/bin:/bin`, HOME: "/tmp", ...extra };
  return [
    "run",
    "--rm",
    "--name",
    name,
    // Only ever the image the user built: a missing one is an error, never a download.
    "--pull=never",
    "--network=none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,size=256m",
    "--userns=keep-id",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    // A hostile document can loop, write or allocate until the timeout: bound what it can use.
    "--pids-limit=256",
    "--ulimit",
    "fsize=536870912:536870912",
    "--ulimit",
    "nofile=1024:1024",
    ...(env.memoryLimit ? ["--memory=2g", "--memory-swap=2g"] : []),
    ...(env.mounts ?? []).flatMap(([host, at]) => ["--volume", `${host}:${at}:ro`]),
    "--volume",
    `${work}:/work`,
    "--workdir",
    "/work",
    ...Object.entries(vars).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    image,
    ...cmd,
  ];
}

/** Run one command of a build, isolated as configured, in `work` (paths inside it are relative). */
export async function runIsolated(
  env: PreviewEnv,
  cfg: PreviewConfig,
  typesetter: Typesetter,
  work: string,
  cmd: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const timeout = cfg.timeout * 1000;
  if (env.isolation === "container") {
    if (/[:,]/.test(work)) return { code: -1, stdout: "", stderr: `Can't mount ${work} into a container: its path contains ':' or ','.` };
    const name = `stet-preview-${randomBytes(6).toString("hex")}`;
    const podman = env.podman ?? "podman";
    const r = await runProgram(podman, containerArgs(env, env.image ?? cfg.image, work, name, cmd, typesetter.buildEnv(env, "/tmp", true)), { timeout });
    if (r.code !== 0) await runProgram(podman, ["rm", "--force", "--ignore", name]); // after a timeout
    return r;
  }
  // A normal process: the restrictions above, a private HOME, and nothing else from the environment.
  const home = join(work, "stet-home");
  await mkdir(home, { recursive: true });
  const path = [env.bin, ...(process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== env.bin)].join(delimiter);
  const vars: NodeJS.ProcessEnv = { PATH: path, HOME: home, USERPROFILE: home, ...typesetter.buildEnv(env, home, false) };
  for (const k of ["SystemRoot", "TEMP", "TMP", "LANG"]) if (process.env[k]) vars[k] = process.env[k];
  return runProgram(cmd[0]!, cmd.slice(1), { cwd: work, env: vars, timeout });
}
