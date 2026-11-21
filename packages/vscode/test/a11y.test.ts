/** Accessibility of what the extension draws: the preview page, decorations, results, rows and the status bar. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PreviewResult } from "@stet/core";
import { afterEach, describe, expect, it } from "vitest";
import { announce } from "../src/announce.js";
import { insertedTextStyle } from "../src/editor.js";
import { type Snapshot, TreeModel } from "../src/model.js";
import { frameKey, pageAlt, previewPage, viewerKey } from "../src/previewPage.js";
import { offerContrastStyle } from "../src/questions.js";
import { itemRow, itemSpoken, LOST_TEXT, statusView } from "../src/rows.js";
import { spokenRow } from "../src/text.js";
import { fake } from "./fake-vscode.js";
import { makeItem as item } from "./fixtures.js";

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

afterEach(() => fake.reset());

/** A preview page for a change, from a result. */
const page = (result: PreviewResult | undefined) =>
  previewPage({
    item: { id: "1.2", file: "main.tex", oldText: "problem", newText: "task" },
    result,
    img: (f) => `webview:${f}`,
    inCache: () => true,
    cspSource: "webview:",
    nonce: "n0nce",
  });
const side = (p: number) => ({ file: `/cache/p${p}.png`, page: p, count: 9, width: 600, height: 800, marks: [{ x0: 1, y0: 2, x1: 3, y1: 4 }] });
const scriptOf = (h: string) => h.slice(h.indexOf('<script nonce="n0nce">') + 22, h.lastIndexOf("</script>"));

describe("the PDF preview page", () => {
  const viewer = page({ status: "ready", after: { file: "/cache/a.png", page: 3 }, pages: { after: side(3), before: side(2) } } as unknown as PreviewResult);

  it("names its language, controls and regions, and says which page it shows", () => {
    expect(viewer).toContain('<html lang="en">');
    for (const name of ["Previous page", "Next page", "Zoom out", "Zoom in", "Fit to the width"]) expect(viewer).toContain(`aria-label="${name}"`);
    expect(viewer).toMatch(/id="show-after"[^>]*aria-pressed="true"/);
    expect(viewer).toMatch(/id="pageno"[^>]*aria-live="polite"/);
    expect(viewer).toMatch(/class="page tall" tabindex="0" role="region" aria-label="[^"]*Page Up and Page Down turn pages/);
  });

  it("runs only its own script, which is valid JavaScript", () => {
    expect(viewer).toContain("script-src 'nonce-n0nce'");
    expect(() => new Function(scriptOf(viewer))).not.toThrow();
  });

  it("moves and zooms a page from the keyboard as the mouse does", () => {
    expect(frameKey("ArrowRight")).toEqual({ move: [0.1, 0] });
    expect(frameKey("ArrowUp")).toEqual({ move: [0, -0.1] });
    expect(frameKey("+")).toEqual({ zoom: 1.25 });
    expect(frameKey("-")).toEqual({ zoom: 0.8 });
    expect(frameKey("x")).toBeNull();
  });

  it("turns pages and shows after and before from the keyboard (test report v0.16)", () => {
    const at = { side: "after" as const, shown: { after: 3, before: 2 }, count: 9, hasBefore: true };
    expect(viewerKey("PageDown", at)).toEqual({ side: "after", page: 4 });
    expect(viewerKey("PageUp", at)).toEqual({ side: "after", page: 2 });
    expect(viewerKey("PageDown", { ...at, shown: { after: 9, before: 2 } })).toBeNull();
    expect(viewerKey("b", at)).toEqual({ side: "before", page: 2 });
    expect(viewerKey("B", { ...at, hasBefore: false })).toBeNull();
    expect(viewerKey("a", { ...at, side: "before" })).toEqual({ side: "after", page: 3 });
  });

  it("says in its pictures' alt text what the change is (test report v0.16)", () => {
    expect(pageAlt(3, "after", "“problem” replaced with “task”", 2)).toBe("Page 3 with the change: “problem” replaced with “task”, 2 changed places marked");
    expect(pageAlt(2, "before", "“x” deleted", 0)).toBe("Page 2 without the change: “x” deleted");
    const plain = page({ status: "ready", after: { file: "/cache/a.png", page: 3 } } as unknown as PreviewResult);
    expect(plain).toContain('alt="Page 3 with the change: “problem” replaced with “task”"');
    expect(plain).not.toMatch(/alt="(page|after|before)"/i);
    expect(page(undefined)).toContain("Building the preview");
  });
});

describe("proposed text and results", () => {
  it("proposed text is not marked by colour alone in High Contrast themes", () => {
    const c = manifest.contributes.colors.find((x: { id: string }) => x.id === "stet.insertedText.border");
    expect(c.defaults.highContrast).toBeTruthy();
    expect(c.defaults.dark).toBe("#00000000");
    const after = insertedTextStyle().after as { border: string; borderColor: { id: string } };
    expect(after.border).toBe("1px dashed");
    expect(after.borderColor.id).toBe("stet.insertedText.border");
  });

  it("a result goes to the status bar, and to a screen reader as a notification without icons (test report v0.16)", () => {
    announce("$(comment) Comment on 1.2 sent.", 3000);
    expect(fake.statusMessages).toEqual([{ text: "$(comment) Comment on 1.2 sent.", ms: 3000 }]);
    expect(fake.notifications).toEqual([]);
    fake.settings.set("editor.accessibilitySupport", "on");
    announce("$(check) Note N1 resolved.");
    expect(fake.notifications).toEqual(["Note N1 resolved."]);
  });

  it("offers the bordered style once, in High Contrast themes, where proposed text wraps (test report v0.16)", () => {
    const s = { highContrast: true, inProject: true, wrapsWithLine: true, askedBefore: false };
    expect(offerContrastStyle(s)).toBe(true);
    expect(offerContrastStyle({ ...s, askedBefore: true })).toBe(false);
    expect(offerContrastStyle({ ...s, highContrast: false })).toBe(false);
    expect(offerContrastStyle({ ...s, wrapsWithLine: false })).toBe(false);
  });
});

describe("rows and the status bar in words", () => {
  const model = new TreeModel({
    agents: [],
    changesets: [],
    groups: [],
    items: [],
    notes: [],
    syncNeeded: new Set(),
    uncommitted: [],
    unshared: false,
    missing: [],
  } as Snapshot);

  it("a change's row is read out as its spoken label, and says when it can't be found", () => {
    const it2 = item("2.1", { oldText: "problem", newText: "task", groups: [] });
    expect(itemRow(it2, model, { line: 4, found: true }, { history: false, unread: 0 }).spoken).toBe(itemSpoken(it2, 4));
    const lost = itemRow(it2, model, { line: 4, found: false }, { history: false, unread: 0 });
    expect(lost.spoken).toBe(`${itemSpoken(it2)}, ${LOST_TEXT}`);
    expect(lost.description).toBe("⚠ not found in main.tex");
  });

  it('the status bar says its counts in words, not as "3 2" (test report 2026-11-20)', () => {
    const v = statusView({ pending: 3, unread: 2, uncommitted: 1, behind: [], unshared: [], missing: [], projects: [] });
    expect(v.text).toBe("$(checklist) 3 $(comment-unresolved) 2 $(git-commit) 1");
    expect(v.spoken).toMatch(/^Stet: 3 changes to review\. 2 new replies from agents .*\. 1 accepted, not committed yet/);
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
