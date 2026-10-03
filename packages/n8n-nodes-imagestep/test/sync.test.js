import { describe, expect, it } from "vitest";

import { ITEM_CONCURRENCY, ImageStep } from "../src/nodes/ImageStep/ImageStep.node.js";
import { fakeContext } from "./fake-context.js";

/**
 * Store Result = off (#82): binary in, binary out, nothing stored.
 *
 * The old job path had to **publish the customer's image to a public URL** just so the workflow
 * could read its own output. For an invoice, an ID photo or anything internal that is not a
 * inconvenience, it is disqualifying. These cases pin that the off path neither stores nor
 * publishes — and that "which ops may take it" is the API's answer, not a list in the node.
 */
describe("op:run with Store Result off", () => {
  const opsRoute = (syncEndpoint) => () => ({
    status: 200,
    body: {
      success: true,
      data: [
        { op: "resize", kind: "deterministic", syncEndpoint },
        { op: "upscale", kind: "ai", syncEndpoint: null }
      ]
    }
  });

  const binary = { data: { fileName: "invoice.png", mimeType: "image/png", buffer: Buffer.from("IN") } };

  function ctxFor(params, routes) {
    return fakeContext({
      params: { resource: "op", operation: "run", storeResult: false, ...params },
      binary,
      routes
    });
  }

  it("transforms and hands the bytes back without creating or publishing anything", async () => {
    const ctx = ctxFor(
      { op: "resize", parameters: '{"width":40}' },
      {
        "GET /api/v1/ops": opsRoute("POST /api/v1/images/transform"),
        "POST /api/v1/images/transform": () => ({
          status: 200,
          headers: { "content-type": "image/webp" },
          body: Buffer.from("OUT")
        })
      }
    );

    const [items] = await ImageStep.prototype.execute.call(ctx);

    expect(items[0].json.mode).toBe("sync");
    expect(items[0].json.stored).toBe(false);
    expect(items[0].binary.data.data).toBeTruthy();
    // The whole point: no upload, no job, no publish, no CDN fetch.
    const paths = ctx.calls.map((c) => new URL(c.url).pathname);
    expect(paths).not.toContain("/api/v1/assets/stage-upload");
    expect(paths).not.toContain("/api/v1/jobs");
    expect(paths).not.toContain("/api/v1/assets/update");
    // One ImageStep API call for the work itself (plus the catalogue lookup).
    expect(paths.filter((p) => p === "/api/v1/images/transform")).toHaveLength(1);
  });

  it("renames the extension to the produced format so a Write File node is right", async () => {
    const ctx = ctxFor(
      { op: "resize", parameters: "{}" },
      {
        "GET /api/v1/ops": opsRoute("POST /api/v1/images/transform"),
        "POST /api/v1/images/transform": () => ({
          status: 200,
          headers: { "content-type": "image/webp" },
          body: Buffer.from("OUT")
        })
      }
    );

    const [items] = await ImageStep.prototype.execute.call(ctx);
    expect(items[0].binary.data.fileName).toBe("invoice.webp");
  });

  it("sends no Idempotency-Key — contract §9's documented exception", async () => {
    const ctx = ctxFor(
      { op: "resize", parameters: "{}" },
      {
        "GET /api/v1/ops": opsRoute("POST /api/v1/images/transform"),
        "POST /api/v1/images/transform": () => ({
          status: 200,
          headers: { "content-type": "image/webp" },
          body: Buffer.from("OUT")
        })
      }
    );

    await ImageStep.prototype.execute.call(ctx);
    const call = ctx.calls.find((c) => c.url.includes("/images/transform"));
    const names = Object.keys(call.headers).map((h) => h.toLowerCase());
    expect(names).not.toContain("idempotency-key");
  });

  it("reads the Binary Property the user typed, not always `data`", async () => {
    // `binaryProperty` is a top-level parameter, not a member of the Options collection; the sync
    // path used to read `options.binaryProperty`, which is always undefined — so a workflow whose
    // image sits in `image` was told "binary property data not found" (#91).
    const ctx = fakeContext({
      params: { resource: "op", operation: "run", storeResult: false, op: "resize", parameters: "{}", binaryProperty: "image" },
      binary: { image: { fileName: "invoice.png", mimeType: "image/png", buffer: Buffer.from("IN") } },
      routes: {
        "GET /api/v1/ops": opsRoute("POST /api/v1/images/transform"),
        "POST /api/v1/images/transform": () => ({ status: 200, headers: { "content-type": "image/webp" }, body: Buffer.from("OUT") })
      }
    });

    const [items] = await ImageStep.prototype.execute.call(ctx);
    expect(items[0].json.mode).toBe("sync");
    // Out on the same property it came in on, so the rest of the workflow keeps working.
    expect(items[0].binary.image.fileName).toBe("invoice.webp");
  });

  it("runs a single Asset ID through the sync path — the JSON form, no job, nothing stored", async () => {
    // Input = Asset IDs with Store Result off (both defaults on their own field) used to throw
    // `assertBinaryData`: the sync path never read `inputMode` (#92). The service accepts a
    // reference instead of bytes (contract §9), so an asset you already own can be resized without
    // becoming a job either.
    const ctx = fakeContext({
      params: {
        resource: "op",
        operation: "run",
        storeResult: false,
        op: "resize",
        parameters: '{"width":40}',
        inputMode: "assetIds",
        assetIds: "ast_1"
      },
      binary: {},
      routes: {
        "GET /api/v1/ops": opsRoute("POST /api/v1/images/transform"),
        "POST /api/v1/images/transform": () => ({ status: 200, headers: { "content-type": "image/webp" }, body: Buffer.from("OUT") })
      }
    });

    const [items] = await ImageStep.prototype.execute.call(ctx);

    expect(items[0].json.mode).toBe("sync");
    expect(items[0].json.sourceAssetId).toBe("ast_1");
    expect(items[0].binary.data.fileName).toBe("ast_1.webp");

    const call = ctx.calls.find((c) => c.url.includes("/images/transform"));
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.body)).toEqual({ assetId: "ast_1" });
    expect(call.qs).toEqual({ op: "resize", width: 40 });
    const paths = ctx.calls.map((c) => new URL(c.url).pathname);
    expect(paths).not.toContain("/api/v1/jobs");
    expect(paths).not.toContain("/api/v1/assets/update");
  });

  it("keeps several Asset IDs on the job path — a batch is a job", async () => {
    const ctx = fakeContext({
      params: {
        resource: "op",
        operation: "run",
        storeResult: false,
        op: "resize",
        parameters: "{}",
        inputMode: "assetIds",
        assetIds: "ast_1, ast_2",
        wait: false
      },
      binary: {},
      routes: {
        "GET /api/v1/ops": opsRoute("POST /api/v1/images/transform"),
        "POST /api/v1/jobs": () => ({ status: 200, body: { success: true, data: { id: "job-1", status: "PROCESSING", items: [] } } })
      }
    });

    const [items] = await ImageStep.prototype.execute.call(ctx);
    expect(items[0].json.jobId).toBe("job-1");
  });

  it("keeps Input=None on the job path — there are no bytes to send", async () => {
    const ctx = fakeContext({
      params: { resource: "op", operation: "run", storeResult: false, op: "resize", parameters: "{}", inputMode: "none", wait: false },
      binary: {},
      routes: {
        "GET /api/v1/ops": opsRoute("POST /api/v1/images/transform"),
        "POST /api/v1/jobs": () => ({ status: 200, body: { success: true, data: { id: "job-1", status: "PROCESSING", items: [] } } })
      }
    });

    const [items] = await ImageStep.prototype.execute.call(ctx);
    expect(items[0].json.jobId).toBe("job-1");
  });

  it("falls back to the job path when the catalogue gives the op no sync form", async () => {
    const ctx = ctxFor(
      { op: "resize", parameters: "{}", wait: false },
      {
        "GET /api/v1/ops": opsRoute(null),
        "POST /api/v1/assets/stage-upload": () => ({
          status: 200,
          body: { success: true, data: [{ objectId: "o1", url: "https://storage.test/put", contentType: "image/png" }] }
        }),
        "PUT /put": () => ({ status: 200, body: "" }),
        "POST /api/v1/assets/finish-upload": () => ({ status: 200, body: { success: true, data: [{ id: "ast-1", status: "DONE" }] } }),
        "POST /api/v1/assets/status": () => ({ status: 200, body: { success: true, data: { items: [{ id: "ast-1", status: "DONE" }] } } }),
        "GET /api/v1/assets/ast-1": () => ({ status: 200, body: { success: true, data: { id: "ast-1", status: "DONE" } } }),
        "POST /api/v1/jobs": () => ({ status: 200, body: { success: true, data: { id: "job-1", status: "PROCESSING", items: [] } } })
      }
    );

    const [items] = await ImageStep.prototype.execute.call(ctx);
    expect(items[0].json.jobId).toBe("job-1");
    expect(ctx.calls.map((c) => new URL(c.url).pathname)).toContain("/api/v1/jobs");
  });

  it("falls back to the job path when the catalogue cannot be reached at all", async () => {
    const ctx = ctxFor(
      { op: "resize", parameters: "{}", wait: false },
      {
        "GET /api/v1/ops": () => ({ status: 503, body: { success: false, error: { code: "internal_error" } } }),
        "POST /api/v1/assets/stage-upload": () => ({
          status: 200,
          body: { success: true, data: [{ objectId: "o1", url: "https://storage.test/put", contentType: "image/png" }] }
        }),
        "PUT /put": () => ({ status: 200, body: "" }),
        "POST /api/v1/assets/finish-upload": () => ({ status: 200, body: { success: true, data: [{ id: "ast-1", status: "DONE" }] } }),
        "POST /api/v1/assets/status": () => ({ status: 200, body: { success: true, data: { items: [{ id: "ast-1", status: "DONE" }] } } }),
        "GET /api/v1/assets/ast-1": () => ({ status: 200, body: { success: true, data: { id: "ast-1", status: "DONE" } } }),
        "POST /api/v1/jobs": () => ({ status: 200, body: { success: true, data: { id: "job-1", status: "PROCESSING", items: [] } } })
      }
    );

    // Slower is a better failure than wrong.
    const [items] = await ImageStep.prototype.execute.call(ctx);
    expect(items[0].json.jobId).toBe("job-1");
  });
});

