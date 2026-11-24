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
  if (fx.kind === "proofs")
    steps.push([
      "long proposals in a plain-text file",
      async () => {
        // VS Code opens .prf files as plain text (no extension knows them). With word wrap, proposed
        // text is an inline hint: shown in full, as Stet sets no limit for plain text; where VS Code's
        // limit holds, or stet.inlineTextLength is set, Stet shortens it itself (the rest is shown elsewhere).
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc);
        const G = vscode.ConfigurationTarget.Global;
        await vscode.workspace.getConfiguration("editor").update("wordWrap", "on", G);
        await vscode.workspace.getConfiguration("stet").update("newTextStyle", "wrapping", G);
        const longest = async () => {
          const h = (await vscode.commands.executeCommand("vscode.executeInlayHintProvider", uri, new vscode.Range(0, 0, doc.lineCount, 0))) || [];
          return h.map((x) => (typeof x.label === "string" ? x.label : x.label.map((p) => p.value).join(""))).sort((a, b) => b.length - a.length)[0] ?? "";
        };
        const settle = (what, ok) => until(what, async () => ((await ok(await longest())) ? true : null), 10000).catch(() => false);
        const full = await settle("full hint", (l) => l.includes("third_one"));
        check(
          `a long proposal is shown in full in a ${doc.languageId} file`,
          full && doc.languageId === "plaintext",
          JSON.stringify({ lang: doc.languageId, label: await longest() }),
        );
        const plain = vscode.workspace.getConfiguration("editor", { languageId: "plaintext" });
        await plain.update("inlayHints.maximumLength", 43, G, true);
        const cut = await settle("hint within VS Code's limit", (l) => l.length <= 43 && l.endsWith("…"));
        check("where VS Code's limit holds, Stet shortens the text to it", cut, JSON.stringify({ label: await longest() }));
        await plain.update("inlayHints.maximumLength", undefined, G, true);
        await vscode.workspace.getConfiguration("stet").update("inlineTextLength", 20, G);
        const own = await settle("hint within stet.inlineTextLength", (l) => l.length <= 20 && l.endsWith("…"));
        check("stet.inlineTextLength shortens it", own, JSON.stringify({ label: await longest() }));
        await vscode.workspace.getConfiguration("stet").update("inlineTextLength", undefined, G);
      },
    ]);
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
