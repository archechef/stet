/** Markdown for hovers and tooltips: a change, a proposal, the reviewer's wording, a diff. No `vscode` import. */
import { describeItem, firstLines, type Item, isLiveItem, lineDiff, partIndexOf, printable, profileByName } from "@stet/core";
import type { TreeModel } from "./model.js";
import { esc, fence, STATUS_TEXT } from "./text.js";

/** The full new text of a proposal, for the editor's inline widget. Agent text: fenced, never rendered. */
export function proposalMarkdown(item: Item): string {
  const lang = profileByName(item.file).fence;
  return `*Proposed text, replacing the struck-through text above:*\n\n${fence(item.newText, lang)}`;
}

/** The reviewer's wording of a change, for hovers: the code block on lines of its own. */
export function draftMarkdown(item: Pick<Item, "draft" | "file">): string {
  return `✎ **Your wording** (from the review of this file), which Accept uses:\n\n${fence(item.draft ?? "", profileByName(item.file).fence)}`;
}

/** A unified-style diff for hovers. */
export function diffBlock(oldText: string, newText: string): string {
  // Several lines on both sides (a .bib entry whose key alone changed): the changed lines with one
  // line around them, not the whole entry twice.
  if (oldText.split("\n").length >= 3 && newText.split("\n").length >= 3) return fence(lineDiff(printable(oldText), printable(newText), 1).join("\n"), "diff");
  const lines = [
    ...(oldText
      ? printable(oldText)
          .split("\n")
          .map((l) => "- " + l)
      : []),
    ...(newText
      ? printable(newText)
          .split("\n")
          .map((l) => "+ " + l)
      : []),
  ];
  return fence(lines.join("\n"), "diff");
}

/** Markdown description of an item (hover, tooltips). */
export function itemMarkdown(item: Item, model: TreeModel): string {
  const cs = model.snap.changesets.find((c) => c.id === item.changeset);
  const d = describeItem(item, model.get);
  const lines = [`**${item.id}** · ${esc(item.agent)} · ${STATUS_TEXT[item.status]}`];
  // A file that takes effect once accepted: said first.
  if (d.effect) lines.push(`⚠ **Takes effect:** ${esc(d.effect)}. Accepting asks to confirm.`);
  if (cs) lines.push(`*${esc(cs.title)}*${cs.rationale ? ` — ${esc(cs.rationale)}` : ""}`);
  if (item.note) lines.push(esc(item.note));
  // A revision: what it revises, and what you asked for there.
  if (d.revises) lines.push(`↻ **Revision of ${d.revises.id}**${d.revises.asked ? `, where you asked: ${esc(d.revises.asked)}` : ""}`);
  if (d.yours?.accepted) lines.push(`✎ **Accepted with your wording:** ${diffBlock(item.oldText, d.yours.text)}\n\nThe agent proposed:`);
  else if (d.yours) lines.push(draftMarkdown({ draft: d.yours.text, file: item.file }));
  for (const gid of item.groups) {
    const g = model.group(gid);
    if (g && g.kind !== "atomic")
      lines.push(`${g.kind === "linked" ? "🔗 linked" : "▣ related"}: ${esc(g.title)} (${g.items.join(", ")})${g.state === "broken" ? " ⚠ broken" : ""}`);
    const k = g ? partIndexOf(g, item.id) : -1;
    if (g && k >= 0) lines.push(`part ${k + 1} of ${g.parts!.length}: ${esc(g.parts![k]!.title)} (${g.parts![k]!.items.join(", ")})`);
  }
  const shown = (ls: readonly string[]) => {
    const { shown, more } = firstLines(ls);
    return shown.join("\n") + (more ? `\n… ${more} more lines` : "");
  };
  if (d.move) {
    const { out, from, to, otherFiles, changed, changes } = d.move;
    lines.push(
      `⇅ **Move**: ${from.join(", ")} remove${out ? " text here" : ""}, ${to.join(", ")} insert${out ? "" : " it here"}${otherFiles.length ? ` (also in ${otherFiles.map(esc).join(", ")})` : ""}. Accepting or rejecting one decides the whole move.`,
    );
    if (changes.length) {
      lines.push(`⚠ **Changed on the way (${changed} word${changed > 1 ? "s" : ""}):** ${changes.map((c) => `“${esc(c.was)}” → “${esc(c.now)}”`).join(", ")}`);
    } else lines.push("Word for word: the text arrives unchanged (spacing and line breaks aside).");
    lines.push(fence(out ? item.oldText : item.newText, profileByName(item.file).fence));
  } else if (item.kind === "modify") lines.push(diffBlock(item.oldText, item.newText));
  else {
    lines.push(`${item.kind} ${esc(item.file)}${item.oldFile ? ` (from ${esc(item.oldFile)})` : ""}`);
    // A whole file's content (its first lines): new files showed only their name.
    const whole = d.whole && (item.kind === "delete-file" ? d.whole.old : d.whole.new);
    if (whole?.length) lines.push(fence(shown(whole), profileByName(item.file).fence));
    // Text with bytes that aren't UTF-8: its changed lines, the bytes marked.
    if (d.bytes)
      lines.push("Not UTF-8 text: bytes that aren't UTF-8 are shown as ⟨0x..⟩; accepting writes the file byte for byte.", fence(shown(d.bytes), "diff"));
  }
  // A decided change shows its whole conversation (History's tooltip showed only three messages,
  // and later replies were lost); a pending one the latest three, as more is in its comment thread.
  const last = isLiveItem(item) ? item.thread.slice(-3) : item.thread;
  if (last.length < item.thread.length)
    lines.push(`*${item.thread.length - last.length} earlier message${item.thread.length - last.length === 1 ? "" : "s"} in the comment thread*`);
  if (last.length) lines.push(last.map((t) => `> **${t.author === "user" ? "You" : esc(item.agent)}:** ${esc(t.text)}`).join("\n>\n"));
  return lines.join("\n\n");
}
