/**
 * MCP server for agents (spec §10.1): newline-delimited JSON-RPC 2.0 over stdio.
 * Dependency-free; implements initialize, ping, tools/list and tools/call.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { GroupHint, NoteHint } from "./grouping.js";
import { MCP_INSTRUCTIONS } from "./instructions.js";
import type { GroupKind, Item, ItemStatus, StetEvent } from "./model.js";
import { Stet, StetError } from "./service.js";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const whereSchema = {
  type: "array",
  items: { type: "string" },
  description: 'Locations in YOUR workspace after editing: "file", "file:line" or "file:from-to" (1-based lines).',
};

export const TOOLS: ToolDef[] = [
  {
    name: "stet_status",
    description: "Your agent status: item counts, unread feedback, and whether the document changed so that you must call stet_sync before new work.",
    inputSchema: obj({}),
  },
  {
    name: "stet_submit",
    description:
      "Submit your current edits in this workspace for human review. Stet splits them into reviewable items. " +
      "Group edits that must be accepted together as 'linked' (REQUIRED e.g. for label/ref renames, macro definition + uses, " +
      "citation keys), edits that only read well together as 'atomic', and thematic batches as 'related'.",
    inputSchema: obj(
      {
        title: str("Short title of this batch of changes."),
        rationale: str("Why these changes improve the document."),
        groups: {
          type: "array",
          items: obj(
            {
              kind: { type: "string", enum: ["linked", "atomic", "related"] },
              title: str("What the group does."),
              rationale: str("Optional explanation."),
              where: whereSchema,
            },
            ["kind", "title", "where"],
          ),
        },
        notes: {
          type: "array",
          description: "Per-change explanations shown to the reviewer.",
          items: obj({ where: whereSchema, note: str("Explanation for the reviewer.") }, ["where", "note"]),
        },
      },
      ["title"],
    ),
  },
  {
    name: "stet_sync",
    description:
      "Move your workspace onto the latest document: accepted changes become part of it, rejected/withdrawn ones disappear, " +
      "pending ones stay on top. Requires all edits to be submitted (or discarded) first.",
    inputSchema: obj({}),
  },
  {
    name: "stet_get_feedback",
    description:
      "New reviewer feedback since your last call: accepted (possibly with edited text), rejected (with reason), " +
      "revision requests, comments, stale items (text changed underneath) and broken linked groups.",
    inputSchema: obj({ ack: { type: "boolean", description: "Mark the feedback as read (default true)." } }),
  },
  {
    name: "stet_list",
    description: "List your items, optionally filtered by status (pending, needs_revision, accepted, rejected, withdrawn, superseded, stale) or file.",
    inputSchema: obj({
      status: { type: "array", items: { type: "string" } },
      file: str("Only items in this file."),
    }),
  },
  {
    name: "stet_show",
    description: "Show one item (S12) with its text, note, groups and discussion thread, or a group (G3) with its members.",
    inputSchema: obj({ id: str("Item id like S12 or group id like G3.") }, ["id"]),
  },
  {
    name: "stet_reply",
    description: "Reply to the reviewer's comment on one of your items.",
    inputSchema: obj({ itemId: str("Item id, e.g. S12."), text: str("Your reply.") }, ["itemId", "text"]),
  },
  {
    name: "stet_withdraw",
    description: "Withdraw your own pending items that you no longer propose.",
    inputSchema: obj({ itemIds: { type: "array", items: { type: "string" } }, reason: str("Optional reason.") }, ["itemIds"]),
  },
  {
    name: "stet_group",
    description: "Group already-submitted items: 'linked' (accept all or none), 'atomic' (merge into one item, same paragraph), or 'related'.",
    inputSchema: obj(
      {
        itemIds: { type: "array", items: { type: "string" } },
        kind: { type: "string", enum: ["linked", "atomic", "related"] },
        title: str("What the group does."),
        rationale: str("Optional explanation."),
      },
      ["itemIds", "kind", "title"],
    ),
  },
  {
    name: "stet_ungroup",
    description: "Remove one of your groups (including groups Stet detected automatically).",
    inputSchema: obj({ groupId: str("Group id, e.g. G3.") }, ["groupId"]),
  },
];

// ---------------------------------------------------------------------------
// Text formatting for the model

const clip = (s: string, n = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

function itemLine(i: Item): string {
  const change = i.kind !== "modify" ? `${i.kind}` : `"${clip(i.oldText, 60)}" → "${clip(i.newText, 60)}"`;
  return `${i.id} [${i.status}] ${i.file}: ${change}${i.groups.length ? ` (groups ${i.groups.join(",")})` : ""}`;
}

export function describeFeedback(e: StetEvent): string {
  const d = (e.data ?? {}) as any;
  const it = d.item ? `${d.item.id} (${d.item.file}:${d.item.line}, "${clip(d.item.oldText, 50)}" → "${clip(d.item.newText, 50)}")` : (e.items ?? []).join(", ");
  switch (e.type) {
    case "accepted":
      return `ACCEPTED ${it}${d.finalText !== undefined ? `; the reviewer edited it to: "${clip(d.finalText, 300)}"` : ""}`;
    case "rejected":
      return `REJECTED ${it}${d.reason ? `; reason: ${d.reason}` : ""}. Do not propose this change again.`;
    case "revision_requested":
      return `REVISION REQUESTED for ${it}: ${d.comment}`;
    case "comment":
      return `COMMENT on ${it}: ${d.text} (answer with stet_reply)`;
    case "stale":
      return `STALE ${it}: ${d.reason}.${d.currentText ? ` Current text around it: "${clip(d.currentText, 400)}"` : ""} Re-propose if still relevant.`;
    case "repeat_rejected":
      return `AUTO-REJECTED ${it}: it repeats an earlier rejected change (${d.previous}).`;
    case "group_broken":
      return `LINKED GROUP BROKEN ${e.group} "${d.title}": ${(d.members ?? []).map((m: any) => `${m.id}=${m.status}`).join(", ")}. Make the document consistent again.`;
    default:
      return `${e.type} ${it}`;
  }
}

// ---------------------------------------------------------------------------

export interface McpOptions {
  /** Folder the server runs in (normally the agent workspace). */
  cwd: string;
  /** Explicit workspace (STET_WORKSPACE) and agent id (STET_AGENT) overrides. */
  workspace?: string;
  agentId?: string;
  version: string;
}

