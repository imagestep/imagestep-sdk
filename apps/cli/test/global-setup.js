import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Once before a run (vitest.config.mjs globalSetup, #880): what killed runs left in the temp folder goes. Every test
// removes its own folders when it ends, but a run stopped half-way (Ctrl-C, a timeout, a crash) never gets there. Only
// folders older than an hour: another run, in another checkout or session, may be using its fresh ones right now.
const PREFIXES = [
  "imagestep-cli-env-",
  "imagestep-cli-perm-",
  "imagestep-cli-test-",
  "imagestep-dl-",
  "imagestep-home-",
  "imagestep-image-exit-",
  "imagestep-image-inplace-",
  "imagestep-image-mime-",
  "imagestep-image-quota-",
  "imagestep-json-stdout-",
  "imagestep-put-",
  "imagestep-render-",
  "imagestep-rows-",
  "imagestep-skill-"
];

export default function sweep() {
  const old = Date.now() - 3600e3;
  for (const name of readdirSync(tmpdir())) {
    if (!PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const at = join(tmpdir(), name);
    try {
      if (statSync(at).mtimeMs < old) rmSync(at, { recursive: true, force: true });
    } catch {
      // gone already, or not ours to remove: the next run tries again
    }
  }
}
