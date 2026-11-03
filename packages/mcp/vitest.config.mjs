import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    // Each test file's temp folder is its own and goes when the file ends (setup.js); the sweep takes what killed runs
    // left behind (#896, as apps/cli #880).
    setupFiles: ["./test/setup.js"],
    globalSetup: ["./test/global-setup.js"],
    environment: "node",
    // The family ceiling: vitest's 5s default reads a loaded machine as a failed test; the root guard
    // (test/workspace.test.js) holds every package at or above 30s. It bounds a hung test or hook, it waits for neither.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: { provider: "v8", reporter: ["text-summary", "json-summary"], include: ["src/**/*.js"] }
  }
});
