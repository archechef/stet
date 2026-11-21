/** Deciding changes: accept, reject, edit, comment, revise, review a file, finish the review. */
import { type Group, type Item, isLiveItem, itemEffect, partId, pendingInRound, roundOf } from "@stet/core";
import * as vscode from "vscode";
import { acceptAction, acceptQuestion, changeActions, withIcon } from "../actions.js";
import { announce } from "../announce.js";
import { inProject } from "../comments.js";
import type { El } from "../common.js";
import { EDIT_SCHEME, EditFiles } from "../edits.js";
import type { StetExtension } from "../extension.js";
import {
  actionsTitle,
  bulkQuestion,
  dissolveQuestion,
  editedPart,
  editFrame,
  FINISH_SAVE,
  failedAcceptActions,
  finishQuestion,
  fromPanel,
  manyQuestion,
  noLinks,
  oneLine,
  type Ref,
  toLf,
} from "../model.js";
import { previewPlace } from "../preview.js";
import type { Project } from "../project.js";
import { ReviewFiles } from "../review.js";

/** Longest change (one line) edited in an input box; that box shows about this many characters. */
const SHORT_EDIT = 80;

export class ReviewCommands {
  constructor(private readonly ext: StetExtension) {}

  /** Whether the active file has pending changes (the editor title's Review button). */
  async updateFileContext(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const p = uri && this.ext.projectFor(uri);
    const rel = p?.relPath(uri!);
    const has = !!rel && p!.snapshot.items.some((i) => i.file === rel && i.kind === "modify" && isLiveItem(i));
    await vscode.commands.executeCommand("setContext", "stet.fileHasChanges", has);
  }

