// A local language profile for the integration test: LaTeX under another id, with LaTeX's PDF
// preview backend bundled in (esbuild.mjs makes dist/it-latex-profile.mjs, a module as `stet profile
// import` takes it, with only the profile kit left to the Stet that imports it).
import { LATEX } from "../../../core/src/lang/latex.js";

export const apiVersion = 1;

export default { ...LATEX, id: "paper-latex", name: "Paper LaTeX", files: "paper" };
