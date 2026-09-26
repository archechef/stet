/** Stet service layer (spec §7, §12.1). All frontends go through this class. */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { applyItems, locate, overlaps, type FileChange, type FileView, type TextFile } from "./apply.js";
import { anchor, captureContext, type Span } from "./anchor.js";
import { matchesAny, type StetConfig } from "./config.js";
import { gitRaw, Repo, STET_IDENTITY } from "./git.js";
import {
  autoGroups,
  joinTitles,
  normalizeGroups,
  parseWhere,
  unitMatches,
  type GroupDraft,
  type GroupHint,
  type HintUnit,
  type NoteHint,
} from "./grouping.js";
import {
  FEEDBACK_TYPES,
  isLive,
  type Agent,
  type AgentKind,
  type Changeset,
  type Group,
  type GroupKind,
  type Item,
  type ItemStatus,
  type StetEvent,
} from "./model.js";
import { isKeyEdit, splitText, type Edit, type FileClass } from "./split.js";
import { Store } from "./store.js";
import { installHooks } from "./hooks.js";
import { isWorkspaceFile, WORKSPACE_EXCLUDES, writeWorkspaceFiles, type CliCommand, type WorkspaceResult } from "./workspace.js";
import { detectEol, fromLf, isBinary, lineOf, lineRange, normalizeWs, sha256, toLf } from "./text.js";

export class StetError extends Error {}

export const BASE_REF = "refs/stet/base";
const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Result types

export interface SubmitResult {
  changeset: Changeset | null;
  items: Item[];
  groups: Group[];
  ungrouped: string[];
  superseded: string[];
  withdrawn: string[];
  repeats: string[];
  warnings: string[];
  sync: SyncResult | null;
}

export interface SyncResult {
  base: string;
  stale: Item[];
  kept: number;
}

export interface AcceptResult {
  accepted: Item[];
  stale: Item[];
  committed: string | null;
  warnings: string[];
}

export interface AgentStatus {
  agent: Agent;
  mainBranch: string;
  base: string;
  syncNeeded: boolean;
  counts: Partial<Record<ItemStatus, number>>;
  unreadFeedback: number;
}

export interface ItemFilter {
  agent?: string;
  status?: ItemStatus | ItemStatus[];
  changeset?: string;
  file?: string;
}

// ---------------------------------------------------------------------------

interface Candidate extends Edit {
  file: string;
  oldFile?: string;
  kind: Item["kind"];
  oldBlob?: string | null;
  newBlob?: string | null;
}

export class Stet {
  private constructor(
    /** Path of the main worktree (the user's working copy). */
    readonly mainPath: string,
    readonly repo: Repo,
    readonly store: Store,
  ) {}

  // -------------------------------------------------------------------------
  // Opening / init

  /** Locate the repository containing `cwd` (main worktree or any agent worktree). */
  static async locate(cwd: string): Promise<{ repo: Repo; mainPath: string; commonDir: string; toplevel: string }> {
    const probe = new Repo(cwd);
    const top = await probe.tryRun(["rev-parse", "--show-toplevel"]);
    if (!top) throw new StetError(`Not inside a git repository: ${cwd}`);
    let common = await probe.run(["rev-parse", "--git-common-dir"]);
    if (!isAbsolute(common)) common = resolve(cwd, common);
    const main = (await probe.worktrees())[0]?.path ?? top;
    return { repo: new Repo(main), mainPath: main, commonDir: common, toplevel: top };
  }

  static async open(cwd: string): Promise<Stet> {
    const { repo, mainPath, commonDir } = await Stet.locate(cwd);
    const store = new Store(join(commonDir, "stet"));
    if (!(await store.exists())) throw new StetError("Stet is not set up in this repository. Run `stet init` in the project folder.");
    return new Stet(mainPath, repo, store);
  }

  static async init(cwd: string, opts: { mainBranch?: string; cli?: CliCommand } = {}): Promise<Stet> {
    const { repo, mainPath, commonDir } = await Stet.locate(cwd);
    const branch = opts.mainBranch ?? (await repo.tryRun(["symbolic-ref", "--short", "HEAD"]));
    if (!branch) throw new StetError("Can't determine the main branch (detached HEAD?). Pass --main <branch>.");
    if (!(await repo.revParse(`refs/heads/${branch}`)))
      throw new StetError(`Branch '${branch}' has no commits yet. Commit your document first, then run \`stet init\`.`);
    const store = new Store(join(commonDir, "stet"));
    await store.init(branch);
    const stet = new Stet(mainPath, repo, store);
    await store.withLock(async () => {
      const cfg = await store.config();
      if (opts.cli) await store.saveConfig({ ...cfg, cli: opts.cli });
      if (cfg.guardHooks) await installHooks(repo, commonDir, cfg);
      await stet.ensureBase();
    });
    return stet;
  }

  config(): Promise<StetConfig> {
    return this.store.config();
  }

  /** The repository's shared git dir (where the store and hooks live). */
  get commonDir(): string {
    return dirname(this.store.root);
  }

  // -------------------------------------------------------------------------
  // Helpers

  private async mainHead(cfg: StetConfig): Promise<string> {
    const head = await this.repo.revParse(`refs/heads/${cfg.mainBranch}`);
    if (!head) throw new StetError(`Main branch '${cfg.mainBranch}' not found.`);
    return head;
  }

  private fileClass(cfg: StetConfig, path: string): FileClass {
    if (matchesAny(path, cfg.files.tex)) return "tex";
    if (matchesAny(path, cfg.files.bib)) return "bib";
    return "text";
  }

  /** Cached reads of blobs at commits. */
  private textCache = new Map<string, TextFile | null>();
  private async textAt(rev: string, path: string): Promise<TextFile | null> {
    const key = rev + ":" + path;
    if (!this.textCache.has(key)) this.textCache.set(key, await this.repo.readText(rev, path));
    return this.textCache.get(key)!;
  }

  private treeView(rev: string): FileView {
    return {
      read: (p) => this.textAt(rev, p),
      blobId: (p) => this.repo.blobId(rev, p),
    };
  }

  private workingView(): FileView {
    return {
      read: async (p) => {
        try {
          const raw = await readFile(join(this.mainPath, p), "utf8");
          return { text: toLf(raw), eol: detectEol(raw) };
        } catch {
          return null;
        }
      },
      blobId: async (p) => {
        try {
          await stat(join(this.mainPath, p));
        } catch {
          return null;
        }
        return this.repo.run(["hash-object", "--", p]);
      },
    };
  }

  private refText = async (item: Item) => (await this.textAt(item.baseCommit, item.oldFile ?? item.file))?.text;

  private async changesToCommitMap(changes: Map<string, FileChange>): Promise<Map<string, string | Buffer | null>> {
    const out = new Map<string, string | Buffer | null>();
    for (const [p, c] of changes) {
      if (c === null) out.set(p, null);
      else if ("blob" in c) out.set(p, await this.blobBytes(c.blob));
      else out.set(p, fromLf(c.text, c.eol));
    }
    return out;
  }

