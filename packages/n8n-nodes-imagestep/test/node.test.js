import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as api from "../lib/api.ts";
import { ImageStep } from "../nodes/ImageStep/ImageStep.node.ts";
import { fakeContext, fail, ok } from "./fake-context.js";

const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const sha1 = createHash("sha1").update(png).digest("hex");

/** Routes for the whole upload flow: stage → PUT → finish → poll (PROCESSING once, then DONE). */
function uploadRoutes(seen) {
  let polls = 0;
  return {
    "POST /api/v1/assets/stage-upload": (req) => {
      seen.stage = req.body;
      return ok([{ objectId: "obj1", url: "https://storage.test/bucket/obj1?sig=1", sha1Hash: sha1 }]);
    },
    "PUT storage.test/bucket/obj1": (req) => {
      seen.put = req;
      return { status: 200, body: "" };
    },
    "POST /api/v1/assets/finish-upload": (req) => {
      seen.finish = req.body;
      return ok([{ id: "ast1", name: "cat.png", status: "PROCESSING" }]);
    },
    "POST /api/v1/assets/status": () => {
      polls++;
      return ok({ items: [{ id: "ast1", status: polls === 1 ? "PROCESSING" : "DONE" }] });
    },
    "GET /api/v1/assets/ast1": () =>
      ok({ id: "ast1", name: "cat.png", status: "DONE", image: { mimeType: "image/png", width: 1, height: 1 } })
  };
}

describe("uploadBinary — stage → presigned PUT → finish → poll", () => {
  it("hashes the buffer, PUTs it unauthenticated with the binary's mime type, then waits for DONE", async () => {
    const seen = {};
    const ctx = fakeContext({ routes: uploadRoutes(seen), binary: { data: { buffer: png, fileName: "cat.png", mimeType: "image/png" } } });

    const asset = await api.uploadBinary(ctx, 0, "data", { collection: "shop", intervalMs: 1 });

    expect(asset).toMatchObject({ id: "ast1", status: "DONE" });
    expect(seen.stage).toEqual([{ fileName: "cat.png", fileSize: png.length, sha1Hash: sha1 }]);
    expect(seen.put.via).toBe("plain");
    expect(seen.put.headers["Content-Type"]).toBe("image/png");
    expect(Buffer.isBuffer(seen.put.body) && seen.put.body.equals(png)).toBe(true);
    expect(seen.put.json).toBe(false);
    expect(seen.finish).toEqual([{ objectId: "obj1", name: "cat.png", collection: "shop" }]);
    expect(ctx.calls.map((c) => `${c.via} ${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "auth POST /api/v1/assets/stage-upload",
      "plain PUT /bucket/obj1",
      "auth POST /api/v1/assets/finish-upload",
      "auth POST /api/v1/assets/status",
      "auth POST /api/v1/assets/status",
      "auth GET /api/v1/assets/ast1"
    ]);
    // Every API write carries an Idempotency-Key and the package User-Agent; the storage PUT does not.
    for (const c of ctx.calls.filter((c) => c.via === "auth")) {
      expect(c.headers["User-Agent"]).toBe("n8n-nodes-imagestep/0.1.0");
      if (c.method === "POST") expect(c.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
      else expect(c.headers["Idempotency-Key"]).toBeUndefined();
    }
    expect(seen.put.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("reuses the existing asset when the service already holds the bytes (sha1 dedupe)", async () => {
    const seen = {};
    const routes = uploadRoutes(seen);
    routes["POST /api/v1/assets/stage-upload"] = () =>
      ok([{ objectId: "obj1", url: "https://storage.test/bucket/obj1", exists: true, existingAssetId: "ast_old" }]);
    routes["GET /api/v1/assets/ast_old"] = () => ok({ id: "ast_old", status: "DONE" });
    const ctx = fakeContext({ routes, binary: { data: { buffer: png, fileName: "cat.png", mimeType: "image/png" } } });
    const asset = await api.uploadBinary(ctx, 0, "data", { wait: false });
    expect(asset.id).toBe("ast_old");
    expect(ctx.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(ctx.calls.some((c) => c.method === "POST" && c.url.endsWith("/finish-upload"))).toBe(false);
  });

  it("still PUTs when `exists` comes without a reusable asset id (the slot is empty)", async () => {
    const seen = {};
    const routes = uploadRoutes(seen);
    routes["POST /api/v1/assets/stage-upload"] = () => ok([{ objectId: "obj1", url: "https://storage.test/bucket/obj1", exists: true }]);
    const ctx = fakeContext({ routes, binary: { data: { buffer: png, fileName: "cat.png", mimeType: "image/png" } } });
    await api.uploadBinary(ctx, 0, "data", { wait: false });
    expect(ctx.calls.some((c) => c.method === "PUT")).toBe(true);
  });

  it("surfaces a rejected file (size limit) as a non-retryable error naming the parameter", async () => {
    const routes = uploadRoutes({});
    routes["POST /api/v1/assets/stage-upload"] = () => ok([{ error: "File exceeds the 50 MB limit" }]);
    const ctx = fakeContext({ routes, binary: { data: { buffer: png, fileName: "cat.png", mimeType: "image/png" } } });
    await expect(api.uploadBinary(ctx, 0, "data")).rejects.toThrow(/invalid_param \(param: file\): File exceeds/);
  });
});

/** Routes for a job that completes on the first poll with one output. */
function jobRoutes(seen, { publish = true } = {}) {
  return {
    "POST /api/v1/jobs": (req, url) => {
      seen.job = req.body;
      seen.dryRun = url.searchParams.get("dryRun");
      if (seen.dryRun) return ok({ type: "ai-remove-bg", totalItems: 2, costPerItem: 5, estimatedCredits: 10, sufficientCredit: true });
      return ok({ id: "job1", type: "ai-remove-bg", status: "PENDING", items: [] });
    },
    "GET /api/v1/jobs/job1": (req) => {
      seen.jobWait = req.qs?.wait; // n8n carries the query apart from the URL
      return ok({
        id: "job1",
        type: "ai-remove-bg",
        status: "COMPLETED",
        creditsCharged: 10,
        items: [
          { status: "COMPLETED", sourceAssetId: "ast1", resultAssetId: "out1" },
          { status: "COMPLETED", sourceAssetId: "ast2", resultAssetId: "out2" }
        ]
      });
    },
    // The run's products, newest first — the listing's order, not the items' (#441 / #522).
    "GET /api/v1/assets": (req) => {
      seen.outputsQuery = req.qs;
      return ok(
        [
          { id: "out2", name: "b.png", status: "DONE", image: { mimeType: "image/png", width: 5, height: 6 } },
          { id: "out1", name: "a.png", status: "DONE", image: { mimeType: "image/png", width: 3, height: 4 } }
        ],
        { page: 0, perPage: 100, total: 2, hasMore: false }
      );
    },
    "POST /api/v1/assets/update": (req) => {
      seen.publish = req.body;
      if (!publish) return ok([]);
      return ok(
        req.body.ids.map((id) => ({
          id,
          name: `${id}.png`,
          status: "DONE",
          published: true,
          publicUrl: `https://cdn.test/${id}`,
          image: { mimeType: "image/png", width: 3, height: 4 }
        }))
      );
    },
    "GET cdn.test/out1": () => ({ status: 200, headers: { "content-type": "image/png" }, body: png }),
    "GET cdn.test/out2": () => ({ status: 200, headers: { "content-type": "image/png" }, body: png })
  };
}