// #523: one catalogue read per execution, and the synchronous lane used as wide as the account has it.
describe("many items", () => {
  const ops = () => ({
    status: 200,
    body: {
      success: true,
      data: [
        { op: "resize", syncEndpoint: "POST /api/v1/images/transform" },
        { op: "upscale", syncEndpoint: null }
      ]
    }
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("reads GET /api/v1/ops once for 20 items, runs four at a time, and keeps item order and pairedItem", async () => {
    let inFlight = 0;
    let widest = 0;
    let n = 0;
    const ctx = fakeContext({
      params: { resource: "op", operation: "run", op: "resize", storeResult: false, parameters: '{"width":40}' },
      binary: { data: { fileName: "a.png", mimeType: "image/png", buffer: Buffer.from("IN") } },
      items: Array.from({ length: 20 }, () => ({ json: {} })),
      routes: {
        "GET /api/v1/ops": ops,
        "POST /api/v1/images/transform": async () => {
          const mine = n++;
          inFlight++;
          widest = Math.max(widest, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 20 - (mine % 5) * 4)); // later items finish first
          inFlight--;
          return { status: 200, headers: { "content-type": "image/webp" }, body: Buffer.from(`OUT${mine}`) };
        }
      }
    });
    const [out] = await ImageStep.prototype.execute.call(ctx);
    expect(ctx.calls.filter((c) => new URL(c.url).pathname === "/api/v1/ops")).toHaveLength(1);
    expect(widest).toBe(ITEM_CONCURRENCY);
    expect(out.map((o) => o.pairedItem.item)).toEqual([...Array(20).keys()]);
  });

  it("runs job-path items one at a time, and reads the catalogue once for them too", async () => {
    let inFlight = 0;
    let widest = 0;
    const ctx = fakeContext({
      params: { resource: "op", operation: "run", op: "upscale", inputMode: "assetIds", assetIds: "ast1", wait: false },
      items: Array.from({ length: 6 }, () => ({ json: {} })),
      routes: {
        "GET /api/v1/ops": ops,
        "POST /api/v1/jobs": async () => {
          inFlight++;
          widest = Math.max(widest, inFlight);
          await tick();
          inFlight--;
          return { status: 200, body: { success: true, data: { id: "job", status: "PENDING", items: [] } } };
        }
      }
    });
    const [out] = await ImageStep.prototype.execute.call(ctx);
    expect(out).toHaveLength(6);
    expect(widest).toBe(1);
    expect(ctx.calls.filter((c) => new URL(c.url).pathname === "/api/v1/ops")).toHaveLength(1);
  });

  it("stops starting items after a failure and reports the failed item", async () => {
    const ctx = fakeContext({
      params: { resource: "op", operation: "run", op: "upscale", inputMode: "assetIds", assetIds: "ast1", wait: false },
      items: Array.from({ length: 10 }, () => ({ json: {} })),
      routes: {
        "GET /api/v1/ops": ops,
        "POST /api/v1/jobs": () => ({
          status: 402,
          body: { success: false, error: { code: "insufficient_credit", message: "top up", retryable: false } }
        })
      }
    });
    await expect(ImageStep.prototype.execute.call(ctx)).rejects.toMatchObject({ code: "insufficient_credit", itemIndex: 0 });
    // The first job-path item failed: the items queued behind it on the serial lane never run, and no new one starts.
    expect(ctx.calls.filter((c) => new URL(c.url).pathname === "/api/v1/jobs")).toHaveLength(1);
  });
});
