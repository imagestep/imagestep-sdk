import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { needsCatalogue } from "../src/commands/image.js";

/**
 * The entry point is the one file no other test touches, and its two defects were both invisible to
 * a human reading the help text: a bare `imagestep` printed the command list to STDERR and exited 1
 * (commander's no-subcommand path), and `-V` answered with a literal that had drifted two patch
 * releases behind package.json. Both matter to the caller the PRD cares about — a program branches
 * on the exit code and reports the version it was told.
 */
const run = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/imagestep.js", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("imagestep entry point", () => {
  it("answers a bare invocation with help on stdout and exit 0", async () => {
    const { stdout, stderr } = await run(process.execPath, [bin]);
    expect(stdout).toContain("Usage: imagestep");
    expect(stdout).toContain("image");
    expect(stderr).toBe("");
  });

  it("reports the published version", async () => {
    const { stdout } = await run(process.execPath, [bin, "--version"]);
    expect(stdout.trim()).toBe(pkg.version);
  });

  it("still fails on an unknown command", async () => {
    const error = await run(process.execPath, [bin, "not-a-command"]).catch((e) => e);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("Invalid command");
  });
});

/**
 * imagestep#526 — only the `image` group reads the op catalogue before parsing, and it gives up within seconds. `--help`
 * on any command used to fetch `GET /api/v1/ops` first (30 s against an API that does not answer), and `-h` did not.
 * Which command lines ask is `needsCatalogue`; the 3 s it is given is pinned in `image-command.test.js`.
 */
describe("the catalogue fetch at startup", () => {
  it.each([
    [["image", "-h"], true],
    [["image", "--help"], true],
    [["image", "resize", "--help"], true],
    [["image", "metadata", "--help"], false],
    [["jobs", "--help"], false],
    [["asset", "-h"], false],
    [["--help"], false]
  ])("%j → %s", (argv, expected) => {
    expect(needsCatalogue(argv)).toBe(expected);
  });

  it("is made for the image group's help, and the help lists what it answered", async () => {
    const hits = [];
    const server = createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, data: [{ op: "resize", syncEndpoint: "POST /api/v1/images/transform", params: {} }] }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const env = {
        ...process.env,
        HOME: mkdtempSync(join(tmpdir(), "imagestep-home-")),
        IMAGESTEP_BASE_URL: `http://127.0.0.1:${server.address().port}`
      };
      const { stdout } = await run(process.execPath, [bin, "image", "-h"], { env });
      expect(hits).toEqual(["/api/v1/ops"]);
      expect(stdout).toContain("resize");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