describe("ImageStep node — Operation → Run", () => {
  it("submits the op over asset ids, waits, publishes, and returns one jobRef with public URLs", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: jobRoutes(seen),
      params: {
        resource: "op",
        operation: "run",
        op: "remove_bg",
        inputMode: "assetIds",
        assetIds: "ast1, ast2",
        parameters: "{}",
        storeResult: true,
        wait: true,
        publish: true
      }
    });
    const [out] = await new ImageStep().execute.call(ctx);
    // Wait is on, so the wait starts on the submit itself (#355): the service holds it for up to its 60 s ceiling.
    expect(seen.job).toEqual({ op: "remove_bg", assetIds: ["ast1", "ast2"], wait: 60 });
    // …and what is left of Wait Seconds (180 by default) goes to a long-poll read, never a fixed-interval poll.
    expect(seen.jobWait).toBe(60);
    expect(seen.publish).toEqual({ ids: ["out1", "out2"], published: true });
    expect(out).toHaveLength(1);
    expect(out[0].pairedItem).toEqual({ item: 0 });
    expect(out[0].json).toMatchObject({ jobId: "job1", status: "COMPLETED", completedItems: 2, failedItems: 0, creditsCharged: 10 });
    expect(out[0].json.outputs.map((o) => o.publicUrl)).toEqual(["https://cdn.test/out1", "https://cdn.test/out2"]);
    expect(out[0].json.outputs[0]).toMatchObject({ assetId: "out1", width: 3, height: 4, mimeType: "image/png" });
  });

  /**
   * #564 — an AI op has to run as a job, and with Store Result off the switches that would publish are hidden: n8n answers
   * a hidden field with the node's fallback, and Publish's was on. Every output went to a public URL while the field said
   * nothing is published. A stale `publish: true` (a template written with Store Result on) must not reach it either.
   */
  it("with Store Result off, a job is waited for and nothing is published — the outputs come back as asset ids", async () => {
    for (const params of [{}, { publish: true, downloadOutput: true }]) {
      const seen = {};
      const ctx = fakeContext({
        routes: jobRoutes(seen),
        params: { resource: "op", operation: "run", op: "remove_bg", inputMode: "assetIds", assetIds: "ast1, ast2", ...params }
      });
      const [out] = await new ImageStep().execute.call(ctx);
      expect(seen.publish).toBeUndefined();
      expect(ctx.calls.some((c) => c.url.includes("/assets/update") || c.url.startsWith("https://cdn.test/"))).toBe(false);
      expect(out).toHaveLength(1);
      expect(out[0].json.outputs.map((o) => [o.assetId, o.publicUrl])).toEqual([
        ["out1", undefined],
        ["out2", undefined]
      ]);
    }
  });

  it("uploads the binary first when the input is a file, and passes prompt / count / model / parameters / collection", async () => {
    const seen = {};
    const routes = { ...uploadRoutes(seen), ...jobRoutes(seen) };
    const ctx = fakeContext({
      routes,
      binary: { data: { buffer: png, fileName: "cat.png", mimeType: "image/png" } },
      params: {
        resource: "op",
        operation: "run",
        op: "edit",
        inputMode: "binary",
        binaryProperty: "data",
        prompt: "make it blue",
        parameters: '{"strength": 0.5}',
        options: { model: "google/x", collection: "shop" },
        wait: false
      }
    });
    // uploadBinary polls with the default interval; make the asset ready on the first poll.
    routes["POST /api/v1/assets/status"] = () => ok({ items: [{ id: "ast1", status: "DONE" }] });
    routes["GET /api/v1/assets/ast1"] = () => ok({ id: "ast1", status: "DONE" });
    const [out] = await new ImageStep().execute.call(ctx);
    expect(seen.finish[0].collection).toBe("shop");
    expect(seen.job).toEqual({
      op: "edit",
      assetIds: ["ast1"],
      prompt: "make it blue",
      model: "google/x",
      parameters: { strength: 0.5 },
      collection: "shop"
    });
    expect(out[0].json).toMatchObject({ jobId: "job1", status: "PENDING" });
    expect(out[0].json.outputs).toBeUndefined();
  });

  it("generate needs no input and sends count", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: jobRoutes(seen),
      params: { resource: "op", operation: "run", op: "generate", inputMode: "none", prompt: "a red bicycle", count: 2, wait: false }
    });
    await new ImageStep().execute.call(ctx);
    expect(seen.job).toEqual({ op: "generate", prompt: "a red bicycle", count: 2 });
  });

  it("dry run returns the estimate and creates nothing", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: jobRoutes(seen),
      params: { resource: "op", operation: "run", op: "remove_bg", inputMode: "assetIds", assetIds: "ast1,ast2", dryRun: true }
    });
    const [out] = await new ImageStep().execute.call(ctx);
    expect(seen.dryRun).toBe("true");
    expect(out[0].json).toEqual({
      dryRun: true,
      request: { op: "remove_bg", assetIds: ["ast1", "ast2"] },
      estimate: { type: "ai-remove-bg", totalItems: 2, costPerItem: 5, estimatedCredits: 10, sufficientCredit: true }
    });
    expect(ctx.calls).toHaveLength(1);
  });

  // #572 → #586: pricing a binary used to mean uploading it — a dry run that left an asset behind. It is priced by count.
  it("dry run over a Binary File prices one image and uploads nothing — on an op and on a preset", async () => {
    for (const [params, request] of [
      [
        { resource: "op", operation: "run", op: "remove_bg" },
        { op: "remove_bg", imageCount: 1 }
      ],
      [
        { resource: "preset", operation: "run", preset: "builtin-util-to-webp" },
        { presetId: "builtin-util-to-webp", assetIds: [], imageCount: 1 }
      ]
    ]) {
      const seen = {};
      const ctx = fakeContext({
        routes: { ...uploadRoutes({}), ...jobRoutes(seen) },
        binary: { data: { buffer: png, fileName: "cat.png", mimeType: "image/png" } },
        params: { ...params, inputMode: "binary", binaryProperty: "data", dryRun: true }
      });
      const [out] = await new ImageStep().execute.call(ctx);
      expect(seen.dryRun).toBe("true");
      expect(out[0].json.request).toEqual(request);
      expect(ctx.calls).toHaveLength(1); // the dry run, and no upload before it

      // The binary still has to be there, as it would for the run.
      const missing = fakeContext({ routes: jobRoutes({}), binary: {}, params: { ...params, inputMode: "binary", dryRun: true } });
      await expect(new ImageStep().execute.call(missing)).rejects.toThrow(/no binary data/);
      expect(missing.calls).toEqual([]);
    }
  });

  it("downloads each output into the `data` binary, one item per output", async () => {
    const ctx = fakeContext({
      routes: jobRoutes({}),
      params: {
        resource: "op",
        operation: "run",
        op: "remove_bg",
        inputMode: "assetIds",
        assetIds: "ast1,ast2",
        storeResult: true,
        wait: true,
        publish: true,
        downloadOutput: true
      }
    });
    const [out] = await new ImageStep().execute.call(ctx);
    expect(out).toHaveLength(2);
    expect(out[1].json.output.assetId).toBe("out2");
    expect(out[1].binary.data).toMatchObject({ fileName: "out2.png", mimeType: "image/png", data: png.toString("base64") });
    const cdn = ctx.calls.filter((c) => c.url.startsWith("https://cdn.test/"));
    expect(cdn.map((c) => c.via)).toEqual(["plain", "plain"]);
    expect(cdn[0].encoding).toBe("arraybuffer");
  });

  it("maps an API error to a NodeApiError carrying code, param and retryable — and to a row under continueOnFail", async () => {
    const routes = {
      "POST /api/v1/jobs": () =>
        fail(400, { code: "invalid_param", message: "format must be one of: webp, png", retryable: false, param: "format" })
    };
    const params = {
      resource: "op",
      operation: "run",
      op: "convert",
      inputMode: "assetIds",
      assetIds: "ast1",
      parameters: '{"format":"bmp"}'
    };
    const ctx = fakeContext({ routes, params });
    const err = await new ImageStep().execute.call(ctx).catch((e) => e);
    expect(err.constructor.name).toBe("NodeApiError");
    expect(err.message).toMatch(/invalid_param \(param: format\): format must be one of/);
    expect(err.description).toMatch(/retryable=false/);
    expect(err).toMatchObject({ code: "invalid_param", param: "format", retryable: false, httpCode: "400" });

    const tolerant = fakeContext({ routes, params });
    tolerant.continueOnFail = () => true;
    const [out] = await new ImageStep().execute.call(tolerant);
    expect(out[0].json).toMatchObject({ code: "invalid_param", param: "format", retryable: false });
    expect(out[0].json.error).toMatch(/format must be one of/);
  });

  /**
   * #570 — running out of Wait Seconds is not a failed job: it keeps running. The error says so in the fields a workflow
   * branches on, and under Continue On Fail the item is the job handle — it used to be `internal_error`, `retryable: false`.
   */
  it("Wait Seconds running out: a retryable error carrying the job, and under Continue On Fail the handle with timedOut", async () => {
    const running = () => ({
      "POST /api/v1/jobs": () => ok({ id: "job1", type: "ai-upscale", status: "PENDING", items: [] }),
      "GET /api/v1/jobs/job1": () => ok({ id: "job1", type: "ai-upscale", status: "PROCESSING", totalItems: 1, items: [] })
    });
    for (const params of [
      { resource: "op", operation: "run", op: "upscale", inputMode: "assetIds", assetIds: "ast1", storeResult: true, waitSeconds: 0.05 },
      { resource: "job", operation: "wait", jobId: "job1", waitSeconds: 0.05 }
    ]) {
      const err = await new ImageStep().execute.call(fakeContext({ routes: running(), params })).catch((e) => e);
      expect(err).toMatchObject({ retryable: true, timedOut: true, job: { id: "job1", status: "PROCESSING" } });
      expect(err.message).toMatch(/still PROCESSING .* keeps running; continue with Job → Wait/);

      const tolerant = fakeContext({ routes: running(), params });
      tolerant.continueOnFail = () => true;
      const [out] = await new ImageStep().execute.call(tolerant);
      expect(out[0].json).toMatchObject({ jobId: "job1", status: "PROCESSING", timedOut: true, code: null, retryable: true });
      expect(out[0].json.error).toMatch(/keeps running/);
    }
  });

  // Contract §11: the id an operator quotes when reporting a failure — from the envelope, else X-Request-Id (#277).
  it("carries the request id from the error envelope, or from X-Request-Id when the body is not one", async () => {
    const params = {
      resource: "op",
      operation: "run",
      op: "convert",
      inputMode: "assetIds",
      assetIds: "ast1",
      parameters: '{"format":"webp"}'
    };
    const enveloped = fakeContext({
      routes: {
        "POST /api/v1/jobs": () => fail(503, { code: "provider_unavailable", message: "busy", retryable: true, requestId: "req-body" })
      },
      params
    });
    const fromBody = await new ImageStep().execute.call(enveloped).catch((e) => e);
    expect(fromBody).toMatchObject({ code: "provider_unavailable", retryable: true, requestId: "req-body" });
    expect(fromBody.description).toMatch(/requestId=req-body/);

    const bare = fakeContext({
      routes: { "POST /api/v1/jobs": () => ({ status: 502, headers: { "X-Request-Id": "req-header" }, body: "<html>bad gateway</html>" }) },
      params
    });
    const fromHeader = await new ImageStep().execute.call(bare).catch((e) => e);
    expect(fromHeader).toMatchObject({ code: "internal_error", retryable: true, requestId: "req-header" });
  });
});

