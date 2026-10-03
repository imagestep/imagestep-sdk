import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * imagestep#272 — the edges a PROGRAM calling this CLI meets: a retried submit must not become two jobs, an error must
 * carry the id that finds it in the logs, and a delete that did nothing must not exit 0. That a hung call gives up and
 * says which one, and where the request id is read from, are the SDK's transport — `sdk/js/test/client.test.js`.
 */
let base;
let handler;
let server;
const requests = [];

vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => base,
  getConfigFile: () => "/tmp/config.yml"
}));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  requests.length = 0;
  vi.restoreAllMocks();
});

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

describe("imagestep jobs submit", () => {
  it("retries a retryable answer with the SAME Idempotency-Key, so a landed submit replays", async () => {
    let calls = 0;
    handler = (req, res) => {
      calls += 1;
      if (calls < 3) {
        json(res, 503, { error: { code: "provider_unavailable", message: "busy", retryable: true } }, { "retry-after": "0" });
      } else {
        json(res, 200, { success: true, data: { id: "job-1", status: "PENDING" } });
      }
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { default: jobsCommand } = await import("../src/commands/jobs.js");

    await jobsCommand.parseAsync(["submit", "--op", "resize", "--asset-ids", "a1", "--params", '{"width":10}'], { from: "user" });

    expect(requests).toHaveLength(3);
    const keys = requests.map((r) => r.headers["idempotency-key"]);
    expect(keys[0]).toMatch(/[0-9a-f-]{36}/);
    expect(new Set(keys).size).toBe(1);
    // The service's audit log says which client made the call: this CLI at this version, not the SDK under it.
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(requests[0].headers["user-agent"]).toBe(`imagestep-cli/${version}`);
  });

  it("does not retry an answer that is not retryable", async () => {
    handler = (req, res) => json(res, 400, { error: { code: "invalid_param", message: "bad", retryable: false, requestId: "req-3" } });
    const errors = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    const { default: jobsCommand } = await import("../src/commands/jobs.js");

    await expect(jobsCommand.parseAsync(["submit", "--op", "resize", "--asset-ids", "a1"], { from: "user" })).rejects.toThrow("exit 3"); // #284: refused, not retryable
    expect(requests).toHaveLength(1);
    // The id is the last line: it is what a person pastes into a bug report (contract §11).
    expect(errors.at(-1)).toContain("request id: req-3");
  });
});

describe("destructive commands without --yes", () => {
  const bin = fileURLToPath(new URL("../bin/imagestep.js", import.meta.url));

  it("exit 1 when there is no terminal to confirm on", async () => {
    // execFile's stdin is a pipe — the shape of `echo | imagestep asset delete x` and of every script.
    const error = await promisify(execFile)(process.execPath, [bin, "asset", "delete", "some-asset"]).catch((e) => e);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("--yes");
  });

  it("exit 1 at a terminal too: there is no prompt to answer, and nothing was deleted (#566)", async () => {
    const { confirmDeletion } = await import("../src/utils/command-helpers.js");
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const errors = [];
    vi.spyOn(console, "error").mockImplementation((line) => errors.push(String(line)));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    try {
      expect(() => confirmDeletion(false, "preset")).toThrow("exit 1");
    } finally {
      if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
      else delete process.stdin.isTTY;
    }
    expect(errors.join("\n")).toMatch(/nothing was deleted/);
  });
});
