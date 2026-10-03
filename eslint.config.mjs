import js from "@eslint/js";
import globals from "globals";

const NODE = { ...globals.node };

export default [
  { ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.venv/**"] },
  { linterOptions: { reportUnusedDisableDirectives: "error" } },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}"],
    rules: {
      "no-useless-assignment": "error",
      "preserve-caught-error": "error",
      // `const { x, ...rest }` drops one key on purpose.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // Functions are hoisted on purpose; a variable used before its declaration is a runtime error.
      "no-use-before-define": ["error", { variables: true, functions: false, classes: false, allowNamedExports: true }]
    }
  },
  // Node: the CLI, the recipes, every package's scripts, tests and config.
  {
    files: ["apps/cli/**", "recipes/**", "test/**", "**/scripts/**", "**/test/**", "**/*.config.{js,mjs}"],
    languageOptions: { globals: NODE }
  },
  // The SDK and the MCP server run on Node and on edge runtimes (fetch, crypto.subtle, AbortController).
  { files: ["sdk/**", "packages/**"], languageOptions: { globals: { ...NODE, ...globals.browser } } }
];
