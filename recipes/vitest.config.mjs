import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    // The recipes themselves, for the workspace's coverage report. They run against a live API, so this suite reads
    // them as files and a unit run reaches none of their lines: the report says so rather than leaving them out.
    coverage: { include: ["*/*.mjs"] }
  }
});
