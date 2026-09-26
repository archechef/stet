// Bundles the extension (CommonJS, as VS Code loads it) and the `stet` CLI that agents' tools run.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node20", sourcemap: false, logLevel: "info" };

await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", format: "cjs", external: ["vscode"] });
await build({ ...common, entryPoints: ["../cli/src/index.ts"], outfile: "dist/stet.mjs", format: "esm" });