describe("ImageStep node — Preset, Job, Asset", () => {
  it("runs a preset as a job, and a stale Mode parameter never reaches the request (#331)", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: jobRoutes(seen),
      params: {
        resource: "preset",
        operation: "run",
        preset: "builtin-util-to-webp",
        inputMode: "assetIds",
        assetIds: "ast1",
        mode: "REPLACE_MEDIA",
        wait: false
      }
    });
    await new ImageStep().execute.call(ctx);
    expect(seen.job).toEqual({ presetId: "builtin-util-to-webp", assetIds: ["ast1"] });
  });

  // #564: a preset always runs as a job, and Store Result is what decides whether its outputs are published.
  it("publishes a preset's outputs only with Store Result on", async () => {
    const params = { resource: "preset", operation: "run", preset: "builtin-util-to-webp", inputMode: "assetIds", assetIds: "ast1,ast2" };
    const off = {};
    await new ImageStep().execute.call(fakeContext({ routes: jobRoutes(off), params: { ...params, publish: true } }));
    expect(off.publish).toBeUndefined();
    const on = {};
    const [out] = await new ImageStep().execute.call(
      fakeContext({ routes: jobRoutes(on), params: { ...params, storeResult: true, publish: true } })
    );
    expect(on.publish).toEqual({ ids: ["out1", "out2"], published: true });
    expect(out[0].json.outputs.map((o) => o.publicUrl)).toEqual(["https://cdn.test/out1", "https://cdn.test/out2"]);
  });

  /**
   * imagestep#460 — the carousel shape: Input = None, the row's scene as the prompt, four images. Nothing is uploaded
   * (no binary is read), and the prompt reaches the service as written — {{subject.hero}} is the service's to expand.
   */
  it("runs a preset from a prompt: no upload, the prompt and count on the request", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: jobRoutes(seen),
      params: {
        resource: "preset",
        operation: "run",
        preset: "carousel-brand",
        inputMode: "none",
        prompt: "{{subject.hero}} on a wooden pier at sunrise",
        count: 4,
        wait: false
      }
    });
    await new ImageStep().execute.call(ctx);
    expect(seen.job).toEqual({
      presetId: "carousel-brand",
      assetIds: [],
      prompt: "{{subject.hero}} on a wooden pier at sunrise",
      count: 4
    });
  });

  it("still refuses a preset run with no input when Input is Asset IDs and the field is empty", async () => {
    const ctx = fakeContext({
      routes: jobRoutes({}),
      params: { resource: "preset", operation: "run", preset: "web-optimize", inputMode: "assetIds", assetIds: "", wait: false }
    });
    await expect(new ImageStep().execute.call(ctx)).rejects.toThrow(/at least one input asset/);
  });

  /** imagestep#249 — the Version field is the whole point of a versioned preset: it pins what runs. */
  it("submits slug@version when a Version is set, and the bare ref when it is 0", async () => {
    const pinned = {};
    await new ImageStep().execute.call(
      fakeContext({
        routes: jobRoutes(pinned),
        params: {
          resource: "preset",
          operation: "run",
          preset: "web-optimize",
          presetVersion: 3,
          inputMode: "assetIds",
          assetIds: "ast1",
          wait: false
        }
      })
    );
    expect(pinned.job.presetId).toBe("web-optimize@3");

    const current = {};
    await new ImageStep().execute.call(
      fakeContext({
        routes: jobRoutes(current),
        params: {
          resource: "preset",
          operation: "run",
          preset: "web-optimize",
          presetVersion: 0,
          inputMode: "assetIds",
          assetIds: "ast1",
          wait: false
        }
      })
    );
    expect(current.job.presetId).toBe("web-optimize");
  });

  /**
   * imagestep#249 — an op carries a model, never a preset. The option used to let a preset in through the back
   * door, where the op's own Prompt and Model silently became overrides of steps the field never showed.
   */
  it("never sends a presetId on an op, whatever is in Options", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: jobRoutes(seen),
      params: {
        resource: "op",
        operation: "run",
        op: "generate",
        inputMode: "none",
        prompt: "a red bicycle",
        count: 1,
        options: { model: "google/gemini-3.1-flash-image-preview", presetId: "builtin-consistent-character" },
        wait: false
      }
    });
    await new ImageStep().execute.call(ctx);
    expect(seen.job).not.toHaveProperty("presetId");
    expect(seen.job.model).toBe("google/gemini-3.1-flash-image-preview");
  });

  it("Job → Get returns the jobRef with published outputs", async () => {
    const seen = {};
    const ctx = fakeContext({ routes: jobRoutes(seen), params: { resource: "job", operation: "get", jobId: "job1", publish: true } });
    const [out] = await new ImageStep().execute.call(ctx);
    expect(out[0].json.outputs).toHaveLength(2);
    expect(seen.publish.ids).toEqual(["out1", "out2"]);
  });

  it("Asset → Publish and Asset → List map to references and Asset → Get reads one", async () => {
    const routes = {
      ...jobRoutes({}),
      "GET /api/v1/assets": (req) => {
        expect(req.qs).toEqual({ collection: "shop", page: 0, perPage: 100 });
        return ok([{ id: "ast1", name: "a.png", image: { width: 1, height: 2 } }], { page: 0, total: 1, hasMore: false });
      },
      "GET /api/v1/assets/ast1": () => ok({ id: "ast1", name: "a.png", image: { width: 1, height: 2 } })
    };
    const publish = fakeContext({ routes, params: { resource: "asset", operation: "publish", assetIds: "out1" } });
    expect((await new ImageStep().execute.call(publish))[0][0].json.publicUrl).toBe("https://cdn.test/out1");

    const list = fakeContext({ routes, params: { resource: "asset", operation: "list", collection: "shop" } });
    const [rows] = await new ImageStep().execute.call(list);
    expect(rows[0].json).toMatchObject({ assetId: "ast1", width: 1, total: 1, hasMore: false, nextCursor: null });

    const get = fakeContext({ routes, params: { resource: "asset", operation: "get", assetId: "ast1" } });
    expect((await new ImageStep().execute.call(get))[0][0].json).toMatchObject({ assetId: "ast1", height: 2 });
  });

  it("Asset → List with a Cursor reads the page after it and sends no page number (#493)", async () => {
    const routes = {
      "GET /api/v1/assets": (req) => {
        expect(req.qs).toEqual({ cursor: "c2", perPage: 100 });
        return ok([{ id: "ast3", name: "c.png" }], { perPage: 100, hasMore: true, nextCursor: "c3" });
      }
    };
    const ctx = fakeContext({ routes, params: { resource: "asset", operation: "list", cursor: "c2", page: 4 } });
    const [rows] = await new ImageStep().execute.call(ctx);
    expect(rows[0].json).toMatchObject({ assetId: "ast3", hasMore: true, nextCursor: "c3" });
  });

  it("Asset → List Collections is one item per collection, with its count (#349)", async () => {
    const routes = {
      "GET /api/v1/assets/collections": (req) => {
        expect(req.qs).toEqual({ q: "sho", page: 0, perPage: 100 });
        return ok([{ collection: "shop", count: 4, lastCreatedAt: Date.UTC(2026, 8, 17) }], { page: 0, total: 1, hasMore: false });
      }
    };
    const ctx = fakeContext({ routes, params: { resource: "asset", operation: "listCollections", q: "sho" } });
    const [rows] = await new ImageStep().execute.call(ctx);
    expect(rows.map((r) => r.json)).toEqual([
      { collection: "shop", count: 4, lastAddedAt: "2026-09-17T00:00:00.000Z", page: 0, total: 1, hasMore: false, nextCursor: null }
    ]);
  });

  it("loadOptions: ops come from the live catalogue and fall back to the static list; presets list built-ins then yours", async () => {
    const live = fakeContext({
      routes: {
        "GET /api/v1/ops": () =>
          ok([
            { op: "remove_bg", kind: "ai", description: "d" },
            { op: "read_metadata", kind: "sync" }
          ])
      }
    });
    const node = new ImageStep();
    expect(await node.methods.loadOptions.getOps.call(live)).toEqual([{ name: "remove_bg", value: "remove_bg", description: "d" }]);
    const down = fakeContext({ routes: { "GET /api/v1/ops": () => fail(401, { code: "unauthorized", message: "no", retryable: false }) } });
    expect((await node.methods.loadOptions.getOps.call(down)).map((o) => o.value)).toContain("grayscale");

    const presets = fakeContext({
      routes: {
        "GET /api/v1/presets": (req) =>
          req.qs.filter === "builtin"
            ? ok([{ id: "builtin-util-to-webp", slug: "util-to-webp", builtIn: true, description: "to webp" }])
            : ok([{ id: "p_1", slug: "shop-hero", name: "Shop hero" }])
      }
    });
    expect(await node.methods.loadOptions.getPresets.call(presets)).toEqual([
      { name: "util-to-webp", value: "builtin-util-to-webp", description: "built-in · to webp" },
      { name: "shop-hero", value: "p_1", description: "yours" }
    ]);
  });
});

