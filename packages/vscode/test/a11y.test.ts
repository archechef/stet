/** Accessibility of what the extension draws (test report 2026-11-20): checked in its sources and manifest. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Item } from "@stet/core";
import { describe, expect, it } from "vitest";
import { itemSpoken, spokenRow } from "../src/model.js";

const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

const item = (id: string, extra: Partial<Item> = {}): Item => ({
  id,
  agent: "a",
  changeset: "C1",
  file: "main.tex",
  kind: "modify",
  baseCommit: "b",
  range: { start: 0, end: 1 },
  oldText: "old",
  newText: "new",
  context: { before: "", after: "" },
  fingerprint: "",
  note: null,
  groups: ["G1"],
  status: "pending",
  resolution: null,
  supersedes: null,
  conflictsWith: [],
  history: [],
  thread: [],
  ...extra,
});

describe("accessibility", () => {
  it("the PDF preview names its controls and pictures, and works from the keyboard", () => {
    const p = src("preview.ts");
    for (const name of ["Previous page", "Next page", "Zoom out", "Zoom in", "Fit to the width"]) expect(p).toContain(`aria-label="${name}"`);
    expect(p).toContain('aria-pressed="true"');
    expect(p).toContain('setAttribute("aria-pressed"');
    expect(p).toContain('<html lang="en">');
    expect(p).toMatch(/id="pageno"[^>]*aria-live="polite"/);
    expect(p).not.toMatch(/alt="(page|after|before)"/);
    expect(p).toMatch(/tabindex="0" role="region"/);
    expect(p).toContain('addEventListener("keydown"');
    expect(p).toContain("--vscode-diffEditor-insertedTextBackground");
    // Pages and versions from the keyboard, and pictures that say what changed (test report v0.16.0).
    expect(p).toContain('e.key === "PageDown"');
    expect(p).toMatch(/e\.key === "b"/);
    expect(p).toContain('" with the change: " + PAGES.what');
  });

  it("inserted text is not marked by colour alone in high-contrast themes", () => {
    const c = manifest.contributes.colors.find((x: { id: string }) => x.id === "stet.insertedText.border");
    expect(c.defaults.highContrast).toBeTruthy();
    expect(c.defaults.dark).toBe("#00000000");
    expect(src("editor.ts")).toContain('borderColor: new vscode.ThemeColor("stet.insertedText.border")');
  });

  it("results reach a screen reader, and comments, revisions, replies and notes say they were sent (test report v0.16.0)", () => {
    const e = src("extension.ts");
    // Every result goes through announce(), which a screen reader hears as a notification.
    expect(e.match(/setStatusBarMessage\(/g)).toHaveLength(1);
    expect(e).toMatch(/function announce[\s\S]*accessibilitySupport|accessibilitySupport[\s\S]*function announce/);
    for (const m of [
      "Comment on ${t.item.id} sent",
      "Revision of ${t.item.id}${this.inWhich(t.project)} requested",
      "Note ${t.note.id} resolved",
      "Reply on note ${note.id} sent",
      "Reply on ${hit.item.id} sent",
    ])
      expect(e).toContain(m);
  });

  it("offers the bordered style once in High Contrast themes when proposed text wraps (test report v0.16.0)", () => {
    const e = src("extension.ts");
    const offer = e.slice(e.indexOf("private async offerContrastStyle"), e.indexOf("Whether the user last picked"));
    for (const part of ["ColorThemeKind.HighContrast", "usesHints(uri)", "stet.askedContrastStyle"]) expect(offer).toContain(part);
    expect(e).toContain('this.setOption("newTextStyle", "highlighted")');
    expect(e).toContain("onDidChangeActiveColorTheme");
  });

  it("tree items and the status bar have spoken labels", () => {
    const e = src("extension.ts");
    expect(e).toMatch(/t\.accessibilityInformation = \{ label: itemSpoken\(it, /);
    expect(e).toContain("this.status.accessibilityInformation");
  });
});

describe("a change's spoken label says what its row shows (test report v0.16)", () => {
  it("your wording, the conversation, and the status words of the row", () => {
    const it2 = item("2.1", {
      oldText: "problem",
      newText: "task",
      draft: "hard task",
      thread: [
        { at: "", author: "agent", text: "ok" },
        { at: "", author: "user", text: "?" },
      ],
    });
    expect(itemSpoken(it2, 4)).toBe("Change 2.1, replace “problem” with “hard task”, in main.tex line 4, pending, your wording, 2 messages");
    expect(itemSpoken(item("2.2", { status: "needs_revision" }))).toMatch(/, revision requested$/);
  });
  it("the wording a change was accepted with", () => {
    const acc = item("2.3", { oldText: "problem", newText: "task", status: "accepted", resolution: { appliedText: "job", edited: true, committed: null } });
    expect(itemSpoken(acc)).toBe("Change 2.3, replace “problem” with “job”, in main.tex, accepted");
  });
});

describe("spoken rows (test report 5e4c6af)", () => {
  it("accessibility: rows are read out in words", () => {
    expect(spokenRow("G1 linked · 💬 3 (1 new) · ⚠ broken")).toBe("G1 linked, 3 messages (1 new), warning: broken");
  });
});
