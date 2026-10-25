import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

// Before each test file (vitest.config.mjs setupFiles, #896): the file's temp folder is one of its own, removed when the
// file ends. The server keeps one scratch folder per process and removes it on `exit` (src/server.js `scratchDir`), and a
// vitest worker runs file after file without exiting — every file that reached it left one behind. `os.tmpdir()` reads
// TMPDIR on every call, so whatever the server or a test makes under it lands here.
const outer = process.env.TMPDIR;
const dir = mkdtempSync(join(tmpdir(), "imagestep-mcp-test-"));
process.env.TMPDIR = dir;

afterAll(() => {
  if (outer === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = outer;
  rmSync(dir, { recursive: true, force: true });
});
