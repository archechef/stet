#!/usr/bin/env node
/** The `stet` command (see main.ts). */
import { fileURLToPath } from "node:url";
import { main } from "./main.js";

export { forTerminal } from "./output.js";

main(process.argv.slice(2), {
  // How other tools run this CLI: this script with this Node.js. On VS Code's own runtime (bundled
  // with the extension) it stays in Node mode.
  self: {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url)],
    ...(process.env.ELECTRON_RUN_AS_NODE ? { env: { ELECTRON_RUN_AS_NODE: "1" } } : {}),
  },
}).then((code) => {
  process.exitCode = code;
});
