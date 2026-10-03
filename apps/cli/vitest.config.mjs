import { defineConfig } from "vitest/config";

// One runner for the whole workspace (imagestep#57, checklist §1.1 T1).
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    globals: true,
    coverage: {
      // T4: measured, not gated. The ratchet is a `live`-phase decision.
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["src/**/*.js"]
    }
  }
});