  private async blobBytes(blob: string): Promise<Buffer> {
    return (await gitRaw(["cat-file", "blob", blob], { cwd: this.mainPath })).stdout;
  }

  private async writeWorking(changes: Map<string, FileChange>): Promise<void> {
    for (const [p, c] of changes) {
      const abs = join(this.mainPath, p);
      if (c === null) await rm(abs, { force: true });
      else {
        await mkdir(dirname(abs), { recursive: true });
        if ("blob" in c) await writeFile(abs, await this.blobBytes(c.blob));
        else await writeFile(abs, fromLf(c.text, c.eol), "utf8");
      }
    }
  }

  private setStatus(item: Item, status: ItemStatus, by: "user" | "agent" | "stet", note?: string) {
    item.status = status;
    item.history.push({ at: now(), status, by, ...(note ? { note } : {}) });
  }

  private async itemLine(item: Item): Promise<number> {
    const t = await this.refText(item);
    return t ? lineOf(t, item.range.start) : 1;
  }

  /** Compact description of an item for event payloads. */
  private async describe(item: Item) {
    return {
      id: item.id,
      file: item.file,
      line: await this.itemLine(item),
      kind: item.kind,
      oldText: item.oldText.length > 400 ? item.oldText.slice(0, 400) + "…" : item.oldText,
      newText: item.newText.length > 400 ? item.newText.slice(0, 400) + "…" : item.newText,
    };
  }

  // -------------------------------------------------------------------------
  // Review base (§7.3)

  /** Make sure refs/stet/base = main HEAD + accepted-but-uncommitted items. Call under lock. */
  async ensureBase(): Promise<string> {
    const cfg = await this.config();
    const head = await this.mainHead(cfg);
    const pending = (await this.store.items()).filter((i) => i.status === "accepted" && i.resolution && !i.resolution.committed);
    const view = this.treeView(head);
    const stillOpen: Item[] = [];
    for (const it of pending) {
      const applied = it.resolution!.appliedText;
      if (it.kind !== "modify") {
        const exists = (await view.blobId(it.file)) !== null;
        const done = it.kind === "delete-file" ? !exists : exists;
        if (done) {
          it.resolution!.committed = head;
          await this.store.putItem(it);
        } else stillOpen.push(it);
        continue;
      }
      const f = await view.read(it.file);
      const ref = await this.refText(it);
      if (f && anchor(it, f.text, ref)) {
        stillOpen.push(it);
        continue;
      }
      // Either committed by the user, or overwritten; both mean "no longer ours to carry".
      const probe = { ...it, oldText: applied, range: { start: it.range.start, end: it.range.start + applied.length } };
      it.resolution!.committed = f && anchor(probe, f.text) ? head : `external:${head}`;
      await this.store.putItem(it);
    }
    const key = head + ":" + stillOpen.map((i) => i.id).join(",");
    const state = await this.store.state();
    const current = await this.repo.revParse(BASE_REF);
    if (state.base?.key === key && current === state.base.commit) return current;

    let commit = head;
    if (stillOpen.length) {
      const res = await applyItems(stillOpen, view, {
        refText: this.refText,
        overrides: new Map(stillOpen.map((i) => [i.id, i.resolution!.appliedText])),
      });
      commit = await this.repo.buildCommit({
        parents: [head],
        baseRev: head,
        changes: await this.changesToCommitMap(res.changes),
        message: `stet: review base (accepted, not yet committed: ${res.applied.map((a) => a.item.id).join(", ")})`,
      });
    }
    await this.repo.run(["update-ref", BASE_REF, commit]);
    const s = await this.store.state();
    s.base = { key, commit };
    await this.store.saveState(s);
    return commit;
  }

  // -------------------------------------------------------------------------
  // Agents (§7.1)

  async listAgents(): Promise<Agent[]> {
    return this.store.agents();
  }

