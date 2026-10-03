import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * imagestep#527 — `asset download` and `jobs outputs --download` against a real HTTP server: the bytes are streamed to a
 * temporary name and renamed when whole, a storage connection that stops sending is given up on (and tried once more),
 * and `jobs outputs --download` fetches `--concurrency` outputs at a time.
 */
let base;
let server;
let storage = () => {};
const state = { inFlight: 0, widest: 0, storageHits: 0 };

vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => base,
  getConfigFile: () => "/tmp/config.yml"
}));

const payload = Buffer.alloc(256 * 1024, 7);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const content = /^\/api\/v1\/assets\/([^/]+)\/content$/.exec(url.pathname);
    if (content) {
      res.writeHead(302, { location: `${base}/storage/${content[1]}` });
      return res.end();
    }
    if (url.pathname.startsWith("/storage/")) {
      state.storageHits++;
      return storage(req, res, url.pathname.slice("/storage/".length));
    }
    if (url.pathname === "/api/v1/jobs/j1") {
      const items = Array.from({ length: 6 }, (_, i) => ({ index: i, status: "COMPLETED", resultAssetId: `o${i}` }));
      return json(res, { id: "j1", status: "COMPLETED", items });
    }
    if (url.pathname === "/api/v1/assets") {
      return json(
        res,
        Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, name: `o${i}.png`, status: "DONE" })),
        { page: 0, perPage: 100, total: 6, hasMore: false }
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

function json(res, data, meta) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ success: true, data, ...(meta ? { meta } : {}) }));
}

const whole = (_req, res) => {
  res.writeHead(200, { "content-type": "image/png" });
  res.end(payload);
};

const { downloadAsset, TIMEOUTS } = await import("../src/utils/download.js");

beforeEach(() => {
  Object.assign(state, { inFlight: 0, widest: 0, storageHits: 0 });
  storage = whole;
  Object.assign(TIMEOUTS, { headersMs: 30_000, idleMs: 60_000 });
});

describe("downloadAsset", () => {
  it("streams to a temporary name and renames it when whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagestep-dl-"));
    const { target, bytes } = await downloadAsset("ast_1", { dir });
    expect(target).toBe(join(dir, "ast_1.png"));
    expect(bytes).toBe(payload.length);
    expect(readFileSync(target).equals(payload)).toBe(true);
    expect(readdirSync(dir)).toEqual(["ast_1.png"]);
  });

  it("gives up on a stalled body, tries once more, and leaves no partial file", async () => {
    Object.assign(TIMEOUTS, { idleMs: 100 });
    storage = (req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      if (state.storageHits === 1)
        res.write(payload.subarray(0, 1024)); // …and never another byte
      else res.end(payload);
    };
    const dir = mkdtempSync(join(tmpdir(), "imagestep-dl-"));
    const { target } = await downloadAsset("ast_2", { dir });
    expect(state.storageHits).toBe(2);
    expect(readFileSync(target).equals(payload)).toBe(true);
    expect(readdirSync(dir)).toEqual(["ast_2.png"]);

    storage = (req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.write(payload.subarray(0, 1024));
    };
    const empty = mkdtempSync(join(tmpdir(), "imagestep-dl-"));
    await expect(downloadAsset("ast_3", { dir: empty })).rejects.toThrow(/stalled/);
    expect(readdirSync(empty)).toEqual([]);
  });
});

describe("jobs outputs --download", () => {
  it("downloads --concurrency outputs at a time, every one of them", async () => {
    storage = (req, res) => {
      state.inFlight++;
      state.widest = Math.max(state.widest, state.inFlight);
      setTimeout(() => {
        state.inFlight--;
        whole(req, res);
      }, 30);
    };
    const dir = mkdtempSync(join(tmpdir(), "imagestep-dl-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { default: jobsCommand } = await import("../src/commands/jobs.js");
    await jobsCommand.parseAsync(["outputs", "j1", "--download", dir, "--concurrency", "2", "-o", "json"], { from: "user" });
    expect(readdirSync(dir).sort()).toEqual(["o0.png", "o1.png", "o2.png", "o3.png", "o4.png", "o5.png"]);
    expect(state.widest).toBe(2);
  });
});
