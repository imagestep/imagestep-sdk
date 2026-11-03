import { defineConfig } from "vitest/config";

// One runner for the whole workspace (imagestep#57, checklist §1.1 T1).
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    // Sweeps what killed runs left in the temp folder; each test removes its own (#880).
    globalSetup: ["./test/global-setup.js"],
    environment: "node",
    // The family ceiling: vitest's 5s default reads a loaded machine as a failed test; the root guard
    // (test/workspace.test.js) holds every package at or above 30s. It bounds a hung test or hook, it waits for neither.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globals: true,
    coverage: {
      // T4: measured, not gated — the root `vitest.config.mjs` re-anchors this include for the merged report.
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.js"]
    }
  }
});
