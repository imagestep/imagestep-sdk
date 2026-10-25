import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    // Sweeps what killed runs left in the temp folder; each test removes its own (#896, as apps/cli #880).
    globalSetup: ["./test/global-setup.js"],
    environment: "node",
    coverage: { provider: "v8", reporter: ["text-summary", "json-summary"], include: ["src/**/*.js"] }
  }
});
