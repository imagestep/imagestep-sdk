import { describe, expect, it, vi } from "vitest";
import { ImageStep, ImageStepError, JobFailedError, verifyWebhookSignature, constructWebhookEvent } from "../src/index.js";

function envelope(data, meta) {
  return new Response(JSON.stringify({ success: true, data, meta }), { status: 200, headers: { "content-type": "application/json" } });
}
function errorResponse(status, error, headers = {}) {
  return new Response(JSON.stringify({ success: false, error }), { status, headers: { "content-type": "application/json", ...headers } });
}

function client(fetchImpl, opts = {}) {
  return new ImageStep({ apiKey: "is_sk_test", baseUrl: "https://api.test", fetch: fetchImpl, maxRetries: 0, ...opts });
}

describe("request contract", () => {
  it("sends the ApiKey header, unwraps the envelope and adds an Idempotency-Key to writes", async () => {
    const fetchImpl = vi.fn(async () => envelope({ id: "job_1" }));
    const c = client(fetchImpl);
    const job = await c.jobs.submit({ type: "process", presetId: "p", assetIds: ["a"] });
    expect(job.id).toBe("job_1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/jobs");
    expect(init.headers.Authorization).toBe("ApiKey is_sk_test");
    expect(init.headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("GETs carry no Idempotency-Key and list() returns items + meta", async () => {
    const fetchImpl = vi.fn(async () => envelope([{ id: "a1" }], { total: 1, page: 0, perPage: 12, hasMore: false }));
    const { items, meta } = await client(fetchImpl).assets.list({ collection: "shoot", perPage: 12 });
    expect(items).toHaveLength(1);
    expect(meta.total).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/assets?collection=shoot&perPage=12");
    expect(init.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("maps an error body to ImageStepError with code / retryable / param", async () => {
    const fetchImpl = vi.fn(async () =>
      errorResponse(400, { code: "invalid_param", message: "width must be between 1 and 16384", retryable: false, param: "width" })
    );
    const err = await client(fetchImpl)
      .ops.resize("a1", { width: 0 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImageStepError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_param");
    expect(err.param).toBe("width");
    expect(err.retryable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("carries the request id to quote — from error.requestId, else the X-Request-Id header (contract §11)", async () => {
    const inBody = vi.fn(async () =>
      errorResponse(
        404,
        { code: "job_not_found", message: "no", retryable: false, requestId: "req-body" },
        { "X-Request-Id": "req-header" }
      )
    );
    expect(
      (
        await client(inBody)
          .jobs.get("j")
          .catch((e) => e)
      ).requestId
    ).toBe("req-body");

    // A body that is not the contract's (a proxy's HTML 502) still has the header.
    const headerOnly = vi.fn(
      async () => new Response("<html>bad gateway</html>", { status: 502, headers: { "X-Request-Id": "req-header" } })
    );
    const err = await client(headerOnly)
      .jobs.get("j")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImageStepError);
    expect(err.requestId).toBe("req-header");
  });

  it("retries a retryable error after its Retry-After, not the backoff, then succeeds with the same Idempotency-Key", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(errorResponse(429, { code: "rate_limited", message: "slow down", retryable: true }, { "Retry-After": "2" }))
        .mockResolvedValueOnce(envelope({ id: "job_2" }));
      const pending = client(fetchImpl, { maxRetries: 1 }).ops.removeBg("a1");
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).id).toBe("job_2");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0][1].headers["Idempotency-Key"]).toBe(fetchImpl.mock.calls[1][1].headers["Idempotency-Key"]);
    } finally {
      vi.useRealTimers();
    }
  });

  // #589: a wall answers with what clears it, and the error hands it to the caller untouched — an agent passes the link on.
  it("sends a refusal for credit once and hands the caller the figures and the top-up link", async () => {
    const details = { requiredCredits: 20, requiredUsd: "0.002", availableCredits: 0, topUpUrl: "https://imagestep.dev/usage/credits" };
    const fetchImpl = vi.fn(async () =>
      errorResponse(402, { code: "insufficient_credit", message: "Not enough credit", retryable: false, details })
    );
    const err = await client(fetchImpl, { maxRetries: 3 })
      .ops.run("resize", { assetIds: ["a1"] })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "insufficient_credit", retryable: false, details });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a non-retryable error", async () => {
    const fetchImpl = vi.fn(async () => errorResponse(402, { code: "insufficient_credit", message: "no", retryable: false }));
    await expect(client(fetchImpl, { maxRetries: 3 }).ops.generate("x")).rejects.toMatchObject({ code: "insufficient_credit" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // An answer with no envelope names no code, and the error does not invent one; `status` and `retryable` say the rest.
  it.each([
    [502, true],
    [429, true],
    [404, false]
  ])("a bare %i: code null, retryable %s", async (status, retryable) => {
    const fetchImpl = vi.fn(async () => new Response("<h1>proxy</h1>", { status, headers: { "content-type": "text/html" } }));
    const err = await client(fetchImpl)
      .jobs.get("j")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ImageStepError);
    expect(err).toMatchObject({ status, code: null, retryable, message: "<h1>proxy</h1>" });
  });

  it("gives up on a call that never answers, naming the request", async () => {
    const hang = vi.fn((_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
    const err = await client(hang, { timeoutMs: 20 })
      .jobs.list()
      .catch((e) => e);
    expect(err.message).toBe("ImageStep GET https://api.test/api/v1/jobs timed out after 20 ms");
  });

  it("without a key it sends no Authorization — the public reads need none", async () => {
    const fetchImpl = vi.fn(async () => envelope([{ op: "resize" }]));
    const ops = await new ImageStep({ baseUrl: "https://api.test", fetch: fetchImpl }).ops.list();
    expect(ops).toEqual([{ op: "resize" }]);
    expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
  });
});

describe("ops", () => {
  it("run() posts the op vocabulary and dryRun goes to ?dryRun=true", async () => {
    const fetchImpl = vi.fn(async () => envelope({ totalItems: 2, estimatedCredits: 60 }));
    const est = await client(fetchImpl).ops.estimate("upscale", { assetIds: ["a", "b"], parameters: { scaleFactor: 2 } });
    expect(est.estimatedCredits).toBe(60);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/jobs?dryRun=true");
    expect(JSON.parse(init.body)).toEqual({ op: "upscale", assetIds: ["a", "b"], parameters: { scaleFactor: 2 } });
  });

  // #591: how long to keep what a call makes is the caller's to shorten — it rides in the body of every call that makes assets.
  it("carries retentionDays on an op run, a preset run and a URL ingest", async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.includes("from-url") ? envelope([{ url: "https://x.test/a.png", id: "ast_1", status: "DONE" }]) : envelope({ id: "job_1" })
    );
    const c = client(fetchImpl);
    await c.ops.run("resize", { assetIds: "a1", parameters: { width: 10 }, retentionDays: 7 });
    await c.presets.run("web-optimize", "a1", { retentionDays: 7 });
    await c.assets.fromUrl(["https://x.test/a.png"], { retentionDays: 7, wait: false });
    const bodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map((b) => b.retentionDays)).toEqual([7, 7, 7]);
  });

  it("setCollection() sends the name, and null takes the assets out of their collection", async () => {
    const fetchImpl = vi.fn(async () => envelope([{ id: "a" }]));
    const c = client(fetchImpl);
    await c.assets.setCollection("a", "shoot-01");
    await c.assets.setCollection(["a", "b"], null);
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)])).toEqual([
      ["https://api.test/api/v1/assets/update", { ids: ["a"], collection: "shoot-01" }],
      ["https://api.test/api/v1/assets/update", { ids: ["a", "b"], collection: "" }]
    ]);
  });

  it("collections() lists with the filter and renameCollection() moves them, null meaning out", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        envelope([{ collection: "shoot-01", count: 2, lastCreatedAt: 1 }], { total: 1, page: 0, perPage: 20, hasMore: false })
      )
      .mockResolvedValue(envelope({ from: "shoot-01", updated: 2 }));
    const c = client(fetchImpl);
    const { items, meta } = await c.assets.collections({ q: "shoot", perPage: 20 });
    expect(items[0].count).toBe(2);
    expect(meta.total).toBe(1);
    await c.assets.renameCollection("shoot-01", null, { idempotencyKey: "k1" });
    const [listUrl] = fetchImpl.mock.calls[0];
    const [renameUrl, renameInit] = fetchImpl.mock.calls[1];
    expect(listUrl).toBe("https://api.test/api/v1/assets/collections?q=shoot&perPage=20");
    expect(renameUrl).toBe("https://api.test/api/v1/assets/collections/rename");
    expect(JSON.parse(renameInit.body)).toEqual({ from: "shoot-01", to: "" });
    expect(new Headers(renameInit.headers).get("Idempotency-Key")).toBe("k1");
  });

  it("run() sends the collection the outputs go in under the request's own name", async () => {
    const fetchImpl = vi.fn(async () => envelope({ id: "j", status: "PENDING" }));
    await client(fetchImpl).ops.run("resize", { assetIds: "a", parameters: { width: 800 }, collection: "shoot-01" });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      op: "resize",
      assetIds: ["a"],
      parameters: { width: 800 },
      collection: "shoot-01"
    });
  });

  it("wait:true lets the SERVICE wait — on the submit, then on the read — and throws JobFailedError on FAILED (#355)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envelope({ id: "j", status: "PENDING" }))
      .mockResolvedValueOnce(envelope({ id: "j", status: "PROCESSING" }))
      .mockResolvedValueOnce(envelope({ id: "j", status: "COMPLETED", items: [{ status: "COMPLETED", resultAssetId: "out" }] }));
    const seen = [];
    const job = await client(fetchImpl).ops.removeBg("a1", { wait: { intervalMs: 1, onProgress: (j) => seen.push(j.status) } });
    expect(job.status).toBe("COMPLETED");
    expect(seen).toEqual(["PENDING", "PROCESSING", "COMPLETED"]);
    // The submit asks the service to hold on (60 s is the service's ceiling), and so does every read after it.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ op: "remove_bg", assetIds: ["a1"], wait: 60 });
    expect(fetchImpl.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "https://api.test/api/v1/jobs/j?wait=60",
      "https://api.test/api/v1/jobs/j?wait=60"
    ]);

    const failing = vi
      .fn()
      .mockResolvedValueOnce(envelope({ id: "k", status: "PENDING" }))
      .mockResolvedValueOnce(envelope({ id: "k", status: "FAILED" }));
    await expect(client(failing).ops.removeBg("a1", { wait: { intervalMs: 1 } })).rejects.toBeInstanceOf(JobFailedError);
  });

  it("a job that came back finished from the submit costs no read at all", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(envelope({ id: "j", status: "COMPLETED", items: [] }));
    const job = await client(fetchImpl).presets.run("web-optimize", "a1", { wait: true });
    expect(job.status).toBe("COMPLETED");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ presetId: "web-optimize", assetIds: ["a1"], wait: 60 });

    const failed = vi.fn().mockResolvedValueOnce(envelope({ id: "j", status: "FAILED", items: [] }));
    await expect(client(failed).ops.removeBg("a1", { wait: true })).rejects.toBeInstanceOf(JobFailedError);
    const tolerated = vi.fn().mockResolvedValueOnce(envelope({ id: "j", status: "FAILED", items: [] }));
    expect((await client(tolerated).ops.removeBg("a1", { wait: { throwOnFailure: false } })).status).toBe("FAILED");
  });

  it("jobs.submit takes the same wait: a raw request held on the submit, then read to the end", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(envelope({ id: "j", status: "PENDING" }))
      .mockResolvedValueOnce(envelope({ id: "j", status: "FAILED" }));
    const job = await client(fetchImpl).jobs.submit(
      { type: "process", presetId: "p", assetIds: ["a"] },
      { wait: { intervalMs: 1, throwOnFailure: false } }
    );
    expect(job.status).toBe("FAILED");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ type: "process", presetId: "p", assetIds: ["a"], wait: 60 });
    expect(fetchImpl.mock.calls[1][0]).toBe("https://api.test/api/v1/jobs/j?wait=60");
  });

  // contract §5.1: over the account's share of open waits the read is `429 rate_limited` + `Retry-After` — a wait with
  // time left asks again rather than ending on it, however many times `request`'s own retries were spent.
  it("a waited read turned away is asked again until the wait's own deadline", async () => {
    const turnedAway = () => errorResponse(429, { code: "rate_limited", message: "8 waits open", retryable: true }, { "Retry-After": "0" });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => turnedAway())
      .mockImplementationOnce(async () => turnedAway())
      .mockImplementationOnce(async () => turnedAway())
      .mockResolvedValueOnce(envelope({ id: "j", status: "COMPLETED" }));
    expect((await client(fetchImpl).jobs.wait("j", { intervalMs: 1 })).status).toBe("COMPLETED");
    expect(fetchImpl).toHaveBeenCalledTimes(4);

    const refused = vi.fn(async () => errorResponse(404, { code: "job_not_found", message: "no", retryable: false }));
    await expect(client(refused).jobs.wait("j", { intervalMs: 1 })).rejects.toMatchObject({ code: "job_not_found" });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("asks for no longer than the caller will wait, never sends `wait` unasked, and does not spin on a service that answers early", async () => {
    const short = vi.fn().mockResolvedValueOnce(envelope({ id: "j", status: "COMPLETED" }));
    await client(short).ops.removeBg("a1", { wait: { timeoutMs: 8_000 } });
    expect(JSON.parse(short.mock.calls[0][1].body).wait).toBe(8);

    const plain = vi.fn().mockResolvedValueOnce(envelope({ id: "j", status: "PENDING" }));
    await client(plain).ops.removeBg("a1");
    expect(JSON.parse(plain.mock.calls[0][1].body)).toEqual({ op: "remove_bg", assetIds: ["a1"] });
    const dry = vi.fn().mockResolvedValueOnce(envelope({ totalItems: 1 }));
    await client(dry).ops.removeBg("a1", { dryRun: true, wait: true });
    expect(dry.mock.calls[0][0]).toBe("https://api.test/api/v1/jobs?dryRun=true");
    expect(JSON.parse(dry.mock.calls[0][1].body).wait).toBeUndefined();

    // An older service ignores `wait` and answers at once: `intervalMs` is the floor between reads.
    const eager = vi.fn(async () => envelope({ id: "j", status: "PROCESSING" }));
    const started = Date.now();
    await expect(client(eager).jobs.wait("j", { intervalMs: 40, timeoutMs: 150 })).rejects.toBeInstanceOf(JobFailedError);
    expect(eager.mock.calls.length).toBeLessThanOrEqual(6);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("readMetadata is a GET on the asset, never a job", async () => {
    const fetchImpl = vi.fn(async () => envelope({ id: "a1", image: { width: 10 }, metadata: { exif: {} } }));
    const m = await client(fetchImpl).ops.readMetadata("a1");
    expect(m.image.width).toBe(10);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.test/api/v1/assets/a1");
    expect(fetchImpl.mock.calls[0][1].method).toBe("GET");
  });
});

/**
 * imagestep#127 — the contract face. It is on the client rather than left to a raw request because
 * the contract's §7 asks an agent to report a gap instead of routing around it, and a rule whose
 * only implementation is "build your own HTTP call" loses to the workaround.
 */
describe("agent", () => {
  it("reads the contract from the public endpoint", async () => {
    const fetchImpl = vi.fn(async () => envelope({ version: 1, updated: "2026-09-12", markdown: "# Rules" }));

    const guidelines = await client(fetchImpl).agent.guidelines();

    expect(guidelines.markdown).toBe("# Rules");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/agent-guidelines");
    expect(init.method).toBe("GET");
  });

  it("posts a report with only the fields it was given, and it is idempotent like every other write", async () => {
    const fetchImpl = vi.fn(async () => envelope({ id: "fbk_1", kind: "capability_gap" }));

    const saved = await client(fetchImpl).agent.feedback({
      kind: "capability_gap",
      op: "detect_faces",
      message: "No such op; I need one.",
      context: { tried: "generate" }
    });

    expect(saved.id).toBe("fbk_1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/feedback");
    expect(JSON.parse(init.body)).toEqual({
      kind: "capability_gap",
      op: "detect_faces",
      message: "No such op; I need one.",
      context: { tried: "generate" }
    });
    expect(init.headers["Idempotency-Key"]).toMatch(/[0-9a-f-]{36}/);
  });

  it("lists this account's own reports with pagination", async () => {
    const fetchImpl = vi.fn(async () => envelope([{ id: "fbk_1" }], { total: 1, page: 1, perPage: 20, hasMore: false }));

    const { items, meta } = await client(fetchImpl).agent.reports({ page: 1, perPage: 20 });

    expect(items).toHaveLength(1);
    expect(meta.total).toBe(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.test/api/v1/feedback?page=1&perPage=20");
  });
});

describe("assets.upload", () => {
  it("stages, PUTs the bytes to the presigned URL with the mime type, finishes, and waits for DONE", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith("/stage-upload")) return envelope([{ objectId: "obj-1", url: "https://bucket/obj-1?sig", exists: false }]);
      if (url.startsWith("https://bucket/")) return new Response(null, { status: 200 });
      if (url.endsWith("/finish-upload")) return envelope([{ id: "ast_1", status: "PROCESSING" }]);
      if (url.endsWith("/assets/status")) return envelope({ items: [{ id: "ast_1", status: "DONE" }] });
      if (url.endsWith("/assets/ast_1")) return envelope({ id: "ast_1", status: "DONE", image: { width: 2 } });
      throw new Error("unexpected " + url);
    });
    const asset = await client(fetchImpl).assets.upload(new Uint8Array([137, 80, 78, 71]), {
      name: "pixel.png",
      collection: "smoke",
      tags: ["hero"]
    });
    expect(asset.status).toBe("DONE");
    const stage = JSON.parse(calls[0][1].body)[0];
    expect(stage).toMatchObject({ fileName: "pixel.png", fileSize: 4 });
    expect(stage.sha1Hash).toMatch(/^[0-9a-f]{40}$/);
    expect(calls[1][1].method).toBe("PUT");
    expect(calls[1][1].headers["Content-Type"]).toBe("image/png");
    const finish = JSON.parse(calls[2][1].body)[0];
    // #232: the object, the name, the label and the tags (#334) — nothing the service can work out for itself.
    expect(finish).toEqual({ objectId: "obj-1", name: "pixel.png", collection: "smoke", tags: ["hero"] });
  });

  it("returns the existing asset when the bytes were ingested before, and always PUTs otherwise", async () => {
    const reuse = vi.fn(async (url) => {
      if (url.endsWith("/stage-upload"))
        return envelope([{ objectId: "obj-new", url: "https://bucket/obj-new", exists: true, existingAssetId: "ast_old" }]);
      if (url.endsWith("/assets/ast_old")) return envelope({ id: "ast_old", status: "DONE" });
      throw new Error("unexpected " + url);
    });
    const asset = await client(reuse).assets.upload(new Uint8Array([1, 2, 3]), { name: "x.jpg" });
    expect(asset.id).toBe("ast_old");
    expect(reuse.mock.calls.some(([, init]) => init.method === "PUT")).toBe(false);

    // exists but the caller wants a fresh row → the slot is empty, so the bytes go up
    const fresh = vi.fn(async (url) => {
      if (url.endsWith("/stage-upload"))
        return envelope([{ objectId: "obj-new", url: "https://bucket/obj-new", exists: true, existingAssetId: "ast_old" }]);
      if (url.startsWith("https://bucket/")) return new Response(null, { status: 200 });
      if (url.endsWith("/finish-upload")) return envelope([{ id: "ast_new", status: "DONE" }]);
      if (url.endsWith("/assets/status")) return envelope({ items: [{ id: "ast_new", status: "DONE" }] });
      return envelope({ id: "ast_new", status: "DONE" });
    });
    const created = await client(fresh).assets.upload(new Uint8Array([1, 2, 3]), { name: "x.jpg", reuseExisting: false });
    expect(created.id).toBe("ast_new");
    expect(fresh.mock.calls.some(([, init]) => init.method === "PUT")).toBe(true);
  });

  // #567: the PUT went straight to fetch — a dropped connection failed the upload, a hung one never ended.
  it("sends a storage PUT that failed on the network or with a 503 again, and times out one that hangs", async () => {
    const puts = [];
    const flaky = vi.fn(async (url, init) => {
      if (url.endsWith("/stage-upload")) return envelope([{ objectId: "o", url: "https://bucket/o", contentType: "image/png" }]);
      if (url.startsWith("https://bucket/")) {
        puts.push(init.body);
        if (puts.length === 1) throw new TypeError("fetch failed");
        if (puts.length === 2) return new Response("<Error>SlowDown</Error>", { status: 503, headers: { "Retry-After": "0" } });
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/finish-upload")) return envelope([{ id: "ast_1", status: "DONE" }]);
      throw new Error("unexpected " + url);
    });
    const asset = await client(flaky, { maxRetries: 2 }).assets.upload(new Uint8Array([1, 2]), { name: "p.png", wait: false });
    expect(asset.id).toBe("ast_1");
    expect(puts).toHaveLength(3);
    expect(puts.every((body) => body instanceof Uint8Array && body.length === 2)).toBe(true);

    const hang = vi.fn((url, init) =>
      url.endsWith("/stage-upload")
        ? Promise.resolve(envelope([{ objectId: "o", url: "https://bucket/o", contentType: "image/png" }]))
        : new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
    );
    const err = await client(hang, { timeoutMs: 20 })
      .assets.upload(new Uint8Array([1, 2]), { name: "p.png", wait: false })
      .catch((e) => e);
    expect(err.message).toMatch(/^ImageStep PUT https:\/\/bucket\/o timed out after 21 ms$/);
  });
});

