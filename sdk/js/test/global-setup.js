import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Once before a run (vitest.config.mjs globalSetup, #896 — apps/cli's #880): what killed runs left in the temp folder
// goes. Every test removes its own folder when it ends, but a run stopped half-way (Ctrl-C, a timeout, a crash) never
// gets there. Only folders older than an hour: another run, in another checkout or session, may be using its fresh ones.
// The repo's test prefix (#921: the root test/temp-dirs.test.js holds it to the root test/global-setup.js — a copy, as
// the public export carries this package without it).
const PREFIX = "imagestep-test-";
// A folder's mtime moves only when an entry right in it comes or goes, so «older than an hour» is in truth «made over an
// hour ago» — a folder a run still uses once that run has lived an hour (a Mac asleep mid-run, a debugger, a hung run).
// So each run leaves a mark while it lives, `imagestep-test-run-<pid>` (made at its start, removed by its teardown), and
// while any live run's mark is over an hour old no folder goes: an hour-old folder can only be such a run's. A mark whose
// pid is gone, or a day old (a hung run, a watch left open, a pid used again), is a dead run's and goes; with no live
// hour-old mark the sweep is what it always was (#979). Every project of one vitest run makes the same mark — globalSetup
// runs in its main process — and vitest tears them all down when the whole run ends.
const RUN = /^imagestep-test-run-(\d+)$/;
const HOUR = 3600e3;

// The temp folder `tmp` swept as at `now`: dead runs' marks go; then, unless a live run has lived over an hour, what
// killed runs left (the folders and files of PREFIX, but live marks, an hour old)
export function sweepTemp(tmp = tmpdir(), now = Date.now()) {
  const names = readdirSync(tmp);
  let longRun = false;
  for (const name of names) {
    const m = name.match(RUN);
    if (!m) continue;
    const at = join(tmp, name);
    try {
      const age = now - statSync(at).mtimeMs;
      let alive = age < 24 * HOUR;
      try {
        process.kill(Number(m[1]), 0);
      } catch (e) {
        if (e.code !== "EPERM") alive = false; // ESRCH: gone (EPERM: another user's, alive)
      }
      if (!alive) rmSync(at, { force: true });
      else if (age > HOUR) longRun = true;
    } catch {
      // gone already: the next run tries again
    }
  }
  if (longRun) return;
  const old = now - HOUR;
  for (const name of names) {
    if (!name.startsWith(PREFIX) || RUN.test(name)) continue;
    const at = join(tmp, name);
    try {
      if (statSync(at).mtimeMs < old) rmSync(at, { recursive: true, force: true });
    } catch {
      // gone already, or not ours to remove: the next run tries again
    }
  }
}

// This run's mark, and the teardown that removes it (T9: a run that ends leaves none)
export function markRun(tmp = tmpdir()) {
  const mark = join(tmp, `imagestep-test-run-${process.pid}`);
  writeFileSync(mark, `${new Date().toISOString()}\n`);
  return function teardown() {
    rmSync(mark, { force: true });
  };
}

export default function sweep() {
  sweepTemp();
  return markRun();
}
