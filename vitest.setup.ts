/**
 * Before any test: the end-to-end tests run the built CLI (`packages/cli/dist`). Without it they
 * failed to run, or were skipped without a word; now the run stops and says what to do.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const cli = fileURLToPath(new URL("./packages/cli/dist/index.js", import.meta.url));
  if (!existsSync(cli)) throw new Error(`The CLI isn't built (${cli} is missing): run \`npm run build\` first.`);
}