describe("webhooks", () => {
  async function sign(body, secret, t) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
    return `t=${t},v1=${Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;
  }

  it("verifies a good signature and rejects a tampered body or a stale timestamp", async () => {
    const body = JSON.stringify({ id: "evt_1", type: "job.completed", createdAt: "2026-09-08T00:00:00Z", data: { jobId: "j" } });
    const now = 1_800_000_000;
    const header = await sign(body, "whsec_x", now);
    expect(await verifyWebhookSignature(body, header, "whsec_x", { now })).toBe(true);
    expect(await verifyWebhookSignature(body + " ", header, "whsec_x", { now })).toBe(false);
    expect(await verifyWebhookSignature(body, header, "whsec_x", { now: now + 3600 })).toBe(false);
    const event = await constructWebhookEvent(body, header, "whsec_x", { now });
    expect(event.type).toBe("job.completed");
    await expect(constructWebhookEvent(body, header, "whsec_other", { now })).rejects.toThrow(/signature/);
  });

  it("throws on a missing secret instead of checking a signature anybody could make (#479)", async () => {
    // null and undefined used to be encoded as the strings "null" / "undefined": a receiver whose env var was unset
    // accepted a forgery signed with that word. ("" already failed, inside WebCrypto, with a DataError nobody reads as
    // "you forgot the secret".)
    const body = "{}";
    const now = 1_800_000_000;
    for (const secret of ["", null, undefined]) {
      const forged = await sign(body, String(secret) || "x", now);
      await expect(verifyWebhookSignature(body, forged, secret, { now }), String(secret)).rejects.toThrow(/secret/);
      await expect(constructWebhookEvent(body, forged, secret, { now })).rejects.toThrow(TypeError);
    }
  });
});

describe("assets.fromUrl", () => {
  it("lets the service fetch every URL, keeps each URL's outcome, and waits only for what was created", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([url, init]);
      if (url.endsWith("/assets/from-url"))
        return envelope([
          { url: "https://cdn.example/a.png", id: "ast_1", status: "PROCESSING" },
          { url: "http://10.0.0.7/x.png", error: { code: "invalid_param", message: "private address", retryable: false, param: "url" } }
        ]);
      if (url.endsWith("/assets/status")) return envelope({ items: [{ id: "ast_1", status: "DONE" }] });
      if (url.endsWith("/assets/ast_1")) return envelope({ id: "ast_1", status: "DONE" });
      throw new Error("unexpected " + url);
    });

    const out = await client(fetchImpl).assets.fromUrl(["https://cdn.example/a.png", "http://10.0.0.7/x.png"], {
      collection: "shoot",
      tags: ["hero"]
    });

    expect(JSON.parse(calls[0][1].body)).toEqual({
      urls: ["https://cdn.example/a.png", "http://10.0.0.7/x.png"],
      collection: "shoot",
      tags: ["hero"]
    });
    expect(out[0]).toEqual({ url: "https://cdn.example/a.png", asset: { id: "ast_1", status: "DONE" } });
    expect(out[1].error.param).toBe("url");
    // One POST, one batch-status poll (#233) and one read: nothing is fetched client-side, and the failed URL is not polled.
    expect(calls).toHaveLength(3);
  });
});

// #525: the service takes twenty URLs a request, and one status call can read a hundred ids.
describe("bulk ingest (#525)", () => {
  function ingestingService({ ticks = 3 } = {}) {
    const calls = { fromUrl: [], status: 0, get: 0, stage: [], put: [], finish: [] };
    let polls = 0;
    let inFlight = 0;
    let widest = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.endsWith("/assets/from-url")) {
        const { urls } = JSON.parse(init.body);
        calls.fromUrl.push(urls.length);
        return envelope(urls.map((u) => ({ url: u, id: `ast_${u.split("/").pop()}`, status: "PROCESSING" })));
      }
      if (url.endsWith("/assets/status")) {
        calls.status++;
        polls++;
        const { ids } = JSON.parse(init.body);
        return envelope({ items: ids.map((id) => ({ id, status: polls >= ticks ? "DONE" : "PROCESSING" })) });
      }
      if (url.endsWith("/assets/stage-upload")) {
        const items = JSON.parse(init.body);
        calls.stage.push(items.length);
        return envelope(items.map((f, n) => ({ objectId: `obj${n}`, url: `https://storage.test/obj${n}`, contentType: "image/png" })));
      }
      if (url.startsWith("https://storage.test/")) {
        inFlight++;
        widest = Math.max(widest, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        calls.put.push(url);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/assets/finish-upload")) {
        const items = JSON.parse(init.body);
        calls.finish.push(items.length);
        return envelope(items.map((f) => ({ id: `ast_${f.objectId}`, name: f.name, status: "PROCESSING" })));
      }
      const got = /\/assets\/(ast_[\w.]+)$/.exec(url);
      if (got) {
        calls.get++;
        return envelope({ id: got[1], status: "DONE" });
      }
      throw new Error("unexpected " + url);
    });
    return { fetchImpl, calls, widest: () => widest };
  }

  it("fromUrl sends 25 URLs as two requests of 20 and 5, and keeps every URL's outcome in order", async () => {
    const { fetchImpl, calls } = ingestingService({ ticks: 1 });
    const urls = Array.from({ length: 25 }, (_, n) => `https://cdn.example/${n}.png`);
    const out = await client(fetchImpl).assets.fromUrl(urls);
    expect(calls.fromUrl).toEqual([20, 5]);
    expect(out.map((r) => r.url)).toEqual(urls);
    expect(out.every((r) => r.asset?.status === "DONE")).toBe(true);
  });

  it("waits for 20 ingesting assets with one status call per tick, not one per asset", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl, calls } = ingestingService({ ticks: 3 });
      const urls = Array.from({ length: 20 }, (_, n) => `https://cdn.example/${n}.png`);
      const pending = client(fetchImpl).assets.fromUrl(urls);
      await vi.advanceTimersByTimeAsync(2 * 1500); // two ticks of the default poll interval
      const out = await pending;
      expect(calls.status).toBe(3);
      expect(calls.get).toBe(20);
      expect(out).toHaveLength(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uploadMany: 10 files are one stage, one finish, PUTs at most `concurrency` at a time, one status call per tick", async () => {
    const { fetchImpl, calls, widest } = ingestingService({ ticks: 1 });
    const files = Array.from({ length: 10 }, (_, n) => new File([new Uint8Array([n, 1, 2])], `f${n}.png`, { type: "image/png" }));
    const out = await client(fetchImpl).assets.uploadMany(files, { concurrency: 3, collection: "shoot" });
    expect(calls.stage).toEqual([10]);
    expect(calls.finish).toEqual([10]);
    expect(calls.put).toHaveLength(10);
    expect(widest()).toBeLessThanOrEqual(3);
    expect(calls.status).toBe(1);
    expect(out.map((r) => r.name)).toEqual(files.map((f) => f.name));
    expect(out.every((r) => r.asset?.status === "DONE")).toBe(true);
  });

  it("uploadMany keeps a file the service refused as its own result", async () => {
    const { fetchImpl, calls } = ingestingService({ ticks: 1 });
    const base = fetchImpl.getMockImplementation();
    fetchImpl.mockImplementation(async (url, init) => {
      if (url.endsWith("/assets/stage-upload")) {
        const items = JSON.parse(init.body);
        return envelope(
          items.map((f, n) =>
            n === 1
              ? { error: "File exceeds the 100 MB limit" }
              : { objectId: `obj${n}`, url: `https://storage.test/obj${n}`, contentType: "image/png" }
          )
        );
      }
      return base(url, init);
    });
    const files = [0, 1, 2].map((n) => new Uint8Array([n]));
    const out = await client(fetchImpl).assets.uploadMany(files, { wait: false });
    expect(out[1]).toEqual({
      name: "upload.bin",
      error: { code: "invalid_param", message: "File exceeds the 100 MB limit", retryable: false, param: "file" }
    });
    expect(calls.finish).toEqual([2]);
    expect(out[0].asset.id).toBe("ast_obj0");
    expect(out[2].asset.id).toBe("ast_obj2");
  });
});

