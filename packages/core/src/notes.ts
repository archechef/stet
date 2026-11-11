/** Reviewer notes (spec §7.8): how a delivered note reads for an agent, in the MCP server and the CLI alike. */
import type { Note } from "./model.js";
import { oneLine } from "./text.js";

/** A note as delivered at a sync: where the passage now is in the agent's workspace (1-based lines). */
export interface DeliveredNote {
  note: Note;
  lines: { from: number; to: number } | null;
}

export function describeNote(d: DeliveredNote, reply: (id: string) => string = (id) => `stet_reply ${id}`): string {
  const n = d.note;
  const where = d.lines ? `${n.file}:${d.lines.from}${d.lines.to !== d.lines.from ? `-${d.lines.to}` : ""}` : n.file;
  const passage = d.lines
    ? `The passage: "${oneLine(n.text, 300)}".`
    : `The passage could not be found in your workspace any more; it read: "${oneLine(n.text, 300)}".`;
  const later = n.thread.map((t) => ` ${t.author === "user" ? "Reviewer" : "You"}: ${oneLine(t.text, 300)}`).join("");
  const body = /[.!?…:]$/.test(n.body) ? n.body : `${n.body}.`;
  return `NOTE ${n.id} from the reviewer on ${where}: ${body} ${passage}${later} Act on it in your next changes; answer with ${reply(n.id)} if something is unclear or when done.`;
}