describe("uploadFromUrls — the service fetches (#219)", () => {
  it("posts the URLs once, waits for each created asset, and keeps a failed URL as its own result", async () => {
    const seen = {};
    let polls = 0;
    const ctx = fakeContext({
      routes: {
        "POST /api/v1/assets/from-url": (req) => {
          seen.body = req.body;
          return ok([
            { url: "https://cdn.example/a.png", id: "ast9", status: "PROCESSING" },
            { url: "https://example.com/", error: { code: "unsupported_format", message: "text/html is not an image", retryable: false } }
          ]);
        },
        "POST /api/v1/assets/status": () => {
          polls++;
          return ok({ items: [{ id: "ast9", status: polls === 1 ? "PROCESSING" : "DONE" }] });
        },
        "GET /api/v1/assets/ast9": () => ok({ id: "ast9", name: "a", status: "DONE", image: { mimeType: "image/png" } })
      }
    });

    const out = await api.uploadFromUrls(ctx, ["https://cdn.example/a.png", "https://example.com/"], { collection: "shop", intervalMs: 1 });

    expect(seen.body).toEqual({ urls: ["https://cdn.example/a.png", "https://example.com/"], collection: "shop" });
    expect(out[0].asset.status).toBe("DONE");
    expect(out[1]).toEqual({
      url: "https://example.com/",
      error: { code: "unsupported_format", message: "text/html is not an image", retryable: false }
    });
    // Nothing went to storage from n8n: every call carried the credential, none was a plain download or PUT.
    expect(ctx.calls.every((c) => c.via === "auth")).toBe(true);
  });
});