describe("assets.tag (#334)", () => {
  it("replaces the tags through the batch update, one id or many", async () => {
    const fetchImpl = vi.fn(async (url, init) => envelope(JSON.parse(init.body).ids.map((id) => ({ id }))));
    const assets = client(fetchImpl).assets;

    await assets.tag("ast_1", ["hero", "sale"]);
    await assets.tag(["ast_1", "ast_2"], []);

    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.test/api/v1/assets/update");
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ ids: ["ast_1"], tags: ["hero", "sale"] });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ ids: ["ast_1", "ast_2"], tags: [] });
  });
});

describe("assets.download (#233)", () => {
  it("follows the content redirect itself and never sends the API key to storage", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init = {}) => {
      calls.push([url, init]);
      if (url.includes("/assets/ast_1/content"))
        return new Response(null, { status: 302, headers: { Location: "https://bucket/obj?sig=1" } });
      if (url === "https://bucket/obj?sig=1")
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/png" } });
      throw new Error("unexpected " + url);
    });

    const file = await client(fetchImpl).assets.download("ast_1", { variant: "preview" });

    expect([...file.bytes]).toEqual([1, 2, 3]);
    expect(file.contentType).toBe("image/png");
    expect(calls[0][0]).toBe("https://api.test/api/v1/assets/ast_1/content?variant=preview");
    expect(calls[0][1].redirect).toBe("manual");
    expect(calls[0][1].headers.Authorization).toMatch(/^ApiKey /);
    expect(calls[1][1].headers?.Authorization).toBeUndefined();
  });

  it("turns an error answer into an ImageStepError with the contract's code", async () => {
    const fetchImpl = vi.fn(async () =>
      errorResponse(404, { code: "asset_not_found", message: "Asset 'x' was not found", retryable: false })
    );
    await expect(client(fetchImpl).assets.download("x")).rejects.toMatchObject({ status: 404, code: "asset_not_found" });
  });

  // #567: both legs were a bare fetch — no timeout, and one 503 from storage failed the download.
  it("sends both legs again when they fail for now, and names a storage failure that outlived the retries", async () => {
    let redirects = 0;
    let reads = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.includes("/content")) {
        if (++redirects === 1)
          return errorResponse(429, { code: "rate_limited", message: "slow", retryable: true }, { "Retry-After": "0" });
        return new Response(null, { status: 302, headers: { Location: "https://bucket/obj?sig=1" } });
      }
      if (++reads === 1) return new Response("<Error/>", { status: 503, headers: { "Retry-After": "0" } });
      return new Response(new Uint8Array([9]), { status: 200, headers: { "Content-Type": "image/png" } });
    });
    const file = await client(fetchImpl, { maxRetries: 1 }).assets.download("ast_1");
    expect([...file.bytes]).toEqual([9]);
    expect([redirects, reads]).toEqual([2, 2]);

    const down = vi.fn(async (url) =>
      url.includes("/content")
        ? new Response(null, { status: 302, headers: { Location: "https://bucket/obj?sig=1" } })
        : new Response("<Error/>", { status: 503, headers: { "Retry-After": "0" } })
    );
    await expect(client(down, { maxRetries: 1 }).assets.download("ast_1")).rejects.toMatchObject({
      status: 503,
      code: "internal_error",
      retryable: true,
      message: "Download from storage failed (503)"
    });
    expect(down).toHaveBeenCalledTimes(3);
  });
});

