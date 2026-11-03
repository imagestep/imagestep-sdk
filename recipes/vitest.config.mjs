import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    // The family ceiling: vitest's 5s default reads a loaded machine as a failed test; the root guard
    // (test/workspace.test.js) holds every package at or above 30s. It bounds a hung test or hook, it waits for neither.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The recipes themselves, for the workspace's coverage report. They run against a live API, so this suite reads
    // them as files and a unit run reaches none of their lines: the report says so rather than leaving them out.
    coverage: { include: ["*/*.mjs"] }
  }
});
