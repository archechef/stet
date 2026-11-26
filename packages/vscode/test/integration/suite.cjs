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
  // Shared between steps: what an earlier step found or set up.
  let ext,
    store,
    cfg,
    s,
    status,
    uri,
    doc,
    ed,
    lenses,
    first,
    after,
    moved,
    disk,
    shows,
    items,
    j,
    hintLabels,
    editorCfg,
    wraps,
    wrapUri,
    workbench,
    on,
    decided,
    statusOf;
  // Each step runs on its own: one that fails is reported, and the next still runs.
  const steps = [
    [
      "activation, the bundled CLI and the agent's MCP server",
      async () => {
        ext = vscode.extensions.getExtension("archechef.stet-vscode");
        await ext.activate();
        check("activates", ext.isActive);

        store = join(fx.repo, ".git", "stet");
        await until("managed CLI", () => existsSync(join(store, "bin", "stet.mjs")));
        cfg = JSON.parse(readFileSync(join(store, "config.json"), "utf8"));
        check("records bundled CLI", cfg.cli?.args[0].endsWith("/stet/bin/stet.mjs"), JSON.stringify(cfg.cli));
        const mcp = await until(
          "agent MCP config",
          () => existsSync(join(fx.worktree, ".mcp.json")) && JSON.parse(readFileSync(join(fx.worktree, ".mcp.json"), "utf8")),
        );
        check("writes agent workspace files", mcp.mcpServers.stet.args.includes("mcp"), JSON.stringify(mcp.mcpServers.stet));
        const help = execFileSync(cfg.cli.command, [...cfg.cli.args, "--help"], { env: { ...process.env, ...(cfg.cli.env || {}) }, encoding: "utf8" });
        check("recorded CLI runs", help.includes("stet — review"), help.slice(0, 60));
        const runtime = process.env.STET_IT_RUNTIME || "auto";
        check(
          `runtime '${runtime}' honoured`,
          runtime === "vscode" ? cfg.cli.env && cfg.cli.env.ELECTRON_RUN_AS_NODE === "1" : !cfg.cli.env,
          JSON.stringify(cfg.cli),
        );
        // What an agent's tool does: start the MCP server with the workspace's config and list tools.
        s = mcp.mcpServers.stet;
        const req = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        const mcpOut = execFileSync(s.command, s.args, {
          env: { ...process.env, ...s.env },
          input:
            req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "it", version: "1" } }) +
            req(2, "tools/list") +
            req(3, "tools/call", { name: "stet_status", arguments: {} }),
          encoding: "utf8",
          timeout: 30000,
        });
        const replies = mcpOut
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const tools = replies.find((r) => r.id === 2)?.result;
        status = replies.find((r) => r.id === 3)?.result;
        check("agent MCP server answers", tools?.tools.some((t) => t.name === "stet_submit") && status && !status.isError, mcpOut.slice(0, 300));
      },
    ],
    [
      "code lenses for the changes",
      async () => {
        uri = vscode.Uri.file(join(fx.repo, "main.tex"));
        doc = await vscode.workspace.openTextDocument(uri);
        ed = await vscode.window.showTextDocument(doc);
        lenses = await until("code lenses", async () => {
          const l = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri);
          return l && l.length >= 6 ? l : null;
        });
        const titles = lenses.map((l) => l.command?.title);
        check(
          "code lenses for both items",
          titles.includes(`${fx.items[0]}: $(check) Accept`) && titles.includes(`${fx.items[1]}: $(check) Accept`),
          titles.join(" | "),
        );
      },
    ],
    [
      "a group removed outside; lenses, actions, hovers and the diff document",
      async () => {
        // A change made outside the extension that appends no event (removing a group) still
        // reaches the editor and the panel: the store signals it (bug report 2026-11-20).
        {
          const stetCli = (...a) =>
            execFileSync(cfg.cli.command, [...cfg.cli.args, ...a, "--json"], {
              cwd: fx.repo,
              env: { ...process.env, ...(cfg.cli.env || {}) },
              encoding: "utf8",
            });
          const lens0 = async () =>
            ((await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri)) || [])
              .map((l) => l.command?.title)
              .find((t) => t?.startsWith(`${fx.items[0]}:`)) || "";
          const g = JSON.parse(stetCli("group", fx.items[0], fx.items[1], "--kind", "linked", "-t", "Test", "--reason", "integration test")).group.id;
          const linked = await until("linked lens", async () => ((await lens0()).includes(`Accept all of ${g}`) ? true : null), 10000).catch(() => false);
          stetCli("ungroup", g);
          const unlinked = await until("lens after ungroup", async () => ((await lens0()) === `${fx.items[0]}: $(check) Accept` ? true : null), 10000).catch(
            () => false,
          );
          check("a group removed outside the extension disappears without a reload", linked && unlinked, JSON.stringify({ linked, lens: await lens0() }));
        }
        first = lenses.find((l) => l.command.title === `${fx.items[0]}: $(check) Accept`);
        check("lens on the right line", first.range.start.line === 3, first.range.start.line);
        // Above each change: Accept, Reject… and More… (every action, the same list as everywhere).
        const onFirst = lenses.filter((l) => l.range.start.line === 3).map((l) => l.command.command);
        check(
          "lenses: Accept, Reject, More…",
          JSON.stringify(onFirst) === JSON.stringify(["stet.accept", "stet.reject", "stet.changeActions"]),
          JSON.stringify(onFirst),
        );
        // Ctrl+. in a change offers the same actions, in the same order.
        const fixes = (await vscode.commands.executeCommand("vscode.executeCodeActionProvider", uri, new vscode.Range(3, 28, 3, 28))) || [];
        const ours = fixes.map((f) => f.title).filter((t) => t.startsWith(`Stet ${fx.items[0]}:`));
        check(
          "Ctrl+. in a change lists its actions",
          ours.length >= 6 && ours[0] === `Stet ${fx.items[0]}: Accept` && ours.includes(`Stet ${fx.items[0]}: Review file`),
          JSON.stringify(ours),
        );

        const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, new vscode.Position(3, 26));
        const hoverText = hovers.flatMap((h) => h.contents.map((c) => c.value || String(c))).join("\n");
        check(
          "hover shows the diff and every action",
          hoverText.includes("- problem") &&
            hoverText.includes("+ task") &&
            ["$(check) Accept", "$(close) Reject…", "$(edit) Edit & accept…", "$(diff-multiple) Review file"].every((a) => hoverText.includes(`[${a}]`)),
          hoverText.slice(0, 200),
        );
        // The hover answers to the word before and after a change too, and stays open across them.
        const hoverAt = async (pos) => (await vscode.commands.executeCommand("vscode.executeHoverProvider", uri, pos)) || [];
        const textOf = (hs) => hs.flatMap((h) => h.contents.map((c) => c.value || String(c))).join("\n");
        const beside = await hoverAt(new vscode.Position(3, 23)); // "the" before "problem"
        const besideRange = beside.find((h) => textOf([h]).includes("+ task"))?.range;
        check(
          "the hover shows next to a change, and covers the words around it",
          !!besideRange && besideRange.start.character === 22 && besideRange.end.character === 36,
          JSON.stringify(besideRange) + " " + textOf(beside).slice(0, 80),
        );
        check(
          "no hover away from a change",
          !textOf(await hoverAt(new vscode.Position(3, 4))).includes("+ task"),
          textOf(await hoverAt(new vscode.Position(3, 4))).slice(0, 80),
        );

        after = vscode.Uri.from({ scheme: "stet-diff", path: "/main.tex", query: `p=${encodeURIComponent(fx.repo)}&id=${fx.items[1]}&side=after` });
        const diffDoc = await vscode.workspace.openTextDocument(after);
        check("diff document shows the proposal", diffDoc.getText().includes("effective in real use"), diffDoc.getText().slice(0, 80));
      },
    ],
    [
      "lenses follow unsaved edits",
      async () => {
        // Unsaved edit above the changes: CodeLens must follow.
        await ed.edit((e) => e.insert(new vscode.Position(0, 0), "% my note\n"));
        moved = await until("moved lenses", async () => {
          const l = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri);
          const f = l?.find((x) => x.command && x.command.title === `${fx.items[0]}: $(check) Accept`);
          return f && f.range.start.line === 4 ? f : null;
        });
        check("lenses follow unsaved edits", moved);
      },
    ],
    [
      "accepting from a lens",
      async () => {
        // Accept exactly as a click on the CodeLens would: with its own (project-scoped) arguments.
        const args = moved.command.arguments;
        check("lens arguments name the project", args.length === 1 && args[0].id === fx.items[0] && typeof args[0].path === "string", JSON.stringify(args));
        const t0 = Date.now();
        await vscode.commands.executeCommand(moved.command.command, ...args);
        const acceptMs = Date.now() - t0;
        disk = readFileSync(uri.fsPath, "utf8");
        check("accept writes the change", disk.includes("the task of reviewing"), disk.slice(0, 120));
        check("accept keeps the user's unsaved edit (saved first)", disk.startsWith("% my note\n"));
        shows = await until("the editor to show the accepted text", () => doc.getText().includes("the task of reviewing") && !doc.isDirty, 3000).catch(
          () => false,
        );
        check("editor shows the accepted text", shows);
        const nextSel = await until(
          "the next change after accepting",
          () => {
            const e = vscode.window.activeTextEditor;
            return e && e.document.getText(e.selection) === "practice" ? e : null;
          },
          5000,
        ).catch(() => null);
        check(`accept moves on to the next change (${acceptMs} ms)`, nextSel);
        const log = execFileSync("git", ["log", "--format=%s"], { cwd: fx.repo, encoding: "utf8" });
        check("not committed because of the user's own edit", !log.includes("stet: accept"), log);

        items = JSON.parse(readFileSync(join(store, "items", `${fx.items[0]}.json`), "utf8"));
        check("item accepted", items.status === "accepted", items.status);
        const remaining = await until("lenses after accept", async () => {
          const l = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", uri);
          return l && !l.some((x) => x.command.title.startsWith(`${fx.items[0]}:`)) ? l : null;
        });
        check(
          "accepted item's lenses are gone",
          remaining.some((x) => x.command.title.startsWith(`${fx.items[1]}:`)),
        );

        await vscode.commands.executeCommand("stet.showItem", fx.items[1]);
        const sel = vscode.window.activeTextEditor.selection;
        check(
          "go to change selects it",
          vscode.window.activeTextEditor.document.getText(sel) === "practice",
          vscode.window.activeTextEditor.document.getText(sel),
        );
      },
    ],
    [
      "keyboard review with j",
      async () => {
        // Keyboard review: what `j` runs (focus down + select) must move the editor to the change.
        const bindings = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")).contributes.keybindings;
        j = bindings.find((b) => b.key === "j");
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
      },
    ],
    [
      "Share my edits",
      async () => {
        // Share my edits: the user's saved note reaches the agents' review base.
        const rel = require("node:path").relative(fx.repo, uri.fsPath).replace(/\\/g, "/");
        const baseText = () => execFileSync("git", ["show", `refs/stet/base:${rel}`], { cwd: fx.repo, encoding: "utf8" });
        check("own edits not shared before the button", !baseText().startsWith("% my note"), baseText().slice(0, 60));
        await vscode.commands.executeCommand("stet.shareEdits");
        check("Share my edits shares them", baseText().startsWith("% my note") && baseText().includes("the task of reviewing"), baseText().slice(0, 60));
      },
    ],
    [
      "new text and word wrap",
      async () => {
        // Without word wrap, new text is a (green) decoration; with word wrap, an inlay hint, so word
        // wrap makes room for it. The 83-character line fits in 86 columns on its own; with
        // " real use" after "practice" it has to wrap.
        const doc2 = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc2);
        const lineNo = doc2
          .getText()
          .split("\n")
          .findIndex((l) => l.startsWith("We show that this approach"));
        hintLabels = async (u) => {
          const h = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", u, new vscode.Range(0, 0, 50, 0));
          return (h || []).map((x) => (typeof x.label === "string" ? x.label : x.label.map((p) => p.value).join("")));
        };
        check("without word wrap, new text is not an inlay hint", (await hintLabels(uri)).length === 0, JSON.stringify(await hintLabels(uri)));
        editorCfg = vscode.workspace.getConfiguration("editor");
        await editorCfg.update("wordWrapColumn", 86, vscode.ConfigurationTarget.Global);
        await editorCfg.update("wordWrap", "wordWrapColumn", vscode.ConfigurationTarget.Global);
        const labels = await until(
          "inlay hints with word wrap",
          async () => {
            const l = await hintLabels(uri);
            return l.length ? l : null;
          },
          5000,
        ).catch(() => []);
        check("with word wrap, new text is an inlay hint", labels.includes("real use"), JSON.stringify(labels));
        {
          // Its tooltip is the change's full hover, made when it's hovered (resolved). VS Code's
          // command doesn't resolve hints, so this asks the extension's provider directly.
          const { editor } = ext.exports;
          const hs = await editor.provideInlayHints(await vscode.workspace.openTextDocument(uri), new vscode.Range(0, 0, 50, 0));
          const resolved = hs.map((h) => editor.resolveInlayHint(h));
          const tip = resolved.map((h) => (typeof h.tooltip === "string" ? h.tooltip : h.tooltip?.value)).find(Boolean) || "";
          check(
            "the inline text's tooltip is the full hover, with actions",
            tip.includes("Accept") && tip.includes("Revise"),
            tip.slice(0, 120) || "(no tooltip)",
          );
        }
        wraps = async () => {
          // cursorMove acts on the active editor, and an editor object goes stale when its editor is
          // replaced: take the one showTextDocument returns, every time.
          const ed = await vscode.window.showTextDocument(doc2, { preserveFocus: false, preview: false });
          ed.selection = new vscode.Selection(lineNo, 0, lineNo, 0);
          await vscode.commands.executeCommand("cursorMove", { to: "down", by: "wrappedLine" });
          return ed.selection.active.line === lineNo;
        };
        const wrappedWithHint = await until("the line to wrap with the hint", wraps, 5000).catch(() => false);
        await vscode.workspace.getConfiguration("stet").update("inlineChanges", false, vscode.ConfigurationTarget.Global);
        const wrappedWithout = await until("the line to fit without the hint", async () => !(await wraps()), 5000).then(
          () => false,
          () => true,
        );
        // Moving the cursor by screen lines needs the window to have the system's focus (it hasn't
        // while you work in another window during the test): then these can't measure, and say so.
        const measurable = await until("window focus", async () => vscode.window.state.focused || null, 5000).catch(() => false);
        if (measurable)
          check("word wrap makes room for the new text", wrappedWithHint && !wrappedWithout, `with hint: ${wrappedWithHint}, without: ${wrappedWithout}`);
        else check("word wrap makes room for the new text (skipped: window not focused)", true);
        await vscode.workspace.getConfiguration("stet").update("inlineChanges", true, vscode.ConfigurationTarget.Global);
      },
    ],
    [
      "a long proposal wraps whole",
      async () => {
        // A long proposal in a long paragraph line wraps over several screen lines, whole: VS Code
        // cuts inline hints after 43 characters per line unless told otherwise (Stet's default for
        // LaTeX files), and a hint must be broken at its spaces like text.
        wrapUri = vscode.Uri.file(join(fx.repo, "wrap.tex"));
        const wrapEd = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(wrapUri));
        await editorCfg.update("wordWrapColumn", 80, vscode.ConfigurationTarget.Global);
        // Screen rows of the paragraph: scrolled down one row at a time from the top, until its line
        // is out of view. (Moving the cursor by wrapped line can't count them: a row of proposed text
        // alone has no position for the cursor.)
        const rowsOfLine0 = async () => {
          const ed = await vscode.window.showTextDocument(wrapEd.document, { preserveFocus: false, preview: false });
          ed.selection = new vscode.Selection(0, 0, 0, 0);
          ed.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
          await sleep(200);
          let n = 0;
          while (n < 40 && (ed.visibleRanges[0]?.start.line ?? 1) < 1) {
            await vscode.commands.executeCommand("editorScroll", { to: "down", by: "wrappedLine", value: 1 });
            await sleep(30);
            n++;
          }
          return n;
        };
        await until("hint in wrap.tex", async () => ((await hintLabels(wrapUri)).some((l) => l.length > 100) ? true : null), 5000).catch(() => null);
        await sleep(500);
        const rowsWith = await rowsOfLine0();
        const hintLens = (await hintLabels(wrapUri)).map((l) => l.length);
        await vscode.workspace.getConfiguration("stet").update("inlineChanges", false, vscode.ConfigurationTarget.Global);
        await sleep(500);
        const rowsWithout = await rowsOfLine0();
        await vscode.workspace.getConfiguration("stet").update("inlineChanges", true, vscode.ConfigurationTarget.Global);
        const maxLen = vscode.workspace.getConfiguration("editor", { uri: wrapUri, languageId: wrapEd.document.languageId }).get("inlayHints.maximumLength");
        if (vscode.window.state.focused)
          check(
            "a long proposal wraps over several screen lines",
            rowsWith - rowsWithout >= 2,
            JSON.stringify({ rowsWith, rowsWithout, hintLens, lang: wrapEd.document.languageId, maxLen }),
          );
        else check("a long proposal wraps over several screen lines (skipped: window not focused)", true);
      },
    ],
    [
      "the colour button",
      async () => {
        // The colour button: green parameter hints in the user's settings, and back (keeping their own value).
        workbench = () => vscode.workspace.getConfiguration("workbench").inspect("colorCustomizations").globalValue || {};
        await vscode.workspace
          .getConfiguration("workbench")
          .update(
            "colorCustomizations",
            { "editorInlayHint.parameterForeground": "#123456", "editor.background": "#fafafa" },
            vscode.ConfigurationTarget.Global,
          );
        await vscode.commands.executeCommand("stet.toggleHighlight");
        on = workbench();
        await until(
          "the highlight to register",
          async () => vscode.workspace.getConfiguration("workbench").get("colorCustomizations")["editorInlayHint.parameterForeground"] === "#2DA44E" || null,
          3000,
        ).catch(() => null);
        await vscode.commands.executeCommand("stet.toggleHighlight");
        const off = workbench();
        check(
          "the green-text option turns proposed text green and back",
          on["editorInlayHint.parameterForeground"] === "#2DA44E" &&
            off["editorInlayHint.parameterForeground"] === "#123456" &&
            !("editorInlayHint.parameterBackground" in off) &&
            off["editor.background"] === "#fafafa",
          JSON.stringify({ on, off }),
        );
      },
    ],
    [
      "a formula's changed parts",
      async () => {
        // A changed exponent and sign in a formula: one item, but only those parts are shown as new.
        const mathUri = vscode.Uri.file(join(fx.repo, "math.tex"));
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(mathUri));
        const mathLabels = await until(
          "hints in the formula",
          async () => {
            const h = await vscode.commands.executeCommand("vscode.executeInlayHintProvider", mathUri, new vscode.Range(0, 0, 10, 0));
            const l = (h || []).map((x) => (typeof x.label === "string" ? x.label : x.label.map((p) => p.value).join("")));
            return l.length ? l : null;
          },
          5000,
        ).catch(() => []);
        check(
          "formula changes are shown part by part",
          mathLabels.length >= 1 && mathLabels.length <= 3 && mathLabels.every((l) => l.trim().length <= 4),
          JSON.stringify(mathLabels),
        );
      },
    ],
    [
      "History",
      async () => {
        // History: the view exists and opens; decided changes show as a diff of the change itself.
        let historyOk = true;
        await Promise.resolve(vscode.commands.executeCommand("stet.history.focus")).catch(() => (historyOk = false));
        check("history view opens", historyOk);
        decided = fx.items[0];
        const diffAfter = await vscode.workspace.openTextDocument(
          vscode.Uri.from({ scheme: "stet-diff", path: "/main.tex", query: `p=${encodeURIComponent(fx.repo)}&id=${decided}&side=after` }),
        );
        check(
          "diff of a decided change shows the accepted text in context",
          diffAfter.getText().includes("the task of reviewing"),
          diffAfter.getText().slice(0, 100),
        );
      },
    ],
    [
      "diffs",
      async () => {
        // Diffs: the left side is your text as it is (read-only), not your file with the proposals in it.
        {
          const itemOf = (id) => JSON.parse(readFileSync(join(store, "items", `${id}.json`), "utf8"));
          const wrapId = fx.items.find((id) => itemOf(id).file === "wrap.tex" && itemOf(id).status === "pending");
          await vscode.commands.executeCommand("stet.showDiff", { path: fx.repo, id: wrapId });
          const tab = await until(
            "diff tab",
            async () => {
              const t = vscode.window.tabGroups.activeTabGroup.activeTab;
              return t && t.input instanceof vscode.TabInputTextDiff ? t.input : null;
            },
            10000,
          ).catch(() => null);
          const left = tab && (await vscode.workspace.openTextDocument(tab.original));
          check(
            "a diff's left side is your text, read-only, without the proposals",
            !!left && tab.original.scheme === "stet-diff" && left.getText() === readFileSync(join(fx.repo, "wrap.tex"), "utf8"),
            tab ? `${tab.original.toString()} ${left?.getText().slice(0, 60)}` : "no diff tab",
          );
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

          // Editing a longer change: an editor of its own; saving keeps your wording, the change stays pending.
          await vscode.commands.executeCommand("stet.edit", { path: fx.repo, id: wrapId });
          const editDoc = await until(
            "edit editor",
            async () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "stet-edit" && d.uri.path.startsWith(`/${wrapId}/`)) || null,
            10000,
          ).catch(() => null);
          const editLenses = editDoc
            ? ((await vscode.commands.executeCommand("vscode.executeCodeLensProvider", editDoc.uri)) || []).map((l) => l.command?.title)
            : [];
          if (editDoc) {
            const e = new vscode.WorkspaceEdit();
            e.insert(editDoc.uri, editDoc.positionAt(editDoc.getText().length), " Reworded by me.");
            await vscode.workspace.applyEdit(e);
            await editDoc.save();
          }
          const drafted = itemOf(wrapId);
          check(
            "editing a change in its own editor: buttons above, Ctrl+S keeps your wording, still pending",
            !!editDoc &&
              editLenses.some((t) => t.startsWith(`${wrapId}: $(check) Accept`) && t.endsWith("with this wording")) &&
              editLenses.includes("$(save) Save wording") &&
              drafted.status === "pending" &&
              (drafted.draft || "").endsWith("Reworded by me."),
            JSON.stringify({ editLenses, status: drafted.status, draft: (drafted.draft || "").slice(-30) }),
          );
          if (editDoc) await vscode.commands.executeCommand("stet.editReset", editDoc.uri.toString());
          check("Agent's wording drops yours", itemOf(wrapId).draft === undefined, JSON.stringify(itemOf(wrapId).draft));
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

          // Going to a change uses the group that has its file open, not the focused one.
          const wrapUri = vscode.Uri.file(join(fx.repo, "wrap.tex"));
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(wrapUri), { viewColumn: vscode.ViewColumn.One });
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: "other" }), { viewColumn: vscode.ViewColumn.Two });
          await vscode.commands.executeCommand("stet.showItem", { path: fx.repo, id: wrapId });
          const groupsWithWrap = vscode.window.tabGroups.all
            .filter((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === wrapUri.toString()))
            .map((g) => g.viewColumn);
          // (The active group, not activeTextEditor: that one lags while the test window is in the background.)
          const active = vscode.window.tabGroups.activeTabGroup;
          const shown =
            active.viewColumn === 1 &&
            active.activeTab &&
            active.activeTab.input instanceof vscode.TabInputText &&
            active.activeTab.input.uri.toString() === wrapUri.toString();
          check(
            "going to a change reuses the tab of its file",
            JSON.stringify(groupsWithWrap) === "[1]" && shown,
            JSON.stringify({ groupsWithWrap, active: active.viewColumn }),
          );
          await vscode.commands.executeCommand("workbench.action.closeEditorsInOtherGroups");
        }
      },
    ],
    [
      "two quick accepts",
      async () => {
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
        statusOf = (id) => JSON.parse(readFileSync(join(store, "items", `${id}.json`), "utf8")).status;
        const acceptedNow = fx.items.slice(1).filter((id) => statusOf(id) === "accepted");
        check(
          "two quick accepts accept two changes",
          !errors.length && statusOf(fx.items[1]) === "accepted" && acceptedNow.length === 2,
          JSON.stringify({ errors, accepted: acceptedNow }),
        );
      },
    ],
    [
      "undo from the panel",
      async () => {
        // Undo from the panel: the accept is taken out of the file again and the change is pending.
        const undoBefore = readFileSync(join(fx.repo, "main.tex"), "utf8");
        await vscode.commands.executeCommand("stet.undo", fx.items[0]);
        const undoAfter = await until(
          "undo",
          async () => (statusOf(fx.items[0]) === "pending" ? readFileSync(join(fx.repo, "main.tex"), "utf8") : null),
          5000,
        ).catch(() => null);
        check(
          "undo takes an accepted change out of the file",
          undoAfter !== null && undoBefore.includes("the task of reviewing") && !undoAfter.includes("the task of reviewing"),
          JSON.stringify({ status: statusOf(fx.items[0]) }),
        );
      },
    ],
    [
      "undo a rejection",
      async () => {
        // A change rejected (here from the command line), then Undo in History: pending again.
        const id = fx.items.find((i) => statusOf(i) === "pending");
        const cli = (...a) => {
          try {
            return execFileSync(cfg.cli.command, [...cfg.cli.args, ...a], {
              cwd: fx.repo,
              env: { ...process.env, ...(cfg.cli.env || {}) },
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            });
          } catch (e) {
            throw new Error(`stet ${a.join(" ")}: ${e.stderr || e.stdout || e.message}`);
          }
        };
        cli("reject", id, "-m", "not this one");
        await sleep(1500); // the panel sees the rejection
        await vscode.commands.executeCommand("stet.undo", id);
        const back = await until("undo of a rejection", async () => statusOf(id) === "pending", 5000).catch(() => false);
        check("undo of a rejection makes the change pending again", back, JSON.stringify({ status: statusOf(id) }));
      },
    ],
    [
      "PDF preview",
      async () => {
        // PDF preview: opens at once, and the compiled region arrives afterwards (when TeX and the
        // preview image are there; otherwise the panel says what is missing).
        await vscode.commands.executeCommand("stet.preview", fx.items[0]);
        const { readdirSync, existsSync: exists } = require("node:fs");
        const previewDir = join(store, "previews");
        const result = await until(
          "preview",
          async () => {
            if (!exists(previewDir)) return null;
            for (const base of readdirSync(previewDir)) {
              const items = join(previewDir, base, "items");
              if (!exists(items)) continue;
              const hit = readdirSync(items).find((d) => d.startsWith(fx.items[0] + "-") && exists(join(items, d, "result.json")));
              if (hit) return JSON.parse(readFileSync(join(items, hit, "result.json"), "utf8"));
            }
            return null;
          },
          60000,
        ).catch(() => null);
        check(
          "a PDF preview is built in the background",
          result && ["ready", "no-spot", "unavailable", "failed"].includes(result.status),
          JSON.stringify(result && { status: result.status, message: result.message }),
        );
        console.log("preview result: " + result?.status);
      },
    ],
    [
      "the hover's PDF preview",
      async () => {
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
        const pdfWithImage = await until(
          "hover preview",
          async () => {
            const t = await pdfHoverText();
            return /!\[PDF preview of /.test(t) ? t : null;
          },
          60000,
        ).catch(() => null);
        check(
          "the hover shows the PDF preview once it is built",
          !!pdfWithImage && /file:\/\/.*after\.png\|width=520,height=\d+\)/.test(pdfWithImage),
          (await pdfHoverText()).slice(0, 300),
        );
      },
    ],
    [
      "reviewing a file",
      async () => {
        // Review all changes in a file: an editable diff. Saving keeps changes pending with the
        // user's wording; ✓ Accept there accepts with it.
        const mainFile = vscode.Uri.file(join(fx.repo, "main.tex"));
        // Diff of a pending change: the same kind of review, with only that change.
        await vscode.commands.executeCommand("stet.showDiff", { path: fx.repo, id: fx.items[0] });
        const oneDoc = await until(
          "review of one change",
          async () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "stet-review" && d.uri.query.includes(`ids=${fx.items[0]}`)) || null,
          10000,
        ).catch(() => null);
        const oneLenses = oneDoc ? (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", oneDoc.uri)) || [] : [];
        check(
          "Diff of a pending change is an editable review of just that change",
          !!oneDoc &&
            oneDoc.getText().includes("the task of reviewing") &&
            oneLenses.some((l) => l.command?.title.startsWith(`${fx.items[0]}: $(check) Accept`)) &&
            !oneLenses.some((l) => l.command?.title.startsWith(`${fx.items[1]}:`)),
          oneDoc ? oneLenses.map((l) => l.command?.title).join(" | ") : "no review document",
        );
        await vscode.commands.executeCommand("stet.reviewFile", mainFile);
        const reviewDoc = await until(
          "review document",
          async () =>
            vscode.workspace.textDocuments.find((d) => d.uri.scheme === "stet-review" && d.uri.path.endsWith("main.tex") && !d.uri.query.includes("ids=")) ||
            null,
          10000,
        ).catch(() => null);
        check(
          "the review of a file shows its pending changes",
          !!reviewDoc && reviewDoc.getText().includes("the task of reviewing"),
          reviewDoc ? reviewDoc.getText().slice(0, 200) : "no review document",
        );
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
          check(
            "saving the review keeps the change pending with your wording",
            saved && item0().status === "pending" && item0().draft === "hard task",
            JSON.stringify({ saved, status: item0().status, draft: item0().draft }),
          );
          const outside = await replaceIn("In this work", "In this paper").catch(() => false);
          check("an edit outside the changes isn't saved", outside === false && item0().draft === "hard task", JSON.stringify({ outside }));
          await vscode.commands.executeCommand("workbench.action.files.revert");
          // The same actions as in the file: the row above the change, the hover, Ctrl+.
          const at = reviewDoc.positionAt(reviewDoc.getText().indexOf("hard task") + 2);
          const rl = (await vscode.commands.executeCommand("vscode.executeCodeLensProvider", reviewDoc.uri)) || [];
          const rt = rl.map((l) => l.command?.title);
          const rh = ((await vscode.commands.executeCommand("vscode.executeHoverProvider", reviewDoc.uri, at)) || [])
            .flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value)))
            .join("\n");
          const rc = ((await vscode.commands.executeCommand("vscode.executeCodeActionProvider", reviewDoc.uri, new vscode.Range(at, at))) || []).map(
            (a) => a.title,
          );
          check(
            "the review has the file's actions: row above, hover, Ctrl+.",
            rt.includes(`${fx.items[0]}: $(check) Accept (your wording)`) &&
              rt.includes("$(close) Reject…") &&
              rt.includes("$(ellipsis) More…") &&
              rl.every((l) => !l.command || l.command.command === "stet.reviewRun") &&
              rh.includes("stet.reviewRun") &&
              rh.includes("Reject") &&
              rc.includes(`Stet ${fx.items[0]}: Accept`) &&
              rc.some((t) => t.endsWith("Comment…")),
            JSON.stringify({ rt, rc }) + " " + rh.slice(0, 200),
          );
          // Accept from the row above the change, with an unsaved edit: it is saved first and used.
          const k = reviewDoc.getText().indexOf("hard task");
          const e = new vscode.WorkspaceEdit();
          e.replace(reviewDoc.uri, new vscode.Range(reviewDoc.positionAt(k), reviewDoc.positionAt(k + 4)), "harder");
          await vscode.workspace.applyEdit(e);
          const acceptLens = rl.find((l) => l.command?.title.startsWith(`${fx.items[0]}:`));
          await vscode.commands.executeCommand(acceptLens.command.command, ...acceptLens.command.arguments);
          const accepted = await until(
            "accept from the review",
            async () => (item0().status === "accepted" ? readFileSync(join(fx.repo, "main.tex"), "utf8") : null),
            10000,
          ).catch(() => null);
          check(
            "✓ Accept in the review accepts with your (unsaved) wording",
            !!accepted && accepted.includes("the harder task of reviewing"),
            JSON.stringify({ status: item0().status, dirty: reviewDoc.isDirty }),
          );
        }
      },
    ],
    [
      "keys act on their view; the palette and the filter",
      async () => {
        // Test report 2026-11-20: keys act on the view they are pressed in (B8, B9), and the Review
        // panel has no Undo (it never shows decided changes).
        {
          const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")).contributes;
          const keys = pkg.keybindings;
          const inReview = keys.filter((k) => k.when.includes("focusedView == stet.review"));
          const inHistory = keys.filter((k) => k.when.includes("focusedView == stet.history"));
          check(
            "panel keys act on the panel's selection, History keys on History's",
            inReview.every((k) => k.args === "panel" || ["stet.next", "stet.previous", "stet.undoLast", "stet.filter"].includes(k.command)) &&
              inHistory.every((k) => k.args === "history"),
            JSON.stringify(keys.filter((k) => !k.args).map((k) => k.key)),
          );
          const deadUndo =
            keys.some((k) => k.command === "stet.undo" && k.when.includes("stet.review")) ||
            pkg.menus["view/item/context"].some((m) => m.command === "stet.undo" && m.when.includes("view == stet.review"));
          check("no Undo in the Review panel, where nothing is decided", !deadUndo);
          const agentWelcome = pkg.viewsWelcome.find((v) => v.when === "stet.agentWorkspace");
          check(
            'an agent\'s own window says where to review, not "not set up"',
            agentWelcome?.contents.includes("command:stet.openAgentProject") &&
              pkg.viewsWelcome.some((v) => v.contents.startsWith("Stet is not set up") && v.when.includes("!stet.agentWorkspace")),
          );

          // From the palette (no argument), a command acts on the change at the cursor once the user
          // moved there, even with another change selected in the panel.
          const itemOf = (id) => JSON.parse(readFileSync(join(store, "items", `${id}.json`), "utf8"));
          const target = fx.items.map(itemOf).find((i) => i.status === "pending" && i.kind === "modify" && i.oldText.trim().length >= 3);
          if (target) {
            await vscode.commands.executeCommand("stet.review.focus");
            await vscode.commands.executeCommand("stet.next");
            await sleep(300);
            const tdoc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(fx.repo, target.file)));
            const ted = await vscode.window.showTextDocument(tdoc);
            const k = tdoc.getText().indexOf(target.oldText.trim());
            ted.selection = new vscode.Selection(tdoc.positionAt(k + 1), tdoc.positionAt(k + 1));
            await sleep(300);
            await vscode.commands.executeCommand("stet.showDiff");
            const diffTab = await until(
              "diff from the palette",
              async () => {
                const t = vscode.window.tabGroups.activeTabGroup.activeTab;
                return t && t.input instanceof vscode.TabInputTextDiff ? t.input : null;
              },
              10000,
            ).catch(() => null);
            const ids = diffTab ? new URLSearchParams(diffTab.modified.query).get("ids") || "" : "";
            check("a palette command acts on the change at the cursor", ids.split(",").includes(target.id), JSON.stringify({ target: target.id, ids, k }));
            await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

            // Undo right after deciding: `u` in the panel (Undo my last decision) takes the accept back.
            const before = readFileSync(join(fx.repo, target.file), "utf8");
            await vscode.commands.executeCommand("stet.accept", { path: fx.repo, id: target.id });
            const acc = await until("accepted", async () => (itemOf(target.id).status === "accepted" ? true : null), 10000).catch(() => false);
            const uKey = keys.find((k) => k.key === "u" && k.when.includes("stet.review"));
            await vscode.commands.executeCommand(uKey.command);
            const back = await until("undone", async () => (itemOf(target.id).status === "pending" ? true : null), 10000).catch(() => false);
            check(
              "u in the panel undoes the last decision",
              acc && back && readFileSync(join(fx.repo, target.file), "utf8") === before,
              JSON.stringify({ acc, back, status: itemOf(target.id).status }),
            );
          } else check("a palette command acts on the change at the cursor (skipped: no pending change left)", true);

          // Filters: j moves only through the changes shown.
          const pendingIn = (f) => fx.items.map(itemOf).filter((i) => i.status === "pending" && i.file === f);
          const fileWith = ["math.tex", "wrap.tex", "main.tex"].find((f) => pendingIn(f).length);
          if (fileWith) {
            await vscode.commands.executeCommand("stet.filter", { file: fileWith });
            await vscode.commands.executeCommand("stet.review.focus");
            const seen = new Set();
            for (let n = 0; n < 4; n++) {
              await vscode.commands.executeCommand("stet.next");
              await sleep(300);
              const e = vscode.window.activeTextEditor;
              if (e) seen.add(e.document.uri.path.split("/").pop());
            }
            await vscode.commands.executeCommand("stet.clearFilter");
            check("a filter keeps j to the changes it shows", seen.size === 1 && seen.has(fileWith), JSON.stringify({ fileWith, seen: [...seen] }));
          } else check("a filter keeps j to the changes it shows (skipped: nothing pending)", true);
        }
      },
    ],
    [
      "view options",
      async () => {
        // View options switch settings from the panel.
        const stetConf = () => vscode.workspace.getConfiguration("stet");
        const inlineBefore = stetConf().get("inlineChanges");
        await vscode.commands.executeCommand("stet.toggleInlineChanges");
        const flipped = stetConf().get("inlineChanges");
        await vscode.commands.executeCommand("stet.toggleInlineChanges");
        await vscode.commands.executeCommand("stet.longChanges.hover");
        const long = stetConf().get("longChanges");
        await vscode.commands.executeCommand("stet.longChanges.collapsed");
        check(
          "view options switch settings",
          flipped === !inlineBefore && stetConf().get("inlineChanges") === inlineBefore && long === "hover",
          JSON.stringify({ inline: inlineBefore, flipped, long }),
        );
      },
    ],
    [
      "grouped by file",
      async () => {
        // View options → Group changes by file: agent → file → changes; a file's Accept all accepts its changes.
        const { tree } = ext.exports;
        await vscode.commands.executeCommand("stet.groupBy.file");
        const rows = await until(
          "file rows",
          () => {
            const [agentRow] = tree.getChildren();
            const files = agentRow ? tree.getChildren(agentRow).filter((r) => r.node?.type === "file") : [];
            return files.length ? files : null;
          },
          10000,
        ).catch(() => []);
        check("grouped by file, an agent's rows are its files", rows.length > 0, JSON.stringify(rows.map((r) => r.node?.file)));
        const row = rows.find((r) => tree.getChildren(r).some((c) => c.node?.item?.status === "pending"));
        if (row) {
          const pending = tree
            .getChildren(row)
            .filter((c) => c.node?.item?.status === "pending")
            .map((c) => c.node.item.id);
          const t = await tree.getTreeItem(row);
          check("a file's row offers Accept all", t.contextValue === "file.live", t.contextValue);
          if (pending.length === 1) {
            await vscode.commands.executeCommand("stet.acceptGroup", row);
            const done = await until("accepted", () => statusOf(pending[0]) === "accepted", 15000).catch(() => false);
            check(`Accept all on ${row.node.file}'s row accepts its change`, done, pending.join(","));
          }
        } else check("a file still has a pending change to accept", false, JSON.stringify(rows.map((r) => r.node?.file)));
        await vscode.commands.executeCommand("stet.groupBy.round");
      },
    ],
    [
      "every command in package.json is registered",
      async () => {
        const allCommands = await vscode.commands.getCommands(true);
        const declared = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")).contributes.commands.map((c) => c.command);
        const missing = declared.filter((c) => !allCommands.includes(c));
        check("every command in package.json is registered", declared.length > 30 && !missing.length, JSON.stringify(missing));
      },
    ],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (e) {
      check(`${name}: ran to the end`, false, e?.stack);
    }
  }
  writeFileSync(out, JSON.stringify(results, null, 2));
};
