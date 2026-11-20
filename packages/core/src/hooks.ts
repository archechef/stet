/** Git hooks that stop agent branches from bypassing review (spec §9, layer 3). */
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { StetConfig } from "./config.js";
import { Repo } from "./git.js";
import { shQuote } from "./text.js";
import { pathExists } from "./paths.js";

export const HOOK_MARKER = "# stet-guard-hook";
export const HOOK_NAMES = ["reference-transaction", "pre-push"] as const;


/**
 * Shell epilogue: pass stdin and arguments on to the hook that was there before Stet.
 * Run it the way git would: only if executable, and by itself (its own shebang: sh, python, node…).
 */
function chain(name: string): string {
  return `orig="$(dirname "$0")/${name}.stet-orig"
if [ -x "$orig" ]; then
  printf '%s' "$input" | "$orig" "$@" || exit $?
fi
exit 0`;
}

function script(name: (typeof HOOK_NAMES)[number], cfg: StetConfig): string {
  const main = shQuote(`refs/heads/${cfg.mainBranch}`);
  // Quoted parts of a case pattern match literally; only the trailing * is a wildcard.
  const prefix = shQuote(cfg.agentBranchPrefix);
  const agentHeads = shQuote(`refs/heads/${cfg.agentBranchPrefix}`);
  // for-each-ref matches a pattern "up to a slash", so refs/heads/stet covers refs/heads/stet/*.
  const agentRefs = shQuote(`refs/heads/${cfg.agentBranchPrefix.replace(/\/+$/, "")}`);
  const head = `#!/bin/sh
${HOOK_MARKER} (installed by Stet; remove with \`stet hooks uninstall\`)
input="$(cat)"
current="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"
case "$current" in ${prefix}*) in_agent=1 ;; *) in_agent=0 ;; esac
`;
  if (name === "reference-transaction") {
    return `${head}
if [ "$1" = "prepared" ] && [ "$STET_INTERNAL" != "1" ]; then
  printf '%s\\n' "$input" | while read -r old new ref; do
    [ -z "$ref" ] && continue
    case "$ref" in
      refs/stet/*)
        echo "stet: only Stet may update $ref." >&2; exit 1 ;;
      ${main})
        if [ "$in_agent" = "1" ]; then
          echo "stet: agent workspaces may not update the main branch. Submit with stet_submit instead." >&2; exit 1
        fi
        case "$new" in *[!0]*) ;; *) continue ;; esac
        case "$old" in *[!0]*) ;; *) continue ;; esac
        # Moving back to an older commit of the main branch is fine.
        git merge-base --is-ancestor "$new" "$old" 2>/dev/null && continue
        # Block if the update brings in commits that only agent branches have (merge or fast-forward).
        tips="$(git for-each-ref --format='%(objectname)' ${agentRefs} 2>/dev/null)"
        [ -z "$tips" ] && continue
        shared="$( { git rev-list "$new" "^$old"; git rev-list $tips "^$old"; } 2>/dev/null | sort | uniq -d | head -n 1)"
        if [ -n "$shared" ]; then
          echo "stet: this would bring an agent branch's commits into $ref. Review its changes with Stet instead of merging." >&2
          echo "stet: the branch was not moved, but git may already have written the agent's files into your" >&2
          echo "stet: working copy. Undo that with: git restore --staged --worktree :/   (after saving any own edits)" >&2
          exit 1
        fi ;;
    esac
  done || exit 1
fi
${chain(name)}
`;
  }
  if (name === "pre-push") {
    return `${head}
if [ "$STET_INTERNAL" != "1" ]; then
  if [ "$in_agent" = "1" ]; then
    echo "stet: pushing from an agent workspace is not allowed." >&2; exit 1
  fi
  printf '%s\\n' "$input" | while read -r lref lsha rref rsha; do
    case "$lref $rref" in
      *${agentHeads}*) echo "stet: agent branches ($lref) must not be pushed." >&2; exit 1 ;;
    esac
  done || exit 1
fi
${chain(name)}
`;
  }
  throw new Error(`unknown hook ${name}`);
}

async function hooksDir(repo: Repo, commonDir: string): Promise<{ dir: string; custom: boolean }> {
  const custom = await repo.tryRun(["config", "--get", "core.hooksPath"]);
  if (custom) return { dir: isAbsolute(custom) ? custom : resolve(repo.cwd, custom), custom: true };
  return { dir: join(commonDir, "hooks"), custom: false };
}

async function readIf(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

export interface HookStatus {
  dir: string;
  customHooksPath: boolean;
  installed: string[];
  missing: string[];
}

export async function hookStatus(repo: Repo, commonDir: string, known?: { dir: string; custom: boolean }): Promise<HookStatus> {
  const { dir, custom } = known ?? (await hooksDir(repo, commonDir));
  const installed: string[] = [];
  const missing: string[] = [];
  for (const n of HOOK_NAMES) ((await readIf(join(dir, n)))?.includes(HOOK_MARKER) ? installed : missing).push(n);
  return { dir, customHooksPath: custom, installed, missing };
}

/**
 * Install (or refresh) the hooks. Existing foreign hooks are kept as `<name>.stet-orig`
 * and chained. With a custom core.hooksPath (e.g. husky) nothing is installed unless `force`.
 */
export async function installHooks(repo: Repo, commonDir: string, cfg: StetConfig, opts: { force?: boolean } = {}): Promise<HookStatus> {
  const where = await hooksDir(repo, commonDir);
  const { dir, custom } = where;
  if (custom && !opts.force) return hookStatus(repo, commonDir, where);
  await mkdir(dir, { recursive: true });
  for (const n of HOOK_NAMES) {
    const p = join(dir, n);
    const existing = await readIf(p);
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      const orig = `${p}.stet-orig`;
      if ((await readIf(orig)) === null) await rename(p, orig);
    }
    await writeFile(p, script(n, cfg).replace(/\r\n/g, "\n"), "utf8");
    await chmod(p, 0o755).catch(() => {});
  }
  return hookStatus(repo, commonDir, where);
}

export async function uninstallHooks(repo: Repo, commonDir: string): Promise<void> {
  const { dir } = await hooksDir(repo, commonDir);
  for (const n of HOOK_NAMES) {
    const p = join(dir, n);
    if (!(await readIf(p))?.includes(HOOK_MARKER)) continue;
    await rm(p, { force: true });
    const orig = `${p}.stet-orig`;
    if (await pathExists(orig)) await rename(orig, p);
  }
}
