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
    await vscode.commands.executeCommand(moved.command.command, ...args);
    const disk = readFileSync(uri.fsPath, "utf8");
    check("accept writes the change", disk.includes("the task of reviewing"), disk.slice(0, 120));
    check("accept keeps the user's unsaved edit (saved first)", disk.startsWith("% my note\n"));
    check("editor shows the accepted text", doc.getText().includes("the task of reviewing") && !doc.isDirty);
    const nextSel = await until("the next change after accepting", () => {
      const e = vscode.window.activeTextEditor;
      return e && e.document.getText(e.selection) === "practice" ? e : null;
    }, 5000).catch(() => null);
    check("accept moves on to the next change", nextSel);
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
  } catch (e) {
    check("no exception", false, e && e.stack);
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
};
