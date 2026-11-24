// Runs inside VS Code (--extensionTestsPath) for projects in the language of an imported profile
// (fixture.mjs: proofs, latex-profile). Stet must start by itself, as it does for LaTeX, Typst and Lean.
const { existsSync, readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

exports.run = async function run() {
  const out = process.env.STET_IT_OUT;
  const fx = JSON.parse(process.env.STET_IT_FIXTURE);
  const results = [];
  const check = (name, ok, detail = "") => results.push({ name, ok: !!ok, detail: String(detail) });
  const store = join(fx.repo, ".git", "stet");
  const uri = vscode.Uri.file(join(fx.repo, fx.file));
  const steps = [
    [
      "activation",
      async () => {
        // Not activated by the test: only by the project's own files.
        const ext = vscode.extensions.getExtension("archechef.stet-vscode");
        const active = await until("activation", () => ext.isActive, 30000).catch(() => false);
        check(`activates by itself in a ${fx.kind} project`, active, JSON.stringify({ isActive: ext.isActive }));
        if (!active) await ext.activate();
        await until("managed CLI", () => existsSync(join(store, "bin", "stet.mjs")), 30000);
        const cfg = JSON.parse(readFileSync(join(store, "config.json"), "utf8"));
        check(`the project's language is the imported ${fx.language}`, cfg.language === fx.language, cfg.language);
      },
    ],
    [
      "the proposal in the editor",
      async () => {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
        const titles = await until(
          "code lenses",
          async () => {
            const l = (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri)) || [];
            const t = l.map((x) => x.command?.title);
            return t.includes(`${fx.items[0]}: $(check) Accept`) ? t : null;
          },
          30000,
        ).catch(() => null);
        check(`the change to ${fx.file} has its Accept lens`, !!titles, JSON.stringify(titles));
      },
    ],
  ];
  if (fx.kind === "latex-profile")
    steps.push([
      "PDF preview with the imported profile",
      async () => {
        // The imported profile's preview backend compiles the document and finds the change on the page.
        await vscode.commands.executeCommand("stet.preview", fx.items[0]);
        const previewDir = join(store, "previews");
        const result = await until(
          "preview",
          async () => {
            if (!existsSync(previewDir)) return null;
            for (const base of readdirSync(previewDir)) {
              const items = join(previewDir, base, "items");
              if (!existsSync(items)) continue;
              const hit = readdirSync(items).find((d) => d.startsWith(`${fx.items[0]}-`) && existsSync(join(items, d, "result.json")));
              if (hit) return JSON.parse(readFileSync(join(items, hit, "result.json"), "utf8"));
            }
            return null;
          },
          90000,
        ).catch(() => null);
        console.log(`imported-profile preview: ${result?.status}`);
        check(
          "the imported profile compiles the document and locates the change on the page",
          result?.status === "ready" && result.after?.page === 1 && existsSync(result.after.file),
          JSON.stringify(result && { status: result.status, message: result.message, after: result.after }),
        );
      },
    ]);
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      check(`${name}: ran to the end`, false, e?.stack);
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
};
