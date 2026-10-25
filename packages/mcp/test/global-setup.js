import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Once before a run (vitest.config.mjs globalSetup, #896 — apps/cli's #880): the test-file folders (setup.js) that killed
// runs left behind go. A run stopped half-way (Ctrl-C, a timeout, a crash) never reaches a file's own cleanup. Only folders
// older than an hour: another run, in another checkout or session, may be using its fresh ones right now. Never a server's
// own `imagestep-mcp-` scratch folder: a stdio server running for hours on this machine is still using it.
const PREFIX = "imagestep-mcp-test-";

export default function sweep() {
  const old = Date.now() - 3600e3;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const at = join(tmpdir(), name);
    try {
      if (statSync(at).mtimeMs < old) rmSync(at, { recursive: true, force: true });
    } catch {
      // gone already, or not ours to remove: the next run tries again
    }
  }
}
