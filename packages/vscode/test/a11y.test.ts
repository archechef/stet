/** Accessibility of what the extension draws (test report 2026-11-20): checked in its sources and manifest. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));

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
    for (const m of ["Comment on ${t.item.id} sent", "Revision of ${t.item.id} requested", "Note ${t.note.id} resolved", "Reply on note ${note.id} sent", "Reply on ${hit.item.id} sent"]) expect(e).toContain(m);
  });

  it("tree items and the status bar have spoken labels", () => {
    const e = src("extension.ts");
    expect(e).toContain("t.accessibilityInformation = { label: itemSpoken(it, line) }");
    expect(e).toContain("this.status.accessibilityInformation");
  });
});
