/** Agent instructions (spec §10.3). Shared by the MCP server and the workspace files. */
import type { Agent } from "./model.js";
import { documentProfile, type LanguageProfile } from "./lang/index.js";

/** The document's language, and examples in it (the project's, LaTeX by default). */
const docOf = (p: LanguageProfile = documentProfile()) => ({
  name: p.name,
  terms: p.agentTerms ?? { location: 'main.txt:12 "suggestion"', linked: "a definition and its uses", compiles: "an undefined name is not", reference: "a name with its uses", dependencies: "a definition and its uses, the same symbol renamed" },
});

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

/**
 * `watch`: the shell command that runs `stet watch` here (absolute paths, so it needs no PATH
 * setup). `profile`: the project's language (`documentProfile(cfg)`).
 */
export function agentInstructions(agentId: string, watch = "stet watch", profile?: LanguageProfile): string {
  const doc = () => docOf(profile);
  return `${STET_MARKER}
# You are working under Stet review (agent: ${agentId})

This folder is a *proposal workspace* for a ${doc().name} project. Nothing you change
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
  Locations are "file:line" or "file:from-to" in THIS folder after your edits.
  A paragraph is often a single line: to pick one of several changes on a
  line, add a quoted snippet of its new text, e.g. '${doc().terms.location}'.
  Always do this when the parts of a group share a line, or they can't be
  separated.
  - \`linked\` means all or nothing, which is tiring to review. Use it ONLY
    when accepting some of the edits without the others would break the
    document or lose text:
    ${doc().terms.linked},
    one symbol renamed in several formulas. Stet detects moves, label/ref and citation renames
    itself. Edits that merely serve one goal, are in one section, or read
    better together are NOT linked: make them \`related\` (the reviewer can
    still accept them all at once).
    Stet checks every linked group: if it sees no dependency between all of
    its edits, it makes the group related, links only the edits that need
    each other, and tells you in the submit result. If accepting only some
    really breaks the document in a way Stet can't see, give the group a
    \`reason\` (one sentence, shown to the reviewer) and it stays linked.
    A large linked group is hard to review. Split it into \`parts\` (each with
    a title and its locations) when every part can be accepted on its own:
    accepting one part alone must leave the document compiling
    (${doc().terms.compiles}), and must not
    stop any other part from being accepted later. Make parts as SMALL as
    these two conditions allow: one sentence, one formula, one wording change,
    or ${doc().terms.reference}. Never put changes in one part just
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
    keep them few: up to one changed word in ten is shown as part of the
    move; with more it is a deletion and an insertion (linked), which is
    much harder to check. A single sentence of 7 words or more counts too.
  - \`related\`: thematic batches with a title and rationale, as large as
    makes sense (a section's rewording, a notation change by section).
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
  - note_reopened: the reviewer opened a closed note again; act on it as before.
  - group_partial: the reviewer accepted some parts of a linked group and
    rejected others. The document compiles but may be inconsistent (e.g.
    references to a renamed label); propose what makes it consistent.
- Use \`stet_withdraw\` for proposals you no longer believe in.
- Waiting for the reviewer: don't poll \`stet_status\` in a loop. Run this
  command in the background instead (it only reads, works in the sandbox and
  the guard allows it):
      ${watch}
  It prints one line for each thing that arrives for you (feedback, a note,
  a sync needed) as it happens. Add \`--once\` if your tool wakes you when a
  background command ends rather than when it prints: it then exits after
  the first lines. When a line arrives, act on it (\`stet_get_feedback\`,
  \`stet_sync\`) and start watching again. The same lines are appended to
  \`.stet/inbox\` in this folder (\`tail -n 0 -f .stet/inbox\` works too). They
  are only written while your Stet tools are connected. The same command with
  \`help\` instead of \`watch\` lists Stet's commands; use the Stet tools for
  everything else.
`;
}

/** Short protocol summary sent as MCP server instructions, for a project in `profile`'s language. */
export const mcpInstructions = (profile?: LanguageProfile) => `Stet manages human review of your edits to a ${docOf(profile).name} project.
You work in a proposal workspace (a git worktree); the human's files are never
touched directly. Edit files normally, then call stet_submit with a title and
rationale (and groups: linked for edits that must be accepted together,
with parts for pieces that can each be accepted alone, atomic for edits that
only make sense as one, related for thematic batches). Prefer moving
passages word for word: Stet then shows them to the reviewer as one move.
Before new work call stet_status and stet_sync if needed (sync also
delivers the reviewer's notes on passages). Read
stet_get_feedback and act on rejections, revision requests, comments and
stale items. To wait for the reviewer without polling, run \`stet watch\` in
the background (the exact command is in your instructions file): it prints a
line whenever something arrives, from .stet/inbox in the workspace. Never
reflow text or touch files outside the workspace.`;

/** The summary for a LaTeX project. */
export const MCP_INSTRUCTIONS = mcpInstructions();
