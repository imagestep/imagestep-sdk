import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * imagestep#828 — a terminal user who sets NO_COLOR (no-color.org) or passes `--no-color` gets no colour. chalk reads
 * neither NO_COLOR nor, once commander had refused it as an unknown option, the flag; cli-highlight, which colours
 * `-o json` / `-o yaml`, carries its own chalk; the table borders use a third library. Each case runs a process that
 * believes it writes to a terminal, so the colour is really there to switch off.
 */
const run = promisify(execFile);
const tty = fileURLToPath(new URL("./fixtures/fake-tty.mjs", import.meta.url));
const printer = fileURLToPath(new URL("./fixtures/print-in-colour.mjs", import.meta.url));
const bin = fileURLToPath(new URL("../bin/imagestep.js", import.meta.url));
const ESC = "\u001b[";

function print(env, args = []) {
  const clean = { ...process.env, TERM: "xterm-256color" };
  for (const name of ["NO_COLOR", "FORCE_COLOR", "CI", "COLORTERM"]) delete clean[name];
  return run(process.execPath, ["--import", tty, printer, ...args], { env: { ...clean, ...env } });
}

describe("no colour on request (#828)", () => {
  it("colours a terminal by default, so the cases below have something to switch off", async () => {
    const { stdout, stderr } = await print({});
    expect(stderr).toContain(ESC);
    expect(stdout).toContain(ESC);
  });

  it.each([
    ["NO_COLOR=1", { NO_COLOR: "1" }, []],
    ["NO_COLOR set to anything", { NO_COLOR: "false" }, []],
    ["--no-color", {}, ["--no-color"]]
  ])("prints the log, the JSON, the YAML and the table without escape codes with %s", async (_, env, args) => {
    const { stdout, stderr } = await print(env, args);
    expect(stderr).toContain("WARN");
    expect(stdout).toContain('"id": "a1"');
    expect(stdout).toContain("id: a1");
    expect(stderr + stdout).not.toContain(ESC);
  });

  it("treats an empty NO_COLOR as unset", async () => {
    expect((await print({ NO_COLOR: "" })).stderr).toContain(ESC);
  });

  it("accepts --no-color anywhere on the command line", async () => {
    const { stdout } = await run(process.execPath, [bin, "skill", "--no-color"]);
    expect(stdout).toContain("imagestep");
    const help = await run(process.execPath, [bin, "--help"]);
    expect(help.stdout).toMatch(/--no-color\s+no colour in the output/);
  });
});