describe("templates (#234)", () => {
  it("lists a page of summaries and iterates every page (#497)", async () => {
    const pages = [];
    const fetchImpl = vi.fn(async (url) => {
      const at = new URL(url).searchParams.get("cursor") === "c1" ? 1 : 0;
      pages.push(new URL(url).search);
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ id: `tpl_${at}`, name: "card" }],
          meta: { perPage: 1, hasMore: at === 0, nextCursor: at === 0 ? "c1" : null }
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    const templates = client(fetchImpl).templates;

    const first = await templates.list("user", { perPage: 1 });
    expect(first.items.map((t) => t.id)).toEqual(["tpl_0"]);
    expect(first.meta.hasMore).toBe(true);
    const all = [];
    for await (const t of templates.iterate("user")) all.push(t.id);
    expect(all).toEqual(["tpl_0", "tpl_1"]);
    expect(pages[0]).toBe("?filter=user&perPage=1");
  });

  it("speaks every template route, and one version is addressed as id@version", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([init.method, url.replace("https://api.test", ""), init.body]);
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : envelope({ id: "tpl_1", version: 2 });
    });
    const templates = client(fetchImpl).templates;

    await templates.list("user");
    await templates.get("tpl_1@1");
    await templates.versions("tpl_1");
    await templates.create({ name: "card", html: "<h1>{{ title }}</h1>", width: 600, height: 300 });
    await templates.update("tpl_1", { name: "card", html: "<h2>{{ title }}</h2>", width: 600, height: 300 });
    await templates.delete("tpl_1");
    await templates.import([{ name: "card", html: "<p></p>", width: 1, height: 1 }]);

    expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      "GET /api/v1/templates?filter=user",
      "GET /api/v1/templates/tpl_1%401",
      "GET /api/v1/templates/tpl_1/versions",
      "POST /api/v1/templates",
      "PUT /api/v1/templates/tpl_1",
      "DELETE /api/v1/templates/tpl_1",
      "POST /api/v1/templates/import"
    ]);
    expect(JSON.parse(calls[3][2]).html).toBe("<h1>{{ title }}</h1>");
  });
});