// #521: n8n's Retry On Fail runs the whole node again over every input item. The key of a write is derived from the
// execution, the node, the item and the body, so the items an earlier try already submitted are replayed, not re-bought.
describe("retries and idempotency keys (#521)", () => {
  const params = { resource: "op", operation: "run", op: "upscale", inputMode: "assetIds", assetIds: "ast1", wait: false };
  const queued = (id) => ok({ id, status: "PENDING", items: [] });

  it("derives the key from execution + node + item + body: the same item re-run sends the same key, other items do not", async () => {
    const keys = [];
    const routes = {
      "POST /api/v1/jobs": (req) => {
        keys.push({ key: req.headers["Idempotency-Key"], body: req.body });
        return queued(`job${keys.length}`);
      }
    };
    const items = [{ json: {} }, { json: {} }];
    // Both items name the same asset — only the item index tells their writes apart.
    await new ImageStep().execute.call(fakeContext({ routes, params, items }));
    await new ImageStep().execute.call(fakeContext({ routes, params, items })); // n8n's retry: same execution
    await new ImageStep().execute.call(fakeContext({ routes, params, items, executionId: "exec-2" }));
    expect(keys).toHaveLength(6);
    for (const { key } of keys) expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const [a0, a1, b0, b1, c0, c1] = keys.map((k) => k.key);
    expect(b0).toBe(a0);
    expect(b1).toBe(a1);
    expect(a1).not.toBe(a0);
    expect(c0).not.toBe(a0);
    expect(c1).not.toBe(a1);

    // A different body is a different key: the service answers a reused key with a different body 409.
    const ctx = fakeContext();
    const one = api.idempotencyKey(ctx, "POST", "/api/v1/jobs", { op: "upscale", assetIds: ["ast1"] }, 0);
    expect(api.idempotencyKey(ctx, "POST", "/api/v1/jobs", { op: "upscale", assetIds: ["ast1"] }, 0)).toBe(one);
    expect(api.idempotencyKey(ctx, "POST", "/api/v1/jobs", { op: "upscale", assetIds: ["ast2"] }, 0)).not.toBe(one);
    // Outside an item (a trigger's lifecycle hooks) there is nothing to derive it from.
    expect(api.idempotencyKey(ctx, "POST", "/api/v1/webhook-endpoints", {}, undefined)).not.toBe(
      api.idempotencyKey(ctx, "POST", "/api/v1/webhook-endpoints", {}, undefined)
    );
  });

  it("a node re-run after item 2 failed replays item 1's job: its submit carries the key the first try used", async () => {
    const byKey = new Map();
    let failing = true;
    const routes = {
      "POST /api/v1/jobs": (req) => {
        const key = req.headers["Idempotency-Key"];
        if (req.body.assetIds[0] === "ast2" && failing)
          return fail(400, { code: "insufficient_credit", message: "top up", retryable: false });
        if (!byKey.has(key)) byKey.set(key, `job${byKey.size + 1}`);
        return queued(byKey.get(key));
      }
    };
    const perItem = { ...params, assetIds: undefined };
    const items = [{ json: {} }, { json: {} }];
    const ctx = () => {
      const c = fakeContext({ routes, params: perItem, items });
      c.getNodeParameter = (name, i, fallback) => (name === "assetIds" ? `ast${i + 1}` : name in perItem ? perItem[name] : fallback);
      return c;
    };
    await expect(new ImageStep().execute.call(ctx())).rejects.toMatchObject({ code: "insufficient_credit" });
    failing = false;
    const [out] = await new ImageStep().execute.call(ctx());
    // Two jobs in all, not three: item 1's second submit landed on the job its first created.
    expect(byKey.size).toBe(2);
    expect(out.map((o) => o.json.jobId)).toEqual(["job1", "job2"]);
  });

  it("retries a retryable answer with the same key, honouring Retry-After, and succeeds", async () => {
    const seen = [];
    const routes = {
      "POST /api/v1/jobs": (req) => {
        seen.push(req.headers["Idempotency-Key"]);
        if (seen.length === 1)
          return { status: 429, headers: { "Retry-After": "1" }, ...fail(429, { code: "rate_limited", message: "slow", retryable: true }) };
        if (seen.length === 2) return fail(503, { code: "provider_unavailable", message: "busy", retryable: true });
        return queued("job1");
      }
    };
    const [out] = await new ImageStep().execute.call(fakeContext({ routes, params }));
    expect(out[0].json.jobId).toBe("job1");
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
  });

  it("gives up after two retries, and never retries a non-retryable answer", async () => {
    let calls = 0;
    const busy = { "POST /api/v1/jobs": () => (calls++, fail(503, { code: "provider_unavailable", message: "busy", retryable: true })) };
    await expect(new ImageStep().execute.call(fakeContext({ routes: busy, params }))).rejects.toMatchObject({
      code: "provider_unavailable"
    });
    expect(calls).toBe(3);

    calls = 0;
    const bad = { "POST /api/v1/jobs": () => (calls++, fail(400, { code: "invalid_param", message: "no", retryable: false })) };
    await expect(new ImageStep().execute.call(fakeContext({ routes: bad, params }))).rejects.toMatchObject({ code: "invalid_param" });
    expect(calls).toBe(1);
  });

  // #589 / #592: a refusal for credit is sent once, on the job lane or the synchronous one, and its execution log carries the
  // link that clears it — the person reading a failed run is the one who can top up.
  it("sends a refusal for credit once and shows where to top up", async () => {
    let calls = 0;
    const topUpUrl = "https://imagestep.dev/usage/credits";
    const out = {
      "POST /api/v1/jobs": () => (
        calls++,
        fail(402, { code: "insufficient_credit", message: "Not enough credit", retryable: false, details: { topUpUrl } })
      )
    };
    const refused = await new ImageStep().execute.call(fakeContext({ routes: out, params })).catch((e) => e);
    expect(refused).toMatchObject({ code: "insufficient_credit" });
    expect(refused.description).toContain(topUpUrl);
    expect(calls).toBe(1);

    calls = 0;
    const sync = fakeContext({
      routes: {
        "GET /api/v1/ops": () => ok([{ op: "resize", syncEndpoint: "/api/v1/images/transform" }]),
        "POST /api/v1/images/transform": () => (
          calls++,
          {
            status: 402,
            headers: { "content-type": "application/json" },
            body: Buffer.from(
              JSON.stringify({ success: false, error: { code: "insufficient_credit", message: "Not enough credit", retryable: false } })
            )
          }
        )
      },
      params: { resource: "op", operation: "run", op: "resize", inputMode: "binary", binaryProperty: "data", parameters: '{"width":10}' },
      binary: { data: { buffer: png, mimeType: "image/png", fileName: "cat.png" } }
    });
    await expect(new ImageStep().execute.call(sync)).rejects.toMatchObject({ code: "insufficient_credit" });
    expect(calls).toBe(1);
  });

  it("retries a request that got no HTTP answer at all", async () => {
    let calls = 0;
    const routes = {
      "POST /api/v1/jobs": () => {
        calls++;
        if (calls === 1) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        return queued("job1");
      }
    };
    const [out] = await new ImageStep().execute.call(fakeContext({ routes, params }));
    expect(out[0].json.jobId).toBe("job1");
    expect(calls).toBe(2);
  });
});

