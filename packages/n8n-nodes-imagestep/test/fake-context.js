import { createHmac } from "node:crypto";
import { createRequire } from "node:module";

// Every HTTP call a test makes goes through this context, so this is where retries are told to wait milliseconds, not
// the real 0.5 s / 1 s backoff (#521). `retries` stays as shipped: /docs/n8n quotes it.
Object.assign(createRequire(import.meta.url)("../src/lib/api.js").RETRY, { baseMs: 1, maxWaitMs: 5 });

/**
 * A stand-in for n8n's function context (`this` inside execute / hooks / webhook): a route table
 * answers every HTTP call, and every call is recorded with which helper carried it — `auth` for
 * httpRequestWithAuthentication (the API), `plain` for httpRequest (storage PUT, CDN GET).
 */
export function fakeContext({ routes = {}, params = {}, binary = {}, items, staticData = {}, executionId = "exec-1" } = {}) {
  const calls = [];

  async function dispatch(via, request) {
    const call = { via, ...request };
    calls.push(call);
    const url = new URL(request.url);
    const key = `${request.method} ${url.host}${url.pathname}`;
    const handler = routes[key] || routes[`${request.method} ${url.pathname}`];
    if (!handler) throw new Error(`fakeContext: no route for ${key}`);
    const result = await handler(call, url);
    if (result && typeof result === "object" && "status" in result && "body" in result) {
      return { statusCode: result.status, headers: result.headers || {}, body: result.body };
    }
    return { statusCode: 200, headers: {}, body: result };
  }

  const ctx = {
    calls,
    staticData,
    getCredentials: async () => ({ apiKey: "is_sk_test", baseUrl: "https://api.test/" }),
    getNode: () => ({ name: "ImageStep", type: "n8n-nodes-imagestep.imageStep", typeVersion: 1 }),
    getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
    getInputData: () => items || [{ json: {} }],
    continueOnFail: () => false,
    getWorkflowStaticData: () => staticData,
    getNodeWebhookUrl: () => "https://n8n.example.com/webhook/abc",
    getWorkflow: () => ({ id: "wf1", name: "Test workflow" }),
    getExecutionId: () => executionId,
    getInstanceId: () => "instance-1",
    helpers: {
      async httpRequestWithAuthentication(credential, request) {
        if (credential !== "imageStepApi") throw new Error(`unexpected credential ${credential}`);
        return dispatch("auth", request);
      },
      async httpRequest(request) {
        return dispatch("plain", request);
      },
      assertBinaryData(_i, prop) {
        if (!binary[prop]) throw new Error(`no binary ${prop}`);
        const { buffer, ...meta } = binary[prop];
        return meta;
      },
      async getBinaryDataBuffer(_i, prop) {
        return binary[prop].buffer;
      },
      async prepareBinaryData(buffer, fileName, mimeType) {
        return { data: buffer.toString("base64"), fileName, mimeType, fileSize: `${buffer.length} B` };
      },
      returnJsonArray: (arr) => [].concat(arr).map((json) => ({ json }))
    }
  };
  return ctx;
}

/** Contract envelope helpers (docs/api-contract.md §1). */
export const ok = (data, meta) => ({ success: true, data, ...(meta ? { meta } : {}) });
export const fail = (status, error) => ({ status, body: { success: false, error } });

/** An `ImageStep-Signature` header for a body, signed the way the service signs a delivery (contract §6). */
export function signBody(rawBody, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}