describe("presets (#247)", () => {
  it("speaks every preset route, and a version rides on the path", async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push([init.method, url.replace("https://api.test", ""), init.body]);
      return init.method === "DELETE" ? new Response(null, { status: 204 }) : envelope({ id: "pre_1", slug: "web-optimize", version: 2 });
    });
    const presets = client(fetchImpl).presets;
    const steps = [
      { op: "resize", parameters: { width: 1600 } },
      { operation: "sharpen", params: { sigma: 0.5 } }
    ];

    await presets.list("user");
    await presets.get("web-optimize@1");
    await presets.create({ name: "web-optimize", steps });
    await presets.update("web-optimize", { name: "web-optimize", steps: steps.slice(0, 1) });
    await presets.run("web-optimize@1", ["a1", "a2"]);
    await presets.delete("web-optimize");
    // imagestep#445 — one stored version, on its own path: the version is a path segment here, not an `@` on the slug,
    // because `@` names the version to READ and this names the one to remove.
    await presets.deleteVersion("web-optimize", 2);
    await presets.import([{ name: "web-optimize", steps }]);

    expect(calls.map(([method, path]) => `${method} ${path}`)).toEqual([
      "GET /api/v1/presets?filter=user",
      "GET /api/v1/presets/web-optimize%401",
      "POST /api/v1/presets",
      "PUT /api/v1/presets/web-optimize",
      "POST /api/v1/jobs",
      "DELETE /api/v1/presets/web-optimize",
      "DELETE /api/v1/presets/web-optimize/versions/2",
      "POST /api/v1/presets/import"
    ]);
    // Both step shapes survive the wire as written: an op step and a registry step.
    expect(JSON.parse(calls[2][2]).steps).toEqual(steps);
    expect(JSON.parse(calls[4][2])).toEqual({ presetId: "web-optimize@1", assetIds: ["a1", "a2"] });
  });

  it("dry-runs a chain and gets the price back segment by segment", async () => {
    const estimate = {
      type: "chain",
      totalItems: 2,
      costPerItem: 400,
      estimatedCredits: 800,
      creditBalance: 5000,
      sufficientCredit: true,
      assetCountLeft: 100,
      processPerItem: 1,
      steps: [
        { index: 0, op: "remove_bg", model: "fal-ai/bria/background/remove", costPerItem: 200 },
        { index: 1, op: "process", costPerItem: 0 },
        { index: 2, op: "upscale", model: "fal-ai/clarity-upscaler", costPerItem: 200, bound: true }
      ]
    };
    const fetchImpl = vi.fn(async () => envelope(estimate));

    const priced = await client(fetchImpl).presets.run("cut-out@2", ["a1", "a2"], { dryRun: true });

    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.test/api/v1/jobs?dryRun=true");
    expect(priced.steps.reduce((sum, step) => sum + step.costPerItem, 0)).toBe(priced.costPerItem);
    expect(priced.steps[2].bound).toBe(true);
  });

  // imagestep#461 — a consistency preset is "the same subject, a new scene each run": the scene is this run's prompt.
  it("sends this run's prompt and count, and nothing it was not given", async () => {
    const fetchImpl = vi.fn(async () => envelope({ id: "j1", status: "PENDING" }));
    const presets = client(fetchImpl).presets;

    await presets.run("bottle-shots@2", [], { prompt: "{{subject.bottle}} on a beach at dusk", count: 3 });
    await presets.run("bottle-shots", []);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      presetId: "bottle-shots@2",
      assetIds: [],
      prompt: "{{subject.bottle}} on a beach at dusk",
      count: 3
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ presetId: "bottle-shots", assetIds: [] });
  });
});

