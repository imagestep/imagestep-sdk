import { existsSync } from "node:fs";
import { basename } from "node:path";
import { expect, test } from "vitest";

// test/setup.js makes each file's temp folder in beforeAll, not when the file loads: vitest runs no hooks for a file whose
// cases all skip, so a folder made at load stayed in the temp folder on every run (#900). While this file loads, TMPDIR is
// still the outer one; by the time a case runs it is a fresh folder of this file's own.
const atLoad = process.env.TMPDIR;

test("setup.js makes nothing while a test file loads", () => {
  expect(basename(atLoad ?? "")).not.toMatch(/^imagestep-test-mcp-/);
  expect(basename(process.env.TMPDIR)).toMatch(/^imagestep-test-mcp-/);
  expect(existsSync(process.env.TMPDIR)).toBe(true);
});
