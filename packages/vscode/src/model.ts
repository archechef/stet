/**
 * View model for the Stet panel and editor integration. No `vscode` import here,
 * so it can be unit-tested with vitest.
 */
import { oneLine, type Agent, type Changeset, type Group, type Item, type ItemStatus } from "@stet/core";

export interface Snapshot {
  agents: Agent[];
  changesets: Changeset[];
  groups: Group[];
  items: Item[];
  /** Agents whose workspace is behind the review base. */
  syncNeeded: Set<string>;
  /** Accepted items not committed yet. */
  uncommitted: Item[];
}

export type Node =
  | { type: "agent"; agent: Agent }
  | { type: "changeset"; changeset: Changeset }
  | { type: "group"; group: Group }
  | { type: "item"; item: Item; parent: string };

/**
 * An item or group id together with its project, as passed by CodeLens and hover links.
 * Ids like S3 or G1 are numbered per project, so an id alone is ambiguous with several projects open.
 */
export interface Ref {
  path: string;
  id: string;
}

export const isRef = (v: unknown): v is Ref =>
  !!v && typeof v === "object" && typeof (v as Ref).path === "string" && typeof (v as Ref).id === "string";

export const LIVE: readonly ItemStatus[] = ["pending", "needs_revision"];
export const isLive = (i: Item) => LIVE.includes(i.status);
const num = (id: string) => Number(id.slice(1));
const byId = (a: { id: string }, b: { id: string }) => num(a.id) - num(b.id);

/** Tree structure: agent → changeset → group → item, ungrouped items directly under the changeset. */
export class TreeModel {
  private items = new Map<string, Item>();
  private groups = new Map<string, Group>();

  constructor(
    readonly snap: Snapshot,
    readonly showResolved: boolean,
  ) {
    for (const i of snap.items) this.items.set(i.id, i);
    for (const g of snap.groups) this.groups.set(g.id, g);
  }

  visible(i: Item): boolean {
    return this.showResolved ? true : isLive(i);
  }

  /** Visible members of a group (atomic groups never show: their members are merged). */
  members(g: Group): Item[] {
    if (g.kind === "atomic") return [];
    return g.items.map((id) => this.items.get(id)).filter((i): i is Item => !!i && this.visible(i)).sort(byId);
  }

  private groupsOf(cs: Changeset): Group[] {
    return this.snap.groups.filter((g) => g.changeset === cs.id && this.members(g).length > 0).sort(byId);
  }

  private ungrouped(cs: Changeset): Item[] {
    return this.snap.items
      .filter((i) => i.changeset === cs.id && this.visible(i))
      .filter((i) => !i.groups.some((gid) => {
        const g = this.groups.get(gid);
        return g && g.kind !== "atomic";
      }))
      .sort(byId);
  }

  private csVisible(cs: Changeset): boolean {
    return this.groupsOf(cs).length > 0 || this.ungrouped(cs).length > 0;
  }

  children(node?: Node): Node[] {
    if (!node) {
      return this.snap.agents
        .filter((a) => a.state === "active" || this.snap.items.some((i) => i.agent === a.id && this.visible(i)))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((agent) => ({ type: "agent", agent }));
    }
    switch (node.type) {
      case "agent":
        return this.snap.changesets
          .filter((c) => c.agent === node.agent.id && this.csVisible(c))
          .sort((a, b) => num(b.id) - num(a.id))
          .map((changeset) => ({ type: "changeset", changeset }));
      case "changeset":
        return [
          ...this.groupsOf(node.changeset).map((group): Node => ({ type: "group", group })),
          ...this.ungrouped(node.changeset).map((item): Node => ({ type: "item", item, parent: node.changeset.id })),
        ];
      case "group":
        return this.members(node.group).map((item) => ({ type: "item", item, parent: node.group.id }));
      case "item":
        return [];
    }
  }

  liveCount(pred: (i: Item) => boolean): number {
    return this.snap.items.filter((i) => isLive(i) && pred(i)).length;
  }

  item(id: string): Item | undefined {
    return this.items.get(id.toUpperCase());
  }

  group(id: string): Group | undefined {
    return this.groups.get(id.toUpperCase());
  }

  /** Live members of linked groups containing any of `ids`, excluding `ids` themselves. */
  linkedRest(ids: string[]): Item[] {
    const out = new Map<string, Item>();
    for (const id of ids) {
      for (const gid of this.item(id)?.groups ?? []) {
        const g = this.groups.get(gid);
        if (g?.kind !== "linked") continue;
        for (const m of g.items) {
          const mi = this.items.get(m);
          if (mi && isLive(mi) && !ids.includes(mi.id)) out.set(mi.id, mi);
        }
      }
    }
    return [...out.values()].sort(byId);
  }

  /** The linked group of an item, if any. */
  linkedGroup(item: Item): Group | undefined {
    return item.groups.map((g) => this.groups.get(g)).find((g) => g?.kind === "linked");
  }
}

// ---------------------------------------------------------------------------
// Labels

export { oneLine };

export function itemLabel(it: Item): string {
  switch (it.kind) {
    case "add-file":
      return `${it.id}  new file ${it.file}`;
    case "delete-file":
      return `${it.id}  delete ${it.file}`;
    case "rename-file":
      return `${it.id}  rename ${it.oldFile} → ${it.file}`;
    case "binary":
      return `${it.id}  binary ${it.file}`;
    default:
      if (!it.oldText) return `${it.id}  + “${oneLine(it.newText, 50)}”`;
      if (!it.newText) return `${it.id}  − “${oneLine(it.oldText, 50)}”`;
      return `${it.id}  “${oneLine(it.oldText, 28)}” → “${oneLine(it.newText, 28)}”`;
  }
}

export const STATUS_TEXT: Record<ItemStatus, string> = {
  pending: "pending",
  needs_revision: "revision requested",
  accepted: "accepted",
  rejected: "rejected",
  withdrawn: "withdrawn",
  superseded: "superseded",
  stale: "stale",
};

export function groupLabel(g: Group): string {
  return g.title;
}

export function groupDescription(g: Group, shown: number): string {
  const parts = [g.kind === "linked" ? "linked" : g.kind];
  if (g.source === "auto") parts.push("auto");
  if (g.state === "broken") parts.push("broken");
  parts.push(`${shown}`);
  return parts.join(" · ");
}

/** Short text for ghost-text decorations (no newlines, bounded length). */
export function ghostText(s: string, max = 80): string {
  const t = s.replace(/\r?\n/g, " ⏎ ");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Markdown fenced block that is safe for any content. */
export function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

/** A unified-style diff for hovers. */
export function diffBlock(oldText: string, newText: string): string {
  const lines = [
    ...(oldText ? oldText.split("\n").map((l) => "- " + l) : []),
    ...(newText ? newText.split("\n").map((l) => "+ " + l) : []),
  ];
  return fence(lines.join("\n"), "diff");
}

// ---------------------------------------------------------------------------
// Text positions

/** Line/column of an offset in LF text. Line/column are the same in the CRLF version of the text. */
export class LineIndex {
  private starts: number[] = [0];
  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  position(offset: number): { line: number; character: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.starts[lo]! };
  }
}

export const toLf = (s: string) => s.replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// Agents

export function suggestAgentId(kind: "claude-code" | "codex" | "other", existing: string[]): string {
  const prefix = kind === "claude-code" ? "claude" : kind === "codex" ? "codex" : "agent";
  for (let n = 1; ; n++) if (!existing.includes(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse `node --version` output; returns the major version or null. */
export function nodeMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version.trim());
  return m ? Number(m[1]) : null;
}
