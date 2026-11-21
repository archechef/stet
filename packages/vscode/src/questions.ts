/** The questions the extension asks, and their answers: before accepting, finishing, archiving. No `vscode` import. */
import { plural, StetError } from "@stet/core";

/** The button of Finish review's question that saves unsaved editors into the commit. */
export const FINISH_SAVE = "Save and commit";

/**
 * Finish review's question: which files are committed, which hold edits of yours that go along,
 * which have unsaved text (not committed unless saved), and that undo ends with the commit.
 */
export function finishQuestion(
  count: number,
  files: string[],
  yourEdits: string[],
  unsaved: string[],
  project = "",
): { message: string; detail: string; buttons: string[] } {
  const list = (xs: string[]) => xs.join(", ");
  const detail = [`Files: ${list(files)}.`];
  if (yourEdits.length) detail.push(`Your own edits in ${list(yourEdits)} are committed too (Stet commits whole files).`);
  if (unsaved.length)
    detail.push(
      `${list(unsaved)} ${unsaved.length === 1 ? "has" : "have"} unsaved edits: “Commit” leaves them out, “${FINISH_SAVE}” saves them into the commit.`,
    );
  detail.push("After the commit, Undo no longer takes these changes back (git revert can).");
  return {
    message: `Commit ${plural(count, "accepted change")}${project ? ` in ${project}` : ""}?`,
    detail: detail.join("\n"),
    buttons: unsaved.length ? ["Commit", FINISH_SAVE] : ["Commit"],
  };
}

/**
 * What to ask when several selected changes are linked with others not selected: take those
 * along (recommended), or decide only the selected ones, which breaks their linked groups.
 */
export function manyQuestion(
  verb: "Accept" | "Reject",
  count: number,
  rest: string[],
  /** Pending changes in other parts of their linked groups: asked about too. */
  otherParts: string[] = [],
): { title: string; choices: { label: string; detail: string; withRest: boolean; withGroups?: boolean }[] } {
  const choices: { label: string; detail: string; withRest: boolean; withGroups?: boolean }[] = [];
  if (rest.length)
    choices.push({ label: `${verb} the ${count} selected and the ${rest.length} linked with them`, detail: "Linked changes belong together.", withRest: true });
  if (otherParts.length)
    choices.push({
      label: `${verb} the ${count} selected and all ${otherParts.length + rest.length} other changes of their linked groups`,
      detail: "Every part at once.",
      withRest: true,
      withGroups: true,
    });
  if (rest.length)
    choices.push({
      label: `${verb} only the ${count} selected (breaks their linked groups)`,
      detail: "The agent is asked to repair the document.",
      withRest: false,
    });
  else
    choices.push({
      label: `${verb} only the ${count} selected`,
      detail: `The other parts of their linked groups (${otherParts.join(", ")}) stay pending: the document is inconsistent until they are accepted too.`,
      withRest: true,
    });
  return { title: `The ${count} selected changes are linked with ${[...rest, ...otherParts].join(", ")}`, choices };
}

export function suggestAgentId(kind: "claude-code" | "codex" | "other", existing: string[]): string {
  const prefix = kind === "claude-code" ? "claude" : kind === "codex" ? "codex" : "agent";
  for (let n = 1; ; n++) if (!existing.includes(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The buttons of the archive dialog, the safe one first (Enter takes it): archiving can't be
 * undone, and deleting the folder came first. `unsubmitted`: files
 * the agent changed and didn't submit, named on the delete button.
 */
export function archiveChoices(unsubmitted: number): { keep: string; del: string; order: string[] } {
  const keep = "Archive, keep folder";
  const del = unsubmitted ? `Archive and delete folder, with ${plural(unsubmitted, "unsubmitted file")}` : "Archive and delete folder";
  return { keep, del, order: [keep, del] };
}

/**
 * The question to ask before deciding several changes at once, or null to go ahead. A round
 * always asks; a group or part asks unless it is linked (its changes must go together anyway).
 * Shift+A asked for a round only, and Shift+R never did.
 */
export function bulkQuestion(verb: "Accept" | "Reject", s: { count: number; what: string; changeset: boolean; linked: boolean }): string | null {
  if (s.count < 2 || (s.linked && !s.changeset)) return null;
  return `${verb} all ${s.count} changes of ${s.what}?`;
}

/** The question before dissolving a group, or null: a linked group's changes can then be decided apart, which can break the document. */
export function dissolveQuestion(g: { id: string; kind: string; title: string }): string | null {
  if (g.kind === "linked")
    return `Dissolve linked group ${g.id} “${g.title}”? Its changes can then be accepted one by one, which can break the document. This can't be undone.`;
  // A related group too: dissolving it can't be undone either.
  if (g.kind === "related") return `Dissolve group ${g.id} “${g.title}”? Its changes are then listed one by one in their round. This can't be undone.`;
  return null;
}

/**
 * Whether to offer the highlighted style: once, in a High Contrast theme, for a file of a Stet
 * project whose proposed text wraps with the line (an inlay hint, which gets no border there).
 */
export function offerContrastStyle(s: { highContrast: boolean; inProject: boolean; wrapsWithLine: boolean; askedBefore: boolean }): boolean {
  return s.highContrast && s.inProject && s.wrapsWithLine && !s.askedBefore;
}

/**
 * What a failed accept offers instead: Reject… and Revise… when the one change accepted can't be
 * found in your file any more, as its More… list does; nothing for other failures.
 */
export function failedAcceptActions(ids: readonly string[], e: unknown): string[] {
  return ids.length === 1 && e instanceof StetError && e.lost.includes(ids[0]!) ? ["Reject…", "Revise…"] : [];
}
