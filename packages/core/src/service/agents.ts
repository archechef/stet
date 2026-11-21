/** Agent workspaces (§7.1): create, refresh, archive, find and notify agents, and their status. */
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { AgentFiles } from "../agentfiles.js";
import { notFound, StetError } from "../errors.js";
import { Repo } from "../git.js";
import { pingInbox } from "../inbox.js";
import { archivedMessage, STET_MARKER } from "../instructions.js";
import { documentProfile } from "../lang/index.js";
import {
  type Agent,
  type AgentKind,
  FEEDBACK_TYPES,
  type ItemStatus,
  isLive,
  NOTIFY_MODES,
  NOTIFY_TRIGGERS,
  type NotifyMode,
  type NotifyTrigger,
  notifyMode,
  notifyTriggers,
} from "../model.js";
import { isInside, pathExists, samePath } from "../paths.js";
import { writeInside } from "../safefs.js";
import type { AgentStatus, Stet } from "../service.js";
import { changedToolConfigs, type WorkspaceResult, writeWorkspaceFiles } from "../workspace.js";
import { verifyAgentWorktree } from "../worktree.js";
import { now } from "./common.js";

export class Agents {
  constructor(private readonly stet: Stet) {}

  async listAgents(): Promise<Agent[]> {
    return this.stet.store.agents();
  }

