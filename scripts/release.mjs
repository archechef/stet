#!/usr/bin/env node
/**
 * Release helper.
 *   node scripts/release.mjs set <x.y.z>    set the version everywhere and date the changelog's "Unreleased" section
 *   node scripts/release.mjs check <x.y.z>  fail unless every version is <x.y.z> and the changelog has a section for it
 *   node scripts/release.mjs notes <x.y.z>  print the release notes (the changelog section) for GitHub
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = (p) => join(root, p);
const read = (p) => readFileSync(path(p), "utf8");
const write = (p, s) => writeFileSync(path(p), s);
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

const PACKAGES = ["packages/core/package.json", "packages/cli/package.json", "packages/vscode/package.json"];
const CLI_SRC = "packages/cli/src/version.ts";
const VERSION_CONST = /const VERSION = "([^"]+)";/;
const README_VERSION = /^Version (\S+?)\. /m;

/** Every place that names the version, with what it says now. */
function versions() {
  const out = [];
  for (const p of PACKAGES) {
    const j = JSON.parse(read(p));
    out.push([`${p} version`, j.version]);
    if (j.dependencies?.["@stet/core"]) out.push([`${p} → @stet/core`, j.dependencies["@stet/core"]]);
  }
  out.push([`${CLI_SRC} VERSION`, VERSION_CONST.exec(read(CLI_SRC))?.[1]]);
  out.push(["README.md status", README_VERSION.exec(read("README.md"))?.[1]]);
  return out;
}

/** The changelog section for `v` (without its heading), or null. */
function changelogSection(v) {
  const text = read("CHANGELOG.md").replace(/\r\n/g, "\n");
  const start = text.search(new RegExp(`^## ${v.replace(/\./g, "\\.")}( |$)`, "m"));
  if (start < 0) return null;
  const body = text.slice(text.indexOf("\n", start) + 1);
  const end = body.search(/^## /m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

const [cmd, v] = process.argv.slice(2);
// The VS Code Marketplace accepts only major.minor.patch.
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) fail(`expected a version like 1.2.3, got '${v ?? ""}'`);

switch (cmd) {
  case "set": {
    // Check everything before writing anything, so a refused release leaves no files half-changed.
    const UNRELEASED = /^## Unreleased[ \t]*$/m;
    const log = read("CHANGELOG.md");
    if (changelogSection(v)) fail(`CHANGELOG.md already has a "## ${v}" section.`);
    if (!UNRELEASED.test(log)) fail('CHANGELOG.md has no "## Unreleased" section. Add one with the changes of this release.');
    if (!changelogSection("Unreleased")) fail('the "Unreleased" section of CHANGELOG.md is empty.');
    for (const p of PACKAGES) {
      const j = JSON.parse(read(p));
      j.version = v;
      if (j.dependencies?.["@stet/core"]) j.dependencies["@stet/core"] = v;
      write(p, JSON.stringify(j, null, 2) + "\n");
    }
    write(CLI_SRC, read(CLI_SRC).replace(VERSION_CONST, `const VERSION = "${v}";`));
    write("README.md", read("README.md").replace(README_VERSION, `Version ${v}. `));
    const date = new Date().toISOString().slice(0, 10);
    write("CHANGELOG.md", log.replace(UNRELEASED, `## ${v} — ${date}`));
    execSync("npm install --package-lock-only --ignore-scripts", { cwd: root, stdio: "inherit" });
    console.log(`Version set to ${v}. Next:
  git commit -am "Release v${v}"
  git tag v${v}
  git push && git push origin v${v}`);
    break;
  }
  case "check": {
    const wrong = versions().filter(([, found]) => found !== v);
    if (wrong.length)
      fail(`version mismatch for v${v}:\n${wrong.map(([where, found]) => `  ${where}: ${found}`).join("\n")}\nRun: node scripts/release.mjs set ${v}`);
    if (!changelogSection(v)) fail(`CHANGELOG.md has no "## ${v}" section.`);
    console.log(`All versions are ${v}.`);
    break;
  }
  case "notes": {
    const section = changelogSection(v);
    if (!section) fail(`CHANGELOG.md has no "## ${v}" section.`);
    console.log(`${section}

---

**Install the VS Code extension:** download \`stet-vscode-${v}.vsix\` below, then in VS Code: Extensions view → \`…\` → *Install from VSIX…*. It includes the \`stet\` command for the agents; you need neither Node.js nor this repository.

**Command line only:** \`stet-${v}.mjs\` is the whole CLI in one file. Run it with Node.js 20 or newer: \`node stet-${v}.mjs --help\`.

Checksums: \`SHA256SUMS.txt\`.`);
    break;
  }
  default:
    fail(`unknown command '${cmd ?? ""}' (use set, check or notes)`);
}
