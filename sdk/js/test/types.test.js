import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * imagestep#315 — `index.d.ts` is hand-written and is the entire API to a TypeScript caller, so a
 * missing resource is a method that "does not exist" to half the users of this package. The
 * name-level guard (`test/sdk-surface.test.js` at the repo root) answers "is every method
 * declared"; this one answers the other half — do the declarations actually compile, and does the
 * call a README shows type-check. `test/types/surface.ts` is the fixture; it never runs.
 *
 * `skipLibCheck` is off in its tsconfig on purpose: the point is to check our own `.d.ts` files.
 */
const PACKAGE = fileURLToPath(new URL("../", import.meta.url));

describe("the TypeScript declarations compile", () => {
  it("tsc --noEmit over test/types/surface.ts", () => {
    let output = "";
    try {
      execFileSync("node", ["node_modules/typescript/bin/tsc", "-p", "test/types"], { cwd: PACKAGE, encoding: "utf8" });
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    expect(output).toBe("");
  });
}, 60_000);
