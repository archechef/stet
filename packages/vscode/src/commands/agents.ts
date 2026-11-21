/** Agent workspaces: create, open, notify, ping and archive them. */
import {
  type Agent,
  type AgentKind,
  isLiveItem,
  NOTIFY_TRIGGER_TEXT,
  NOTIFY_TRIGGERS,
  type NotifyMode,
  type NotifyTrigger,
  notifyMode,
  notifyTriggers,
} from "@stet/core";
import * as vscode from "vscode";
import { announce } from "../announce.js";
import { type El, NOTIFY_PICKS } from "../common.js";
import type { StetExtension } from "../extension.js";
import type { Project } from "../project.js";
import { AGENT_ID, archiveChoices, suggestAgentId } from "../questions.js";

/** Put a folder path on the clipboard, in the form the platform's apps expect (backslashes on Windows). */
const copyPath = (p: string) => vscode.env.clipboard.writeText(process.platform === "win32" ? p.replace(/\//g, "\\") : p);

export class AgentCommands {
  constructor(private readonly ext: StetExtension) {}

  async newAgent(): Promise<void> {
    const p = await this.ext.setupWizard.pickProject();
    if (!p && this.ext.agentOf) {
      const open = await vscode.window.showInformationMessage(
        "This window is an agent's workspace: create agents in the window of your project.",
        "Open the project",
      );
      return void (open && (await this.ext.openAgentProject()));
    }
    if (!p)
      return void vscode.window.showInformationMessage("Set up Stet for this project first.", "Set up project").then((c) => c && this.ext.setupWizard.setup());
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
      validateInput: (v) => (!AGENT_ID.test(v) ? "Use letters, digits, '.', '_' or '-'." : existing.includes(v) ? `'${v}' already exists.` : undefined),
    });
    if (!id) return;
    const agent = await this.ext.run(p, async () =>
      vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating workspace ${id}…` }, () =>
        p.stet.newAgent(id, { kind: k.agentKind }),
      ),
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
      await copyPath(agent.worktree);
      announce(`$(copy) Copied ${agent.worktree}`, 4000);
    } else if (pick.id === "reveal") await vscode.commands.executeCommand("revealFileInOS", uri);
    else await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
  }

  private async pickAgent(arg: unknown): Promise<{ project: Project; agent: Agent } | undefined> {
    if (arg && typeof arg === "object" && "node" in arg && (arg as El).node?.type === "agent") {
      const el = arg as El & { node: { type: "agent"; agent: Agent } };
      return { project: el.project, agent: el.node.agent };
    }
    const all = this.ext.allProjects().flatMap((project) => project.snapshot.agents.filter((a) => a.state === "active").map((agent) => ({ project, agent })));
    if (!all.length) return void vscode.window.showInformationMessage("No agent workspaces yet.", "New agent workspace").then((c) => c && this.newAgent());
    const pick = await vscode.window.showQuickPick(
      // With several projects, the same agent name can be in both: say whose.
      all.map((x) => ({
        label: x.agent.id,
        description: this.ext.allProjects().length > 1 ? `${x.project.name} · ${x.agent.kind}` : x.agent.kind,
        detail: x.agent.worktree,
        x,
      })),
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
    if (a) await copyPath(a.agent.worktree);
  }

  /**
   * When and about what an agent waiting with `stet watch` is woken, in one checklist: the timing
   * (one of two) and the kinds of news. Nothing ticked below means off.
   */
  async agentNotify(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    type Item = vscode.QuickPickItem & { timing?: NotifyMode; news?: NotifyTrigger };
    const mode = notifyMode(a.agent);
    const timings: Item[] = NOTIFY_PICKS.filter((x) => x.mode !== "off").map((x) => ({ label: x.label, detail: x.detail, timing: x.mode }));
    const kinds: Item[] = NOTIFY_TRIGGERS.map((t) => ({ label: NOTIFY_TRIGGER_TEXT[t], news: t }));
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Notifications for ${a.agent.id}`;
    qp.placeholder = "Untick every kind of news to turn notifications off. The megaphone above wakes the agent at once.";
    qp.canSelectMany = true;
    const notifyNow: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("megaphone"), tooltip: "Notify now…: wake the agent at once" };
    qp.buttons = [notifyNow];
    qp.onDidTriggerButton((b) => {
      if (b !== notifyNow) return;
      qp.hide();
      void this.agentPing({ project: a.project, node: { type: "agent", agent: a.agent } } as El);
    });
    qp.items = [
      { label: "When", kind: vscode.QuickPickItemKind.Separator },
      ...timings,
      { label: "Wake it for", kind: vscode.QuickPickItemKind.Separator },
      ...kinds,
    ];
    let timing = timings.find((t) => t.timing === (mode === "off" ? "batched" : mode))!;
    const on = new Set(mode === "off" ? [] : notifyTriggers(a.agent));
    qp.selectedItems = [timing, ...kinds.filter((k) => on.has(k.news!))];
    // The two timings exclude each other, and one of them is always ticked.
    qp.onDidChangeSelection((sel) => {
      const picked = sel.filter((s) => s.timing);
      const next = picked.find((s) => s !== timing) ?? picked[0] ?? timing;
      if (picked.length !== 1 || next !== timing) {
        timing = next;
        qp.selectedItems = [timing, ...sel.filter((s) => s.news)];
      }
    });
    const chosen = await new Promise<Item[] | undefined>((resolve) => {
      qp.onDidAccept(() => resolve([...qp.selectedItems]));
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
    qp.dispose();
    if (!chosen) return;
    const kindsOn = chosen.filter((c) => c.news).map((c) => c.news!);
    await this.ext.run(a.project, async () => {
      if (!kindsOn.length) return a.project.stet.setNotify(a.agent.id, "off");
      await a.project.stet.setNotifyOn(a.agent.id, kindsOn);
      return a.project.stet.setNotify(a.agent.id, timing.timing!);
    });
  }

  /** *Notify now*: wake a watching agent, whatever its settings, optionally with a message. */
  async agentPing(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    const message = await vscode.window.showInputBox({
      title: `Notify ${a.agent.id} now`,
      prompt: "Wakes the agent if it is waiting with stet watch. A message is optional.",
      placeHolder: "e.g. I've finished reviewing round 3",
    });
    if (message === undefined) return;
    const ok = await this.ext.run(a.project, async () => {
      await a.project.stet.pingAgent(a.agent.id, message);
      return true;
    });
    if (ok) announce(`$(megaphone) Asked ${a.agent.id} to check in`, 4000);
  }

  async archiveAgent(arg: unknown): Promise<void> {
    const a = await this.pickAgent(arg);
    if (!a) return;
    const pending = a.project.snapshot.items.filter((i) => i.agent === a.agent.id && isLiveItem(i)).length;
    const unsubmitted = await a.project.stet.unsubmittedFiles(a.agent).catch(() => [] as string[]);
    // Keeping the folder comes first, so Enter never deletes anything.
    const { del, order } = archiveChoices(unsubmitted.length);
    const ok = await vscode.window.showWarningMessage(
      `Archive agent ${a.agent.id}?`,
      {
        modal: true,
        detail:
          (pending
            ? `Its ${pending} pending change${pending === 1 ? " is" : "s are"} withdrawn: closed without being applied (History keeps ${pending === 1 ? "it" : "them"}). `
            : "") +
          (unsubmitted.length ? `It changed files it did not submit: ${unsubmitted.slice(0, 5).join(", ")}${unsubmitted.length > 5 ? ", …" : ""}. ` : "") +
          `Deleting the folder also deletes the branch ${a.agent.branch} and anything the agent did not submit, for good. Close the agent's session first.`,
      },
      ...order,
    );
    if (!ok) return;
    const r = await this.ext.run(a.project, () => a.project.stet.archiveAgent(a.agent.id, { removeWorktree: ok === del, discardUnsubmitted: ok === del }));
    if (r) {
      void vscode.window.showInformationMessage(
        `Archived ${a.agent.id}.` +
          (r.withdrawn.length
            ? ` Withdrew ${r.withdrawn.length} pending change${r.withdrawn.length === 1 ? "" : "s"} (${r.withdrawn.join(", ")}).`
            : " It had no pending changes.") +
          (r.worktreeRemoved ? " Its folder and branch are deleted." : ` Its folder is kept: ${a.agent.worktree}.`) +
          " If its session is still open, the agent is told on its next action; you can close that session.",
      );
    }
  }
}