// #522: the job document inlines only its first 100 items (#440); the outputs come from the listing, all of them.
describe("job outputs beyond the inlined items (#522)", () => {
  it("returns all 250 outputs of a truncated job, three listing pages, published a page of ids at a time, in item order", async () => {
    const total = 250;
    const outputs = Array.from({ length: total }, (_, n) => ({ id: `out${n}`, name: `o${n}.png`, status: "DONE" }));
    const listed = outputs.slice().reverse(); // newest first
    const seen = { pages: [], publishes: [], gets: 0 };
    const routes = {
      "GET /api/v1/jobs/job9": () =>
        ok({
          id: "job9",
          type: "ai-upscale",
          status: "COMPLETED",
          totalItems: total,
          completedItems: total,
          itemsTruncated: true,
          items: outputs.slice(0, 100).map((o, n) => ({ status: "COMPLETED", sourceAssetId: `in${n}`, resultAssetId: o.id }))
        }),
      "GET /api/v1/assets": (req) => {
        seen.pages.push(req.qs);
        const page = req.qs.cursor ? Number(req.qs.cursor.slice(1)) : Number(req.qs.page);
        const perPage = Number(req.qs.perPage);
        const hasMore = (page + 1) * perPage < total;
        return ok(listed.slice(page * perPage, (page + 1) * perPage), {
          perPage,
          hasMore,
          nextCursor: hasMore ? `c${page + 1}` : null
        });
      },
      "GET /api/v1/assets/:id": () => (seen.gets++, ok({})),
      "POST /api/v1/assets/update": (req) => {
        seen.publishes.push(req.body.ids.length);
        return ok(req.body.ids.map((id) => ({ id, name: `${id}.png`, status: "DONE", publicUrl: `https://cdn.test/${id}` })));
      }
    };
    const ctx = fakeContext({ routes, params: { resource: "job", operation: "get", jobId: "job9", publish: true } });
    const [out] = await new ImageStep().execute.call(ctx);
    const ref = out[0].json;
    expect(ref.outputs).toHaveLength(total);
    expect(ref.itemsTruncated).toBe(true);
    // #493: the first page, then the cursor each answer carried — never a page number the service would re-count.
    expect(seen.pages.map((q) => [q.jobId, q.perPage, q.page, q.cursor])).toEqual([
      ["job9", 100, 0, undefined],
      ["job9", 100, undefined, "c1"],
      ["job9", 100, undefined, "c2"]
    ]);
    expect(seen.gets).toBe(0);
    expect(seen.publishes).toEqual([100, 100, 50]);
    // Every output is published, the inlined items' outputs first and in item order.
    expect(ref.outputs.every((o) => o.publicUrl)).toBe(true);
    expect(ref.outputs.slice(0, 100).map((o) => o.assetId)).toEqual(outputs.slice(0, 100).map((o) => o.id));
    expect(new Set(ref.outputs.map((o) => o.assetId)).size).toBe(total);
  });

  it("reads nothing for a job that completed no item", async () => {
    const calls = [];
    const routes = {
      "GET /api/v1/jobs/job0": () => ok({ id: "job0", type: "ai-upscale", status: "FAILED", completedItems: 0, items: [] }),
      "GET /api/v1/assets": () => (calls.push("list"), ok([], { hasMore: false }))
    };
    const [out] = await new ImageStep().execute.call(fakeContext({ routes, params: { resource: "job", operation: "get", jobId: "job0" } }));
    expect(out[0].json.outputs).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// #525: the service takes twenty URLs a request; the field takes any number, and they are waited for together.
describe("uploadFromUrls in bulk (#525)", () => {
  it("sends 25 URLs as 20 + 5 and waits for them with one status call per tick", async () => {
    const seen = { posts: [], status: 0, gets: 0 };
    const routes = {
      "POST /api/v1/assets/from-url": (req) => {
        seen.posts.push(req.body.urls.length);
        return ok(req.body.urls.map((url) => ({ url, id: `ast_${url.split("/").pop()}`, status: "PROCESSING" })));
      },
      "POST /api/v1/assets/status": (req) => {
        seen.status++;
        return ok({ items: req.body.ids.map((id) => ({ id, status: seen.status >= 2 ? "DONE" : "PROCESSING" })) });
      }
    };
    const urls = Array.from({ length: 25 }, (_, n) => `https://cdn.example/${n}.png`);
    const ctx = fakeContext({ routes });
    const base = ctx.helpers.httpRequestWithAuthentication;
    ctx.helpers.httpRequestWithAuthentication = async function (credential, request) {
      if (request.method === "GET" && /\/api\/v1\/assets\/ast_/.test(request.url)) {
        seen.gets++;
        return { statusCode: 200, headers: {}, body: { success: true, data: { id: request.url.split("/").pop(), status: "DONE" } } };
      }
      return base.call(this, credential, request);
    };
    const out = await api.uploadFromUrls(ctx, urls, { intervalMs: 1 });
    expect(seen.posts).toEqual([20, 5]);
    expect(seen.status).toBe(2);
    expect(seen.gets).toBe(25);
    expect(out.map((r) => r.url)).toEqual(urls);
    expect(out.every((r) => r.asset.status === "DONE")).toBe(true);
  });
});
