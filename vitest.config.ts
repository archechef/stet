import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The extension's modules import "vscode", which exists only inside VS Code: unit tests get a
  // small stand-in that records what they ask of it (packages/vscode/test/fake-vscode.ts).
  resolve: { alias: { vscode: fileURLToPath(new URL("./packages/vscode/test/fake-vscode.ts", import.meta.url)) } },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    globalSetup: ["./vitest.setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
