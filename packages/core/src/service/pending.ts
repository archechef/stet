/**
 * Records written by one operation, kept in memory until it is done and then written in one step:
 * a submit that fails halfway leaves the store as it was, not with some of its changes. Reads see
 * the operation's own writes first.
 */
import type { Group, Item } from "../model.js";
import { byId, type Store } from "../store.js";

/** The record operations a submit uses, of the store or of `PendingWrites`. */
export interface Records {
  items(): Promise<Item[]>;
  getItem(id: string): Promise<Item | null>;
  putItem(it: Item): Promise<void>;
  groups(): Promise<Group[]>;
  getGroup(id: string): Promise<Group | null>;
  putGroup(g: Group): Promise<void>;
  deleteGroup(id: string): Promise<void>;
}

export class PendingWrites implements Records {
  private readonly items_ = new Map<string, Item>();
  private readonly groups_ = new Map<string, Group>();
  private readonly deleted = new Set<string>();

  constructor(private readonly store: Store) {}

  /** The store's items with this operation's written over them, as copies (as the store gives them). */
  async items(): Promise<Item[]> {
    const out = new Map((await this.store.items()).map((i) => [i.id, i]));
    for (const [id, it] of this.items_) out.set(id, structuredClone(it));
    return [...out.values()].sort((a, b) => byId(a.id, b.id));
  }

  async getItem(id: string): Promise<Item | null> {
    const it = this.items_.get(id);
    return it ? structuredClone(it) : this.store.getItem(id);
  }

  async putItem(it: Item): Promise<void> {
    this.items_.set(it.id, structuredClone(it));
  }

  async groups(): Promise<Group[]> {
    const out = new Map((await this.store.groups()).filter((g) => !this.deleted.has(g.id)).map((g) => [g.id, g]));
    for (const [id, g] of this.groups_) out.set(id, structuredClone(g));
    return [...out.values()].sort((a, b) => byId(a.id, b.id));
  }

  async getGroup(id: string): Promise<Group | null> {
    if (this.deleted.has(id)) return null;
    const g = this.groups_.get(id);
    return g ? structuredClone(g) : this.store.getGroup(id);
  }

  async putGroup(g: Group): Promise<void> {
    this.deleted.delete(g.id);
    this.groups_.set(g.id, structuredClone(g));
  }

  async deleteGroup(id: string): Promise<void> {
    this.groups_.delete(id);
    this.deleted.add(id);
  }

  /** Write everything to the store: removed groups, then groups, then items. */
  async flush(): Promise<void> {
    for (const id of this.deleted) await this.store.deleteGroup(id);
    for (const g of this.groups_.values()) await this.store.putGroup(g);
    for (const it of this.items_.values()) await this.store.putItem(it);
    this.deleted.clear();
    this.groups_.clear();
    this.items_.clear();
  }
}