describe("jobs.outputs (#441)", () => {
  it("is one paged listing of the run, in item order, not one GET per item", async () => {
    const job = {
      id: "job_1",
      items: [
        { status: "COMPLETED", resultAssetId: "ast_1" },
        { status: "FAILED" },
        { status: "COMPLETED", resultAssetId: "ast_2" },
        { status: "COMPLETED", resultAssetId: "ast_3" }
      ]
    };
    // Newest-first, i.e. not item order, and split over two pages.
    const fetchImpl = vi.fn(async () =>
      fetchImpl.mock.calls.length === 1
        ? envelope([{ id: "ast_3" }, { id: "ast_2" }], { total: 3, page: 0, perPage: 2, hasMore: true, nextCursor: "c2" })
        : envelope([{ id: "ast_1" }], { perPage: 2, hasMore: false, nextCursor: null })
    );

    const outputs = await client(fetchImpl).jobs.outputs(job);

    expect(outputs.map((a) => a.id)).toEqual(["ast_1", "ast_2", "ast_3"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2, "three outputs, two pages — never three GETs");
    const first = new URL(fetchImpl.mock.calls[0][0]);
    expect(first.pathname).toBe("/api/v1/assets");
    expect(first.searchParams.get("jobId")).toBe("job_1");
  });

  it("an output the caller has since deleted is absent, not a 404 for the whole call", async () => {
    const job = { id: "job_1", items: [{ resultAssetId: "ast_gone" }, { resultAssetId: "ast_1" }] };
    const fetchImpl = vi.fn(async () => envelope([{ id: "ast_1" }], { total: 1, page: 0, perPage: 100, hasMore: false }));

    expect((await client(fetchImpl).jobs.outputs(job)).map((a) => a.id)).toEqual(["ast_1"]);
  });

  it("a job id with no items keeps the listing's own order", async () => {
    const fetchImpl = vi.fn(async () => envelope([{ id: "ast_2" }, { id: "ast_1" }], { total: 2, page: 0, perPage: 100, hasMore: false }));

    expect((await client(fetchImpl).jobs.outputs("job_1")).map((a) => a.id)).toEqual(["ast_2", "ast_1"]);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("jobId")).toBe("job_1");
  });
});

