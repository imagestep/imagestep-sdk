import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    // Each test file's temp folder is its own and goes when the file ends (setup.js); the sweep takes what killed runs
    // left behind (#896, as apps/cli #880).
    setupFiles: ["./test/setup.js"],
    globalSetup: ["./test/global-setup.js"],
    environment: "node",
    coverage: { provider: "v8", reporter: ["text-summary", "json-summary"], include: ["src/**/*.js"] }
  }
});
