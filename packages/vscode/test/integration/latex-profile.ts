// A local language profile for the integration test: LaTeX under another id, with LaTeX's PDF
// preview backend bundled in (esbuild.mjs makes dist/it-latex-profile.mjs, a self-contained module
// as `stet profile import` takes it).
import { LATEX } from "../../../core/src/lang/latex.js";

export const apiVersion = 1;

export default { ...LATEX, id: "paper-latex", name: "Paper LaTeX", files: "paper" };
