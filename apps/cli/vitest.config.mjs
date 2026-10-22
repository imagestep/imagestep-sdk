import { defineConfig } from "vitest/config";

// One runner for the whole workspace (imagestep#57, checklist §1.1 T1).
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    globals: true,
    coverage: {
      // T4: measured, not gated — the root `vitest.config.mjs` re-anchors this include for the merged report.
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.js"]
    }
  }
});
