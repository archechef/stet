/** Stet's settings: `settings.ts` and the settings `package.json` declares agree, and values are read safely. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHOICES, DEFAULTS, setting } from "../src/settings.js";
import { fake } from "./fake-vscode.js";

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
const declared: Record<string, { type: string; default: unknown; enum?: unknown[] }> = Object.fromEntries(
  Object.entries(manifest.contributes.configuration.properties).map(([k, v]) => [k.replace(/^stet\./, ""), v as never]),
);

afterEach(() => fake.reset());

describe("settings.ts and package.json (code quality report 6a517ae, settings)", () => {
  it("name the same settings", () => {
    expect(Object.keys(DEFAULTS).sort()).toEqual(Object.keys(declared).sort());
  });

  it("give each the same default and type", () => {
    for (const [key, d] of Object.entries(declared)) {
      expect(DEFAULTS[key as keyof typeof DEFAULTS], key).toEqual(d.default);
      expect(typeof DEFAULTS[key as keyof typeof DEFAULTS], key).toBe(d.type);
    }
  });

  it("list the same choices, in the same order", () => {
    const withEnum = Object.entries(declared).filter(([, d]) => d.enum);
    expect(Object.keys(CHOICES).sort()).toEqual(withEnum.map(([k]) => k).sort());
    for (const [key, d] of withEnum) expect([...CHOICES[key as keyof typeof CHOICES]], key).toEqual(d.enum);
  });
});

describe("setting", () => {
  it("is the default when unset", () => {
    expect(setting("pdfPreviews")).toBe("both");
    expect(setting("autoAdvance")).toBe(true);
  });

  it("is the user's value when it is one of the setting's", () => {
    fake.settings.set("stet.pdfPreviews", "off");
    fake.settings.set("stet.autoAdvance", false);
    expect(setting("pdfPreviews")).toBe("off");
    expect(setting("autoAdvance")).toBe(false);
  });

  it("is the default for a value VS Code would only warn about", () => {
    fake.settings.set("stet.pdfPreviews", "Off");
    fake.settings.set("stet.autoAdvance", "no");
    expect(setting("pdfPreviews")).toBe("both");
    expect(setting("autoAdvance")).toBe(true);
  });
});
