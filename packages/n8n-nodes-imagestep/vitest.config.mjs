import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: ["nodes/**/*.js", "credentials/**/*.js", "lib/**/*.js"]
    }
  }
});
