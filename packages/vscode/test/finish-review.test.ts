/** Finish review: what it says it commits. */
import { describe, expect, it } from "vitest";
import { FINISH_SAVE, finishQuestion } from "../src/questions.js";

describe("Finish review says what it commits (test report v0.16, D6)", () => {
  it("names your own edits, unsaved text, and that undo ends", () => {
    const q = finishQuestion(3, ["main.tex", "intro.tex"], ["intro.tex"], ["main.tex"]);
    expect(q.message).toBe("Commit 3 accepted changes?");
    expect(q.detail).toMatch(/Your own edits in intro\.tex are committed too/);
    expect(q.detail).toMatch(/main\.tex has unsaved edits: “Commit” leaves them out/);
    expect(q.detail).toMatch(/Undo no longer takes these changes back/);
    expect(q.buttons).toEqual(["Commit", FINISH_SAVE]);
  });

  it("asks only Commit when nothing is unsaved, and says nothing of your edits when there are none", () => {
    const q = finishQuestion(1, ["main.tex"], [], []);
    expect(q.message).toBe("Commit 1 accepted change?");
    expect(q.detail).not.toMatch(/own edits|unsaved/);
    expect(q.buttons).toEqual(["Commit"]);
  });
});

describe("several projects (test report 5e4c6af)", () => {
  it("multi-root: Finish review names the project", () => {
    expect(finishQuestion(2, ["main.typ"], [], [], "paper-typst").message).toBe("Commit 2 accepted changes in paper-typst?");
    expect(finishQuestion(1, ["main.typ"], [], []).message).toBe("Commit 1 accepted change?");
  });
});
