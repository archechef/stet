/** Groups (§6.4): kept up to date as changes are decided, and made or removed by hand. */
import { captureContext, type Neighbour } from "../anchor.js";
import { applyItems, conflicts, type FileView, locate } from "../apply.js";
import { notFound, StetError } from "../errors.js";
import { DROPPED_STATUSES, type Group, type GroupKind, type Item, isLive, itemId, numberInRound, partId } from "../model.js";
import { absorbLinked, settleParts } from "../parts.js";
import type { Stet } from "../service.js";
import { now, requirePending } from "./common.js";

/** Changes of a simulated accept, as neighbours of `it` (same file and base). */
export function appliedAsNeighbours(applied: { item: Item; text: string }[], it: Item): Neighbour[] {
  return applied
    .filter((a) => a.item.kind === "modify" && a.item.file === it.file && a.item.baseCommit === it.baseCommit && a.item.id !== it.id)
    .map((a) => ({ range: a.item.range, oldText: a.item.oldText, text: a.text }));
}

/** stet_group: a linked group Stet sees no dependency in. */
export function unlinkedRefusal(comps: string[][]): string {
  const linked = comps.filter((c) => c.length > 1);
  const free = comps.filter((c) => c.length === 1).map((c) => c[0]!);
  return (
    `Not linked: Stet sees no dependency between all of these changes` +
    (linked.length
      ? ` (${linked.map((c) => c.join(" + ")).join("; ")} need each other` + (free.length ? `; ${free.join(", ")} don't depend on them)` : ")")
      : ")") +
    `. Group them as "related" and link only the changes that need each other, or pass a "reason" if accepting only some really breaks the document (the reviewer sees it).`
  );
}

/** What `group` takes besides the changes, their kind and the title. */
export interface GroupExtras {
  rationale?: string;
  parts?: { title: string; items: string[] }[];
  reason?: string;
}

export class GroupOps {
  constructor(private readonly stet: Stet) {}

  /**
   * The sets of changes among `members` that need each other: the rules of §6.4.6 from single
   * changes up, plus the same symbol or term replaced, within one of `units` (the agent's parts:
   * a notation change it split by section stays split).
   */
  async dependencies(members: Item[], units?: string[][]): Promise<string[][]> {
    const base = members.find((m) => isLive(m.status))?.baseCommit;
    const singles = members.map((m) => ({ title: m.id, items: [m.id] }));
    const unitOf = new Map((units ?? []).flatMap((u, k) => u.map((i) => [i, k] as const)));
    const sameSymbol = (a: Item, b: Item) => !units || unitOf.get(a.id) === unitOf.get(b.id);
    const cfg = await this.stet.config();
    const { parts } = await settleParts(singles, members, base ? (lists) => this.interference(lists, this.stet.treeView(base)) : undefined, {
      sameSymbol,
      profileOf: (f) => this.stet.profile(cfg, f),
      grouping: cfg.grouping,
    });
    return parts ? parts.map((p) => p.items) : [members.map((m) => m.id)];
  }

  /**
   * Check the parts of a linked group (§6.4.6) and join the ones that break the rules. Accepting
   * is simulated on the review base the members were made against. Returns notes for the agent.
   * `merged`: the group absorbed an earlier one, whose parts may overlap its own (no notes about that).
   */
  async settleParts(g: Group, get: (id: string) => Promise<Item | undefined>, { merged = false } = {}): Promise<string[]> {
    if (g.kind !== "linked" || !g.parts) {
      delete g.parts;
      return [];
    }
    const members = (await Promise.all(g.items.map(get))).filter((x): x is Item => !!x && x.status !== "superseded");
    const base = members.find((m) => isLive(m.status))?.baseCommit;
    const cfg = await this.stet.config();
    const { parts, notes } = await settleParts(g.parts, members, base ? (lists) => this.interference(lists, this.stet.treeView(base)) : undefined, {
      profileOf: (f) => this.stet.profile(cfg, f),
      quietOverlaps: merged,
      grouping: cfg.grouping,
    });
    if (parts) g.parts = parts;
    else delete g.parts;
    // Joins of parts Stet proposed itself are no news to the agent.
    return g.source === "auto" ? [] : notes.map((n) => `Group '${g.title}': ${n}`);
  }

