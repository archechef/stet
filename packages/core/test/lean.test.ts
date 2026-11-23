/** Lean 4 projects: reviewed by declaration, with Lake's files flagged and its build folder ignored. */
import { describe, expect, it } from "vitest";
import { effectOf } from "../src/effects.js";
import { agentInstructions } from "../src/instructions.js";
import { buildIgnores, detectLanguage, documentProfile, LEAN, profileByName, profileFor } from "../src/lang/index.js";
import { declarationStarts, splitLean } from "../src/lang/lean.js";
import { edit, read, setup } from "./helpers.js";

const BASIC = `import Mathlib.Tactic

namespace MyProject

/-- Doubling a number. -/
def double (n : Nat) : Nat := 2 * n

/-- Doubling adds a number to itself. -/
@[simp]
theorem double_eq (n : Nat) : double n = n + n := by
  unfold double
  omega

/- A comment that mentions
theorem not_a_declaration : True := trivial
-/
lemma double_zero : double 0 = 0 := by
  simp [double]

theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by
  unfold double
  omega

end MyProject
`;

const lines = (t: string) => t.split(/(?<=\n)/);

describe("Lean files (Lean profile)", () => {
  it("are Lean by their name and by the config's patterns", () => {
    expect(profileByName("MyProject/Basic.lean")).toBe(LEAN);
    expect(profileFor("MyProject/Basic.lean", { tex: [], bib: [], typ: [], lean: ["*.lean"] })).toBe(LEAN);
    expect(
      detectLanguage(["MyProject.lean", "MyProject/Basic.lean", "lakefile.toml"], { tex: ["*.tex"], bib: ["*.bib"], typ: ["*.typ"], lean: ["*.lean"] }),
    ).toBe("lean");
  });

  it("start a declaration at its doc comment and attributes, not in a comment or an indented line", () => {
    const l = lines(BASIC);
    const names = declarationStarts(l).map((i) => l[i]!.trim().split(" ").slice(0, 2).join(" "));
    expect(names).toEqual([
      "import Mathlib.Tactic",
      "namespace MyProject",
      "/-- Doubling",
      "/-- Doubling",
      "lemma double_zero",
      "theorem double_mono",
      "end MyProject",
    ]);
  });

  it("keep the changes to one proof together, and changes to different declarations apart", () => {
    const after = BASIC.replace("  unfold double\n  omega\n\n/-", "  simp only [double]\n  omega\n\n/-").replace(
      "theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  unfold double\n  omega",
      "theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  simp only [double]\n  have := h\n  omega",
    );
    const edits = splitLean(BASIC, after);
    expect(edits.map((e) => e.newText)).toEqual(["  simp only [double]\n", "  simp only [double]\n  have := h\n"]);

    // Two separate lines of one proof are one change, the unchanged line between them included.
    const twice = BASIC.replace(
      "theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  unfold double\n  omega",
      "theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  unfold double\n  omega\n  -- done",
    ).replace("theorem double_mono {a b", "theorem double_mono' {a b");
    const one = splitLean(BASIC, twice);
    expect(one).toHaveLength(1);
    expect(one[0]!.newText).toContain("double_mono'");
    expect(one[0]!.newText).toContain("-- done");
  });

  it("keep a new declaration apart from a change to the one after it", () => {
    const after = BASIC.replace(
      "theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  unfold double\n  omega",
      "theorem double_one : double 1 = 2 := rfl\n\ntheorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  unfold double\n  simp\n  omega",
    );
    const edits = splitLean(BASIC, after);
    expect(edits.map((e) => e.newText)).toEqual(["theorem double_one : double 1 = 2 := rfl\n\n", "  simp\n"]);
  });

  it("flag Lake's settings, ignore its build folder, and tell agents in Lean's terms", () => {
    expect(effectOf("lakefile.lean")).toMatch(/Lake runs it/);
    expect(effectOf("lakefile.toml")).toMatch(/Lake runs it/);
    expect(effectOf("lean-toolchain")).toMatch(/elan/);
    expect(effectOf("lake-manifest.json")).toMatch(/fetches/);
    expect(effectOf("MyProject/Basic.lean")).toBeNull();
    expect(buildIgnores(["MyProject.lean", "lakefile.toml"])).toEqual([".lake/"]);
    expect(buildIgnores(["main.tex"])).toEqual([]);
    const text = agentInstructions("a", "stet watch", LEAN);
    expect(text).toMatch(/Lean/);
    expect(text).toContain('MyProject/Basic.lean:12 "simp only"');
    expect(documentProfile({ language: "lean" })).toBe(LEAN);
  });
});

describe("a Lean project, end to end", () => {
  it("is set up as Lean, reviewed by declaration, and accepted one declaration at a time", async () => {
    const { stet, repo } = await setup({
      "MyProject/Basic.lean": BASIC,
      "MyProject.lean": "import MyProject.Basic\n",
      "lakefile.toml": 'name = "MyProject"\n',
    });
    expect((await stet.config()).language).toBe("lean");
    const { worktree: wt } = await stet.newAgent("a");
    edit(
      wt,
      "MyProject/Basic.lean",
      "theorem double_eq (n : Nat) : double n = n + n := by\n  unfold double\n  omega",
      "theorem double_eq (n : Nat) : double n = n + n := by\n  simp only [double]\n  omega",
    );
    edit(
      wt,
      "MyProject/Basic.lean",
      "theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  unfold double\n  omega",
      "theorem double_mono {a b : Nat} (h : a ≤ b) : double a ≤ double b := by\n  unfold double\n  have := h\n  omega\n  -- mono",
    );
    const { items } = await stet.submit("a", { title: "Tidy proofs" });
    expect(items).toHaveLength(2);
    const mono = items.find((i) => i.newText.includes("have := h"))!;
    expect(mono.newText).toContain("-- mono");
    await stet.accept([mono.id], { commit: false });
    const text = read(repo, "MyProject/Basic.lean");
    expect(text).toContain("  have := h\n  omega\n  -- mono");
    expect(text).toContain("  unfold double\n  omega\n\n/- A comment"); // the other proof as it was
  });
});
