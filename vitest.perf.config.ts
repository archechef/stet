import { defineConfig } from "vitest/config";

/**
 * Performance checks (`npm run test:perf`): larger submissions, timed, with the time printed.
 * Not part of `npm test` or CI, where machine speed varies too much for time limits to mean much.
 */
export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.perf.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