export class StetMcpServer {
  private stet: Stet | null = null;

  constructor(private readonly opts: McpOptions) {}

  private async context(): Promise<{ stet: Stet; agent: string }> {
    const where = this.opts.workspace ?? this.opts.cwd;
    this.stet ??= await Stet.open(where);
    const agent = this.opts.agentId ?? (await this.stet.agentForCwd(where)).id;
    return { stet: this.stet, agent };
  }

  /** Handle one JSON-RPC message; returns the response, or null for notifications. */
  async handle(msg: JsonRpcRequest): Promise<object | null> {
    const isNotification = msg.id === undefined || msg.id === null;
    const reply = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) => (isNotification ? null : { jsonrpc: "2.0", id: msg.id, error: { code, message } });
    try {
      switch (msg.method) {
        case "initialize": {
          const requested = msg.params?.protocolVersion;
          return reply({
            protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "stet", title: "Stet review", version: this.opts.version },
            instructions: MCP_INSTRUCTIONS,
          });
        }
        case "ping":
          return reply({});
        case "tools/list":
          return reply({ tools: TOOLS });
        case "tools/call":
          return reply(await this.callTool(msg.params?.name, msg.params?.arguments ?? {}));
        default:
          if (msg.method?.startsWith("notifications/")) return null;
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    } catch (e: any) {
      return fail(-32603, e?.message ?? String(e));
    }
  }

  async callTool(name: string, args: any): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: unknown }> {
    const text = (t: string, data?: unknown) => ({
      content: [{ type: "text" as const, text: data === undefined ? t : `${t}\n\n${"```json"}\n${JSON.stringify(data, null, 2)}\n${"```"}` }],
    });
    try {
      if (!TOOLS.some((t) => t.name === name)) return { ...text(`Unknown tool ${name}.`), isError: true };
      const { stet, agent } = await this.context();
      switch (name) {
        case "stet_status": {
          const s = await stet.agentStatus(agent);
          return text(
            [
              `Agent ${agent} on branch ${s.agent.branch}, workspace ${s.agent.worktree}.`,
              `Items: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}.`,
              s.unreadFeedback ? `${s.unreadFeedback} unread feedback event(s): call stet_get_feedback.` : "No unread feedback.",
              s.syncNeeded ? "The document changed since your last sync: call stet_sync before starting new work." : "Your workspace is up to date with the document.",
            ].join("\n"),
          );
        }
        case "stet_submit": {
          const r = await stet.submit(agent, {
            title: String(args.title ?? "Untitled"),
            ...(args.rationale ? { rationale: String(args.rationale) } : {}),
            ...(Array.isArray(args.groups) ? { groups: args.groups as GroupHint[] } : {}),
            ...(Array.isArray(args.notes) ? { notes: args.notes as NoteHint[] } : {}),
          });
          const lines: string[] = [];
          if (r.changeset) lines.push(`Submitted ${r.changeset.id} "${r.changeset.title}" with ${r.items.length} item(s):`, ...r.items.map((i) => "  " + itemLine(i)));
          for (const g of r.groups) lines.push(`Group ${g.id} (${g.kind}${g.source === "auto" ? ", auto-detected" : ""}) "${g.title}": ${g.items.join(", ")}`);
          if (r.ungrouped.length > 1) lines.push(`Ungrouped: ${r.ungrouped.join(", ")}. If some of these must be accepted together, call stet_group.`);
          if (r.superseded.length) lines.push(`Superseded (replaced by your new version): ${r.superseded.join(", ")}`);
          if (r.withdrawn.length) lines.push(`Withdrawn (you removed the change): ${r.withdrawn.join(", ")}`);
          if (r.repeats.length) lines.push(`Auto-rejected because they repeat rejected changes: ${r.repeats.join(", ")}`);
          for (const w of r.warnings) lines.push(`Warning: ${w}`);
          if (r.sync) lines.push(`Your workspace was synced onto the latest document${r.sync.stale.length ? `; stale: ${r.sync.stale.map((s) => s.id).join(", ")}` : ""}.`);
          return text(lines.join("\n"), { changeset: r.changeset?.id ?? null, items: r.items.map((i) => ({ id: i.id, file: i.file, status: i.status, groups: i.groups })), groups: r.groups.map((g) => ({ id: g.id, kind: g.kind, items: g.items })) });
        }
        case "stet_sync": {
          const r = await stet.sync(agent);
          return text(`Synced onto the latest document. ${r.kept} pending item(s) kept.${r.stale.length ? ` Stale (text changed underneath): ${r.stale.map(itemLine).join("; ")}` : ""}`);
        }
        case "stet_get_feedback": {
          const ev = await stet.feedback(agent, { ack: args.ack !== false });
          return text(ev.length ? ev.map(describeFeedback).join("\n") : "No new feedback.");
        }
        case "stet_list": {
          const items = await stet.listItems({
            agent,
            ...(Array.isArray(args.status) && args.status.length ? { status: args.status as ItemStatus[] } : {}),
            ...(args.file ? { file: String(args.file) } : {}),
          });
          return text(items.length ? items.map(itemLine).join("\n") : "No items.");
        }
        case "stet_show": {
          const id = String(args.id ?? "").toUpperCase();
          if (id.startsWith("G")) {
            const g = (await stet.listGroups()).find((x) => x.id === id);
            if (!g) throw new StetError(`Unknown group ${id}.`);
            const members = (await Promise.all(g.items.map((i) => stet.getItem(i)))).filter((x): x is Item => !!x);
            return text([`${g.id} ${g.kind} "${g.title}" (${g.state})`, g.rationale ?? "", ...members.map(itemLine)].filter(Boolean).join("\n"));
          }
          const it = await stet.getItem(id);
          if (!it) throw new StetError(`Unknown item ${id}.`);
          return text(
            [
              itemLine(it),
              it.note ? `Note: ${it.note}` : "",
              `Old text: ${JSON.stringify(it.oldText)}`,
              `New text: ${JSON.stringify(it.newText)}`,
              ...it.thread.map((t) => `${t.author}: ${t.text}`),
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        case "stet_reply": {
          const it = await stet.getItem(String(args.itemId ?? "").toUpperCase());
          if (!it) throw new StetError(`Unknown item ${args.itemId}.`);
          if (it.agent !== agent) throw new StetError(`${it.id} belongs to ${it.agent}.`);
          await stet.comment(it.id, String(args.text ?? ""), "agent");
          return text(`Replied on ${it.id}.`);
        }
        case "stet_withdraw": {
          const w = await stet.withdraw(agent, (args.itemIds ?? []).map(String), args.reason ? String(args.reason) : undefined);
          return text(`Withdrawn: ${w.map((i) => i.id).join(", ")}. They disappear from your workspace at the next stet_sync.`);
        }
        case "stet_group": {
          const r = await stet.group(agent, (args.itemIds ?? []).map(String), args.kind as GroupKind, String(args.title ?? ""), args.rationale ? String(args.rationale) : undefined);
          return text(r.merged ? `Merged into ${itemLine(r.merged)}` : `Created group ${r.group!.id} (${r.group!.kind}): ${r.group!.items.join(", ")}`);
        }
        case "stet_ungroup": {
          await stet.ungroup(String(args.groupId ?? ""), agent);
          return text(`Removed group ${args.groupId}.`);
        }
      }
      return { ...text(`Unknown tool ${name}.`), isError: true };
    } catch (e: any) {
      if (e instanceof StetError) return { ...text(e.message), isError: true };
      return { ...text(`Internal error: ${e?.message ?? e}`), isError: true };
    }
  }
}

/** Serve MCP over newline-delimited JSON on the given streams. Resolves when input ends. */
export async function serveStdio(server: StetMcpServer, input: Readable, output: Writable): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const send = (o: object) => output.write(JSON.stringify(o) + "\n");
  let queue = Promise.resolve();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    // Process in order; Stet operations are serialized by the store lock anyway.
    queue = queue.then(async () => {
      const batch = Array.isArray(msg) ? msg : [msg];
      const out = (await Promise.all(batch.map((m) => server.handle(m)))).filter(Boolean) as object[];
      if (Array.isArray(msg)) {
        if (out.length) send(out);
      } else if (out[0]) send(out[0]);
    });
  }
  await queue;
}