  async newAgent(id: string, opts: { kind?: AgentKind; path?: string } = {}): Promise<Agent> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new StetError(`Invalid agent id '${id}' (use letters, digits, '.', '_', '-').`);
    return this.stet.store.withLock(async () => {
      const cfg = await this.stet.config();
      const branch = cfg.agentBranchPrefix + id;
      // An archived agent's name can be used again once its folder and branch are gone (the
      // manual's way to recreate a workspace). Its decided changes keep its name.
      const old = await this.stet.store.getAgent(id);
      if (old?.state === "active") throw new StetError(`Agent '${id}' already exists.`);
      if (old && ((await pathExists(old.worktree)) || (await this.stet.repo.revParse(`refs/heads/${old.branch}`))))
        throw new StetError(
          `Agent '${id}' is archived, but its folder or branch is still there. Delete them with \`stet agent archive ${id} --remove\`, or choose another name.`,
        );
      if (await this.stet.repo.revParse(`refs/heads/${branch}`)) throw new StetError(`Branch '${branch}' already exists.`);
      const base = await this.stet.baseOps.ensureBase();
      const root = resolve(this.stet.mainPath, cfg.worktreeRoot.replace("{repo}", basename(this.stet.mainPath)));
      const path = opts.path ? resolve(opts.path) : join(root, id);
      // Inside the project, the workspace would be both "the project" and "the workspace" to the guard.
      if (isInside(path, this.stet.mainPath))
        throw new StetError(`The agent workspace (${path}) must be outside your project folder; check worktreeRoot in .git/stet/config.json.`);
      await mkdir(dirname(path), { recursive: true });
      await this.stet.repo.run(["worktree", "add", "-b", branch, path, base]);
      const agent: Agent = {
        id,
        kind: opts.kind ?? "other",
        branch,
        worktree: path.replace(/\\/g, "/"),
        baseCommit: base,
        lastTip: base,
        replayedAt: now(),
        feedbackCursor: (await this.stet.store.state()).nextEvent - 1,
        createdAt: now(),
        state: "active",
      };
      await this.stet.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      return agent;
    });
  }

  /** (Re)write the agent's instructions, MCP config and guardrail files. */
  async refreshWorkspace(agentOrId: Agent | string): Promise<WorkspaceResult | null> {
    const agent = typeof agentOrId === "string" ? await this.requireAgent(agentOrId) : agentOrId;
    const cfg = await this.stet.config();
    if (!cfg.cli) return null;
    const gitDir = await this.checkWorktree(agent.worktree);
    const r = await writeWorkspaceFiles({
      agent,
      mainPath: this.stet.mainPath,
      commonDir: this.stet.commonDir,
      gitDir,
      cli: cfg.cli,
      profile: documentProfile(cfg),
    });
    // What was written, kept where the agent can't write: the MCP server checks it at each start.
    agent.toolConfigs = r.toolConfigs;
    await this.stet.store.withLock(async () => {
      const stored = await this.stet.store.getAgent(agent.id);
      if (stored) await this.stet.store.putAgent({ ...stored, toolConfigs: r.toolConfigs });
    });
    return r;
  }

  /**
   * Tool settings in the agent's workspace that differ from what Stet last wrote (see
   * `changedToolConfigs`). Workspaces written before Stet kept a record have nothing to compare.
   */
  async changedToolConfigs(agent: Agent): Promise<string[]> {
    if (!agent.toolConfigs) return [];
    await this.checkWorktree(agent.worktree);
    return changedToolConfigs(agent.worktree, agent.toolConfigs);
  }

  /**
   * Rewrite every active agent's workspace files (after an update brings new instructions).
   * One agent's failure (e.g. its folder was deleted) doesn't stop the others.
   */
  async refreshWorkspaces(): Promise<{ agent: string; result?: WorkspaceResult | null; error?: string }[]> {
    return this.stet.store.withLock(async () => {
      const out: { agent: string; result?: WorkspaceResult | null; error?: string }[] = [];
      for (const a of await this.stet.store.agents()) {
        if (a.state !== "active") continue;
        try {
          out.push({ agent: a.id, result: await this.refreshWorkspace(a) });
        } catch (e) {
          out.push({ agent: a.id, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return out;
    });
  }

  /** The agent whose worktree contains `cwd`; adopts matching worktrees made by other tools. */
  async agentForCwd(cwd: string): Promise<Agent> {
    // A known workspace's git link is checked before git runs there: a link to a repository the
    // agent made would make git read that repository's config.
    const registered = (await this.stet.store.agents()).find((a) => a.state !== "archived" && isInside(cwd, a.worktree));
    if (registered) await this.checkWorktree(registered.worktree);
    const wt = new Repo(cwd, this.stet.untrustedConfig);
    const top = await wt.tryRun(["rev-parse", "--show-toplevel"]);
    const branch = await wt.tryRun(["symbolic-ref", "--short", "HEAD"]);
    const cfg = await this.stet.config();
    if (!top || !branch?.startsWith(cfg.agentBranchPrefix)) {
      throw new StetError(
        `This folder is not a Stet agent workspace (branch '${branch ?? "?"}'). ` +
          `Create one with \`stet agent new <name>\` in the project and work inside the folder it prints.`,
      );
    }
    const id = branch.slice(cfg.agentBranchPrefix.length);
    const existing = await this.stet.store.getAgent(id);
    if (existing?.state === "archived") throw new StetError(archivedMessage(existing));
    await this.checkWorktree(top);
    if (existing) return existing;
    return this.stet.store.withLock(async () => {
      const base = await this.stet.baseOps.ensureBase();
      const mb = (await this.stet.repo.tryRun(["merge-base", branch, base])) ?? base;
      const agent: Agent = {
        id,
        kind: "other",
        branch,
        worktree: top,
        baseCommit: mb,
        lastTip: mb,
        replayedAt: now(),
        feedbackCursor: (await this.stet.store.state()).nextEvent - 1,
        createdAt: now(),
        state: "active",
      };
      await this.stet.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      return agent;
    });
  }

  /**
   * Retire an agent: withdraw its pending items and, optionally, delete its folder and branch.
   * The agent learns why on its next tool call (see `archivedMessage`); a kept folder gets the
   * same notice in place of its instructions.
   */
  async archiveAgent(
    id: string,
    opts: { removeWorktree?: boolean; discardUnsubmitted?: boolean } = {},
  ): Promise<{ agent: Agent; withdrawn: string[]; worktreeRemoved: boolean }> {
    return this.stet.store.withLock(async () => {
      const agent = await this.requireAgent(id);
      // Deleting the folder loses what the agent didn't submit: only when asked for.
      if (opts.removeWorktree && !opts.discardUnsubmitted && (await pathExists(agent.worktree))) {
        const unsubmitted = await this.unsubmittedFiles(agent).catch(() => [] as string[]);
        if (unsubmitted.length) {
          throw new StetError(
            `${id} has changes it did not submit (${unsubmitted.slice(0, 5).join(", ")}${unsubmitted.length > 5 ? `, and ${unsubmitted.length - 5} more` : ""}); ` +
              `deleting its folder would lose them. Archive it without deleting the folder, or delete them with it explicitly (--force).`,
          );
        }
      }
      const withdrawn: string[] = [];
      for (const it of (await this.stet.store.items()).filter((i) => i.agent === id && isLive(i.status))) {
        this.stet.setStatus(it, "withdrawn", "user", "agent archived");
        await this.stet.store.putItem(it);
        withdrawn.push(it.id);
      }
      // Its open notes are closed too: nobody will act on them any more.
      for (const n of (await this.stet.store.notes()).filter((n) => n.agent === id && n.state === "open")) {
        n.state = "resolved";
        await this.stet.store.putNote(n);
      }
      let worktreeRemoved = false;
      if (opts.removeWorktree) {
        await this.stet.repo.tryRun(["worktree", "remove", "--force", agent.worktree]);
        await this.stet.repo.tryRun(["branch", "-D", agent.branch]);
        worktreeRemoved = !(await pathExists(agent.worktree));
      }
      agent.state = "archived";
      agent.archived = { at: now(), withdrawn, worktreeRemoved };
      await this.stet.store.putAgent(agent);
      await this.stet.store.appendEvent({ type: "archived", agent: id, items: withdrawn, data: { worktreeRemoved } });
      if (!worktreeRemoved) {
        const notice = `${STET_MARKER}\n# This workspace is archived\n\n${archivedMessage(agent)}\n`;
        for (const f of ["CLAUDE.local.md", "AGENTS.override.md"]) await writeInside(agent.worktree, f, notice).catch(() => undefined);
      }
      await this.stet.groupOps.updateGroups((await this.stet.store.items()).filter((i) => withdrawn.includes(i.id)));
      return { agent, withdrawn, worktreeRemoved };
    });
  }

  /** The agent whose workspace is (or was) at `path`, found in the store even if the folder is gone. */
  async agentByWorktree(path: string): Promise<Agent | null> {
    return (await this.stet.store.agents()).find((a) => samePath(a.worktree, path)) ?? null;
  }

  /**
   * Git access to an agent's files that does not rely on the worktree's own git metadata
   * (spec §9; see `AgentFiles`).
   */
  agentFiles(agent: Agent): Promise<AgentFiles> {
    return AgentFiles.open(this.stet.repo, this.stet.commonDir, agent);
  }

  /** Paths an agent changed in its workspace but did not submit yet (Stet's own files excluded). */
  async unsubmittedFiles(agent: Agent): Promise<string[]> {
    return (await this.agentFiles(agent)).uncommitted();
  }

  private checkWorktree(path: string): Promise<string> {
    return verifyAgentWorktree(path, this.stet.commonDir);
  }

  async requireAgent(id: string): Promise<Agent> {
    const a = await this.stet.store.getAgent(id);
    if (!a) throw notFound(`Unknown agent '${id}'.`);
    return a;
  }

  /** Where an agent stands: what it has submitted, what waits for it, whether it should sync. Updates the review base first (`ensureBase`). */
  async agentStatus(agentId: string): Promise<AgentStatus> {
    return this.stet.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      return (await this.statusesOf([agent]))[0]!;
    });
  }

  /** Status of every active agent, computed from one read of the store (for UIs refreshing all agents). */
  async agentStatuses(): Promise<AgentStatus[]> {
    return this.stet.store.withLock(async () => this.statusesOf((await this.stet.store.agents()).filter((a) => a.state === "active")));
  }

  private async statusesOf(agents: Agent[]): Promise<AgentStatus[]> {
    if (!agents.length) return [];
    const base = await this.stet.baseOps.ensureBase();
    const cfg = await this.stet.config();
    const items = await this.stet.store.items();
    const notes = await this.stet.store.notes();
    const events = await this.stet.store.events(Math.min(...agents.map((a) => a.feedbackCursor)));
    // Same content under a different commit (e.g. the user committed accepted changes) needs no sync.
    const trees = new Map<string, Promise<string | null>>();
    const tree = (rev: string) => {
      if (!trees.has(rev)) trees.set(rev, this.stet.repo.tryRun(["rev-parse", `${rev}^{tree}`]));
      return trees.get(rev)!;
    };
    const missing = await this.stet.baseOps.missingNow();
    const out: AgentStatus[] = [];
    for (const agent of agents) {
      const counts: Partial<Record<ItemStatus, number>> = {};
      for (const it of items) if (it.agent === agent.id) counts[it.status] = (counts[it.status] ?? 0) + 1;
      const unread = events.filter((e) => e.seq > agent.feedbackCursor && e.agent === agent.id && FEEDBACK_TYPES.includes(e.type)).length;
      const syncNeeded = agent.baseCommit !== base && (await tree(agent.baseCommit)) !== (await tree(base));
      const notesWaiting = notes.filter((n) => n.agent === agent.id && n.state === "open" && !n.deliveredAt).length;
      const missingAccepted = missing.filter((m) => m.item.agent === agent.id).map((m) => m.item.id);
      out.push({ agent, mainBranch: cfg.mainBranch, base, syncNeeded, counts, unreadFeedback: unread, notesWaiting, missingAccepted });
    }
    return out;
  }

  /** Choose which kinds of news wake an agent (see `NotifyTrigger`). Returns false if unchanged. */
  async setNotifyOn(agentId: string, triggers: NotifyTrigger[]): Promise<boolean> {
    const bad = triggers.filter((t) => !NOTIFY_TRIGGERS.includes(t));
    if (bad.length) throw new StetError(`Unknown kind of news: ${bad.join(", ")} (use ${NOTIFY_TRIGGERS.join(", ")}).`);
    return this.stet.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      const next = NOTIFY_TRIGGERS.filter((t) => triggers.includes(t));
      if (next.join() === notifyTriggers(agent).join()) return false;
      if (next.length === NOTIFY_TRIGGERS.length) delete agent.notifyOn;
      else agent.notifyOn = next;
      await this.stet.store.putAgent(agent);
      return true;
    });
  }

  /** *Notify now*: wake an agent waiting with `stet watch`, whatever its notification settings. */
  async pingAgent(agentId: string, message?: string): Promise<void> {
    const agent = await this.requireAgent(agentId);
    if (agent.state !== "active") throw new StetError(`Agent ${agentId} is archived.`);
    if (!(await pathExists(agent.worktree))) throw new StetError(`The workspace of ${agentId} no longer exists.`);
    await pingInbox(agent.worktree, message);
  }

  /** Set how an agent hears about the reviewer's activity (see `NotifyMode`). Returns false if unchanged. */
  async setNotify(agentId: string, mode: NotifyMode): Promise<boolean> {
    if (!NOTIFY_MODES.includes(mode)) throw new StetError(`Unknown notification mode '${mode}' (use ${NOTIFY_MODES.join(", ")}).`);
    return this.stet.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      if (notifyMode(agent) === mode) return false;
      agent.notify = mode;
      await this.stet.store.putAgent(agent);
      return true;
    });
  }
}
