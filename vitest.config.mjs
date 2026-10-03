import { defineConfig } from "vitest/config";

/** One runner over every JavaScript package; each package's own config decides what it runs. */
export default defineConfig({
  test: {
    projects: ["apps/cli", "packages/mcp", "packages/n8n-nodes-imagestep", "recipes", "sdk/js"]
  }
});
