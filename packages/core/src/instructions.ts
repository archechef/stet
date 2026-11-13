/** Agent instructions (spec §10.3). Shared by the MCP server and the workspace files. */
import type { Agent } from "./model.js";

/** What an agent (and its instruction files) are told once the reviewer archived its workspace. */
export function archivedMessage(agent: Agent): string {
  const a = agent.archived;
  const when = a ? ` on ${a.at.slice(0, 10)}` : "";
  const withdrawn = a?.withdrawn.length
    ? ` Its ${a.withdrawn.length} pending proposal(s) (${a.withdrawn.join(", ")}) were withdrawn and will not be reviewed.`
    : "";
  const folder = a?.worktreeRemoved ? " The workspace folder was deleted." : "";
  return (
    `Stet: the reviewer archived this workspace (agent ${agent.id})${when}.${withdrawn}${folder} ` +
    `Stop working on this task here; nothing done in this workspace reaches the document any more. ` +
    `If there is more to do, tell the user and ask them to create a new agent workspace, then continue there.`
  );
}

export const STET_MARKER = "<!-- stet:instructions -->";

export function agentInstructions(agentId: string): string {
  return `${STET_MARKER}
# You are working under Stet review (agent: ${agentId})

This folder is a *proposal workspace* for a LaTeX project. Nothing you change
here reaches the real document until a human accepts it.

- This file is written by Stet and rewritten at every sync: don't edit it, and
  don't suggest that the reviewer add instructions to it (they would be lost).
- Edit files in this folder normally. Never touch files outside this folder,
  and never run git merge/push/rebase/switch or modify other branches.
- Keep changes minimal and local. Do NOT reflow or rewrap lines, reorder
  unrelated text, or reformat whitespace: every such change is noise for the
  reviewer.
- When a coherent set of changes is done, call the \`stet_submit\` tool (or run
  \`stet submit -t "<title>" -m "<rationale>"\`) with a short title and a
  rationale. Submit in logical batches (e.g. one per section or concern).
  Don't commit yourself or change git config: submitting commits your edits.
- Tell Stet how changes belong together via \`groups\` in \`stet_submit\`.
  Locations are "file:line" or "file:from-to" in THIS folder after your edits:
  - \`linked\`: REQUIRED whenever accepting only some of the edits would break
    or corrupt the document: label/ref renames, macro definition + uses,
    citation keys, notation changed consistently across places.
    A large linked group is hard to review. Split it into \`parts\` (each with
    a title and its locations) when every part can be accepted on its own:
    accepting one part alone must leave the document compiling (warnings such
    as undefined references are fine; an undefined macro is not), and must not
    stop any other part from being accepted later. Make parts as SMALL as
    these two conditions allow: one sentence, one formula, one wording change,
    or a \`\\label\` with its references. Never put changes in one part just
    because they are in the same paragraph or section, or serve the same goal;
    say what they are for in the group's rationale instead. Stet keeps
    identical changes, a definition and its uses, and changes touching the
    same text in one part.
  - \`atomic\`: edits within one sentence/paragraph that only read well together.
  - Moving a passage (sentences, a paragraph, a proof): Stet recognises a
    deletion and an insertion of the same text as one move, and the reviewer
    sees that nothing changed on the way. So strongly prefer moving text word
    for word, and make edits to it in a separate round. If the move itself
    needs small adjustments (a "below" that is now "above", a reference),
    keep them few: up to a few changed words are shown as part of the move,
    more make it an unrelated deletion and insertion that is hard to check.
  - \`related\`: optional thematic batches with a title and rationale.
  Check the submit result and fix groupings with \`stet_group\` / \`stet_ungroup\`.
- Before starting new work, call \`stet_status\`; if it says a sync is needed
  or notes are waiting, call \`stet_sync\` first (it needs a clean folder:
  submit or discard edits; waiting notes arrive even when it refuses).
- Notes from the reviewer (N3) point at a passage and ask for something
  ("shorten this", "check this proof"). Act on them like a request: change
  the passage and submit. Answer with \`stet_reply\` (e.g. \`N3\`) if something
  is unclear or to say what you did.
- Call \`stet_get_feedback\` regularly and act on each event:
  - rejected: do not propose the same change again; learn from the reason.
  - revision_requested: revise that passage, then submit.
  - comment: answer with \`stet_reply\` (and revise if asked).
  - stale: the text changed underneath you; re-propose against the current
    text if still relevant.
  - accepted with edited text: prefer the reviewer's wording from now on.
  - group_broken: some linked edits were applied without the others; propose
    whatever is needed to make the document consistent again.
  - note_comment: the reviewer wrote in a note's thread; answer or act on it.
  - note_resolved: the reviewer closed a note; nothing more to do for it.
  - group_partial: the reviewer accepted some parts of a linked group and
    rejected others. The document compiles but may be inconsistent (e.g.
    references to a renamed label); propose what makes it consistent.
- Use \`stet_withdraw\` for proposals you no longer believe in.
`;
}

/** Short protocol summary sent as MCP server instructions. */
export const MCP_INSTRUCTIONS = `Stet manages human review of your edits to a LaTeX project.
You work in a proposal workspace (a git worktree); the human's files are never
touched directly. Edit files normally, then call stet_submit with a title and
rationale (and groups: linked for edits that must be accepted together,
with parts for pieces that can each be accepted alone, atomic for edits that
only make sense as one, related for thematic batches). Prefer moving
passages word for word: Stet then shows them to the reviewer as one move.
Before new work call stet_status and stet_sync if needed (sync also
delivers the reviewer's notes on passages). Poll
stet_get_feedback and act on rejections, revision requests, comments and
stale items. Never reflow text or touch files outside the workspace.`;
