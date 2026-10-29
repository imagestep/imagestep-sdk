import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Once before a run (vitest.config.mjs globalSetup, #896 — apps/cli's #880): what killed runs left in the temp folder
// goes. Every test removes its own folder when it ends, but a run stopped half-way (Ctrl-C, a timeout, a crash) never
// gets there. Only folders older than an hour: another run, in another checkout or session, may be using its fresh ones.
// The repo's test prefix (#921: the root test/temp-dirs.test.js holds it to the root test/global-setup.js — a copy, as
// the public export carries this package without it).
const PREFIX = "imagestep-test-";

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
