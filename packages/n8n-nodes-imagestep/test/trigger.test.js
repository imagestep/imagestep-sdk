import { describe, expect, it } from "vitest";
import { ImageStepTrigger } from "../nodes/ImageStepTrigger/ImageStepTrigger.node.ts";
import { fakeContext, fail, ok, signBody } from "./fake-context.js";

const secret = "whsec_test";
const event = { id: "evt_1", type: "job.completed", createdAt: "2026-09-08T07:11:00Z", data: { jobId: "job_1", status: "COMPLETED" } };

/** A delivery context: raw body on the request, headers as n8n lowercases them, a recording response. */
function delivery({ rawBody, header, staticData = { webhookId: "wh_1", webhookSecret: secret }, body }) {
  const ctx = fakeContext({ staticData, params: { tolerance: 300 } });
  ctx.response = { statusCode: null, payload: null };
  ctx.getRequestObject = () => ({ rawBody });
  ctx.getResponseObject = () => ({
    status(code) {
      ctx.response.statusCode = code;
      return this;
    },
    json(payload) {
      ctx.response.payload = payload;
    }
  });
  ctx.getHeaderData = () => ({
    "imagestep-signature": header,
    "imagestep-event-id": "evt_1",
    "imagestep-event-type": "job.completed",
    "imagestep-attempt": "2"
  });
  ctx.getBodyData = () => body ?? JSON.parse(rawBody.toString());
  return ctx;
}

describe("ImageStep Trigger — delivery", () => {
  const trigger = new ImageStepTrigger();
  const raw = Buffer.from(JSON.stringify(event));

  it("verifies the signature over the raw body and emits id / type / createdAt / attempt / data", async () => {
    const ctx = delivery({ rawBody: raw, header: signBody(raw, secret) });
    const out = await trigger.webhook.call(ctx);
    expect(ctx.response.statusCode).toBeNull();
    expect(out.workflowData[0][0].json).toEqual({
      id: "evt_1",
      type: "job.completed",
      createdAt: event.createdAt,
      attempt: 2,
      data: event.data
    });
  });

  it("answers 401 without running the workflow on a bad signature, a tampered body, or no stored secret", async () => {
    const bad = delivery({ rawBody: raw, header: signBody(raw, "other") });
    expect(await trigger.webhook.call(bad)).toEqual({ noWebhookResponse: true });
    expect(bad.response).toEqual({ statusCode: 401, payload: { error: "invalid signature" } });

    const tampered = delivery({
      rawBody: Buffer.from(JSON.stringify({ ...event, data: { jobId: "job_2" } })),
      header: signBody(raw, secret)
    });
    expect((await trigger.webhook.call(tampered)).noWebhookResponse).toBe(true);

    const noSecret = delivery({ rawBody: raw, header: signBody(raw, secret), staticData: {} });
    expect((await trigger.webhook.call(noSecret)).noWebhookResponse).toBe(true);
  });

  it("falls back to re-serialising the parsed body when rawBody is unavailable", async () => {
    const serialised = JSON.stringify(event);
    const ctx = delivery({ rawBody: undefined, header: signBody(serialised, secret), body: event });
    const out = await trigger.webhook.call(ctx);
    expect(out.workflowData[0][0].json.data).toEqual(event.data);
  });
});

describe("ImageStep Trigger — endpoint lifecycle", () => {
  const trigger = new ImageStepTrigger();

  it("create registers the n8n webhook URL with the selected events and stores id + secret once", async () => {
    const seen = {};
    const ctx = fakeContext({
      routes: {
        "POST /api/v1/webhook-endpoints": (req) => {
          seen.body = req.body;
          return ok({ id: "wh_1", url: req.body.url, events: req.body.events, secret: "whsec_new" });
        }
      },
      params: { events: ["job.completed"] }
    });
    expect(await trigger.webhookMethods.default.create.call(ctx)).toBe(true);
    expect(seen.body).toEqual({
      url: "https://n8n.example.com/webhook/abc",
      events: ["job.completed"],
      description: "n8n: Test workflow / ImageStep"
    });
    expect(ctx.staticData).toEqual({ webhookId: "wh_1", webhookSecret: "whsec_new" });
    expect(ctx.calls[0].headers["Idempotency-Key"]).toBeDefined();
  });

  it("checkExists is true only while the stored endpoint exists and still points at this URL", async () => {
    const live = fakeContext({
      routes: {
        "GET /api/v1/webhook-endpoints/wh_1": () => ok({ id: "wh_1", url: "https://n8n.example.com/webhook/abc", secretHint: "whse…" })
      },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.checkExists.call(live)).toBe(true);

    const moved = fakeContext({
      routes: { "GET /api/v1/webhook-endpoints/wh_1": () => ok({ id: "wh_1", url: "https://elsewhere.example.com/hook" }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.checkExists.call(moved)).toBe(false);
    expect(moved.staticData).toEqual({});

    const gone = fakeContext({
      routes: { "GET /api/v1/webhook-endpoints/wh_1": () => fail(404, { code: "not_found", message: "gone", retryable: false }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.checkExists.call(gone)).toBe(false);
    expect(await trigger.webhookMethods.default.checkExists.call(fakeContext({ staticData: {} }))).toBe(false);
  });

  it("delete removes the endpoint and forgets the secret; an already-deleted endpoint is fine", async () => {
    const ctx = fakeContext({
      routes: { "DELETE /api/v1/webhook-endpoints/wh_1": () => ({ status: 204, body: "" }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.delete.call(ctx)).toBe(true);
    expect(ctx.staticData).toEqual({});
    const gone = fakeContext({
      routes: { "DELETE /api/v1/webhook-endpoints/wh_1": () => fail(404, { code: "not_found", message: "gone", retryable: false }) },
      staticData: { webhookId: "wh_1", webhookSecret: "s" }
    });
    expect(await trigger.webhookMethods.default.delete.call(gone)).toBe(true);
  });
});
