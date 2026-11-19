// Runs inside VS Code (--extensionTestsPath). Exercises the extension against the fixture project.
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
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
  try {
    const ext = vscode.extensions.getExtension("archechef.stet-vscode");
    await ext.activate();
    check("activates", ext.isActive);

    const store = join(fx.repo, ".git", "stet");
    await until("managed CLI", () => existsSync(join(store, "bin", "stet.mjs")));
    const cfg = JSON.parse(readFileSync(join(store, "config.json"), "utf8"));
    check("records bundled CLI", cfg.cli && cfg.cli.args[0].endsWith("/stet/bin/stet.mjs"), JSON.stringify(cfg.cli));
    const mcp = await until("agent MCP config", () => existsSync(join(fx.worktree, ".mcp.json")) && JSON.parse(readFileSync(join(fx.worktree, ".mcp.json"), "utf8")));
    check("writes agent workspace files", mcp.mcpServers.stet.args.includes("mcp"), JSON.stringify(mcp.mcpServers.stet));
    const help = execFileSync(cfg.cli.command, [...cfg.cli.args, "--help"], { env: { ...process.env, ...(cfg.cli.env || {}) }, encoding: "utf8" });
    check("recorded CLI runs", help.includes("stet — review"), help.slice(0, 60));
    const runtime = process.env.STET_IT_RUNTIME || "auto";
    check(`runtime '${runtime}' honoured`, runtime === "vscode" ? cfg.cli.env && cfg.cli.env.ELECTRON_RUN_AS_NODE === "1" : !cfg.cli.env, JSON.stringify(cfg.cli));
    // What an agent's tool does: start the MCP server with the workspace's config and list tools.
    const s = mcp.mcpServers.stet;
    const req = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    const mcpOut = execFileSync(s.command, s.args, {
      env: { ...process.env, ...s.env },
      input: req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "1" } }) + req(2, "tools/list") + req(3, "tools/call", { name: "stet_status", arguments: {} }),
      encoding: "utf8",
      timeout: 30000,
    });
    const replies = mcpOut.trim().split("\n").map((l) => JSON.parse(l));
    const tools = (replies.find((r) => r.id === 2) || {}).result;
    const status = (replies.find((r) => r.id === 3) || {}).result;
    check("agent MCP server answers", tools && tools.tools.some((t) => t.name === "stet_submit") && status && !status.isError, mcpOut.slice(0, 300));

    const uri = vscode.Uri.file(join(fx.repo, "main.tex"));
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc);
    const lenses = await until("code lenses", async () => {
      const l = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri);
      return l && l.length >= 10 ? l : null;
    });
    const titles = lenses.map((l) => l.command && l.command.title);
    check("code lenses for both items", titles.includes(`${fx.items[0]}: ✓ Accept`) && titles.includes(`${fx.items[1]}: ✓ Accept`), titles.join(" | "));
    const first = lenses.find((l) => l.command.title === `${fx.items[0]}: ✓ Accept`);
    check("lens on the right line", first.range.start.line === 3, first.range.start.line);

    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, new vscode.Position(3, 26));
    const hoverText = hovers.flatMap((h) => h.contents.map((c) => c.value || String(c))).join("\n");
    check("hover shows the diff and actions", hoverText.includes("- problem") && hoverText.includes("+ task") && hoverText.includes("Accept"), hoverText.slice(0, 200));

    const after = vscode.Uri.from({ scheme: "stet-diff", path: "/main.tex", query: `p=${encodeURIComponent(fx.repo)}&id=${fx.items[1]}&side=after` });
    const diffDoc = await vscode.workspace.openTextDocument(after);
    check("diff document shows the proposal", diffDoc.getText().includes("effective in real use"), diffDoc.getText().slice(0, 80));

    // Unsaved edit above the changes: CodeLens must follow.
    await ed.edit((e) => e.insert(new vscode.Position(0, 0), "% my note\n"));
    const moved = await until("moved lenses", async () => {
      const l = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri);
      const f = l && l.find((x) => x.command && x.command.title === `${fx.items[0]}: ✓ Accept`);
      return f && f.range.start.line === 4 ? f : null;
    });
    check("lenses follow unsaved edits", moved);

    // Accept exactly as a click on the CodeLens would: with its own (project-scoped) arguments.
    const args = moved.command.arguments;
    check("lens arguments name the project", args.length === 1 && args[0].id === fx.items[0] && typeof args[0].path === "string", JSON.stringify(args));
    const t0 = Date.now();
    await vscode.commands.executeCommand(moved.command.command, ...args);
    const acceptMs = Date.now() - t0;
    const disk = readFileSync(uri.fsPath, "utf8");
    check("accept writes the change", disk.includes("the task of reviewing"), disk.slice(0, 120));
    check("accept keeps the user's unsaved edit (saved first)", disk.startsWith("% my note\n"));
    const shows = await until("the editor to show the accepted text", () => doc.getText().includes("the task of reviewing") && !doc.isDirty, 3000).catch(() => false);
    check("editor shows the accepted text", shows);
    const nextSel = await until("the next change after accepting", () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.getText(e.selection) === "practice" ? e : null;
    }, 5000).catch(() => null);
    check(`accept moves on to the next change (${acceptMs} ms)`, nextSel);
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: fx.repo, encoding: "utf8" });
    check("not committed because of the user's own edit", !log.includes("stet: accept"), log);

    const items = JSON.parse(readFileSync(join(store, "items", `${fx.items[0]}.json`), "utf8"));
    check("item accepted", items.status === "accepted", items.status);
    const remaining = await until("lenses after accept", async () => {
      const l = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri);
      return l && !l.some((x) => x.command.title.startsWith(`${fx.items[0]}:`)) ? l : null;
    });
    check("accepted item's lenses are gone", remaining.some((x) => x.command.title.startsWith(`${fx.items[1]}:`)));

    await vscode.commands.executeCommand("stet.showItem", fx.items[1]);
    const sel = vscode.window.activeTextEditor.selection;
    check("go to change selects it", vscode.window.activeTextEditor.document.getText(sel) === "practice", vscode.window.activeTextEditor.document.getText(sel));

    // Keyboard review: what `j` runs (focus down + select) must move the editor to the change.
    const bindings = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")).contributes.keybindings;
    const j = bindings.find((b) => b.key === "j");
    const ed2 = vscode.window.activeTextEditor;
    ed2.selection = new vscode.Selection(0, 0, 0, 0);
    await vscode.commands.executeCommand("stet.review.focus");
    let followed = false;
    const trace = [];
    for (let n = 0; n < 5 && !followed; n++) {
      try {
        await vscode.commands.executeCommand(j.command, ...(j.args ? [j.args] : []));
      } catch (err) {
        trace.push("err:" + err.message);
      }
      await sleep(300);
      const e = vscode.window.activeTextEditor;
      trace.push(e ? `${e.document.uri.path.split("/").pop()}@${e.selection.start.line}:${e.selection.start.character}` : "none");
      followed = !!e && e.document.getText(e.selection) === "practice";
    }
    check("j moves through the panel and the editor follows", followed, trace.join(" | "));

    // Share my edits: the user's saved note reaches the agents' review base.
    const rel = require("node:path").relative(fx.repo, uri.fsPath).replace(/\\/g, "/");
    const baseText = () => execFileSync("git", ["show", `refs/stet/base:${rel}`], { cwd: fx.repo, encoding: "utf8" });
    check("own edits not shared before the button", !baseText().startsWith("% my note"), baseText().slice(0, 60));
    await vscode.commands.executeCommand("stet.shareEdits");
    check("Share my edits shares them", baseText().startsWith("% my note") && baseText().includes("the task of reviewing"), baseText().slice(0, 60));

    // Without word wrap, new text is a (green) decoration; with word wrap, an inlay hint, so word
    // wrap makes room for it. The 83-character line fits in 86 columns on its own; with
    // " real use" after "practice" it has to wrap.
    const doc2 = await vscode.workspace.openTextDocument(uri);
    const ed3 = await vscode.window.showTextDocument(doc2);
    const lineNo = doc2.getText().split("\n").findIndex((l) => l.startsWith("We show that this approach"));
    const hintLabels = async (u) => {
      const h = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", u, new vscode.Range(0, 0, 50, 0));
      return (h || []).map((x) => (typeof x.label === "string" ? x.label : x.label.map((p) => p.value).join("")));
    };
    check("without word wrap, new text is not an inlay hint", (await hintLabels(uri)).length === 0, JSON.stringify(await hintLabels(uri)));
    const editorCfg = vscode.workspace.getConfiguration("editor");
    await editorCfg.update("wordWrapColumn", 86, vscode.ConfigurationTarget.Global);
    await editorCfg.update("wordWrap", "wordWrapColumn", vscode.ConfigurationTarget.Global);
    const labels = await until("inlay hints with word wrap", async () => {
      const l = await hintLabels(uri);
      return l.length ? l : null;
    }, 5000).catch(() => []);
    check("with word wrap, new text is an inlay hint", labels.includes("real use"), JSON.stringify(labels));
    const wraps = async () => {
      // cursorMove acts on the active editor, and an editor object goes stale when its editor is
      // replaced: take the one showTextDocument returns, every time.
      const ed = await vscode.window.showTextDocument(doc2, { preserveFocus: false, preview: false });
      ed.selection = new vscode.Selection(lineNo, 0, lineNo, 0);
      await vscode.commands.executeCommand("cursorMove", { to: "down", by: "wrappedLine" });
      return ed.selection.active.line === lineNo;
    };
    const wrappedWithHint = await until("the line to wrap with the hint", wraps, 5000).catch(() => false);
    await vscode.workspace.getConfiguration("stet").update("inlineChanges", false, vscode.ConfigurationTarget.Global);
    const wrappedWithout = await until("the line to fit without the hint", async () => !(await wraps()), 5000).then(() => false, () => true);
    // Moving the cursor by screen lines needs the window to have the system's focus (it hasn't
    // while you work in another window during the test): then these can't measure, and say so.
    const measurable = await until("window focus", async () => vscode.window.state.focused || null, 5000).catch(() => false);
    if (measurable) check("word wrap makes room for the new text", wrappedWithHint && !wrappedWithout, `with hint: ${wrappedWithHint}, without: ${wrappedWithout}`);
    else check("word wrap makes room for the new text (skipped: window not focused)", true);
    await vscode.workspace.getConfiguration("stet").update("inlineChanges", true, vscode.ConfigurationTarget.Global);

    // A long proposal in a long paragraph line wraps over several screen lines, whole: VS Code
    // cuts inline hints after 43 characters per line unless told otherwise (Stet's default for
    // LaTeX files), and a hint must be broken at its spaces like text.
    const wrapUri = vscode.Uri.file(join(fx.repo, "wrap.tex"));
    const wrapEd = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(wrapUri));
    await editorCfg.update("wordWrapColumn", 80, vscode.ConfigurationTarget.Global);
    const screenLines = async () => {
      const ed = await vscode.window.showTextDocument(wrapEd.document, { preserveFocus: false, preview: false });
      ed.selection = new vscode.Selection(0, 0, 0, 0);
      let n = 1;
      for (; n < 40; n++) {
        await vscode.commands.executeCommand("cursorMove", { to: "down", by: "wrappedLine" });
        if (ed.selection.active.line !== 0) break;
      }
      return n;
    };
    await until("hint in wrap.tex", async () => ((await hintLabels(wrapUri)).some((l) => l.length > 100) ? true : null), 5000).catch(() => null);
    await sleep(500);
    const withLong = await screenLines();
    await vscode.workspace.getConfiguration("stet").update("inlineChanges", false, vscode.ConfigurationTarget.Global);
    await sleep(500);
    const withoutLong = await screenLines();
    await vscode.workspace.getConfiguration("stet").update("inlineChanges", true, vscode.ConfigurationTarget.Global);
    const maxLen = vscode.workspace.getConfiguration("editor", { uri: wrapUri, languageId: wrapEd.document.languageId }).get("inlayHints.maximumLength");
    if (vscode.window.state.focused) check("a long proposal wraps over several screen lines", withLong - withoutLong >= 2, JSON.stringify({ withLong, withoutLong, lang: wrapEd.document.languageId, maxLen }));
    else check("a long proposal wraps over several screen lines (skipped: window not focused)", true);

    // The colour button: green parameter hints in the user's settings, and back (keeping their own value).
    const workbench = () => vscode.workspace.getConfiguration("workbench").inspect("colorCustomizations").globalValue || {};
    await vscode.workspace.getConfiguration("workbench").update("colorCustomizations", { "editorInlayHint.parameterForeground": "#123456", "editor.background": "#fafafa" }, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("stet.highlightOn");
    const on = workbench();
    await vscode.commands.executeCommand("stet.highlightOff");
    const off = workbench();
    check(
      "colour button turns proposed text green and back",
      on["editorInlayHint.parameterForeground"] === "#2DA44E" && off["editorInlayHint.parameterForeground"] === "#123456" && !("editorInlayHint.parameterBackground" in off) && off["editor.background"] === "#fafafa",
      JSON.stringify({ on, off }),
    );

    // A changed exponent and sign in a formula: one item, but only those parts are shown as new.
    const mathUri = vscode.Uri.file(join(fx.repo, "math.tex"));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mathUri));
    const mathLabels = await until("hints in the formula", async () => {
      const h = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", mathUri, new vscode.Range(0, 0, 10, 0));
      const l = (h || []).map((x) => (typeof x.label === "string" ? x.label : x.label.map((p) => p.value).join("")));
      return l.length ? l : null;
    }, 5000).catch(() => []);
    check(
      "formula changes are shown part by part",
      mathLabels.length >= 1 && mathLabels.length <= 3 && mathLabels.every((l) => l.trim().length <= 4),
      JSON.stringify(mathLabels),
    );

    // History: the view exists and opens; decided changes show as a diff of the change itself.
    let historyOk = true;
    await Promise.resolve(vscode.commands.executeCommand("stet.history.focus")).catch(() => (historyOk = false));
    check("history view opens", historyOk);
    const decided = fx.items[0];
    const diffAfter = await vscode.workspace.openTextDocument(
      vscode.Uri.from({ scheme: "stet-diff", path: "/main.tex", query: `p=${encodeURIComponent(fx.repo)}&id=${decided}&side=after` }),
    );
    check("diff of a decided change shows the accepted text in context", diffAfter.getText().includes("the task of reviewing"), diffAfter.getText().slice(0, 100));

    // Pressing `a` twice in quick succession accepts two changes: the second waits until the
    // panel has moved on from the first.
    await vscode.commands.executeCommand("stet.review.focus");
    for (let n = 0; n < 6; n++) {
      const e = vscode.window.activeTextEditor;
      if (e && e.document.getText(e.selection) === "practice") break;
      await vscode.commands.executeCommand("stet.next");
      await sleep(200);
    }
    const errors = [];
    await Promise.all([1, 2].map(() => Promise.resolve(vscode.commands.executeCommand("stet.accept")).catch((err) => errors.push(err.message))));
    const statusOf = (id) => JSON.parse(readFileSync(join(store, "items", `${id}.json`), "utf8")).status;
    const acceptedNow = fx.items.slice(1).filter((id) => statusOf(id) === "accepted");
    check(
      "two quick accepts accept two changes",
      !errors.length && statusOf(fx.items[1]) === "accepted" && acceptedNow.length === 2,
      JSON.stringify({ errors, accepted: acceptedNow }),
    );

    // Undo from the panel: the accept is taken out of the file again and the change is pending.
    const undoBefore = readFileSync(join(fx.repo, "main.tex"), "utf8");
    await vscode.commands.executeCommand("stet.undo", fx.items[0]);
    const undoAfter = await until("undo", async () => (statusOf(fx.items[0]) === "pending" ? readFileSync(join(fx.repo, "main.tex"), "utf8") : null), 5000).catch(() => null);
    check(
      "undo takes an accepted change out of the file",
      undoAfter !== null && undoBefore.includes("the task of reviewing") && !undoAfter.includes("the task of reviewing"),
      JSON.stringify({ status: statusOf(fx.items[0]) }),
    );

    // PDF preview: opens at once, and the compiled region arrives afterwards (when TeX and the
    // preview image are there; otherwise the panel says what is missing).
    await vscode.commands.executeCommand("stet.preview", fx.items[0]);
    const { readdirSync, existsSync: exists } = require("node:fs");
    const previewDir = join(store, "previews");
    const result = await until("preview", async () => {
      if (!exists(previewDir)) return null;
      for (const base of readdirSync(previewDir)) {
        const items = join(previewDir, base, "items");
        if (!exists(items)) continue;
        const hit = readdirSync(items).find((d) => d.startsWith(fx.items[0] + "-") && exists(join(items, d, "result.json")));
        if (hit) return JSON.parse(readFileSync(join(items, hit, "result.json"), "utf8"));
      }
      return null;
    }, 60000).catch(() => null);
    check("a PDF preview is built in the background", result && ["ready", "no-spot", "unavailable", "failed"].includes(result.status), JSON.stringify(result && { status: result.status, message: result.message }));
    console.log("preview result: " + (result && result.status));

    // The hover shows the PDF preview once built (setting stet.pdfPreviews: "both" by default).
    // The position is looked up each time: the undo above changed the file on disk, and the
    // editor reloads it in its own time.
    const pdfUri = vscode.Uri.file(join(fx.repo, "main.tex"));
    const pdfHoverText = async () => {
      const doc = await vscode.workspace.openTextDocument(pdfUri);
      const k = doc.getText().indexOf("problem");
      if (k < 0) return "";
      const hs = (await vscode.commands.executeCommand("vscode.executeHoverProvider", pdfUri, doc.positionAt(k + 2))) || [];
      return hs.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
    };
    const pdfWithImage = await until("hover preview", async () => {
      const t = await pdfHoverText();
      return /!\[PDF preview of /.test(t) ? t : null;
    }, 60000).catch(() => null);
    check("the hover shows the PDF preview once it is built", !!pdfWithImage && /file:\/\/.*after\.png/.test(pdfWithImage), (await pdfHoverText()).slice(0, 300));

    // Review all changes in a file: an editable diff. Saving keeps changes pending with the
    // user's wording; ✓ Accept there accepts with it.
    const mainFile = vscode.Uri.file(join(fx.repo, "main.tex"));
    await vscode.commands.executeCommand("stet.reviewFile", mainFile);
    const reviewDoc = await until("review document", async () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "stet-review" && d.uri.path.endsWith("main.tex")) || null, 10000).catch(() => null);
    check("the review of a file shows its pending changes", !!reviewDoc && reviewDoc.getText().includes("the task of reviewing"), reviewDoc ? reviewDoc.getText().slice(0, 200) : "no review document");
    if (reviewDoc) {
      const replaceIn = async (from, to) => {
        const k = reviewDoc.getText().indexOf(from);
        const e = new vscode.WorkspaceEdit();
        e.replace(reviewDoc.uri, new vscode.Range(reviewDoc.positionAt(k), reviewDoc.positionAt(k + from.length)), to);
        await vscode.workspace.applyEdit(e);
        return reviewDoc.save();
      };
      const item0 = () => JSON.parse(readFileSync(join(store, "items", `${fx.items[0]}.json`), "utf8"));
      const saved = await replaceIn("the task of", "the hard task of");
      check("saving the review keeps the change pending with your wording", saved && item0().status === "pending" && item0().draft === "hard task", JSON.stringify({ saved, status: item0().status, draft: item0().draft }));
      const outside = await replaceIn("In this work", "In this paper").catch(() => false);
      check("an edit outside the changes isn't saved", outside === false && item0().draft === "hard task", JSON.stringify({ outside }));
      await vscode.commands.executeCommand("workbench.action.files.revert");
      await vscode.commands.executeCommand("stet.reviewAccept", reviewDoc.uri, { path: fx.repo, id: fx.items[0] });
      const accepted = await until("accept from the review", async () => (item0().status === "accepted" ? readFileSync(join(fx.repo, "main.tex"), "utf8") : null), 10000).catch(() => null);
      check("✓ Accept in the review accepts with your wording", !!accepted && accepted.includes("the hard task of reviewing"), JSON.stringify({ status: item0().status }));
    }

    // View options switch settings from the panel.
    const stetConf = () => vscode.workspace.getConfiguration("stet");
    const inlineBefore = stetConf().get("inlineChanges");
    await vscode.commands.executeCommand("stet.toggleInlineChanges");
    const flipped = stetConf().get("inlineChanges");
    await vscode.commands.executeCommand("stet.toggleInlineChanges");
    await vscode.commands.executeCommand("stet.longChanges.hover");
    const long = stetConf().get("longChanges");
    await vscode.commands.executeCommand("stet.longChanges.collapsed");
    check("view options switch settings", flipped === !inlineBefore && stetConf().get("inlineChanges") === inlineBefore && long === "hover", JSON.stringify({ inline: inlineBefore, flipped, long }));

    const allCommands = await vscode.commands.getCommands(true);
    const wanted = ["stet.agentNotify", "stet.agentNotifyOff", "stet.agentPing", "stet.undo", "stet.toggleCodeLens", "stet.shareEdits.saved", "stet.preview", "stet.previewSetup", "stet.pdfPreviews.hover", "stet.reviewFile", "stet.clearDraft"];
    check("new commands are registered", wanted.every((c) => allCommands.includes(c)), JSON.stringify(wanted.filter((c) => !allCommands.includes(c))));
  } catch (e) {
    check("no exception", false, e && e.stack);
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
};
