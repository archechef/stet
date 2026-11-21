/** Undo: the decisions made in this window, latest last, and the *Undo* button after each. */
import * as vscode from "vscode";
import { announce } from "./announce.js";
import type { StetExtension } from "./extension.js";
import type { Project } from "./project.js";

/** How many decisions *Undo* can go back. */
const UNDO_DEPTH = 50;
type Decision = "accept" | "rejection" | "revision request";
/** How long *Undo* stays in the status bar after a decision. */
const UNDO_SHOWN_MS = 15_000;

export class UndoStack {
  constructor(private readonly ext: StetExtension) {}

  /** *Undo* for a few seconds after each decision (test report 2026-11-20). */
  readonly undoButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);

  /** Decisions made in this window, latest last, for *Undo* (`u`): one per press, back to the oldest. */
  private decisions: { project: Project; ids: string[]; what: Decision }[] = [];
  private undoTimer: ReturnType<typeof setTimeout> | undefined;

  /** Remember a decision for *Undo* (`u` in the panel), and offer the button for a few seconds. */
  noteDecision(p: Project, ids: string[], what: Decision): void {
    if (!ids.length) return;
    this.decisions.push({ project: p, ids, what });
    if (this.decisions.length > UNDO_DEPTH) this.decisions.shift();
    this.showUndo();
  }

  private showUndo(): void {
    // The panel's title has Undo while there is something to undo: mouse users had only the
    // status-bar button for 15 seconds (test report v0.16.0).
    void vscode.commands.executeCommand("setContext", "stet.canUndo", this.decisions.length > 0);
    const d = this.decisions.at(-1);
    if (!d) return void this.undoButton.hide();
    const label = `Undo the ${d.what} of ${d.ids.length > 3 ? `${d.ids.length} changes` : d.ids.join(", ")}`;
    this.undoButton.text = `$(discard) Undo`;
    this.undoButton.tooltip = `${label} (u in the Stet panel)`;
    this.undoButton.accessibilityInformation = { label, role: "button" };
    this.undoButton.command = "stet.undoLast";
    this.undoButton.show();
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.undoButton.hide(), UNDO_SHOWN_MS);
  }

  /** Finish review committed `p`'s accepts: they can't be undone here any more. */
  forgetAccepts(p: Project): void {
    this.decisions = this.decisions.filter((d) => !(d.project === p && d.what === "accept"));
    this.showUndo();
    this.undoButton.hide();
  }

  /**
   * Undo the latest decision made here that isn't undone yet (all the changes it decided); each
   * press goes one further back. Says so when it was decided again since or committed.
   */
  async undoLast(): Promise<void> {
    const d = this.decisions.pop();
    void vscode.commands.executeCommand("setContext", "stet.canUndo", this.decisions.length > 0);
    this.undoButton.hide();
    if (!d)
      return void vscode.window.showInformationMessage(
        "Nothing more to undo: every decision made in this window is undone, committed, or older than this session.",
      );
    const state: Record<Decision, string> = { accept: "accepted", rejection: "rejected", "revision request": "needs_revision" };
    const undone: string[] = [];
    await this.ext.run(d.project, async () => {
      const files = d.ids.flatMap((id) => {
        const it = this.ext.model(d.project).item(id);
        return it ? [it.file, ...(it.oldFile ? [it.oldFile] : [])] : [];
      });
      await this.ext.saveFiles(d.project, files);
      const todo: string[] = [];
      for (const id of d.ids) {
        const it = await d.project.stet.getItem(id);
        // Decided again since.
        if (!it || it.status !== state[d.what]) continue;
        if (it.resolution?.committed) throw new Error(`The accept of ${it.id} is committed already, so Stet can't take it back.`);
        todo.push(id);
      }
      if (!todo.length) return;
      // All at once, with progress when it takes a moment: one by one, 400 changes took 16 s
      // without a word (test report 5e4c6af, B5).
      const r = await vscode.window.withProgress(
        {
          location: todo.length > 20 ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
          title: `Stet: undoing the ${d.what} of ${todo.length} change${todo.length === 1 ? "" : "s"}…`,
        },
        () => d.project.stet.undoMany(todo),
      );
      undone.push(...r.reopened.map((i) => i.id));
    });
    if (undone.length) announce(`$(discard) Undid the ${d.what} of ${[...new Set(undone)].join(", ")}${this.ext.replies.inWhich(d.project)}`, 5000);
    else announce(`$(info) The ${d.what} of ${d.ids.join(", ")} was already undone or decided again`, 5000);
  }

  /** Undo a decision from the History: the change is pending again (an accept is taken out of your file). */
  async undo(arg: unknown): Promise<void> {
    const t = await this.ext.targetItem(arg);
    if (!t) return;
    const { project: p, item } = t;
    if (item.status === "accepted") await this.ext.saveFiles(p, [item.file, ...(item.oldFile ? [item.oldFile] : [])]);
    const r = await this.ext.run(p, () => p.stet.undo(item.id));
    if (r) {
      const what = item.status === "accepted" ? "accept" : item.status === "needs_revision" ? "revision request" : "rejection";
      announce(
        `$(discard) Undid the ${what} of ${r.reopened.map((i) => i.id).join(", ")}` +
          (r.restored.length ? `; ${r.restored.map((i) => i.id).join(", ")} pending again too` : ""),
        5000,
      );
    }
  }
}