/**
 * imagestep#437 — `list()` hands back one page; `iterate()` is the loop nobody should have to write. Since #493 the
 * loop follows `meta.nextCursor` rather than counting pages: the next page is wherever the ANSWER says it starts, and a
 * page number sent after the first would make the service re-read and re-count every earlier row.
 */
describe("walking a listing", () => {
  function pages(...responses) {
    const fetchImpl = vi.fn(async () => envelope(...responses[fetchImpl.mock.calls.length - 1]));
    return fetchImpl;
  }
  const params = (fetchImpl, name) => fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get(name));

  it("yields every row, following the cursor the answer carries, with the same filters (#493)", async () => {
    const fetchImpl = pages(
      [[{ id: "a1" }, { id: "a2" }], { total: 3, page: 0, perPage: 2, hasMore: true, nextCursor: "c2" }],
      [[{ id: "a3" }], { perPage: 2, hasMore: false, nextCursor: null }]
    );
    const seen = [];
    for await (const asset of client(fetchImpl).assets.iterate({ collection: "shoot", perPage: 2 })) seen.push(asset.id);

    expect(seen).toEqual(["a1", "a2", "a3"]);
    // The first request is an ordinary one; every later one is a cursor and never a page number, so the service
    // neither re-reads the earlier rows nor counts again.
    expect(params(fetchImpl, "cursor")).toEqual([null, "c2"]);
    expect(params(fetchImpl, "page")).toEqual([null, null]);
    expect(params(fetchImpl, "collection")).toEqual(["shoot", "shoot"]);
  });

  it("resumes from a page or from a cursor, and continues by cursor either way", async () => {
    const fromPage = pages(
      [[{ id: "a1" }], { total: 4, page: 2, perPage: 1, hasMore: true, nextCursor: "c3" }],
      [[{ id: "a2" }], { perPage: 1, hasMore: false, nextCursor: null }]
    );
    expect((await Array.fromAsync(client(fromPage).assets.iterate({ page: 7, perPage: 1 }))).map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(params(fromPage, "page")).toEqual(["7", null]);
    expect(params(fromPage, "cursor")).toEqual([null, "c3"]);

    const fromCursor = pages(
      [[{ id: "a5" }], { perPage: 1, hasMore: true, nextCursor: "c6" }],
      [[{ id: "a6" }], { perPage: 1, hasMore: false, nextCursor: null }]
    );
    expect((await Array.fromAsync(client(fromCursor).jobs.iterate({ cursor: "c5" }))).map((a) => a.id)).toEqual(["a5", "a6"]);
    expect(params(fromCursor, "cursor")).toEqual(["c5", "c6"]);
  });

  it("a listing that says hasMore without saying where is an error, never a silent stop halfway", async () => {
    const fetchImpl = pages([[{ id: "a1" }], { total: 2, page: 0, perPage: 1, hasMore: true }]);
    await expect(Array.fromAsync(client(fetchImpl).assets.iterate())).rejects.toThrow(/nextCursor/);
  });

  it("one page is one request, and an empty listing is no rows", async () => {
    const one = pages([[{ id: "a1" }], { total: 1, page: 0, perPage: 100, hasMore: false, nextCursor: null }]);
    expect((await Array.fromAsync(client(one).assets.iterate())).length).toBe(1);
    expect(one).toHaveBeenCalledTimes(1);

    const none = pages([[], { total: 0, page: 0, perPage: 100, hasMore: false, nextCursor: null }]);
    expect(await Array.fromAsync(client(none).jobs.iterate({ status: "FAILED" }))).toEqual([]);
  });

  it("every listing has one: collections, jobs, items, reports, templates and an endpoint's deliveries", async () => {
    for (const walk of [
      (c) => c.assets.iterateCollections({ q: "sh" }),
      (c) => c.jobs.iterate({ type: "process" }),
      (c) => c.jobs.iterateItems("job_1", { status: "FAILED" }),
      (c) => c.agent.iterateReports(),
      (c) => c.templates.iterate("user"),
      (c) => c.webhooks.iterateDeliveries("whe_1")
    ]) {
      const fetchImpl = pages(
        [[{ id: "r1" }], { total: 2, page: 0, perPage: 1, hasMore: true, nextCursor: "c1" }],
        [[{ id: "r2" }], { perPage: 1, hasMore: false, nextCursor: null }]
      );
      expect(await Array.fromAsync(walk(client(fetchImpl)))).toHaveLength(2);
      expect(params(fetchImpl, "cursor")).toEqual([null, "c1"]);
    }
  });
});