  /**
   * Pairs (a, b) of item lists where accepting all of a (onto `view`) would keep b from being
   * accepted: b's changes overlap a's (accepting a makes them stale) or can't be located afterwards.
   */
  private async interference(lists: Item[][], view: FileView): Promise<[number, number][]> {
    const opts = { refText: this.stet.refText };
    const out: [number, number][] = [];
    const before = await Promise.all(lists.map((l) => locate(l, view, opts)));
    for (let a = 0; a < lists.length; a++) {
      const res = await applyItems(lists[a]!, view, opts);
      if (res.failed.length) continue; // not applicable on its own here; accept will say why
      const after: FileView = {
        read: async (p) => {
          if (!res.changes.has(p)) return view.read(p);
          const c = res.changes.get(p);
          return c && "text" in c ? c : null;
        },
        blobId: async (p) => (res.changes.has(p) ? (res.changes.get(p) === null ? null : "changed") : view.blobId(p)),
      };
      for (let b = 0; b < lists.length; b++) {
        if (b === a) continue;
        const located = before[b]!.located;
        const clash = located.some((l) =>
          res.applied.some((x) => x.item.file === l.item.file && (l.item.kind !== "modify" || x.item.kind !== "modify" || conflicts(l.span, x.span))),
        );
        // Part a is accepted in this simulation: a change next to it is found with its text, as
        // after a real accept (parts in one paragraph were always joined).
        const simulated = { ...opts, neighbours: async (it: Item) => [...appliedAsNeighbours(res.applied, it), ...(await this.stet.neighbours(it))] };
        const lost = clash
          ? []
          : (
              await locate(
                located.map((l) => l.item),
                after,
                simulated,
              )
            ).failed;
        if (clash || lost.length) out.push([a, b]);
      }
    }
    return out;
  }

  /** Recompute group states after status changes; emits group_broken once per group. */
  async updateGroups(changed: Item[]) {
    const gids = new Set(changed.flatMap((i) => i.groups));
    for (const gid of gids) {
      const g = await this.stet.store.getGroup(gid);
      if (!g) continue;
      // Superseded members have been replaced by newer versions; they no longer count.
      const members = (await Promise.all(g.items.map((i) => this.stet.store.getItem(i)))).filter((x): x is Item => !!x && x.status !== "superseded");
      if (!members.length) continue;
      const statuses = members.map((m) => m.status);
      let state: Group["state"] = statuses.every((s) => !isLive(s)) ? "resolved" : "open";
      // Each part of a linked group is resolved as one (§6.4.6); without parts, the whole group is.
      const units = g.kind !== "linked" ? [] : g.parts ? g.parts.map((p) => members.filter((m) => p.items.includes(m.id))).filter((u) => u.length) : [members];
      for (const u of units) {
        const accepted = u.filter((m) => m.status === "accepted").length;
        const dead = u.filter((m) => DROPPED_STATUSES.includes(m.status)).length;
        if ((accepted && accepted < u.length) || (dead && u.some((m) => isLive(m.status)))) state = "broken";
      }
      if (state === "broken" && g.state !== "broken") {
        await this.stet.store.appendEvent({
          type: "group_broken",
          agent: g.agent,
          group: g.id,
          items: g.items,
          data: { title: g.title, members: members.map((m) => ({ id: m.id, status: m.status, file: m.file })) },
        });
      }
      // Some parts accepted, others not: the document compiles but may be inconsistent.
      if (state === "resolved" && g.state !== "resolved" && g.parts && units.length > 1) {
        const outcome = (u: Item[]) => (u.every((m) => m.status === "accepted") ? "accepted" : u.find((m) => m.status !== "accepted")!.status);
        const parts = g.parts.flatMap((p, k) => {
          const u = members.filter((m) => p.items.includes(m.id));
          return u.length ? [{ id: partId(g.id, k), title: p.title, outcome: outcome(u), items: u.map((m) => m.id) }] : [];
        });
        if (parts.some((p) => p.outcome === "accepted") && parts.some((p) => p.outcome !== "accepted")) {
          await this.stet.store.appendEvent({ type: "group_partial", agent: g.agent, group: g.id, items: g.items, data: { title: g.title, parts } });
        }
      }
      if (state !== g.state) {
        g.state = state;
        await this.stet.store.putGroup(g);
      }
    }
  }

