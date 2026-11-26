/** The rendered preview of Markdown changes, as HTML: no marks in tags, images from the project only. */
import { describe, expect, it } from "vitest";
import { cleanTags, localImages } from "../src/markdownPreview.js";

describe("the rendered HTML", () => {
  it("has no marks in its tags", () => {
    expect(cleanTags(`<a href="b%EE%80%81.md" title="x">text</a>`)).toBe(`<a href="b.md" title="x">text</a>`);
  });

  it("shows the project's images and nothing from elsewhere", () => {
    const html = `<p><img src="images/my%20plot.png" alt="a"> <img src="https://x.org/t.png" alt="b"> <img src="../../etc/x.png"></p>`;
    const out = localImages(html, (p) => (p.startsWith("..") ? null : `vscode-resource:/${p}`));
    expect(out).toBe(`<p><img src="vscode-resource:/images/my plot.png" alt="a"> <img src="" alt="b"> <img src=""></p>`);
  });
});
