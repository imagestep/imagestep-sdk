import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pingAuth } from "../src/commands/login.js";

/**
 * imagestep#258 — `login` probes a stored key before reusing it. The probe asked for
 * `GET /ai-models?mode=chat`, a mode the service stopped answering in #202, so every valid key got a
 * 400 and every login said "could not be verified". The fake service below answers the way the real
 * one does: `chat` is a 400, `ai_image` is a 200 for the good key and a 401 for any other.
 */
const GOOD = "is_sk_good";
let server;
let base;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("mode") !== "ai_image" && url.searchParams.get("mode") !== "analyze") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "invalid_param", param: "mode", retryable: false } }));
      return;
    }
    if (req.headers.authorization === "ApiKey is_sk_flaky") {
      res.writeHead(503).end();
      return;
    }
    res.writeHead(req.headers.authorization === `ApiKey ${GOOD}` ? 200 : 401, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

describe("pingAuth", () => {
  it("says ok for a key the service accepts", async () => {
    expect(await pingAuth(base, GOOD)).toBe("ok");
  });

  it("says invalid for a key the service rejects", async () => {
    expect(await pingAuth(base, "is_sk_revoked")).toBe("invalid");
  });

  it("says unknown when the service answers neither yes nor no", async () => {
    expect(await pingAuth(base, "is_sk_flaky")).toBe("unknown");
  });
});
