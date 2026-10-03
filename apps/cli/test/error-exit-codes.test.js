import { execFile } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ImageStepError } from "imagestep";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exitCodeFor, jsonOutputRequested } from "../src/utils/command-helpers.js";
import { NetworkError } from "../src/utils/service.js";

/**
 * imagestep#284 — what a PROGRAM gets when a command fails. The contract says an agent branches on
 * `retryable` (docs/api-contract.md §2); until now the CLI turned that field into a yellow line on
 * stderr and exit 1 for everything, so a script could not tell "fix your request" from "try again"
 * without parsing prose. Now `-o json` puts the error body on stdout in the contract's own shape,
 * and the exit code carries the branch: 3 refused, 4 transient, 1 never reached the service. Which of 3 and 4 is the
 * SDK's `retryable` — for an answer with no error envelope, true for a 429 or a 5xx (its own tests pin that rule). A
 * request nothing answered is 4 as well (#566): it was sent, and the next attempt may get through.
 */
const run = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/imagestep.js", import.meta.url));
let base;
let handler;
let server;

beforeAll(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

// `Retry-After: 0` so that the SDK's retries of a retryable answer cost nothing here.
function answer(status, body) {
  handler = (req, res) => {
    res.writeHead(status, { "content-type": "application/json", "x-request-id": "req_test", "retry-after": "0" });
    res.end(JSON.stringify(body));
  };
}

function cli(args) {
  return run(process.execPath, [bin, ...args], {
    env: { ...process.env, IMAGESTEP_API_KEY: "is_sk_test", IMAGESTEP_BASE_URL: base, HOME: "/nonexistent" }
  }).catch((e) => e);
}

describe("exitCodeFor", () => {
  it.each([
    ["a refusal", new ImageStepError({ status: 400, code: "invalid_param", retryable: false }), 3],
    ["a transient failure", new ImageStepError({ status: 503, code: "provider_unavailable", retryable: true }), 4],
    ["a bare 502", new ImageStepError({ status: 502 }), 4],
    ["a bare 429", new ImageStepError({ status: 429 }), 4],
    ["a bare 404", new ImageStepError({ status: 404 }), 3],
    ["no answer at all (#566)", new NetworkError("Could not reach api.imagestep.dev: ECONNREFUSED"), 4],
    ["refused before a request (status 0)", new ImageStepError({ status: 0, code: "invalid_param", retryable: false }), 1],
    ["a system error with a `code` of its own", Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }), 1],
    ["nothing", undefined, 1]
  ])("%s → %i", (_name, error, code) => {
    expect(exitCodeFor(error)).toBe(code);
  });
});

describe("jsonOutputRequested", () => {
  it.each([
    [["jobs", "list", "-o", "json"], true],
    [["jobs", "list", "--output", "json"], true],
    [["jobs", "list", "--output=json"], true],
    [["jobs", "list", "-o", "table"], false],
    [["jobs", "get", "-o", "pretty"], false],
    [["jobs", "list"], false]
  ])("%j → %s", (argv, expected) => {
    expect(jsonOutputRequested(argv)).toBe(expected);
  });
});

describe("a refused request", () => {
  it("with -o json: the contract's error body on stdout, exit 3", async () => {
    answer(422, { error: { code: "invalid_param", message: "mode must be ai_image or analyze", retryable: false, param: "mode" } });
    const result = await cli(["models", "list", "-o", "json"]);
    expect(result.code).toBe(3);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toMatchObject({ code: "invalid_param", retryable: false, param: "mode", requestId: "req_test", status: 422 });
    expect(parsed.error.message).toBe("mode must be ai_image or analyze");
  });

  it("without -o json: the human form on stderr, nothing on stdout, exit 3", async () => {
    answer(422, { error: { code: "invalid_param", message: "bad", retryable: false, param: "mode" } });
    const result = await cli(["models", "list", "-o", "table"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid_param");
    expect(result.stderr).toContain("request id: req_test");
  });

  it("the binary lane's refusal reads the same: `image render` names the code and the parameter", async () => {
    answer(422, { error: { code: "invalid_param", message: "no such variable", retryable: false, param: "data" } });
    const result = await cli(["image", "render", "--template", "og", "--data", "{}", "--out", "/nonexistent/og.png"]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("422 invalid_param: no such variable");
    expect(result.stderr).toContain("parameter: data");
  });
});

describe("a transient failure", () => {
  it("retryable: true is exit 4, and the body says so", async () => {
    answer(503, { error: { code: "provider_unavailable", message: "try later", retryable: true } });
    const result = await cli(["models", "list", "-o", "json"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: "provider_unavailable", retryable: true, param: null });
  });

  it("a bare 502 from a proxy, no contract body, is exit 4 with no code — its status and retryable say what happened", async () => {
    handler = (req, res) => {
      res.writeHead(502, { "content-type": "text/html", "retry-after": "0" });
      res.end("<h1>502 Bad Gateway</h1>");
    };
    const result = await cli(["models", "list", "-o", "json"]);
    expect(result.code).toBe(4);
    expect(JSON.parse(result.stdout).error).toMatchObject({ code: null, retryable: true, status: 502 });
  });

  it("no answer at all, once the retries are spent, is exit 4 and retryable: true — no code, no status (#566)", async () => {
    // A port that was open a moment ago and is closed now: the connection is refused, three attempts in a row.
    const closed = http.createServer();
    await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${closed.address().port}`;
    await new Promise((resolve) => closed.close(resolve));

    const result = await run(process.execPath, [bin, "models", "list", "-o", "json"], {
      env: { ...process.env, IMAGESTEP_API_KEY: "is_sk_test", IMAGESTEP_BASE_URL: url, HOME: "/nonexistent" }
    }).catch((e) => e);

    expect(result.code).toBe(4);
    const { error } = JSON.parse(result.stdout);
    expect(error).toMatchObject({ code: null, retryable: true, requestId: null });
    expect(error).not.toHaveProperty("status");
    expect(error.message).toMatch(/^Could not reach 127\.0\.0\.1:\d+: connect ECONNREFUSED/);
  });
});

describe("a failure that never reached the service", () => {
  it("a local error with -o json is still JSON on stdout, code null, exit 1", async () => {
    const result = await cli(["jobs", "submit", "--op", "resize", "--params", "{not json", "-o", "json"]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error.code).toBe(null);
    expect(parsed.error.retryable).toBe(false);
  });
});