  /** Open the review of a file: the file now ↔ the file with all its pending changes, editable. */
  async reviewFile(arg: unknown): Promise<void> {
    let p: Project | undefined;
    let file: string | null | undefined;
    if (arg instanceof vscode.Uri) {
      p = this.ext.projectFor(arg);
      file = p?.relPath(arg);
    } else if (arg !== undefined) {
      const t = await this.ext.targetItem(arg);
      if (t) [p, file] = [t.project, t.item.file];
    } else {
      const uri = vscode.window.activeTextEditor?.document.uri;
      p = uri && this.ext.projectFor(uri);
      file = p && uri ? p.relPath(uri) : undefined;
    }
    if (!p || !file) return void vscode.window.showInformationMessage("Open a file of a Stet project, or select one of its changes in the Stet panel.");
    const live = p.snapshot.items.filter((i) => i.file === file && i.kind === "modify" && isLiveItem(i)).length;
    if (!live) return void vscode.window.showInformationMessage(`${file} has no pending changes.`);
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.ext.navigation.diffLeft(p, file),
      ReviewFiles.uriFor(p, file),
      `${file}${inProject(p)}: yours ↔ ${live} proposed change${live === 1 ? "" : "s"} (editable)`,
      { preview: false, viewColumn: this.ext.navigation.columnFor(ReviewFiles.uriFor(p, file)) },
    );
  }

  /** An action from a review document: its unsaved edits first, so a decision uses what the user sees. */
  async reviewRun(uri: string, command: string, args: unknown[] = []): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (doc?.isDirty && !(await doc.save())) return; // the save failed (and said why)
    await vscode.commands.executeCommand(command, ...args);
  }

  /** ✓ Accept in a review document: its unsaved edits first, so the accept uses what the user sees. */
  async reviewAccept(uri: vscode.Uri, ref: unknown): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc?.isDirty && !(await doc.save())) return; // the save failed (and said why)
    await this.accept(ref);
  }

  /** Drop the user's wording for a change: the agent's text again. */
  async clearDraft(arg: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (t) await this.ext.run(t.project, () => t.project.stet.clearDraft(t.item.id));
  }

  async accept(arg: unknown, all?: unknown): Promise<void> {
    const many = this.selectedMany(arg, all);
    if (many) return this.acceptMany(many.project, many.items, fromPanel(arg));
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const c = await this.acceptWhat(p, item);
    if (c) await this.ext.panel.decide(p, item.id, fromPanel(arg), () => this.doAccept(p, c.ids, { overrideLinked: c.overrideLinked }));
  }

  /**
   * What to accept with `item`: itself (with the other half of its move), or, if it is linked with
   * other pending changes, what the user picks (`acceptQuestion`). Undefined if they cancelled.
   */
  private async acceptWhat(p: Project, item: Item): Promise<{ ids: string[]; overrideLinked: boolean } | undefined> {
    const q = acceptQuestion(this.ext.model(p), item);
    if (!q) return { ids: this.ext.model(p).withMove(item), overrideLinked: false };
    const pick = await vscode.window.showQuickPick(
      q.choices.map((c) => ({ label: c.label, detail: c.detail, c })),
      { title: q.title },
    );
    return pick?.c;
  }

  /**
   * The pending changes selected in the panel, when there are several: a menu or button of a row
   * passes the selection as its second argument, a key in the panel uses the panel's selection.
   * Undefined for one change, so the usual one-change path runs.
   */
  /**
   * With several changes selected, an action that takes one says which one it took: Revise,
   * Comment, Edit and Diff acted on one without a word (test report 5e4c6af, multi-select).
   */
  onlyOne(action: string, item: Item, arg: unknown, all: unknown): void {
    const els: El[] = Array.isArray(all) ? (all as El[]) : arg === "panel" ? [...this.ext.tree.selection] : [];
    const n = els.filter((e) => e?.node?.type === "item").length;
    if (n > 1) announce(`$(info) ${action} takes one change at a time: ${item.id}, not the other ${n - 1} selected.`, 6000);
  }

  private selectedMany(arg: unknown, all: unknown): { project: Project; items: Item[] } | undefined {
    const els: El[] = Array.isArray(all) ? (all as El[]) : arg === "panel" ? [...this.ext.tree.selection] : [];
    const items = els.filter((e) => e?.node?.type === "item" && isLiveItem((e.node as { item: Item }).item));
    if (items.length < 2) return undefined;
    const project = items[0]!.project;
    if (items.some((e) => e.project !== project)) {
      void vscode.window.showInformationMessage("Select changes of one project at a time.");
      return { project, items: [] };
    }
    return {
      project,
      items: items.map((e) => this.ext.model(project).item((e.node as { item: Item }).item.id)).filter((i): i is Item => !!i && isLiveItem(i)),
    };
  }

  /** Accept several selected changes; asks whether to take along what they are linked with. */
  private async acceptMany(p: Project, items: Item[], panel: boolean): Promise<void> {
    if (!items.length) return;
    const ids = [...new Set(items.flatMap((i) => this.ext.model(p).withMove(i)))];
    const rest = this.ext.model(p).linkedRest(ids);
    // Other parts of their groups too, as a single Accept asks: a label's part was accepted
    // without its references, unasked (test report 5e4c6af, D2).
    const others = this.ext.model(p).otherParts(ids);
    let take = ids;
    let overrideLinked = false;
    if (rest.length || others.length) {
      const q = manyQuestion(
        "Accept",
        ids.length,
        rest.map((r) => r.id),
        others.map((o) => o.id),
      );
      const pick = await vscode.window.showQuickPick(q.choices, { title: q.title });
      if (!pick) return;
      if (pick.withRest) take = [...ids, ...rest.map((r) => r.id), ...(pick.withGroups ? others.map((o) => o.id) : [])];
      else overrideLinked = true;
    }
    await this.ext.panel.decide(p, ids[0]!, panel, () => this.doAccept(p, take, { overrideLinked }));
  }

  /** Reject several selected changes with one reason; asks about what they are linked with. */
  private async rejectMany(p: Project, items: Item[], panel: boolean): Promise<void> {
    if (!items.length) return;
    const ids = [...new Set(items.flatMap((i) => this.ext.model(p).withMove(i)))];
    const rest = this.ext.model(p).linkedRest(ids);
    let mode: "all" | "only" | undefined;
    if (rest.length) {
      const q = manyQuestion(
        "Reject",
        ids.length,
        rest.map((r) => r.id),
      );
      const pick = await vscode.window.showQuickPick(q.choices, { title: q.title });
      if (!pick) return;
      mode = pick.withRest ? "all" : "only";
    }
    const reason = await this.reason(`Reject ${ids.length} changes`);
    if (reason === undefined) return;
    await this.ext.panel.decide(p, ids[0]!, panel, () =>
      this.ext.run(p, async () => {
        const r = await p.stet.reject(ids, { ...(reason ? { reason } : {}), ...(mode ? { mode } : {}) });
        const warnings = await p.stet.partlyDecided(r);
        this.ext.undos.noteDecision(
          p,
          r.map((i) => i.id),
          "rejection",
        );
        if (warnings.length)
          void vscode.window.showWarningMessage([`Rejected ${r.map((i) => i.id).join(", ")}${this.ext.replies.inWhich(p)}.`, ...warnings].join(" "));
        else announce(`$(close) Rejected ${r.map((i) => i.id).join(", ")}${this.ext.replies.inWhich(p)}`, 4000);
      }),
    );
  }

  /** Accept only this change of a linked group (breaks it; the agent is asked to repair it). */
  async acceptOnly(arg: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const own = this.ext.model(p).withMove(item);
    const rest = this.ext.model(p).linkedRest(own);
    await this.ext.panel.decide(p, item.id, fromPanel(arg), () => this.doAccept(p, own, { overrideLinked: rest.length > 0 }));
  }

  /** More…: every action on a change, the same list as in its hover and under Ctrl+. in the editor. */
  async changeActions(arg: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const actions = changeActions(this.ext.model(p), p.mainPath, item, {
      previews: previewPlace() !== "off",
      lost: !(await this.ext.panel.placeOf(p, item)).found,
    });
    type Pick = vscode.QuickPickItem & { action?: (typeof actions)[number] };
    const items: Pick[] = [];
    actions.forEach((a, i) => {
      if (i > 0 && actions[i - 1]!.tier !== a.tier) items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
      items.push({
        label: withIcon(a),
        description: a.key ? `${a.key === a.key.toUpperCase() ? "Shift+" : ""}${a.key.toUpperCase()} in the panel` : undefined,
        detail: a.detail,
        action: a,
      });
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: actionsTitle(item, this.ext.model(p).get),
      placeHolder: "What to do with this change",
      matchOnDetail: true,
    });
    if (pick?.action) await vscode.commands.executeCommand(pick.action.command, ...pick.action.args);
  }

  /** What an item must be decided with: "the linked group" or "part 2 “Section 3”". */
  private unitName(p: Project, item: Item): string {
    const part = this.ext.model(p).partOf(item);
    return part ? `part ${part.index + 1} “${part.group.parts![part.index]!.title}”` : "the linked group";
  }

  private async doAccept(
    p: Project,
    ids: string[],
    opts: { overrideLinked?: boolean; edited?: Record<string, string>; confirmEffects?: boolean } = {},
  ): Promise<void> {
    // Files that take effect once accepted (a latexmkrc, .gitattributes, AGENTS.md…): asked
    // explicitly, with what they set off (security report 5e4c6af, S12).
    const effects = ids.map((id) => this.ext.model(p).item(id)).filter((it): it is Item => !!it && !!itemEffect(it));
    if (effects.length) {
      const ok = `Accept ${effects.length > 1 ? "them" : "it"}`;
      const pick = await vscode.window.showWarningMessage(
        `${effects.map((i) => i.id).join(", ")} ${effects.length > 1 ? "change files that take" : "changes a file that takes"} effect once accepted.`,
        { modal: true, detail: effects.map((i) => `${i.id} ${i.file}: ${itemEffect(i)}.`).join("\n") + "\n\nLook at the content first (Diff, or the hover)." },
        ok,
      );
      if (pick !== ok) return;
      opts = { ...opts, confirmEffects: true };
    }
    const files = ids.flatMap((id) => {
      const it = this.ext.model(p).item(id);
      return it ? [it.file, ...(it.oldFile ? [it.oldFile] : [])] : [];
    });
    // Your wording typed in a Review-file or change tab and not saved yet: saved first, so the
    // accept uses it (test report v0.16.0, D4). A save it refuses stops the accept.
    if (!(await this.ext.saveWording(p, ids, files))) return;
    await this.ext.run(p, async () => {
      // Your unsaved edits of these files are saved only for an accept that will work (D7).
      try {
        await p.stet.checkAccept(ids, { ...opts, unsaved: this.ext.unsavedTexts(p, files) });
      } catch (e) {
        if (this.offerInstead(p, ids, e)) return;
        throw e;
      }
      await this.ext.saveFiles(p, files);
      const r = await p.stet.accept(ids, opts);
      this.ext.undos.noteDecision(
        p,
        r.accepted.map((i) => i.id),
        "accept",
      );
      const msg = [
        `Accepted ${r.accepted.map((i) => i.id).join(", ")}${this.ext.replies.inWhich(p)}${r.committed ? ` (committed ${r.committed.slice(0, 7)})` : ""}.`,
      ];
      if (r.stale.length) msg.push(`Now stale (overlapped): ${r.stale.map((i) => i.id).join(", ")}.`);
      msg.push(...r.warnings);
      if (r.warnings.length) void vscode.window.showWarningMessage(noLinks(msg.join(" ")));
      else announce(`$(check) ${msg.join(" ")}`, 4000);
    });
  }

  /**
   * A change that can't be found in your file any more: the failed accept offers Reject… and
   * Revise…, as its More… list does (test report 5e4c6af). False for other failures.
   */
  private offerInstead(p: Project, ids: string[], e: unknown): boolean {
    const instead = failedAcceptActions(ids, e);
    if (!instead.length) return false;
    const ref: Ref = { path: p.mainPath, id: ids[0]! };
    void vscode.window.showErrorMessage(noLinks((e as Error).message), ...instead).then((pick) => {
      if (pick) void vscode.commands.executeCommand(pick === "Reject…" ? "stet.reject" : "stet.revise", ref);
    });
    return true;
  }

  /**
   * The pending changes a group, a changeset, or a change's group stands for (Accept all /
   * Reject all). Tells the user and returns undefined when there is nothing to act on.
   */
  private async scope(arg: unknown): Promise<{ project: Project; ids: string[]; what: string; changeset: boolean; linked: boolean } | undefined> {
    const t = await this.ext.target(arg);
    if (!t?.node) return undefined;
    const p = t.project;
    const model = this.ext.model(p);
    let n = t.node;
    if (n.type === "item") {
      const it = n.item;
      const g = model.linkedGroup(it) ?? it.groups.map((x) => model.group(x)).find((x): x is Group => !!x && x.kind !== "atomic");
      if (!g) return void vscode.window.showInformationMessage(`${it.id} is not part of a group.`);
      n = { type: "group", group: g };
    }
    if (n.type === "part") {
      const g = n.group;
      const ids = model
        .partMembers(g, n.index)
        .filter(isLiveItem)
        .map((i) => i.id);
      const what = `${partId(g.id, n.index)} “${g.parts?.[n.index]?.title ?? ""}”`;
      return ids.length ? { project: p, ids, what, changeset: false, linked: true } : void vscode.window.showInformationMessage(`Nothing pending in ${what}.`);
    }
    if (n.type === "group") {
      const ids = model
        .members(n.group)
        .filter(isLiveItem)
        .map((i) => i.id);
      return ids.length
        ? { project: p, ids, what: `${n.group.id} “${n.group.title}”`, changeset: false, linked: n.group.kind === "linked" }
        : void vscode.window.showInformationMessage(`Nothing pending in ${n.group.id}.`);
    }
    if (n.type === "changeset") {
      const cs = n.changeset;
      const ids = pendingInRound(p.snapshot.items, cs.id).map((i) => i.id);
      return ids.length
        ? { project: p, ids, what: `round ${roundOf(cs.id)} “${cs.title}”`, changeset: true, linked: false }
        : void vscode.window.showInformationMessage(`Nothing pending in round ${roundOf(cs.id)}.`);
    }
    return undefined;
  }

  async acceptAll(arg: unknown): Promise<void> {
    const s = await this.scope(arg);
    if (!s) return;
    let ids = s.ids;
    if (s.changeset)
      ids = [
        ...ids,
        ...this.ext
          .model(s.project)
          .linkedRest(ids)
          .map((i) => i.id),
      ];
    const ask = bulkQuestion("Accept", { ...s, count: ids.length });
    if (ask && (await vscode.window.showWarningMessage(ask, { modal: true }, "Accept all")) !== "Accept all") return;
    await this.ext.panel.decide(s.project, s.ids[0]!, fromPanel(arg), () => this.doAccept(s.project, ids));
  }

  private async reason(prompt: string): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: prompt,
      prompt: "Optional, but it helps the agent: why? (Enter to skip)",
      placeHolder: "e.g. keep the original formula",
    });
  }

  async reject(arg: unknown, all?: unknown): Promise<void> {
    const many = this.selectedMany(arg, all);
    if (many) return this.rejectMany(many.project, many.items, fromPanel(arg));
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    const own = this.ext.model(p).withMove(item);
    const rest = this.ext.model(p).linkedRest(own);
    let mode: "all" | "revise-rest" | "only" | undefined;
    if (rest.length) {
      const picks = [
        { label: `Reject all ${rest.length + own.length} changes of ${this.unitName(p, item)}`, mode: "all" as const },
        { label: `Reject ${own.join(" + ")}, ask the agent to revise the rest`, mode: "revise-rest" as const },
        { label: `Reject only ${own.join(" + ")}`, mode: "only" as const, detail: "Breaks the linked group; the agent is asked to repair the document." },
      ];
      const pick = await vscode.window.showQuickPick(picks, { title: `${item.id} is linked with ${rest.map((r) => r.id).join(", ")}` });
      if (!pick) return;
      mode = pick.mode;
    }
    const reason = await this.reason(`Reject ${item.id}`);
    if (reason === undefined) return;
    await this.ext.panel.decide(p, item.id, fromPanel(arg), () =>
      this.ext.run(p, async () => {
        const r = await p.stet.reject(own, { ...(reason ? { reason } : {}), ...(mode ? { mode } : {}) });
        const warnings = await p.stet.partlyDecided(r);
        this.ext.undos.noteDecision(
          p,
          r.map((i) => i.id),
          "rejection",
        );
        if (warnings.length)
          void vscode.window.showWarningMessage([`Rejected ${r.map((i) => i.id).join(", ")}${this.ext.replies.inWhich(p)}.`, ...warnings].join(" "));
        else announce(`$(close) Rejected ${r.map((i) => i.id).join(", ")}${this.ext.replies.inWhich(p)}`, 4000);
      }),
    );
  }

  async rejectAll(arg: unknown): Promise<void> {
    const s = await this.scope(arg);
    if (!s) return;
    const ask = bulkQuestion("Reject", { ...s, count: s.ids.length });
    if (ask && (await vscode.window.showWarningMessage(ask, { modal: true }, "Reject all")) !== "Reject all") return;
    const reason = await this.reason(`Reject all ${s.ids.length} changes of ${s.what}`);
    if (reason === undefined) return;
    const p = s.project;
    await this.ext.panel.decide(p, s.ids[0]!, fromPanel(arg), () =>
      this.ext.run(p, async () => {
        const r = await p.stet.reject(s.ids, { ...(reason ? { reason } : {}), mode: "all" });
        this.ext.undos.noteDecision(
          p,
          r.map((i) => i.id),
          "rejection",
        );
        announce(`$(close) Rejected ${r.map((i) => i.id).join(", ")}${this.ext.replies.inWhich(p)}`, 4000);
      }),
    );
  }

  async edit(arg: unknown, all?: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    this.onlyOne("Edit & accept", t.item, arg, all);
    const { project: p, item } = t;
    if (item.kind !== "modify") return void vscode.window.showInformationMessage(`${item.id} changes a whole file; it can only be accepted or rejected.`);
    // Your wording, if you have one (from a review document).
    let start = item.draft ?? item.newText;
    // The input box shows one line of about 80 characters: anything longer is edited in a tab,
    // and the box can hand over to one (keeping what was typed).
    if (!start.includes("\n") && start.length <= SHORT_EDIT) {
      const r = await this.editInBox(item, start);
      if (r === undefined) return;
      if (typeof r !== "string" && "save" in r) {
        // Your wording, kept for later; the change stays pending.
        await this.ext.run(p, async () => {
          if (await p.stet.setDraft(item.id, r.save)) announce(`$(edit) Your wording for ${item.id} is saved; still pending: accept when ready`, 6000);
        });
        return;
      }
      if (typeof r !== "string") start = r.inTab;
      else {
        const text = r;
        // Linked with other changes: ask what to take along, as Accept does (test report v0.16.0, D5).
        const c = await this.acceptWhat(p, item);
        if (!c) return;
        return this.ext.panel.decide(p, item.id, fromPanel(arg), () =>
          this.doAccept(p, c.ids, { overrideLinked: c.overrideLinked, edited: { [item.id]: toLf(text) } }),
        );
      }
    }
    await this.editInTab(p, item, start);
  }

  /** Save the wording in a change's editor (it stays pending). */
  async editSave(uri: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
    if (!doc) return;
    if (doc.isDirty) await doc.save();
    else announce("$(edit) Nothing changed since the last save", 3000);
  }

  /** Back to the agent's text in a change's editor (and drop your wording). */
  async editReset(arg: unknown): Promise<void> {
    const uri = typeof arg === "string" ? vscode.Uri.parse(arg) : arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== EDIT_SCHEME) return;
    const { project: p, item } = this.ext.edits.target(uri);
    if (!item) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const e = new vscode.WorkspaceEdit();
    e.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), item.newText);
    await vscode.workspace.applyEdit(e);
    await doc.save();
    await p.refresh();
  }

  /** Accept the change of the active change editor, with its wording (the title bar's ✓). */
  async editAccept(arg: unknown): Promise<void> {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== EDIT_SCHEME) return;
    const { project: p, item } = this.ext.edits.target(uri);
    if (!item) return;
    const a = acceptAction(this.ext.model(p), p.mainPath, item);
    await this.reviewRun(uri.toString(), a.command, a.args);
  }

  /**
   * Edit a short change in an input box: the text to accept it with, `{ save }` to keep it as your
   * wording, `{ inTab }` to continue in a tab, or undefined if cancelled. The box holds the change
   * in the words around it on its line, with the change selected: only that part can be edited.
   */
  private editInBox(item: Item, text: string): Promise<string | { inTab: string } | { save: string } | undefined> {
    const frame = editFrame(item);
    const box = vscode.window.createInputBox();
    box.title = `Edit ${item.id} before accepting`;
    box.prompt = `${item.oldText ? `Replaces “${oneLine(item.oldText, 200)}”. ` : ""}The selected part is the change; the words around it stay as they are. Enter accepts.`;
    box.value = frame.pre + text + frame.post;
    box.valueSelection = [frame.pre.length, frame.pre.length + text.length];
    box.placeholder = "Enter accepts with this wording";
    const outside = "Only the change can be edited here, not the words around it: edit your file for those.";
    const save: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("save"), tooltip: "Save wording without accepting (the change stays pending)" };
    const toTab: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("go-to-file"), tooltip: "Edit in a tab (for longer text)" };
    box.buttons = [save, toTab];
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: string | { inTab: string } | { save: string } | undefined) => {
        if (done) return;
        done = true;
        resolve(r);
        box.dispose();
      };
      const part = () => editedPart(frame, box.value);
      box.onDidChangeValue(() => (box.validationMessage = part() === null ? outside : undefined));
      box.onDidAccept(() => {
        const t = part();
        if (t !== null) finish(t);
      });
      box.onDidTriggerButton((b) => {
        const t = part();
        if (t === null) return;
        finish(b === save ? { save: t } : { inTab: t });
      });
      box.onDidHide(() => finish(undefined));
      box.show();
    });
  }

  /**
   * Edit a change's wording in an editor of its own (edits.ts): Ctrl+S keeps it, the change stays
   * pending; Accept above the text or in the title bar accepts it with it. `text`: what to start
   * from, if not the saved wording (typed in the input box first).
   */
  private async editInTab(p: Project, item: Item, text: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(EditFiles.uriFor(p, item));
    const ed = await vscode.window.showTextDocument(doc, { preview: false, viewColumn: this.ext.navigation.columnFor(doc.uri) });
    if (toLf(doc.getText()) !== text) await ed.edit((e) => e.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));
  }

  async comment(arg: unknown, all?: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    this.onlyOne("Comment", t.item, arg, all);
    const text = await vscode.window.showInputBox({
      title: `Comment on ${t.item.id}`,
      prompt: "The agent sees this with its feedback and can reply.",
      placeHolder: "Message to the agent…",
    });
    if (!text) return;
    const ok = await this.ext.run(t.project, async () => {
      await t.project.stet.comment(t.item.id, text, "user");
      return true;
    });
    if (ok) announce(`$(comment) Comment on ${t.item.id} sent: the agent gets it with its feedback, and can reply.`);
  }

  async revise(arg: unknown, all?: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    this.onlyOne("Revise", t.item, arg, all);
    const text = await vscode.window.showInputBox({
      title: `Request a revision of ${t.item.id}`,
      prompt: "What should the agent change?",
      placeHolder: "e.g. shorter, and keep the term “ansatz”",
    });
    if (!text) return;
    await this.ext.panel.decide(t.project, t.item.id, fromPanel(arg), () =>
      this.ext.run(t.project, async () => {
        await t.project.stet.requestRevision(t.item.id, text);
        // Undoable like the other decisions: `u` after `v` undid an older accept (test report v0.16.0, B5).
        this.ext.undos.noteDecision(t.project, [t.item.id], "revision request");
        announce(`$(sync) Revision of ${t.item.id}${this.ext.replies.inWhich(t.project)} requested: it waits for the agent's new version.`);
      }),
    );
  }

  async ungroup(arg: unknown): Promise<void> {
    const t = await this.ext.target(arg);
    if (t?.node?.type !== "group") return;
    const g = t.node.group;
    const ask = dissolveQuestion(g);
    if (ask && (await vscode.window.showWarningMessage(ask, { modal: true }, "Dissolve")) !== "Dissolve") return;
    await this.ext.run(t.project, () => t.project.stet.ungroup(g.id));
  }

  async finishReview(): Promise<void> {
    // Only projects with something to commit: asking "Which project?" for one was a needless step (test report v0.16.0).
    const ps = this.ext.allProjects().filter((x) => x.snapshot.uncommitted.length);
    if (!ps.length) return void vscode.window.showInformationMessage("Nothing to commit: all accepted changes are committed.");
    const p =
      ps.length === 1
        ? ps[0]!
        : (
            await vscode.window.showQuickPick(
              ps.map((x) => ({ label: x.name, description: `${x.snapshot.uncommitted.length} accepted, not committed`, detail: x.mainPath, x })),
              { title: "Finish the review of which project?" },
            )
          )?.x;
    if (!p) return;
    const items = p.snapshot.uncommitted;
    const files = [...new Set(items.flatMap((i) => [i.file, ...(i.oldFile ? [i.oldFile] : [])]))];
    const preview = await this.ext.run(p, () => p.stet.commitPreview());
    if (!preview) return;
    // What the commit takes, said before it happens: your own edits in these files, and that undo
    // ends here. Unsaved text is not committed unless you choose to save it (test report v0.16.0, D6).
    const unsaved = Object.keys(this.ext.unsavedTexts(p, files));
    const q = finishQuestion(preview.items.length, files, preview.yourEdits, unsaved, this.ext.replies.inWhich(p).replace(/^ in /, ""));
    const ok = await vscode.window.showWarningMessage(q.message, { modal: true, detail: q.detail }, ...q.buttons);
    if (!ok) return;
    const { subject } = await p.stet.commitMessage(items);
    const edited = await vscode.window.showInputBox({
      title: "Commit message",
      value: subject,
      prompt: "Summary line. Stet adds the list of accepted changes below it.",
      validateInput: (v) => (v.trim() ? undefined : "Enter a summary line."),
    });
    if (edited === undefined) return;
    await this.ext.run(p, async () => {
      if (ok === FINISH_SAVE) await this.ext.saveFiles(p, files);
      const r = await p.stet.commitAcceptedItems({ subject: edited });
      if (r.commit) this.ext.undos.forgetAccepts(p);
      announce(r.commit ? `$(git-commit) Committed ${r.items.map((i) => i.id).join(", ")}` : "Nothing to commit", 5000);
    });
  }

  /** *Share my edits*: save the project's open files and let agents see them at their next sync. */
  async shareEdits(): Promise<void> {
    const p = await this.ext.setupWizard.pickProject();
    if (!p) return;
    await this.ext.run(p, async () => {
      for (const d of vscode.workspace.textDocuments) if (d.isDirty && p.relPath(d.uri)) await d.save();
      const changed = await p.stet.shareEdits();
      announce(
        changed ? "$(cloud-upload) Stet: shared your edits; agents pick them up at their next sync" : "$(check) Stet: agents already see your edits",
        5000,
      );
      await p.refresh();
      p.scheduleChecks(0);
    });
  }
}