  async newAgent(id: string, opts: { kind?: AgentKind; path?: string } = {}): Promise<Agent> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new StetError(`Invalid agent id '${id}' (use letters, digits, '.', '_', '-').`);
    return this.store.withLock(async () => {
      if (await this.store.getAgent(id)) throw new StetError(`Agent '${id}' already exists.`);
      const cfg = await this.config();
      const branch = cfg.agentBranchPrefix + id;
      if (await this.repo.revParse(`refs/heads/${branch}`)) throw new StetError(`Branch '${branch}' already exists.`);
      const base = await this.ensureBase();
      const root = resolve(this.mainPath, cfg.worktreeRoot.replace("{repo}", basename(this.mainPath)));
      const path = opts.path ? resolve(opts.path) : join(root, id);
      await mkdir(dirname(path), { recursive: true });
      await this.repo.run(["worktree", "add", "-b", branch, path, base]);
      const agent: Agent = {
        id,
        kind: opts.kind ?? "other",
        branch,
        worktree: path.replace(/\\/g, "/"),
        baseCommit: base,
        lastTip: base,
        replayedAt: now(),
        feedbackCursor: (await this.store.state()).nextEvent - 1,
        createdAt: now(),
        state: "active",
      };
      await this.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      return agent;
    });
  }

  /** (Re)write the agent's instructions, MCP config and guardrail files. */
  async refreshWorkspace(agentOrId: Agent | string): Promise<WorkspaceResult | null> {
    const agent = typeof agentOrId === "string" ? await this.requireAgent(agentOrId) : agentOrId;
    const cfg = await this.config();
    if (!cfg.cli) return null;
    return writeWorkspaceFiles({ agent, mainPath: this.mainPath, commonDir: this.commonDir, cli: cfg.cli });
  }

  /** The agent whose worktree contains `cwd`; adopts matching worktrees made by other tools. */
  async agentForCwd(cwd: string): Promise<Agent> {
    const wt = new Repo(cwd);
    const top = await wt.tryRun(["rev-parse", "--show-toplevel"]);
    const branch = await wt.tryRun(["symbolic-ref", "--short", "HEAD"]);
    const cfg = await this.config();
    if (!top || !branch || !branch.startsWith(cfg.agentBranchPrefix)) {
      throw new StetError(
        `This folder is not a Stet agent workspace (branch '${branch ?? "?"}'). ` +
          `Create one with \`stet agent new <name>\` in the project and work inside the folder it prints.`,
      );
    }
    const id = branch.slice(cfg.agentBranchPrefix.length);
    const existing = await this.store.getAgent(id);
    if (existing) return existing;
    return this.store.withLock(async () => {
      const base = await this.ensureBase();
      const mb = (await this.repo.tryRun(["merge-base", branch, base])) ?? base;
      const agent: Agent = {
        id,
        kind: "other",
        branch,
        worktree: top,
        baseCommit: mb,
        lastTip: mb,
        replayedAt: now(),
        feedbackCursor: (await this.store.state()).nextEvent - 1,
        createdAt: now(),
        state: "active",
      };
      await this.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      return agent;
    });
  }

  async archiveAgent(id: string, opts: { removeWorktree?: boolean } = {}): Promise<void> {
    await this.store.withLock(async () => {
      const agent = await this.requireAgent(id);
      for (const it of (await this.store.items()).filter((i) => i.agent === id && isLive(i.status))) {
        this.setStatus(it, "withdrawn", "user", "agent archived");
        await this.store.putItem(it);
      }
      agent.state = "archived";
      await this.store.putAgent(agent);
      if (opts.removeWorktree) {
        await this.repo.tryRun(["worktree", "remove", "--force", agent.worktree]);
        await this.repo.tryRun(["branch", "-D", agent.branch]);
      }
    });
  }

  /** Uncommitted paths in an agent workspace, ignoring Stet's own files. */
  private async dirtyFiles(wt: Repo): Promise<string[]> {
    return (await wt.status()).map((l) => l.slice(3)).filter((p) => p && !isWorkspaceFile(p));
  }

  private async requireAgent(id: string): Promise<Agent> {
    const a = await this.store.getAgent(id);
    if (!a) throw new StetError(`Unknown agent '${id}'.`);
    return a;
  }

  async agentStatus(agentId: string): Promise<AgentStatus> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      const base = await this.ensureBase();
      const counts: Partial<Record<ItemStatus, number>> = {};
      for (const it of (await this.store.items()).filter((i) => i.agent === agentId)) counts[it.status] = (counts[it.status] ?? 0) + 1;
      const unread = (await this.store.events(agent.feedbackCursor)).filter((e) => e.agent === agentId && FEEDBACK_TYPES.includes(e.type)).length;
      const cfg = await this.config();
      // Same content under a different commit (e.g. the user committed accepted changes) needs no sync.
      const tree = (rev: string) => this.repo.tryRun(["rev-parse", `${rev}^{tree}`]);
      const syncNeeded = agent.baseCommit !== base && (await tree(agent.baseCommit)) !== (await tree(base));
      return { agent, mainBranch: cfg.mainBranch, base, syncNeeded, counts, unreadFeedback: unread };
    });
  }

  // -------------------------------------------------------------------------
  // Submit (§7.2, §6.3, §6.4)

  private async candidatesFor(cfg: StetConfig, base: string, tip: string, touched: Set<string>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const changes = await this.repo.diffNames(base, tip);
    for (const ch of changes) {
      if (!touched.has(ch.path) && !(ch.oldPath && touched.has(ch.oldPath))) continue;
      // Stet's own workspace files are never proposals (unless the project tracks them).
      if (isWorkspaceFile(ch.path) && ch.status === "A") continue;
      const oldPath = ch.status === "R" ? ch.oldPath! : ch.path;
      const oldBuf = ch.status === "A" ? null : await this.repo.readBlob(base, oldPath);
      const newBuf = ch.status === "D" ? null : await this.repo.readBlob(tip, ch.path);
      const binary = (oldBuf && isBinary(oldBuf)) || (newBuf && isBinary(newBuf));
      const oldText = oldBuf ? toLf(oldBuf.toString("utf8")) : "";
      const newText = newBuf ? toLf(newBuf.toString("utf8")) : "";
      const whole = (kind: Item["kind"]): Candidate => ({
        file: ch.path,
        ...(ch.status === "R" ? { oldFile: oldPath } : {}),
        kind,
        start: 0,
        end: 0,
        newStart: 0,
        newEnd: newText.length,
        oldText: binary ? "" : oldText,
        newText: binary ? "" : newText,
      });
      if (binary) {
        out.push({
          ...whole("binary"),
          oldBlob: oldBuf ? await this.repo.blobId(base, oldPath) : null,
          newBlob: newBuf ? await this.repo.blobId(tip, ch.path) : null,
        });
      } else if (ch.status === "A") out.push(whole("add-file"));
      else if (ch.status === "D") out.push(whole("delete-file"));
      else if (ch.status === "R") out.push(whole("rename-file"));
      else {
        for (const e of splitText(this.fileClass(cfg, ch.path), oldText, newText, cfg.split)) {
          out.push({ ...e, file: ch.path, kind: "modify" });
        }
      }
    }
    return out;
  }

  private fingerprint(c: { file: string; kind: string; oldText: string; newText: string; newBlob?: string | null }) {
    return "sha256:" + sha256([c.file, c.kind, normalizeWs(c.oldText), normalizeWs(c.newText), c.newBlob ?? ""].join("\u0000"));
  }

  async submit(
    agentId: string,
    opts: { title: string; rationale?: string; groups?: GroupHint[]; notes?: NoteHint[] },
  ): Promise<SubmitResult> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const agent = await this.requireAgent(agentId);
      if (agent.state !== "active") throw new StetError(`Agent '${agentId}' is archived.`);
      const base = await this.ensureBase();
      const wt = new Repo(agent.worktree);
      const branch = await wt.tryRun(["symbolic-ref", "--short", "HEAD"]);
      if (branch !== agent.branch) throw new StetError(`The agent workspace is on '${branch}', expected '${agent.branch}'.`);

      if ((await this.dirtyFiles(wt)).length) {
        await wt.run(["add", "-A", "--", ".", ...WORKSPACE_EXCLUDES]);
        await wt.run([...STET_IDENTITY, "commit", "-q", "--no-verify", "-m", `${opts.title}\n\n${opts.rationale ?? ""}\n\nStet-Agent: ${agentId}`]);
      }
      const tip = (await wt.revParse("HEAD"))!;
      const result: SubmitResult = {
        changeset: null, items: [], groups: [], ungrouped: [], superseded: [], withdrawn: [], repeats: [], warnings: [], sync: null,
      };

      if (tip !== agent.lastTip) {
        await this.itemize(cfg, agent, tip, opts, result);
        agent.lastTip = tip;
        await this.store.putAgent(agent);
      } else result.warnings.push("Nothing new to submit.");

      if (agent.baseCommit !== base) result.sync = await this.sync(agentId);
      return result;
    });
  }

  private async itemize(
    cfg: StetConfig,
    agent: Agent,
    tip: string,
    opts: { title: string; rationale?: string; groups?: GroupHint[]; notes?: NoteHint[] },
    result: SubmitResult,
  ): Promise<void> {
    const base = agent.baseCommit;
    const touched = new Set<string>();
    for (const ch of await this.repo.diffNames(agent.lastTip, tip)) {
      touched.add(ch.path);
      if (ch.oldPath) touched.add(ch.oldPath);
    }
    let cands = await this.candidatesFor(cfg, base, tip, touched);
    const allItems = await this.store.items();
    // Items whose change is still in the agent's tree: live ones, plus ones resolved since the last replay.
    const resolvedAt = (i: Item) => i.history[i.history.length - 1]!.at;
    const existing = allItems.filter(
      (i) =>
        i.agent === agent.id &&
        i.baseCommit === base &&
        (isLive(i.status) || (["accepted", "rejected"].includes(i.status) && resolvedAt(i) >= (agent.replayedAt ?? ""))) &&
        (touched.has(i.file) || (i.oldFile !== undefined && touched.has(i.oldFile))),
    );

    // Re-merge candidates that fall inside an existing item's range (keeps atomic merges stable).
    for (const e of existing.filter((e) => e.kind === "modify" && e.status === "pending")) {
      const inside = cands.filter((c) => c.kind === "modify" && c.file === e.file && c.start >= e.range.start && c.end <= e.range.end);
      if (inside.length < 2 && !(inside.length === 1 && (inside[0]!.start !== e.range.start || inside[0]!.end !== e.range.end))) continue;
      const crossing = cands.some((c) => c.kind === "modify" && c.file === e.file && !inside.includes(c) && overlaps(c, e.range));
      if (crossing || !inside.length) continue;
      const first = inside[0]!;
      const last = inside[inside.length - 1]!;
      const newStart = first.newStart - (first.start - e.range.start);
      const newEnd = last.newEnd + (e.range.end - last.end);
      const tipText = (await this.textAt(tip, e.file))!.text;
      const baseText = (await this.textAt(base, e.file))!.text;
      const merged: Candidate = {
        file: e.file, kind: "modify", start: e.range.start, end: e.range.end, newStart, newEnd,
        oldText: baseText.slice(e.range.start, e.range.end), newText: tipText.slice(newStart, newEnd),
      };
      cands = [...cands.filter((c) => !inside.includes(c)), merged];
    }

    const sameAs = (c: Candidate, e: Item) =>
      c.file === e.file && c.kind === e.kind && (c.oldFile ?? null) === (e.oldFile ?? null) &&
      c.start === e.range.start && c.end === e.range.end && c.newText === e.newText && (c.newBlob ?? null) === (e.newBlob ?? null);

    const matched = new Map<Candidate, Item>();
    for (const c of cands) {
      const e = existing.find((e) => sameAs(c, e) && ![...matched.values()].includes(e));
      if (e) matched.set(c, e);
    }
    const fresh = cands.filter((c) => !matched.has(c));

    // Atomic hints merge fresh candidates before items exist.
    const hints = opts.groups ?? [];
    const tipRange = async (w: string) => {
      const where = parseWhere(w);
      if (where.from === undefined) return { file: where.file, range: null };
      const t = await this.textAt(tip, where.file);
      if (!t) return { file: where.file, range: { start: -1, end: -1 } };
      return { file: where.file, range: lineRange(t.text, where.from, where.to!) };
    };
    const unit = (c: Candidate, key: string): HintUnit => ({
      key, file: c.file, ...(c.oldFile ? { oldFile: c.oldFile } : {}), wholeFile: c.kind !== "modify", newStart: c.newStart, newEnd: c.newEnd,
    });
    const hintMatches = async (where: string[], pool: Candidate[]) => {
      const out = new Set<Candidate>();
      for (const w of where) {
        const { file, range } = await tipRange(w);
        const hits = pool.filter((c) => unitMatches(unit(c, ""), file, range));
        if (!hits.length) result.warnings.push(`'${w}' matched no change.`);
        hits.forEach((h) => out.add(h));
      }
      return [...out];
    };
    const effectiveHints: GroupHint[] = [];
    for (const h of hints) {
      if (h.kind !== "atomic") {
        effectiveHints.push(h);
        continue;
      }
      const matchedC = (await hintMatches(h.where, fresh)).filter((c) => c.kind === "modify");
      const keyEdits = matchedC.filter((c) => isKeyEdit(c.oldText, c.newText));
      const members = matchedC.filter((c) => !keyEdits.includes(c));
      if (keyEdits.length)
        result.warnings.push(`Atomic group '${h.title}': kept ${keyEdits.map((k) => JSON.stringify(k.newText.trim())).join(", ")} separate (renames are items of their own; link them instead).`);
      if (members.length < 2) continue;
      const files = new Set(members.map((m) => m.file));
      members.sort((a, b) => a.start - b.start);
      const first = members[0]!;
      const last = members[members.length - 1]!;
      const baseText = files.size === 1 ? (await this.textAt(base, first.file))!.text : "";
      const between = baseText.slice(first.end, last.start);
      const others = fresh.filter((c) => !members.includes(c) && c.file === first.file && c.start < last.end && c.end > first.start);
      if (others.some((o) => keyEdits.includes(o))) {
        result.warnings.push(`Atomic group '${h.title}' would swallow a rename; treated as related.`);
        effectiveHints.push({ ...h, kind: "related" });
        continue;
      }
      if (files.size !== 1 || /\n[ \t]*\n/.test(between) || others.length) {
        result.warnings.push(`Atomic group '${h.title}' spans more than one paragraph or file; treated as linked.`);
        effectiveHints.push({ ...h, kind: "linked" });
        continue;
      }
      const tipText = (await this.textAt(tip, first.file))!.text;
      const merged: Candidate = {
        file: first.file, kind: "modify", start: first.start, end: last.end, newStart: first.newStart, newEnd: last.newEnd,
        oldText: baseText.slice(first.start, last.end), newText: tipText.slice(first.newStart, last.newEnd),
      };
      fresh.splice(0, fresh.length, ...fresh.filter((c) => !members.includes(c)), merged);
      (merged as any).note = h.rationale ? `${h.title}: ${h.rationale}` : h.title;
    }

    // Existing items that disappeared: superseded (if replaced) or withdrawn.
    const stillThere = new Set(matched.values());
    const replacedBy = new Map<Item, Candidate>();
    for (const e of existing) {
      if (stillThere.has(e) || !isLive(e.status)) continue;
      const repl = fresh.find((c) => c.file === e.file && (e.kind !== "modify" || overlaps(c, e.range)));
      if (repl) replacedBy.set(e, repl);
      else {
        this.setStatus(e, "withdrawn", "agent", "change removed from the agent workspace");
        await this.store.putItem(e);
        result.withdrawn.push(e.id);
      }
    }

    if (!fresh.length && !result.withdrawn.length) {
      result.warnings.push("Nothing new to submit.");
      return;
    }

    // Create items.
    const rejected = new Map(allItems.filter((i) => i.status === "rejected").map((i) => [i.fingerprint, i]));
    const [csId] = await this.store.allocate("changeset");
    const ids = await this.store.allocate("item", fresh.length);
    const baseTextOf = async (c: Candidate) => (await this.textAt(base, c.oldFile ?? c.file))?.text ?? "";
    const created: Item[] = [];
    const candOf = new Map<Item, Candidate>();
    for (let k = 0; k < fresh.length; k++) {
      const c = fresh[k]!;
      const bt = await baseTextOf(c);
      const item: Item = {
        id: ids[k]!,
        agent: agent.id,
        changeset: csId!,
        file: c.file,
        ...(c.oldFile ? { oldFile: c.oldFile } : {}),
        kind: c.kind,
        baseCommit: base,
        range: { start: c.start, end: c.end },
        oldText: c.oldText,
        newText: c.newText,
        ...(c.kind === "binary" ? { oldBlob: c.oldBlob ?? null, newBlob: c.newBlob ?? null } : {}),
        context: c.kind === "modify" ? captureContext(bt, c.start, c.end) : { before: "", after: "" },
        fingerprint: this.fingerprint(c),
        note: (c as any).note ?? null,
        groups: [],
        status: "pending",
        resolution: null,
        supersedes: null,
        conflictsWith: [],
        history: [{ at: now(), status: "pending", by: "agent" }],
        thread: [],
      };
      const prev = rejected.get(item.fingerprint);
      if (prev) {
        this.setStatus(item, "rejected", "stet", `repeat of ${prev.id}`);
        result.repeats.push(item.id);
      }
      created.push(item);
      candOf.set(item, c);
    }
    const inherited: { from: Item; to: Item }[] = [];
    for (const [e, c] of replacedBy) {
      const item = created[fresh.indexOf(c)]!;
      item.supersedes ??= e.id;
      inherited.push({ from: e, to: item });
      this.setStatus(e, "superseded", "agent", `superseded by ${item.id}`);
      await this.store.putItem(e);
      result.superseded.push(e.id);
    }

    // Conflicts with other agents' live items (same base only; others are checked at accept time).
    for (const other of allItems.filter((i) => i.agent !== agent.id && isLive(i.status) && i.baseCommit === base && i.kind === "modify")) {
      for (const it of created.filter((c) => c.file === other.file && c.kind === "modify" && isLive(c.status))) {
        if (overlaps(it.range, other.range)) {
          it.conflictsWith.push(other.id);
          other.conflictsWith.push(it.id);
          await this.store.putItem(other);
        }
      }
    }

    // Notes.
    for (const n of opts.notes ?? []) {
      const pool = [...created.map((i) => candOf.get(i)!), ...[...matched.keys()]];
      const hits = await hintMatches(Array.isArray(n.where) ? n.where : [n.where], pool);
      for (const h of hits) {
        const it = created.find((i) => candOf.get(i) === h) ?? matched.get(h);
        if (!it) continue;
        it.note = it.note ? `${it.note}\n${n.note}` : n.note;
        if (!created.includes(it)) await this.store.putItem(it);
      }
    }

    // Groups: explicit hints + auto detection.
    const live = created.filter((i) => isLive(i.status));
    const drafts: GroupDraft[] = [];
    const idOfCand = (c: Candidate) => created.find((i) => candOf.get(i) === c)?.id ?? matched.get(c)?.id;
    for (const h of effectiveHints) {
      const pool = [...live.map((i) => candOf.get(i)!), ...[...matched.entries()].filter(([, e]) => isLive(e.status)).map(([c]) => c)];
      const members = (await hintMatches(h.where, pool)).map(idOfCand).filter((x): x is string => !!x);
      if (members.length) drafts.push({ kind: h.kind, title: h.title, rationale: h.rationale ?? null, source: "agent", items: members });
    }
    // Auto-detection also sees the agent's earlier pending items (a \label here, its \ref from before).
    const newIds = new Set(created.map((i) => i.id));
    const earlier = (await this.store.items()).filter((i) => i.agent === agent.id && isLive(i.status) && !newIds.has(i.id) && !result.superseded.includes(i.id));
    drafts.push(...autoGroups([...earlier, ...live], cfg.grouping).filter((d) => d.items.some((i) => newIds.has(i))));
    const finalDrafts = normalizeGroups(drafts);
    const gids = await this.store.allocate("group", finalDrafts.length);
    const byId = new Map<string, Item>([...created, ...matched.values(), ...earlier].map((i) => [i.id, i]));
    // A replacement takes over the groups of the item it supersedes.
    for (const { from, to } of inherited) {
      for (const gid of from.groups) {
        const g = await this.store.getGroup(gid);
        if (!g || g.state === "resolved") continue;
        g.items = g.items.map((i) => (i === from.id ? to.id : i)).filter((x, k, arr) => arr.indexOf(x) === k);
        await this.store.putGroup(g);
        if (!to.groups.includes(gid)) to.groups.push(gid);
      }
    }
    const groups: Group[] = finalDrafts.map((d, k) => ({
      id: gids[k]!, agent: agent.id, changeset: csId!, kind: d.kind, title: d.title, rationale: d.rationale,
      source: d.source, items: d.items, state: "open",
    }));
    // Linked groups from earlier submissions that now share members get merged into the new one.
    const priorGroups = (await this.store.groups()).filter((g) => g.agent === agent.id && g.kind === "linked" && g.state === "open");
    for (const g of groups.filter((g) => g.kind === "linked")) {
      for (const pg of priorGroups.filter((pg) => pg.items.some((i) => g.items.includes(i)))) {
        for (const i of pg.items) if (!g.items.includes(i)) g.items.push(i);
        g.title = joinTitles(pg.title, g.title);
        for (const i of pg.items) {
          const it = byId.get(i) ?? (await this.store.getItem(i));
          if (it) {
            it.groups = it.groups.filter((x) => x !== pg.id);
            byId.set(it.id, it);
          }
        }
        await this.store.deleteGroup(pg.id);
      }
    }
    for (const g of groups) {
      for (const i of g.items) {
        const it = byId.get(i) ?? (await this.store.getItem(i));
        if (it && !it.groups.includes(g.id)) {
          it.groups.push(g.id);
          byId.set(it.id, it);
        }
      }
      await this.store.putGroup(g);
    }
    for (const it of byId.values()) if (!created.includes(it)) await this.store.putItem(it);

    const changeset: Changeset = {
      id: csId!, agent: agent.id, title: opts.title, rationale: opts.rationale ?? "", submittedAt: now(),
      items: created.map((i) => i.id), groups: groups.map((g) => g.id),
    };
    for (const it of created) await this.store.putItem(it);
    await this.store.putChangeset(changeset);
    await this.store.appendEvent({ type: "items_submitted", agent: agent.id, items: created.map((i) => i.id), data: { changeset: csId } });
    for (const id of result.repeats) {
      const it = byId.get(id)!;
      await this.store.appendEvent({
        type: "repeat_rejected", agent: agent.id, items: [id],
        data: { item: await this.describe(it), previous: it.history[it.history.length - 1]!.note },
      });
    }

    result.changeset = changeset;
    result.items = created;
    result.groups = groups;
    result.ungrouped = created.filter((i) => !i.groups.length && isLive(i.status)).map((i) => i.id);
  }

  // -------------------------------------------------------------------------
  // Sync / replay (§7.6)

  async sync(agentId: string): Promise<SyncResult> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      const wt = new Repo(agent.worktree);
      const dirty = await this.dirtyFiles(wt);
      if (dirty.length) {
        throw new StetError(
          `The agent workspace has uncommitted changes (${dirty.join(", ")}). ` +
            `Submit them (stet submit) or discard them before syncing.`,
        );
      }
      const tip = await wt.revParse("HEAD");
      if (tip !== agent.lastTip) throw new StetError("The agent workspace has unsubmitted commits. Submit them before syncing.");
      const base = await this.ensureBase();
      const live = (await this.store.items()).filter((i) => i.agent === agentId && isLive(i.status));
      const res = await applyItems(live, this.treeView(base), { refText: this.refText });
      const stale: Item[] = [];
      const baseTexts = new Map<string, string>();
      for (const { item, reason } of res.failed) {
        await this.markStale(item, reason, base);
        stale.push(item);
      }
      for (const { item, span } of res.applied) {
        if (item.kind === "modify") {
          if (!baseTexts.has(item.file)) baseTexts.set(item.file, (await this.textAt(base, item.file))!.text);
          const bt = baseTexts.get(item.file)!;
          item.range = { ...span };
          item.context = captureContext(bt, span.start, span.end);
        }
        item.baseCommit = base;
        await this.store.putItem(item);
      }
      const commit = res.changes.size
        ? await this.repo.buildCommit({
            parents: [base],
            baseRev: base,
            changes: await this.changesToCommitMap(res.changes),
            message: `stet: pending proposals of ${agentId}\n\nStet-Agent: ${agentId}`,
          })
        : base;
      await wt.run(["reset", "-q", "--hard", commit]);
      agent.baseCommit = base;
      agent.lastTip = commit;
      agent.replayedAt = now();
      await this.store.putAgent(agent);
      await this.refreshWorkspace(agent);
      await this.store.appendEvent({ type: "synced", agent: agentId, data: { base, stale: stale.map((s) => s.id) } });
      await this.updateGroups(stale);
      return { base, stale, kept: res.applied.length };
    });
  }

  private async markStale(item: Item, reason: string, againstRev?: string) {
    this.setStatus(item, "stale", "stet", reason);
    await this.store.putItem(item);
    let current: string | undefined;
    if (againstRev && item.kind === "modify") {
      const t = (await this.textAt(againstRev, item.file))?.text;
      if (t) {
        const at = Math.min(item.range.start, t.length);
        current = t.slice(Math.max(0, at - 200), at + 200 + item.oldText.length);
      }
    }
    await this.store.appendEvent({
      type: "stale", agent: item.agent, items: [item.id],
      data: { item: await this.describe(item), reason, ...(current !== undefined ? { currentText: current } : {}) },
    });
  }

  /** Recompute group states after status changes; emits group_broken once per group. */
  private async updateGroups(changed: Item[]) {
    const gids = new Set(changed.flatMap((i) => i.groups));
    for (const gid of gids) {
      const g = await this.store.getGroup(gid);
      if (!g) continue;
      // Superseded members have been replaced by newer versions; they no longer count.
      const members = (await Promise.all(g.items.map((i) => this.store.getItem(i)))).filter(
        (x): x is Item => !!x && x.status !== "superseded",
      );
      if (!members.length) continue;
      const statuses = members.map((m) => m.status);
      let state: Group["state"] = statuses.every((s) => !isLive(s)) ? "resolved" : "open";
      if (g.kind === "linked") {
        const accepted = statuses.filter((s) => s === "accepted").length;
        const dead = statuses.filter((s) => ["rejected", "stale", "withdrawn"].includes(s)).length;
        if ((accepted && accepted < members.length) || (dead && statuses.some((s) => isLive(s)))) state = "broken";
      }
      if (state === "broken" && g.state !== "broken") {
        await this.store.appendEvent({
          type: "group_broken", agent: g.agent, group: g.id, items: g.items,
          data: { title: g.title, members: members.map((m) => ({ id: m.id, status: m.status, file: m.file })) },
        });
      }
      if (state !== g.state) {
        g.state = state;
        await this.store.putGroup(g);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Review operations (§7.3, §7.4)

  async listItems(filter: ItemFilter = {}): Promise<Item[]> {
    const st = filter.status === undefined ? null : Array.isArray(filter.status) ? filter.status : [filter.status];
    return (await this.store.items()).filter(
      (i) =>
        (!filter.agent || i.agent === filter.agent) &&
        (!st || st.includes(i.status)) &&
        (!filter.changeset || i.changeset === filter.changeset) &&
        (!filter.file || i.file === filter.file || i.oldFile === filter.file),
    );
  }
  getItem = (id: string) => this.store.getItem(id);
  listGroups = () => this.store.groups();
  listChangesets = () => this.store.changesets();

  /** Current 1-based line of an item in the working copy (or its base line if it can't be located). */
  async locateInWorkingCopy(item: Item): Promise<{ line: number; span: Span | null }> {
    if (item.kind !== "modify") return { line: 1, span: null };
    const f = await this.workingView().read(item.file);
    const span = f ? anchor(item, f.text, await this.refText(item)) : null;
    return { line: span && f ? lineOf(f.text, span.start) : await this.itemLine(item), span };
  }

  private async requireItems(ids: string[]): Promise<Item[]> {
    const out: Item[] = [];
    for (const id of ids) {
      const it = await this.store.getItem(id.toUpperCase());
      if (!it) throw new StetError(`Unknown item '${id}'.`);
      out.push(it);
    }
    return out;
  }

  private async linkedMembers(items: Item[]): Promise<Item[]> {
    const out = new Map<string, Item>();
    for (const it of items) {
      for (const gid of it.groups) {
        const g = await this.store.getGroup(gid);
        if (g?.kind !== "linked") continue;
        for (const m of g.items) {
          const mi = await this.store.getItem(m);
          if (mi && isLive(mi.status)) out.set(mi.id, mi);
        }
      }
    }
    return [...out.values()];
  }

  async acceptGroup(groupId: string, opts: { commit?: boolean } = {}): Promise<AcceptResult> {
    const g = await this.store.getGroup(groupId.toUpperCase());
    if (!g) throw new StetError(`Unknown group '${groupId}'.`);
    const ids = [];
    for (const id of g.items) {
      const it = await this.store.getItem(id);
      if (it && isLive(it.status)) ids.push(id);
    }
    if (!ids.length) throw new StetError(`Group ${g.id} has no pending items.`);
    return this.accept(ids, opts);
  }

  async accept(
    ids: string[],
    opts: { edited?: Record<string, string>; overrideLinked?: boolean; commit?: boolean } = {},
  ): Promise<AcceptResult> {
    return this.store.withLock(async () => {
      const cfg = await this.config();
      const items = await this.requireItems(ids);
      for (const it of items) if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
      const onBranch = await this.repo.tryRun(["symbolic-ref", "--short", "HEAD"]);
      if (onBranch !== cfg.mainBranch)
        throw new StetError(`Your project folder is on '${onBranch ?? "a detached HEAD"}', not '${cfg.mainBranch}'. Switch back before accepting.`);

      const warnings: string[] = [];
      const missing = (await this.linkedMembers(items)).filter((m) => !items.some((i) => i.id === m.id));
      if (missing.length) {
        if (!opts.overrideLinked) {
          throw new StetError(
            `${items.map((i) => i.id).join(", ")} ${items.length > 1 ? "are" : "is"} linked with ${missing.map((m) => m.id).join(", ")}: ` +
              `accepting only part of a linked group can break the document. Accept the whole group, or override explicitly.`,
          );
        }
        warnings.push(`Accepted without linked items ${missing.map((m) => m.id).join(", ")}; the group is now broken.`);
      }

      const view = this.workingView();
      const files = new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]));
      const dirtyBefore = new Set<string>();
      for (const f of files) if ((await this.repo.status([f])).length) dirtyBefore.add(f);

      const overrides = new Map(Object.entries(opts.edited ?? {}).map(([k, v]) => [k.toUpperCase(), toLf(v)]));
      const res = await applyItems(items, view, { refText: this.refText, overrides });
      if (res.failed.length) {
        throw new StetError(
          "Nothing was applied, because some items could not be applied:\n" +
            res.failed.map((f) => `  ${f.item.id}: ${f.reason}`).join("\n"),
        );
      }

      // Other live items overlapping what we accept become stale.
      const stale: Item[] = [];
      const acceptedIds = new Set(items.map((i) => i.id));
      const others = (await this.store.items()).filter((i) => isLive(i.status) && !acceptedIds.has(i.id) && files.has(i.file));
      for (const o of others) {
        const { located } = await locate([o], view, { refText: this.refText });
        const span = located[0]?.span;
        const hit = res.applied.find(
          (a) => a.item.file === o.file && (o.kind !== "modify" || a.item.kind !== "modify" || (span && overlaps(span, a.span))),
        );
        if (hit) stale.push(o);
      }

      await this.writeWorking(res.changes);

      for (const a of res.applied) {
        const edited = overrides.has(a.item.id) && overrides.get(a.item.id) !== a.item.newText;
        this.setStatus(a.item, "accepted", "user");
        a.item.resolution = { appliedText: a.item.kind === "modify" ? a.text : a.item.newText, edited, committed: null };
        await this.store.putItem(a.item);
        await this.store.appendEvent({
          type: "accepted", agent: a.item.agent, items: [a.item.id],
          data: { item: await this.describe(a.item), ...(edited ? { finalText: a.text } : {}) },
        });
      }
      for (const s of stale) await this.markStale(s, `overlaps accepted ${res.applied.find((a) => a.item.file === s.file)!.item.id}`);

      let committed: string | null = null;
      const wantCommit = opts.commit ?? cfg.autoCommit === "when-clean";
      if (wantCommit) {
        if (dirtyBefore.size) warnings.push(`Not committed: ${[...dirtyBefore].join(", ")} had uncommitted edits of yours.`);
        else committed = await this.commitAccepted(res.applied.map((a) => a.item), [...res.changes.keys()]);
      }
      await this.updateGroups([...items, ...stale]);
      await this.ensureBase();
      const accepted = res.applied.map((a) => a.item).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
      return { accepted, stale, committed, warnings };
    });
  }

  private async commitAccepted(items: Item[], paths: string[]): Promise<string | null> {
    const ids = items.map((i) => i.id).join(", ");
    const cs = await this.store.getChangeset(items[0]!.changeset);
    const title = cs ? ` — ${cs.title} (${cs.agent})` : "";
    await this.repo.run(["add", "-A", "--", ...paths]);
    const r = await this.repo.tryRun(["commit", "-q", "--only", "-m", `stet: accept ${ids}${title}\n\nStet-Applied: ${ids.replace(/ /g, "")}`, "--", ...paths]);
    if (r === null) return null;
    const head = (await this.repo.revParse("HEAD"))!;
    for (const it of items) {
      it.resolution!.committed = head;
      await this.store.putItem(it);
    }
    return head;
  }

  /**
   * Reject items. For linked members, `mode` decides what happens to the rest of the group:
   * "all" rejects them too, "revise-rest" asks for revision, "only" breaks the group.
   */
  async reject(ids: string[], opts: { reason?: string; mode?: "all" | "revise-rest" | "only" } = {}): Promise<Item[]> {
    return this.store.withLock(async () => {
      const items = await this.requireItems(ids);
      for (const it of items) if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
      const rest = (await this.linkedMembers(items)).filter((m) => !items.some((i) => i.id === m.id));
      if (rest.length && !opts.mode) {
        throw new StetError(
          `${items.map((i) => i.id).join(", ")} is linked with ${rest.map((m) => m.id).join(", ")}. ` +
            `Choose: reject all of them, reject this one and request revision of the rest, or reject only this one.`,
        );
      }
      const toReject = opts.mode === "all" ? [...items, ...rest] : items;
      for (const it of toReject) {
        this.setStatus(it, "rejected", "user", opts.reason);
        if (opts.reason) it.thread.push({ at: now(), author: "user", text: `Rejected: ${opts.reason}` });
        await this.store.putItem(it);
        await this.store.appendEvent({
          type: "rejected", agent: it.agent, items: [it.id],
          data: { item: await this.describe(it), ...(opts.reason ? { reason: opts.reason } : {}) },
        });
      }
      if (opts.mode === "revise-rest") {
        for (const r of rest) {
          const text = `Linked item ${items.map((i) => i.id).join(", ")} was rejected${opts.reason ? `: ${opts.reason}` : ""}. Please revise.`;
          await this.requestRevisionLocked(r, text);
        }
      }
      await this.updateGroups([...toReject, ...rest]);
      return toReject;
    });
  }

  private async requestRevisionLocked(it: Item, text: string) {
    this.setStatus(it, "needs_revision", "user");
    it.thread.push({ at: now(), author: "user", text });
    await this.store.putItem(it);
    await this.store.appendEvent({ type: "revision_requested", agent: it.agent, items: [it.id], data: { item: await this.describe(it), comment: text } });
  }

  async requestRevision(id: string, text: string): Promise<Item> {
    return this.store.withLock(async () => {
      const [it] = await this.requireItems([id]);
      if (!isLive(it!.status)) throw new StetError(`${it!.id} is ${it!.status}, not pending.`);
      await this.requestRevisionLocked(it!, text);
      return it!;
    });
  }

  async comment(id: string, text: string, author: "user" | "agent" = "user"): Promise<Item> {
    return this.store.withLock(async () => {
      const [it] = await this.requireItems([id]);
      it!.thread.push({ at: now(), author, text });
      await this.store.putItem(it!);
      await this.store.appendEvent({
        type: author === "user" ? "comment" : "reply", agent: it!.agent, items: [it!.id],
        data: { item: await this.describe(it!), text },
      });
      return it!;
    });
  }

  async withdraw(agentId: string, ids: string[], reason?: string): Promise<Item[]> {
    return this.store.withLock(async () => {
      const items = await this.requireItems(ids);
      for (const it of items) {
        if (it.agent !== agentId) throw new StetError(`${it.id} belongs to ${it.agent}.`);
        if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
        this.setStatus(it, "withdrawn", "agent", reason);
        await this.store.putItem(it);
        await this.store.appendEvent({ type: "withdrawn", agent: agentId, items: [it.id], data: reason ? { reason } : {} });
      }
      await this.updateGroups(items);
      return items;
    });
  }

  // -------------------------------------------------------------------------
  // Grouping after submit (§6.4)

  async group(agentId: string | null, ids: string[], kind: GroupKind, title: string, rationale?: string): Promise<{ group: Group | null; merged: Item | null }> {
    return this.store.withLock(async () => {
      const items = await this.requireItems(ids);
      if (items.length < 2) throw new StetError("A group needs at least two items.");
      const agent = items[0]!.agent;
      for (const it of items) {
        if (agentId && it.agent !== agentId) throw new StetError(`${it.id} belongs to ${it.agent}.`);
        if (it.agent !== agent) throw new StetError("All items of a group must come from the same agent.");
        if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
      }
      if (kind === "atomic") return { group: null, merged: await this.mergeAtomic(items, title, rationale) };
      const [gid] = await this.store.allocate("group");
      let group: Group = {
        id: gid!, agent, changeset: items[0]!.changeset, kind, title, rationale: rationale ?? null, source: "agent",
        items: items.map((i) => i.id), state: "open",
      };
      if (kind === "linked") {
        for (const pg of (await this.store.groups()).filter((g) => g.kind === "linked" && g.items.some((i) => group.items.includes(i)))) {
          for (const i of pg.items) if (!group.items.includes(i)) group.items.push(i);
          group.title = joinTitles(pg.title, group.title);
          await this.store.deleteGroup(pg.id);
          for (const i of pg.items) {
            const it = await this.store.getItem(i);
            if (it) {
              it.groups = it.groups.filter((x) => x !== pg.id);
              await this.store.putItem(it);
            }
          }
        }
      }
      for (const i of group.items) {
        const it = await this.store.getItem(i);
        if (it && !it.groups.includes(group.id)) {
          it.groups.push(group.id);
          await this.store.putItem(it);
        }
      }
      await this.store.putGroup(group);
      const cs = await this.store.getChangeset(group.changeset);
      if (cs && !cs.groups.includes(group.id)) {
        cs.groups.push(group.id);
        await this.store.putChangeset(cs);
      }
      return { group, merged: null };
    });
  }

  private async mergeAtomic(items: Item[], title: string, rationale?: string): Promise<Item> {
    const first = items[0]!;
    if (items.some((i) => i.kind !== "modify" || i.file !== first.file || i.baseCommit !== first.baseCommit))
      throw new StetError("Atomic groups need text edits in the same file.");
    const sorted = [...items].sort((a, b) => a.range.start - b.range.start);
    const bt = (await this.refText(first)) ?? "";
    const start = sorted[0]!.range.start;
    const end = sorted[sorted.length - 1]!.range.end;
    if (/\n[ \t]*\n/.test(bt.slice(start, end))) throw new StetError("Atomic groups must stay within one paragraph; use a linked group instead.");
    let newText = "";
    let pos = start;
    for (const it of sorted) {
      newText += bt.slice(pos, it.range.start) + it.newText;
      pos = it.range.end;
    }
    newText += bt.slice(pos, end);
    const [id] = await this.store.allocate("item");
    const merged: Item = {
      ...first,
      id: id!,
      range: { start, end },
      oldText: bt.slice(start, end),
      newText,
      context: captureContext(bt, start, end),
      fingerprint: this.fingerprint({ file: first.file, kind: "modify", oldText: bt.slice(start, end), newText }),
      note: rationale ? `${title}: ${rationale}` : title,
      groups: [...new Set(items.flatMap((i) => i.groups))],
      supersedes: sorted.map((i) => i.id).join(","),
      conflictsWith: [...new Set(items.flatMap((i) => i.conflictsWith))],
      history: [{ at: now(), status: "pending", by: "agent" }],
      thread: items.flatMap((i) => i.thread),
      status: "pending",
    };
    for (const it of items) {
      this.setStatus(it, "superseded", "agent", `merged into ${merged.id}`);
      await this.store.putItem(it);
    }
    for (const gid of merged.groups) {
      const g = await this.store.getGroup(gid);
      if (!g) continue;
      g.items = [...g.items.filter((i) => !items.some((x) => x.id === i)), merged.id];
      await this.store.putGroup(g);
    }
    await this.store.putItem(merged);
    const cs = await this.store.getChangeset(merged.changeset);
    if (cs) {
      cs.items.push(merged.id);
      await this.store.putChangeset(cs);
    }
    return merged;
  }

  async ungroup(groupId: string, agentId?: string): Promise<void> {
    await this.store.withLock(async () => {
      const g = await this.store.getGroup(groupId.toUpperCase());
      if (!g) throw new StetError(`Unknown group '${groupId}'.`);
      if (agentId && g.agent !== agentId) throw new StetError(`${g.id} belongs to ${g.agent}.`);
      for (const i of g.items) {
        const it = await this.store.getItem(i);
        if (it) {
          it.groups = it.groups.filter((x) => x !== g.id);
          await this.store.putItem(it);
        }
      }
      const cs = await this.store.getChangeset(g.changeset);
      if (cs) {
        cs.groups = cs.groups.filter((x) => x !== g.id);
        await this.store.putChangeset(cs);
      }
      await this.store.deleteGroup(g.id);
    });
  }

  // -------------------------------------------------------------------------
  // Feedback (§10)

  async feedback(agentId: string, opts: { ack?: boolean } = {}): Promise<StetEvent[]> {
    return this.store.withLock(async () => {
      const agent = await this.requireAgent(agentId);
      const all = await this.store.events(agent.feedbackCursor);
      const mine = all.filter((e) => e.agent === agentId && FEEDBACK_TYPES.includes(e.type));
      if (opts.ack !== false && all.length) {
        agent.feedbackCursor = all[all.length - 1]!.seq;
        await this.store.putAgent(agent);
      }
      return mine;
    });
  }

  events(since = 0) {
    return this.store.events(since);
  }
}
