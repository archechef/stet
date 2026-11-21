/** What the front ends see of the core: its published types (`dist/*.d.ts`), not its internals. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dist = (f: string) => readFileSync(join(__dirname, "..", "dist", f), "utf8");

describe("the core's published API (code quality report 6a517ae, core API width)", () => {
  it("keeps the store, git and the service's parts to the core", () => {
    const service = dist("service.d.ts");
    expect(service).toContain("storeRoot");
    for (const internal of [/readonly store:/, /readonly repo:/, /readonly baseOps/, /readonly decisionOps/]) expect(service).not.toMatch(internal);
  });

  it("exports no preview or language internals", () => {
    const index = dist("index.d.ts");
    for (const name of ["parseSynctex", "errorsOf", "cropRegion", "markRuns", "PREVIEW_CONTAINERFILE", "LATEX_TYPESETTER", "splitText", "BASE_REF"])
      expect(index, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    expect(index).toMatch(/\bStet\b/);
  });
});
