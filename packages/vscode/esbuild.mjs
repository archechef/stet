// Bundles the extension (CommonJS, as VS Code loads it) and the `stet` CLI that agents' tools run.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node22", sourcemap: false, logLevel: "info" };

await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", format: "cjs", external: ["vscode"] });
await build({ ...common, entryPoints: ["../cli/src/index.ts"], outfile: "dist/stet.mjs", format: "esm" });
// The PDF preview page's script, for the webview (a browser).
await build({ ...common, entryPoints: ["src/webview/preview.ts"], outfile: "dist/preview.js", format: "iife", platform: "browser", target: "es2022" });
// The integration test's fixture, with Stet's core bundled in, so the test needs no node_modules
// where VS Code runs (.vscodeignore keeps it out of the .vsix).
await build({ ...common, entryPoints: ["test/integration/fixture.mjs"], outfile: "dist/it-fixture.mjs", format: "esm", logLevel: "warning" });
// A local language profile with LaTeX's preview backend, for the integration test's imported-profile run.
// Built as profile authors build theirs: the profile kit is left to the Stet that imports it.
const profileKit = {
  name: "profile-kit",
  setup(b) {
    b.onResolve({ filter: /^\.\/kit\.js$/ }, () => ({ path: "@stet/profile-kit", external: true }));
  },
};
await build({
  ...common,
  entryPoints: ["test/integration/latex-profile.ts"],
  outfile: "dist/it-latex-profile.mjs",
  format: "esm",
  logLevel: "warning",
  plugins: [profileKit],
});
