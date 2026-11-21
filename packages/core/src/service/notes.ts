/** Reviewer notes (§7.8): a note to one agent on a passage, its replies, and delivering it. */
import { anchor, captureContext, type Span } from "../anchor.js";
import { notFound, StetError } from "../errors.js";
import type { Agent, Note } from "../model.js";
import type { DeliveredNote } from "../notes.js";
import { readInside } from "../safefs.js";
import type { Stet } from "../service.js";
import { isSafeRepoPath, lineOf, lineRange, toLf } from "../text.js";
import { now } from "./common.js";

export class Notes {
  constructor(private readonly stet: Stet) {}

  /**
   * Leave a note for an agent on a passage of `file`: an offset range, or 1-based lines. `text`
   * is the file as the reviewer sees it (e.g. an editor with unsaved edits); default: the file on disk.
   */
  async addNote(
    agentId: string,
    where: { file: string; start?: number; end?: number; fromLine?: number; toLine?: number; text?: string },
    body: string,
  ): Promise<Note> {
    return this.stet.store.withLock(async () => {
      const agent = await this.stet.agentOps.requireAgent(agentId);
      if (agent.state !== "active") throw new StetError(`Agent ${agent.id} is archived.`);
      if (!body.trim()) throw new StetError("The note is empty.");
      const file = where.file.replace(/\\/g, "/");
      if (!isSafeRepoPath(file)) throw new StetError(`'${where.file}' is not a file in the project.`);
      const text = where.text !== undefined ? toLf(where.text) : (await this.stet.workingView().read(file))?.text;
      if (text === undefined) throw new StetError(`${file} does not exist.`);
      let { start, end } = where;
      if (start === undefined || end === undefined) {
        const from = where.fromLine ?? 1;
        const to = Math.max(from, where.toLine ?? from);
        ({ start, end } = lineRange(text, from, to));
        if (end > start && text[end - 1] === "\n") end--;
      }
      if (start < 0 || end > text.length || start > end) throw new StetError("The passage is outside the file.");
      const [id] = await this.stet.store.allocate("note");
      const note: Note = {
        id: id!,
        agent: agent.id,
        file,
        text: text.slice(start, end),
        range: { start, end },
        context: captureContext(text, start, end),
        body: body.trim(),
        createdAt: now(),
        state: "open",
        deliveredAt: null,
        thread: [],
      };
      await this.stet.store.putNote(note);
      await this.stet.store.appendEvent({ type: "note_added", agent: agent.id, data: { note: note.id, file } });
      return note;
    });
  }

  listNotes = (filter: { agent?: string; state?: Note["state"] } = {}) =>
    this.stet.store.notes().then((ns) => ns.filter((n) => (!filter.agent || n.agent === filter.agent) && (!filter.state || n.state === filter.state)));

  async getNote(id: string): Promise<Note> {
    const n = await this.stet.store.getNote(id.trim().toUpperCase());
    if (!n) throw notFound(`Unknown note '${id}'.`);
    return n;
  }

  /** Where a note's passage is in `text` (LF), e.g. an editor buffer. */
  locateNoteInText(note: Note, text: string): Span | null {
    return anchor({ oldText: note.text, range: note.range, context: note.context }, text);
  }

  /** A reply in a note's thread: the reviewer's reaches the agent as feedback once the note was delivered. */
  async replyNote(id: string, text: string, author: "user" | "agent"): Promise<Note> {
    return this.stet.store.withLock(async () => {
      const n = await this.getNote(id);
      if (!text.trim()) throw new StetError("The reply is empty.");
      n.thread.push({ at: now(), author, text: text.trim() });
      await this.stet.store.putNote(n);
      await this.stet.store.appendEvent({
        type: author === "user" ? "note_comment" : "note_reply",
        agent: n.agent,
        data: { note: n.id, file: n.file, text: text.trim() },
      });
      return n;
    });
  }

  async resolveNote(id: string): Promise<Note> {
    return this.stet.store.withLock(async () => {
      const n = await this.getNote(id);
      if (n.state === "resolved") return n;
      n.state = "resolved";
      await this.stet.store.putNote(n);
      await this.stet.store.appendEvent({ type: "note_resolved", agent: n.agent, data: { note: n.id, file: n.file } });
      return n;
    });
  }

  /** Open a resolved note again (from History): the agent is told, if it had it already. */
  async reopenNote(id: string): Promise<Note> {
    return this.stet.store.withLock(async () => {
      const n = await this.getNote(id);
      if (n.state === "open") return n;
      n.state = "open";
      await this.stet.store.putNote(n);
      await this.stet.store.appendEvent({ type: "note_reopened", agent: n.agent, data: { note: n.id, file: n.file } });
      return n;
    });
  }

  /** Hand the agent its open, undelivered notes, located in its workspace as it is now. Under the lock. */
  async deliverNotes(agent: Agent): Promise<DeliveredNote[]> {
    const waiting = (await this.stet.store.notes()).filter((n) => n.agent === agent.id && n.state === "open" && !n.deliveredAt);
    const out: DeliveredNote[] = [];
    for (const n of waiting) {
      const buf = isSafeRepoPath(n.file) ? await readInside(agent.worktree, n.file).catch(() => null) : null;
      const text = buf ? toLf(buf.toString("utf8")) : null;
      const span = text !== null ? this.locateNoteInText(n, text) : null;
      const lines = span && text !== null ? { from: lineOf(text, span.start), to: lineOf(text, Math.max(span.start, span.end - 1)) } : null;
      n.deliveredAt = now();
      await this.stet.store.putNote(n);
      out.push({ note: n, lines });
    }
    return out;
  }
}
