/** Stet for VS Code (spec §12.2): review panel, in-editor review, threads and setup without a command line. */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { doctor, Stet, type Agent, type AgentKind, type Group, type Item } from "@stet/core";
import { esc, itemMarkdown, DiffContent, EditorIntegration, Locator, type Host } from "./editor.js";
import { Threads } from "./comments.js";
import {
  AGENT_ID,
  groupDescription,
  groupLabel,
  isLive,
  itemLabel,
  oneLine,
  STATUS_TEXT,
  suggestAgentId,
  toLf,
  TreeModel,
  type Node,
} from "./model.js";
import { Project } from "./project.js";
import { cliCommand, installCli, isManaged, type RuntimeMode } from "./runtime.js";

type El = { project: Project; node?: Node };

const exists = (p: string) => stat(p).then(() => true, () => false);
const normPath = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/").toLowerCase() : p.replace(/\\/g, "/"));

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).toString().trim())) : resolve(stdout.toString().trim()),
    );
  });
}

class StetExtension implements Host, vscode.TreeDataProvider<El>, vscode.Disposable {
  private projects = new Map<string, Project>();
  private models = new Map<Project, TreeModel>();
  private showResolved = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly treeChanged = new vscode.EventEmitter<El | undefined>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private lines = new Map<string, number>();
  private readonly tree: vscode.TreeView<El>;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private readonly output = vscode.window.createOutputChannel("Stet");
  readonly locator: Locator;
  private disposables: vscode.Disposable[] = [];

