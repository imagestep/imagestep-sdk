import { defineConfig } from "vitest/config";

/** One runner over every JavaScript package; each package's own config decides what it runs. */
export default defineConfig({
  test: {
    projects: ["apps/cli", "packages/mcp", "recipes", "sdk/js"]
  }
});
