/** What the parts of the Stet service share. */
import { StetError } from "../errors.js";
import { type Item, isLive } from "../model.js";

export const now = () => new Date().toISOString();

/** Refuse a change that is decided, superseded or withdrawn. */
export function requirePending(it: Pick<Item, "id" | "status">): void {
  if (!isLive(it.status)) throw new StetError(`${it.id} is ${it.status}, not pending.`);
}