  /** Group changes. `more`: the agent's explanation, its parts (linked groups only), and why the
   *  changes are linked when Stet sees no dependency. */
  async group(
    agentId: string | null,
    ids: string[],
    kind: GroupKind,
    title: string,
    more: GroupExtras = {},
  ): Promise<{ group: Group | null; merged: Item | null; warnings: string[] }> {
    const { parts, reason } = more;
    let rationale = more.rationale;
    return this.stet.store.withLock(async () => {
      if (parts?.length && kind !== "linked") throw new StetError("Only linked groups have parts.");
      const partList = (parts ?? []).map((p) => ({ title: p.title, items: p.items.map((i) => i.toUpperCase()) }));
      for (const p of partList) for (const i of p.items) if (!ids.some((x) => x.toUpperCase() === i)) ids = [...ids, i];
      const items = await this.stet.requireItems(ids);
      if (items.length < 2) throw new StetError("A group needs at least two items.");
      const agent = items[0]!.agent;
      for (const it of items) {
        if (agentId && it.agent !== agentId) throw new StetError(`${it.id} belongs to ${it.agent}.`);
        if (it.agent !== agent) throw new StetError("All items of a group must come from the same agent.");
        requirePending(it);
      }
      if (kind === "atomic") return { group: null, merged: await this.mergeAtomic(items, title, rationale), warnings: [] };
      // An agent's linked group needs a dependency Stet can see, or a reason (§6.4.6).
      if (kind === "linked" && agentId && !reason) {
        const units = partList.length
          ? [...partList.map((p) => p.items), items.map((i) => i.id).filter((i) => !partList.some((p) => p.items.includes(i)))].filter((u) => u.length)
          : undefined;
        const comps = await this.dependencies(items, units);
        if (comps.length > 1) throw new StetError(unlinkedRefusal(comps));
      }
      if (reason) rationale = `Linked because: ${reason}${rationale ? `\n\n${rationale}` : ""}`;
      const [gid] = await this.stet.store.allocate("group");
      const group: Group = {
        id: gid!,
        agent,
        changeset: items[0]!.changeset,
        kind,
        title,
        rationale: rationale ?? null,
        source: "agent",
        items: items.map((i) => i.id),
        ...(partList.length ? { parts: partList } : {}),
        state: "open",
      };
      const warnings: string[] = [];
      if (kind === "linked") {
        for (const pg of (await this.stet.store.groups()).filter((g) => g.kind === "linked" && g.items.some((i) => group.items.includes(i)))) {
          absorbLinked(group, pg);
          await this.stet.store.deleteGroup(pg.id);
          for (const i of pg.items) {
            const it = await this.stet.store.getItem(i);
            if (it) {
              it.groups = it.groups.filter((x) => x !== pg.id);
              await this.stet.store.putItem(it);
            }
          }
        }
      }
      for (const i of group.items) {
        const it = await this.stet.store.getItem(i);
        if (it && !it.groups.includes(group.id)) {
          it.groups.push(group.id);
          await this.stet.store.putItem(it);
        }
      }
      warnings.push(...(await this.settleParts(group, async (i) => (await this.stet.store.getItem(i)) ?? undefined)));
      await this.stet.store.putGroup(group);
      const cs = await this.stet.store.getChangeset(group.changeset);
      if (cs && !cs.groups.includes(group.id)) {
        cs.groups.push(group.id);
        await this.stet.store.putChangeset(cs);
      }
      return { group, merged: null, warnings };
    });
  }