  constructor(private ctx: vscode.ExtensionContext) {
    this.locator = new Locator(this);
    this.tree = vscode.window.createTreeView("stet.review", { treeDataProvider: this, showCollapseAll: true });
    this.status.command = "stet.review.focus";
    this.disposables.push(
      this.tree,
      this.status,
      this.output,
      this.tree.onDidChangeSelection((e) => {
        const el = e.selection[0];
        if (e.selection.length === 1 && el?.node?.type === "item" && isLive(el.node.item)) void this.showItem(el, true);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.discover()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("stet.runtime")) void this.applyRuntime();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) for (const p of this.projects.values()) p.scheduleRefresh(0);
      }),
      vscode.workspace.onDidCloseTextDocument((d) => this.locator.forget(d)),
    );
  }

  // -------------------------------------------------------------------------
  // Projects

  async discover(): Promise<void> {
    const found = new Map<string, Stet>();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      try {
        const loc = await Stet.locate(f.uri.fsPath);
        // Agent workspaces are for the agent; review happens in the project window.
        if (normPath(loc.toplevel) !== normPath(loc.mainPath)) continue;
        const stet = await Stet.open(f.uri.fsPath);
        found.set(normPath(stet.mainPath), stet);
      } catch {
        /* not a git repo, or Stet not set up */
      }
    }
    for (const [key, p] of this.projects) {
      if (!found.has(key)) {
        p.dispose();
        this.projects.delete(key);
      }
    }
    for (const [key, stet] of found) {
      if (this.projects.has(key)) continue;
      const p = new Project(stet);
      this.projects.set(key, p);
      p.onDidChange(() => this.onProjectChanged());
      p.startWatching();
      await this.ensureRuntime(p).catch((e) => this.output.appendLine(`Runtime setup for ${p.mainPath}: ${e?.message ?? e}`));
      await p.refresh().catch((e) => this.output.appendLine(`Loading ${p.mainPath}: ${e?.message ?? e}`));
    }
    await this.onProjectChanged();
  }

  /** Point agents' tools at the CLI bundled with this extension, unless another `stet` is configured and present. */
  private async ensureRuntime(p: Project): Promise<void> {
    const cfg = await p.stet.config();
    const present = cfg.cli && (await exists(cfg.cli.command)) && (await Promise.all(cfg.cli.args.slice(0, 1).map(exists))).every(Boolean);
    if (cfg.cli && present && !isManaged(cfg.cli, p.storeRoot)) return;
    const script = await installCli(this.ctx.asAbsolutePath("dist/stet.mjs"), p.storeRoot);
    const mode = vscode.workspace.getConfiguration("stet").get<RuntimeMode>("runtime", "auto");
    const cli = await cliCommand(mode, script);
    if (await p.stet.setCli(cli)) {
      const runner = cli.env?.ELECTRON_RUN_AS_NODE ? "VS Code's runtime" : "Node.js";
      this.output.appendLine(`Agent workspaces of ${p.name} now run ${script} with ${runner} (${cli.command}).`);
      vscode.window.setStatusBarMessage(`$(check) Stet: agents of ${p.name} now use ${runner}`, 5000);
    }
  }

  private async onProjectChanged(): Promise<void> {
    this.models.clear();
    this.lines.clear();
    const all = [...this.projects.values()];
    const snaps = all.map((p) => p.snapshot);
    const pending = snaps.reduce((n, s) => n + s.items.filter(isLive).length, 0);
    const uncommitted = snaps.reduce((n, s) => n + s.uncommitted.length, 0);
    const sync = snaps.flatMap((s) => [...s.syncNeeded]);
    await vscode.commands.executeCommand("setContext", "stet.active", all.length > 0);
    await vscode.commands.executeCommand("setContext", "stet.hasAgents", snaps.some((s) => s.agents.some((a) => a.state === "active")));
    await vscode.commands.executeCommand("setContext", "stet.uncommitted", uncommitted > 0);
    await vscode.commands.executeCommand("setContext", "stet.showingResolved", this.showResolved);
    this.tree.badge = pending ? { value: pending, tooltip: `${pending} proposed change${pending === 1 ? "" : "s"} to review` } : undefined;
    if (all.length) {
      this.status.text = `$(checklist) ${pending}` + (uncommitted ? ` $(git-commit) ${uncommitted}` : "") + (sync.length ? " $(sync)" : "");
      const tip = [`Stet: ${pending} change${pending === 1 ? "" : "s"} to review`];
      if (uncommitted) tip.push(`${uncommitted} accepted, not committed yet (Finish review)`);
      if (sync.length) tip.push(`Behind your latest text: ${sync.join(", ")}. Agents catch up when they next call stet_sync.`);
      this.status.tooltip = tip.join("\n");
      this.status.show();
    } else this.status.hide();
    this.treeChanged.fire(undefined);
    this.changed.fire();
  }

  projectFor(uri: vscode.Uri): Project | undefined {
    return [...this.projects.values()].find((p) => p.relPath(uri) !== null);
  }

  model(p: Project): TreeModel {
    let m = this.models.get(p);
    if (!m) this.models.set(p, (m = new TreeModel(p.snapshot, this.showResolved)));
    return m;
  }

  allProjects(): Project[] {
    return [...this.projects.values()];
  }

  setShowResolved(v: boolean): void {
    this.showResolved = v;
    void this.onProjectChanged();
  }

  // -------------------------------------------------------------------------
  // Tree

  getChildren(el?: El): El[] {
    const ps = this.allProjects();
    if (!el) {
      if (ps.length === 1) return this.model(ps[0]!).children().map((node) => ({ project: ps[0]!, node }));
      return ps.map((project) => ({ project }));
    }
    return this.model(el.project).children(el.node).map((node) => ({ project: el.project, node }));
  }

  async getTreeItem(el: El): Promise<vscode.TreeItem> {
    const E = vscode.TreeItemCollapsibleState.Expanded;
    if (!el.node) {
      const t = new vscode.TreeItem(el.project.name, E);
      t.iconPath = new vscode.ThemeIcon("repo");
      t.tooltip = el.project.mainPath;
      return t;
    }
    const n = el.node;
    const model = this.model(el.project);
    const snap = el.project.snapshot;
    switch (n.type) {
      case "agent": {
        const t = new vscode.TreeItem(n.agent.id, E);
        const pending = model.liveCount((i) => i.agent === n.agent.id);
        const parts = [`${pending} pending`];
        if (snap.syncNeeded.has(n.agent.id)) parts.push("behind your text");
        if (n.agent.state === "archived") parts.push("archived");
        t.description = parts.join(" · ");
        t.iconPath = new vscode.ThemeIcon(n.agent.kind === "codex" ? "terminal" : "hubot");
        t.tooltip = new vscode.MarkdownString(
          `**${esc(n.agent.id)}** (${n.agent.kind})\n\nWorkspace: ${esc(n.agent.worktree)}` +
            (snap.syncNeeded.has(n.agent.id) ? "\n\nThe agent works on an older version of your text; it catches up when it calls `stet_sync`." : ""),
        );
        t.contextValue = n.agent.state === "active" ? "agent" : "agent.archived";
        return t;
      }
      case "changeset": {
        const cs = n.changeset;
        const t = new vscode.TreeItem(cs.title, E);
        const live = model.liveCount((i) => i.changeset === cs.id);
        t.description = `${cs.id} · ${live} pending`;
        t.iconPath = new vscode.ThemeIcon("layers");
        t.tooltip = new vscode.MarkdownString(`**${cs.id}** ${esc(cs.title)}\n\n${esc(cs.rationale)}\n\n*${new Date(cs.submittedAt).toLocaleString()}*`);
        t.contextValue = live ? "changeset.live" : "changeset.done";
        return t;
      }
      case "group": {
        const g = n.group;
        const members = model.members(g);
        const t = new vscode.TreeItem(groupLabel(g), E);
        t.description = groupDescription(g, members.length);
        t.iconPath =
          g.state === "broken"
            ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"))
            : new vscode.ThemeIcon(g.kind === "linked" ? "link" : "symbol-namespace");
        t.tooltip = new vscode.MarkdownString(
          `**${g.id}** ${g.kind}${g.source === "auto" ? " (detected by Stet)" : ""}: ${esc(g.title)}` +
            (g.rationale ? `\n\n${esc(g.rationale)}` : "") +
            (g.kind === "linked" ? "\n\nAccept or reject these together: accepting only some can break the document." : "") +
            (g.state === "broken" ? "\n\n⚠ Some members were resolved differently; the agent was asked to repair the document." : ""),
        );
        t.contextValue = members.some(isLive) ? `group.live.${g.kind}` : `group.done.${g.kind}`;
        return t;
      }
      case "item": {
        const it = n.item;
        const t = new vscode.TreeItem(itemLabel(it), vscode.TreeItemCollapsibleState.None);
        const line = await this.lineOf(el.project, it);
        t.description = `${it.file}${it.kind === "modify" ? `:${line}` : ""}${it.status === "pending" ? "" : ` · ${STATUS_TEXT[it.status]}`}`;
        t.iconPath = itemIcon(it);
        const md = new vscode.MarkdownString(itemMarkdown(it, model));
        t.tooltip = md;
        t.contextValue = isLive(it) ? `item.live.${it.kind}` : `item.done.${it.kind}`;
        t.command = { command: "stet.showItem", title: "Go to change", arguments: [el, true] };
        t.id = `${el.project.mainPath}|${n.parent}|${it.id}`;
        return t;
      }
    }
  }

  private async lineOf(p: Project, it: Item): Promise<number> {
    const key = `${p.mainPath}|${it.id}`;
    const hit = this.lines.get(key);
    if (hit !== undefined) return hit;
    const doc = vscode.workspace.textDocuments.find((d) => p.relPath(d.uri) === it.file);
    let line: number | undefined;
    if (doc) {
      const l = (await this.locator.locate(doc)).find((x) => x.item.id === it.id);
      if (l) line = l.range.start.line + 1;
    }
    line ??= (await p.stet.locateInWorkingCopy(it).catch(() => ({ line: 1 }))).line;
    this.lines.set(key, line);
    return line;
  }

  // -------------------------------------------------------------------------
  // Targets for commands (tree element, item id from CodeLens/hover, or tree selection / cursor)

  private findItem(id: string): { project: Project; item: Item } | undefined {
    const ed = vscode.window.activeTextEditor;
    const ps = this.allProjects();
    const first = ed ? this.projectFor(ed.document.uri) : undefined;
    for (const p of first ? [first, ...ps.filter((x) => x !== first)] : ps) {
      const item = this.model(p).item(id);
      if (item) return { project: p, item };
    }
    return undefined;
  }

  private async target(arg: unknown): Promise<El | undefined> {
    if (typeof arg === "string") {
      if (/^G\d+$/i.test(arg)) {
        for (const p of this.allProjects()) {
          const group = this.model(p).group(arg);
          if (group) return { project: p, node: { type: "group", group } };
        }
        return undefined;
      }
      const f = this.findItem(arg);
      return f && { project: f.project, node: { type: "item", item: f.item, parent: "" } };
    }
    if (arg && typeof arg === "object" && "project" in arg) return arg as El;
    const sel = this.tree.selection[0];
    if (sel && this.tree.visible) return sel;
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      const p = this.projectFor(ed.document.uri);
      const pos = ed.selection.active;
      const hit = (await this.locator.locate(ed.document)).find((l) => l.range.contains(pos) || l.range.start.line === pos.line);
      if (p && hit) return { project: p, node: { type: "item", item: hit.item, parent: "" } };
    }
    return undefined;
  }

  private async targetItem(arg: unknown): Promise<{ project: Project; item: Item } | undefined> {
    const t = await this.target(arg);
    if (t?.node?.type === "item") return { project: t.project, item: t.node.item };
    void vscode.window.showInformationMessage("Select a proposed change in the Stet panel, or put the cursor on one.");
    return undefined;
  }

  /** Save open, modified documents for `files` before Stet writes to disk. */
  private async saveFiles(p: Project, files: string[]): Promise<void> {
    for (const d of vscode.workspace.textDocuments) {
      const rel = p.relPath(d.uri);
      if (rel && files.includes(rel) && d.isDirty) await d.save();
    }
  }

  private async run<T>(p: Project | undefined, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (e: any) {
      void vscode.window.showErrorMessage(e?.message ?? String(e));
      return undefined;
    } finally {
      await p?.refresh().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Review commands

  async accept(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const rest = this.model(p).linkedRest([item.id]);
    let ids = [item.id];
    let overrideLinked = false;
    if (rest.length) {
      const all = `Accept all ${rest.length + 1} linked changes`;
      const only = `Accept only ${item.id}`;
      const pick = await vscode.window.showQuickPick(
        [
          { label: all, detail: `${[item, ...rest].map((i) => i.id).join(", ")} belong together (e.g. a label and its references).` },
          { label: only, detail: "Breaks the linked group; the agent is asked to repair the document." },
        ],
        { title: `${item.id} is linked with ${rest.map((r) => r.id).join(", ")}` },
      );
      if (!pick) return;
      if (pick.label === all) ids = [item.id, ...rest.map((r) => r.id)];
      else overrideLinked = true;
    }
    await this.doAccept(p, ids, { overrideLinked });
  }

  private async doAccept(p: Project, ids: string[], opts: { overrideLinked?: boolean; edited?: Record<string, string> } = {}): Promise<void> {
    const files = ids.flatMap((id) => {
      const it = this.model(p).item(id);
      return it ? [it.file, ...(it.oldFile ? [it.oldFile] : [])] : [];
    });
    await this.run(p, async () => {
      await this.saveFiles(p, files);
      const r = await p.stet.accept(ids, opts);
      const msg = [`Accepted ${r.accepted.map((i) => i.id).join(", ")}${r.committed ? ` (committed ${r.committed.slice(0, 7)})` : ""}.`];
      if (r.stale.length) msg.push(`Now stale (overlapped): ${r.stale.map((i) => i.id).join(", ")}.`);
      msg.push(...r.warnings);
      if (r.warnings.length) void vscode.window.showWarningMessage(msg.join(" "));
      else vscode.window.setStatusBarMessage(`$(check) ${msg.join(" ")}`, 4000);
    });
  }

  async acceptAll(arg: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t?.node) return;
    const p = t.project;
    const model = this.model(p);
    let ids: string[];
    let what: string;
    if (t.node.type === "group") {
      ids = model.members(t.node.group).filter(isLive).map((i) => i.id);
      what = `${t.node.group.id} “${t.node.group.title}”`;
    } else if (t.node.type === "changeset") {
      const cs = t.node.changeset;
      ids = p.snapshot.items.filter((i) => i.changeset === cs.id && isLive(i)).map((i) => i.id);
      ids = [...ids, ...model.linkedRest(ids).map((i) => i.id)];
      what = `${cs.id} “${cs.title}”`;
      const ok = await vscode.window.showWarningMessage(`Accept all ${ids.length} changes of ${what}?`, { modal: true }, "Accept all");
      if (ok !== "Accept all") return;
    } else if (t.node.type === "item") {
      const g = model.linkedGroup(t.node.item) ?? t.node.item.groups.map((x) => model.group(x)).find((x): x is Group => !!x && x.kind !== "atomic");
      if (!g) return void vscode.window.showInformationMessage(`${t.node.item.id} is not part of a group.`);
      return this.acceptAll({ project: p, node: { type: "group", group: g } } satisfies El);
    } else return;
    if (!ids.length) return void vscode.window.showInformationMessage(`Nothing pending in ${what}.`);
    await this.doAccept(p, ids);
  }

  private async reason(prompt: string): Promise<string | undefined> {
    return vscode.window.showInputBox({ title: prompt, prompt: "Optional, but it helps the agent: why? (Enter to skip)", placeHolder: "e.g. keep the original formula" });
  }

  async reject(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const rest = this.model(p).linkedRest([item.id]);
    let mode: "all" | "revise-rest" | "only" | undefined;
    if (rest.length) {
      const picks = [
        { label: `Reject all ${rest.length + 1} linked changes`, mode: "all" as const },
        { label: `Reject ${item.id}, ask the agent to revise the rest`, mode: "revise-rest" as const },
        { label: `Reject only ${item.id}`, mode: "only" as const, detail: "Breaks the linked group; the agent is asked to repair the document." },
      ];
      const pick = await vscode.window.showQuickPick(picks, { title: `${item.id} is linked with ${rest.map((r) => r.id).join(", ")}` });
      if (!pick) return;
      mode = pick.mode;
    }
    const reason = await this.reason(`Reject ${item.id}`);
    if (reason === undefined) return;
    await this.run(p, async () => {
      const r = await p.stet.reject([item.id], { ...(reason ? { reason } : {}), ...(mode ? { mode } : {}) });
      vscode.window.setStatusBarMessage(`$(close) Rejected ${r.map((i) => i.id).join(", ")}`, 4000);
    });
  }

  async rejectAll(arg: unknown): Promise<void> {
    const t = await this.target(arg);
    if (!t?.node) return;
    const p = t.project;
    const model = this.model(p);
    let ids: string[];
    let what: string;
    if (t.node.type === "group") {
      ids = model.members(t.node.group).filter(isLive).map((i) => i.id);
      what = t.node.group.id;
    } else if (t.node.type === "changeset") {
      const cs = t.node.changeset;
      ids = p.snapshot.items.filter((i) => i.changeset === cs.id && isLive(i)).map((i) => i.id);
      what = cs.id;
    } else if (t.node.type === "item") {
      const g = model.linkedGroup(t.node.item) ?? t.node.item.groups.map((x) => model.group(x)).find((x): x is Group => !!x && x.kind !== "atomic");
      if (!g) return void vscode.window.showInformationMessage(`${t.node.item.id} is not part of a group.`);
      return this.rejectAll({ project: p, node: { type: "group", group: g } } satisfies El);
    } else return;
    if (!ids.length) return;
    const reason = await this.reason(`Reject all ${ids.length} changes of ${what}`);
    if (reason === undefined) return;
    await this.run(p, async () => {
      const r = await p.stet.reject(ids, { ...(reason ? { reason } : {}), mode: "all" });
      vscode.window.setStatusBarMessage(`$(close) Rejected ${r.map((i) => i.id).join(", ")}`, 4000);
    });
  }

  async edit(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    if (item.kind !== "modify") return void vscode.window.showInformationMessage(`${item.id} changes a whole file; it can only be accepted or rejected.`);
    let text: string | undefined;
    if (!item.newText.includes("\n") && item.newText.length <= 400) {
      text = await vscode.window.showInputBox({
        title: `Edit ${item.id} before accepting`,
        prompt: item.oldText ? `Replaces: ${oneLine(item.oldText, 120)}` : "Inserted text",
        value: item.newText,
        valueSelection: [item.newText.length, item.newText.length],
      });
    } else {
      const doc = await vscode.workspace.openTextDocument({ content: item.newText, language: "latex" });
      await vscode.window.showTextDocument(doc, { preview: false });
      const ok = await vscode.window.showInformationMessage(`Edit the text of ${item.id} in this tab, then choose “Accept edited”.`, "Accept edited", "Cancel");
      text = ok === "Accept edited" ? doc.getText() : undefined;
      if (vscode.window.activeTextEditor?.document === doc) await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    }
    if (text === undefined) return;
    const rest = this.model(p).linkedRest([item.id]);
    await this.doAccept(p, [item.id, ...rest.map((r) => r.id)], { edited: { [item.id]: toLf(text) } });
  }

  async comment(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const text = await vscode.window.showInputBox({ title: `Comment on ${t.item.id}`, prompt: "The agent sees this with its feedback and can reply.", placeHolder: "Message to the agent…" });
    if (!text) return;
    await this.run(t.project, () => t.project.stet.comment(t.item.id, text, "user"));
  }

  async revise(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const text = await vscode.window.showInputBox({ title: `Request a revision of ${t.item.id}`, prompt: "What should the agent change?", placeHolder: "e.g. shorter, and keep the term “ansatz”" });
    if (!text) return;
    await this.run(t.project, () => t.project.stet.requestRevision(t.item.id, text));
  }

  async ungroup(arg: unknown): Promise<void> {
    const t = await this.target(arg);
    if (t?.node?.type !== "group") return;
    const g = t.node.group;
    await this.run(t.project, () => t.project.stet.ungroup(g.id));
  }

  async replyThread(reply: vscode.CommentReply, threads: Threads): Promise<void> {
    const hit = await threads.itemForThread(reply.thread);
    if (!hit) {
      void vscode.window.showWarningMessage("Comments go on proposed changes: start the thread on a line with a pending change.");
      if (!threads.isOwn(reply.thread)) reply.thread.dispose();
      return;
    }
    if (!threads.isOwn(reply.thread)) reply.thread.dispose();
    await this.run(hit.project, () => hit.project.stet.comment(hit.item.id, reply.text, "user"));
  }

  // -------------------------------------------------------------------------
  // Navigation

  async showItem(arg: unknown, preserveFocus = false): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    if (item.kind !== "modify") return this.showDiff({ project: p, node: { type: "item", item, parent: "" } } satisfies El);
    const uri = p.fileUri(item.file);
    if (!(await exists(uri.fsPath))) return void vscode.window.showWarningMessage(`${item.file} does not exist in your project.`);
    const doc = await vscode.workspace.openTextDocument(uri);
    const hit = (await this.locator.locate(doc)).find((l) => l.item.id === item.id);
    const range = hit?.range ?? new vscode.Range((await this.lineOf(p, item)) - 1, 0, (await this.lineOf(p, item)) - 1, 0);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus, preview: true });
    ed.selection = new vscode.Selection(range.start, range.end);
    ed.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    if (!hit && isLive(item)) vscode.window.setStatusBarMessage(`$(warning) ${item.id}: its text is no longer where it was; showing the last known line.`, 5000);
  }

  async showDiff(arg: unknown): Promise<void> {
    const t = await this.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const key = encodeURIComponent(p.mainPath);
    const mk = (side: string) => vscode.Uri.from({ scheme: "stet-diff", path: `/${item.file}`, query: `p=${key}&id=${item.id}&side=${side}` });
    await vscode.commands.executeCommand("vscode.diff", mk("before"), mk("after"), `${item.id} ${item.file} (current ↔ proposed)`, { preview: true });
  }

  /** Content of `stet-diff:` documents. */
  async diffSide(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    const p = this.projects.get(normPath(decodeURIComponent(q.get("p") ?? "")));
    const item = p && this.model(p).item(q.get("id") ?? "");
    if (!p || !item) return "";
    const after = q.get("side") === "after";
    if (item.kind === "binary") return `(binary file ${item.file})`;
    if (item.kind !== "modify") return after ? item.newText : item.oldText;
    const uri2 = p.fileUri(item.file);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri2.toString()) ?? (await vscode.workspace.openTextDocument(uri2));
    const text = toLf(doc.getText());
    if (!after) return text;
    const span = await p.stet.locateInText(item, text);
    if (!span) return text + "\n% Stet: this change could not be located in the current text.\n";
    return text.slice(0, span.start) + item.newText + text.slice(span.end);
  }

  // -------------------------------------------------------------------------
  // Project and agent commands

  private async pickProject(): Promise<Project | undefined> {
    const ps = this.allProjects();
    if (ps.length <= 1) return ps[0];
    const pick = await vscode.window.showQuickPick(ps.map((p) => ({ label: p.name, description: p.mainPath, p })), { title: "Which project?" });
    return pick?.p;
  }

  async setup(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) return void vscode.window.showInformationMessage("Open the folder of your LaTeX project first.");
    const folder =
      folders.length === 1
        ? folders[0]!
        : (await vscode.window.showQuickPick(folders.map((f) => ({ label: f.name, description: f.uri.fsPath, f })), { title: "Set up Stet for which folder?" }))?.f;
    if (!folder) return;
    const dir = folder.uri.fsPath;
    try {
      if ((await git(dir, ["rev-parse", "--is-inside-work-tree"]).catch(() => "")) !== "true") {
        const ok = await vscode.window.showWarningMessage(
          `${folder.name} is not a git repository.`,
          { modal: true, detail: "Stet uses git to keep the agents' proposals apart from your files. Create a repository here and commit the current files as a starting point?" },
          "Create repository",
        );
        if (ok !== "Create repository") return;
        await git(dir, ["init"]);
      }
      if (!(await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => ""))) {
        const ok = await vscode.window.showWarningMessage(
          "The repository has no commits yet.",
          { modal: true, detail: "Stet reviews changes against your last commit. Commit the current files now?" },
          "Commit files",
        );
        if (ok !== "Commit files") return;
        await git(dir, ["add", "-A"]);
        await git(dir, ["commit", "-m", "Initial commit"]);
      }
      const loc = await Stet.locate(dir);
      const storeRoot = join(loc.commonDir, "stet");
      let keepCli = false;
      try {
        const cfg = await (await Stet.open(dir)).config();
        keepCli = !!cfg.cli && !isManaged(cfg.cli, storeRoot) && (await exists(cfg.cli.command));
      } catch {
        /* first setup */
      }
      const opts: Parameters<typeof Stet.init>[1] = {};
      if (!keepCli) {
        const script = await installCli(this.ctx.asAbsolutePath("dist/stet.mjs"), storeRoot);
        opts.cli = await cliCommand(vscode.workspace.getConfiguration("stet").get<RuntimeMode>("runtime", "auto"), script);
      }
      const stet = await Stet.init(dir, opts);
      await this.discover();
      const cfg = await stet.config();
      const next = await vscode.window.showInformationMessage(
        `Stet is set up for ${folder.name} (main branch '${cfg.mainBranch}'). Next, create a workspace for an AI agent.`,
        "New agent workspace",
      );
      if (next) await this.newAgent();
    } catch (e: any) {
      void vscode.window.showErrorMessage(`Stet setup failed: ${e?.message ?? e}`);
    }
  }

  async newAgent(): Promise<void> {
    const p = await this.pickProject();
    if (!p) return void vscode.window.showInformationMessage("Set up Stet for this project first.", "Set up project").then((c) => c && this.setup());
    const kinds: { label: string; detail: string; agentKind: AgentKind }[] = [
      { label: "Claude", detail: "Claude desktop app (Code tab) or Claude Code", agentKind: "claude-code" },
      { label: "Codex", detail: "Codex CLI, app or IDE extension", agentKind: "codex" },
      { label: "Other", detail: "Any agent that can edit files and run commands", agentKind: "other" },
    ];
    const k = await vscode.window.showQuickPick(kinds, { title: "Which AI agent will work in this workspace?" });
    if (!k) return;
    const existing = p.snapshot.agents.map((a) => a.id);
    const id = await vscode.window.showInputBox({
      title: "Name of the agent workspace",
      value: suggestAgentId(k.agentKind, existing),
      validateInput: (v) =>
        !AGENT_ID.test(v) ? "Use letters, digits, '.', '_' or '-'." : existing.includes(v) ? `'${v}' already exists.` : undefined,
    });
    if (!id) return;
    const agent = await this.run(p, async () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating workspace ${id}…` }, () => p.stet.newAgent(id, { kind: k.agentKind })),
    );
    if (agent) await this.agentActions(agent, true);
  }

  private async agentActions(agent: Agent, created = false): Promise<void> {
    const app = agent.kind === "codex" ? "Codex" : agent.kind === "claude-code" ? "the Claude desktop app (Code tab) or Claude Code" : "your agent";
    const actions = [
      { label: "$(copy) Copy folder path", id: "copy", detail: `Then open the folder in ${app}.` },
      { label: "$(folder-opened) Reveal in file manager", id: "reveal" },
      { label: "$(window) Open in new VS Code window", id: "window", detail: "For agents that run inside VS Code (e.g. the Codex or Claude Code extension)." },
    ];
    const pick = await vscode.window.showQuickPick(actions, {
      title: created ? `Workspace ${agent.id} is ready: ${agent.worktree}` : `Workspace ${agent.id}: ${agent.worktree}`,
      placeHolder: `Open this folder in ${app}; the agent's instructions and tools are already set up there.`,
    });
    if (!pick) return;
    const uri = vscode.Uri.file(agent.worktree);
    if (pick.id === "copy") {
      await vscode.env.clipboard.writeText(agent.worktree.replace(/\//g, process.platform === "win32" ? "\\" : "/"));
      vscode.window.setStatusBarMessage(`$(copy) Copied ${agent.worktree}`, 4000);
    } else if (pick.id === "reveal") await vscode.commands.executeCommand("revealFileInOS", uri);
    else await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
  }

  private async pickAgent(arg: unknown): Promise<{ project: Project; agent: Agent } | undefined> {
    if (arg && typeof arg === "object" && "node" in arg && (arg as El).node?.type === "agent") {
      const el = arg as El & { node: { type: "agent"; agent: Agent } };
      return { project: el.project, agent: el.node.agent };
    }
    const all = this.allProjects().flatMap((project) => project.snapshot.agents.filter((a) => a.state === "active").map((agent) => ({ project, agent })));
    if (!all.length) return void vscode.window.showInformationMessage("No agent workspaces yet.", "New agent workspace").then((c) => c && this.newAgent());
    const pick = await vscode.window.showQuickPick(
      all.map((x) => ({ label: x.agent.id, description: x.agent.kind, detail: x.agent.worktree, x })),
      { title: "Agent workspace" },
    );
    return pick?.x;
  }

  async openAgent(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (a) await this.agentActions(a.agent);
  }

  async copyAgentPath(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (a) await vscode.env.clipboard.writeText(a.agent.worktree.replace(/\//g, process.platform === "win32" ? "\\" : "/"));
  }

  async archiveAgent(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    const pending = a.project.snapshot.items.filter((i) => i.agent === a.agent.id && isLive(i)).length;
    const del = "Archive and delete folder";
    const keep = "Archive, keep folder";
    const ok = await vscode.window.showWarningMessage(
      `Archive agent ${a.agent.id}?`,
      {
        modal: true,
        detail:
          (pending ? `Its ${pending} pending change${pending === 1 ? " is" : "s are"} withdrawn. ` : "") +
          `Deleting the folder also deletes the branch ${a.agent.branch} and anything the agent did not submit. Close the agent's session first.`,
      },
      del,
      keep,
    );
    if (!ok) return;
    await this.run(a.project, () => a.project.stet.archiveAgent(a.agent.id, { removeWorktree: ok === del }));
  }

  async finishReview(): Promise<void> {
    const p = await this.pickProject();
    if (!p) return;
    const items = p.snapshot.uncommitted;
    if (!items.length) return void vscode.window.showInformationMessage("Nothing to commit: all accepted changes are committed.");
    const files = [...new Set(items.map((i) => i.file))];
    const ok = await vscode.window.showWarningMessage(
      `Commit ${items.length} accepted change${items.length === 1 ? "" : "s"}?`,
      {
        modal: true,
        detail: `Files: ${files.join(", ")}.\nThese files are committed as they are now, including your own edits in them.`,
      },
      "Commit",
    );
    if (ok !== "Commit") return;
    await this.run(p, async () => {
      await this.saveFiles(p, files);
      const r = await p.stet.commitAcceptedItems();
      vscode.window.setStatusBarMessage(r.commit ? `$(git-commit) Committed ${r.items.map((i) => i.id).join(", ")}` : "Nothing to commit", 5000);
    });
  }

  async doctor(): Promise<void> {
    const folder = this.allProjects()[0]?.mainPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) return;
    const checks = await doctor(folder);
    const icon = { ok: "✓", warn: "!", error: "✗", info: "·" };
    this.output.clear();
    this.output.appendLine(`Stet doctor — ${folder}\n`);
    for (const c of checks) this.output.appendLine(`${icon[c.status]} ${c.name}: ${c.message}${c.fix ? `\n    fix: ${c.fix}` : ""}`);
    this.output.show(true);
  }

  async refresh(): Promise<void> {
    await this.discover();
    await this.applyRuntime();
    await Promise.all(this.allProjects().map((p) => p.refresh()));
  }

  /** Re-check how agents run `stet` (after a Refresh or a change of `stet.runtime`). */
  async applyRuntime(): Promise<void> {
    for (const p of this.allProjects()) {
      await this.ensureRuntime(p).catch((e) => void vscode.window.showErrorMessage(`Stet: ${e?.message ?? e}`));
    }
  }

  dispose(): void {
    for (const p of this.projects.values()) p.dispose();
    for (const d of this.disposables) d.dispose();
    this.changed.dispose();
    this.treeChanged.dispose();
  }
}

function itemIcon(it: Item): vscode.ThemeIcon {
  const c = (id: string) => new vscode.ThemeColor(id);
  switch (it.status) {
    case "pending":
      return new vscode.ThemeIcon(it.kind === "modify" ? "diff-modified" : it.kind === "add-file" ? "diff-added" : it.kind === "delete-file" ? "diff-removed" : "diff-renamed");
    case "needs_revision":
      return new vscode.ThemeIcon("sync", c("problemsWarningIcon.foreground"));
    case "accepted":
      return new vscode.ThemeIcon("check", c("testing.iconPassed"));
    case "rejected":
      return new vscode.ThemeIcon("close", c("testing.iconFailed"));
    case "stale":
      return new vscode.ThemeIcon("warning", c("problemsWarningIcon.foreground"));
    default:
      return new vscode.ThemeIcon("circle-slash");
  }
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const ext = new StetExtension(ctx);
  const editor = new EditorIntegration(ext, ext.locator);
  const threads = new Threads(ext, ext.locator, () => ext.allProjects());
  const reg = (id: string, fn: (...a: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  ctx.subscriptions.push(ext, editor, threads, vscode.workspace.registerTextDocumentContentProvider("stet-diff", new DiffContent((u) => ext.diffSide(u))));
  reg("stet.setup", () => ext.setup());
  reg("stet.newAgent", () => ext.newAgent());
  reg("stet.openAgent", (a) => ext.openAgent(a));
  reg("stet.copyAgentPath", (a) => ext.copyAgentPath(a));
  reg("stet.archiveAgent", (a) => ext.archiveAgent(a));
  reg("stet.refresh", () => ext.refresh());
  reg("stet.doctor", () => ext.doctor());
  reg("stet.finishReview", () => ext.finishReview());
  reg("stet.showResolved", () => ext.setShowResolved(true));
  reg("stet.hideResolved", () => ext.setShowResolved(false));
  reg("stet.accept", (a) => ext.accept(a));
  reg("stet.reject", (a) => ext.reject(a));
  reg("stet.edit", (a) => ext.edit(a));
  reg("stet.comment", (a) => ext.comment(a));
  reg("stet.revise", (a) => ext.revise(a));
  reg("stet.acceptGroup", (a) => ext.acceptAll(a));
  reg("stet.rejectGroup", (a) => ext.rejectAll(a));
  reg("stet.ungroup", (a) => ext.ungroup(a));
  reg("stet.showItem", (a, keepFocus) => ext.showItem(a, keepFocus === true));
  reg("stet.showDiff", (a) => ext.showDiff(a));
  reg("stet.replyThread", (r: vscode.CommentReply) => ext.replyThread(r, threads));
  await ext.discover();
}

export function deactivate(): void {}
