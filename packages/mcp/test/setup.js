import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

// Before each test file (vitest.config.mjs setupFiles, #896): the file's temp folder is one of its own, removed when the
// file ends. The server keeps one scratch folder per process and removes it on `exit` (src/server.js `scratchDir`), and a
// vitest worker runs file after file without exiting — every file that reached it left one behind. `os.tmpdir()` reads
// TMPDIR on every call, so whatever the server or a test makes under it lands here. Made in beforeAll, not when this file
// loads: a file whose cases all skip runs neither hook, so it makes nothing and leaves nothing (#900). Nothing reads TMPDIR
// while a test file loads — the server makes its scratch folder on the first call that needs one.
const outer = process.env.TMPDIR;
let dir;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "imagestep-test-mcp-test-"));
  process.env.TMPDIR = dir;
});

afterAll(() => {
  if (outer === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = outer;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