  private async mergeAtomic(items: Item[], title: string, rationale?: string): Promise<Item> {
    const first = items[0]!;
    if (items.some((i) => i.kind !== "modify" || i.file !== first.file || i.baseCommit !== first.baseCommit))
      throw new StetError("Atomic groups need text edits in the same file.");
    const sorted = [...items].sort((a, b) => a.range.start - b.range.start);
    const bt = (await this.stet.refText(first)) ?? "";
    const start = sorted[0]!.range.start;
    const end = sorted[sorted.length - 1]!.range.end;
    // Only the text between the edits counts: an edit that itself crosses a paragraph break is one
    // item already, and merging it with an edit right next to it splits nothing that was together.
    if (sorted.some((it, k) => k > 0 && /\n[ \t]*\n/.test(bt.slice(sorted[k - 1]!.range.end, it.range.start))))
      throw new StetError("Atomic groups must stay within one paragraph; use a linked group instead.");
    let newText = "";
    let pos = start;
    for (const it of sorted) {
      newText += bt.slice(pos, it.range.start) + it.newText;
      pos = it.range.end;
    }
    newText += bt.slice(pos, end);
    // The merged change joins its round under the next free number.
    const taken = (await this.stet.store.items()).filter((i) => i.changeset === first.changeset).map((i) => numberInRound(i.id) ?? 0);
    const id = itemId(first.changeset, Math.max(0, ...taken) + 1);
    const merged: Item = {
      ...first,
      id: id!,
      range: { start, end },
      oldText: bt.slice(start, end),
      newText,
      context: captureContext(bt, start, end),
      fingerprint: this.stet.submitOps.fingerprint({ file: first.file, kind: "modify", oldText: bt.slice(start, end), newText }),
      note: rationale ? `${title}: ${rationale}` : title,
      groups: [...new Set(items.flatMap((i) => i.groups))],
      supersedes: sorted.map((i) => i.id).join(","),
      conflictsWith: [...new Set(items.flatMap((i) => i.conflictsWith))],
      history: [{ at: now(), status: "pending", by: "agent" }],
      thread: items.flatMap((i) => i.thread),
      status: "pending",
    };
    for (const it of items) {
      this.stet.setStatus(it, "superseded", "agent", `merged into ${merged.id}`);
      await this.stet.store.putItem(it);
    }
    await this.stet.store.putItem(merged);
    for (const gid of merged.groups) {
      const g = await this.stet.store.getGroup(gid);
      if (!g) continue;
      g.items = [...g.items.filter((i) => !items.some((x) => x.id === i)), merged.id];
      // The merged item replaces its originals in their parts; parts it now spans are joined.
      if (g.parts) {
        g.parts = g.parts.map((p) => ({ ...p, items: [...new Set(p.items.map((i) => (items.some((x) => x.id === i) ? merged.id : i)))] }));
        await this.settleParts(g, async (i) => (await this.stet.store.getItem(i)) ?? undefined);
      }
      await this.stet.store.putGroup(g);
    }
    const cs = await this.stet.store.getChangeset(merged.changeset);
    if (cs) {
      cs.items.push(merged.id);
      await this.stet.store.putChangeset(cs);
    }
    return merged;
  }

  async ungroup(groupId: string, agentId?: string): Promise<void> {
    await this.stet.store.withLock(async () => {
      const g = await this.stet.store.getGroup(groupId.toUpperCase());
      if (!g) throw notFound(`Unknown group '${groupId}'.`);
      if (agentId && g.agent !== agentId) throw new StetError(`${g.id} belongs to ${g.agent}.`);
      for (const i of g.items) {
        const it = await this.stet.store.getItem(i);
        if (it) {
          it.groups = it.groups.filter((x) => x !== g.id);
          await this.stet.store.putItem(it);
        }
      }
      const cs = await this.stet.store.getChangeset(g.changeset);
      if (cs) {
        cs.groups = cs.groups.filter((x) => x !== g.id);
        await this.stet.store.putChangeset(cs);
      }
      await this.stet.store.deleteGroup(g.id);
    });
  }
}