// #528: against a real HTTP server — a stub fetch never checks what Node's fetch does with a stream body.
describe("stream bodies on a real socket (#528)", () => {
  async function serve(handler) {
    const { createServer } = await import("node:http");
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await handler(req, Buffer.concat(chunks), res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, close: () => new Promise((resolve) => server.close(resolve)) };
  }
  const json = (res, data) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data }));
  };

  it("sends a ReadableStream to the synchronous lane with duplex: half", async () => {
    let received;
    const { base, close } = await serve((req, body, res) => {
      if (req.url.startsWith("/api/v1/ops"))
        return json(res, [{ op: "resize", kind: "deterministic", syncEndpoint: "POST /api/v1/images/transform" }]);
      received = body;
      res.writeHead(200, { "content-type": "image/webp" });
      res.end(Buffer.from([7, 7]));
    });
    try {
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1, 2]));
          c.enqueue(new Uint8Array([3]));
          c.close();
        }
      });
      const out = await new ImageStep({ apiKey: "k", baseUrl: base }).images.transform("resize", {
        file: stream,
        parameters: { width: 4 }
      });
      expect([...received]).toEqual([1, 2, 3]);
      expect([...out]).toEqual([7, 7]);
    } finally {
      await close();
    }
  });

  it("upload(path) hashes the file as a stream and PUTs it as a stream, with the exact length", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 5);
    const path = join(mkdtempSync(join(tmpdir(), "imagestep-sdk-")), "big.png");
    writeFileSync(path, bytes);
    const seen = {};
    const { base, close } = await serve((req, body, res) => {
      if (req.url === "/api/v1/assets/stage-upload") {
        seen.stage = JSON.parse(body)[0];
        return json(res, [{ objectId: "obj1", url: `${base}/storage/obj1`, contentType: "image/png" }]);
      }
      if (req.url === "/storage/obj1") {
        seen.put = { length: body.length, header: req.headers["content-length"], sha1: createHash("sha1").update(body).digest("hex") };
        res.writeHead(200);
        return res.end();
      }
      if (req.url === "/api/v1/assets/finish-upload") return json(res, [{ id: "ast_1", name: "big", status: "PROCESSING" }]);
      res.writeHead(404);
      res.end();
    });
    try {
      const client = new ImageStep({ apiKey: "k", baseUrl: base });
      const spy = vi.spyOn(client, "fetch");
      const asset = await client.assets.upload(path, { wait: false });
      expect(asset.id).toBe("ast_1");
      const sha1 = createHash("sha1").update(bytes).digest("hex");
      expect(seen.stage).toEqual({ fileName: "big.png", fileSize: bytes.length, sha1Hash: sha1 });
      expect(seen.put).toEqual({ length: bytes.length, header: String(bytes.length), sha1 });
      // The PUT carried a stream, not the file's bytes in memory.
      const putInit = spy.mock.calls.find(([url]) => url.endsWith("/storage/obj1"))[1];
      expect(putInit.body instanceof Uint8Array).toBe(false);
      expect(putInit.duplex).toBe("half");
    } finally {
      await close();
    }
  });

  it("a PUT body nobody reads never opens the file — deleting it afterwards throws nothing", async () => {
    // A createReadStream opened at once: a fetch that answered without reading (a stub, a request that failed before
    // sending) left an open queued that hit ENOENT once the file was gone, uncaught — vitest saw it in three docs suites.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "imagestep-sdk-"));
    const path = join(dir, "photo.jpg");
    writeFileSync(path, Buffer.alloc(64, 1));
    const answers = {
      "/api/v1/assets/stage-upload": [{ objectId: "o1", url: "https://storage.test/o1", contentType: "image/jpeg" }],
      "/api/v1/assets/finish-upload": [{ id: "ast_1", status: "PROCESSING" }]
    };
    const fetch = async (url) => {
      const data = answers[new URL(url).pathname];
      return data ? Response.json({ success: true, data }) : new Response(null, { status: 200 });
    };
    const late = [];
    const onError = (e) => late.push(e.code || e.message);
    process.on("uncaughtException", onError);
    try {
      await new ImageStep({ apiKey: "k", fetch }).assets.upload(path, { wait: false });
      rmSync(dir, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(late).toEqual([]);
    } finally {
      process.off("uncaughtException", onError);
    }
  });
});
