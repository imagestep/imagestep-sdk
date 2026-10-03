"use strict";

/**
 * The one HTTP layer of the package. Every call goes through n8n's own helpers
 * (`httpRequestWithAuthentication` for the API, `httpRequest` for storage PUTs and CDN GETs) —
 * no runtime dependency, no `fetch` of our own — and every API call:
 *   - unwraps the `{success, data, error, meta}` envelope (docs/api-contract.md §1),
 *   - sends an `Idempotency-Key` on writes (§3) and the package User-Agent,
 *   - turns an error body into a NodeApiError carrying `code`, `param` and `retryable` (§2).
 *
 * Functions take the n8n context (`this` of execute / loadOptions / hook / webhook) as `ctx`.
 */

const { createHash, randomUUID } = require("node:crypto");
const { NodeApiError, NodeOperationError } = require("n8n-workflow");

const CREDENTIAL = "imageStepApi";
const USER_AGENT = "n8n-nodes-imagestep/0.1.0";
const DEFAULT_BASE_URL = "https://api.imagestep.dev";
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * How a retryable answer is retried (#521): twice more, as both SDKs do (#98), waiting what `Retry-After` says and
 * otherwise 0.5 s, 1 s (+ up to half again of jitter, so the items of one run do not come back in step). Mutable only
 * so a test does not sleep.
 */
const RETRY = { retries: 2, baseMs: 500, maxWaitMs: 60_000 };
/** Failures below HTTP — no answer at all — that a second attempt can get past. */
const TRANSIENT = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether a failed call is worth a second attempt: the contract's `retryable`, or no HTTP answer at all. */
function worthRetrying(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) if (TRANSIENT.has(e.code)) return true;
  return false;
}

function retryDelay(attempt, retryAfter) {
  if (retryAfter != null) return Math.min(retryAfter * 1000, RETRY.maxWaitMs);
  const base = RETRY.baseMs * 2 ** (attempt - 1);
  return base + Math.floor((Math.random() * base) / 2);
}

/** `send` once, and again on a failure {@link worthRetrying} — the caller's request is unchanged, key included. */
async function withRetries(send) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (error) {
      if (attempt > RETRY.retries || !worthRetrying(error)) throw error;
      await sleep(retryDelay(attempt, error.retryAfter));
    }
  }
}

/**
 * The `Idempotency-Key` of a write made for input item `itemIndex` (#521). Name-based, not random: the same execution,
 * node, item, method, path and body give the same key, so n8n's **Retry On Fail** — which runs the whole node again
 * over every input item — replays the job an earlier try already submitted instead of creating and charging it twice.
 * A different body is a different key (the service answers a reused key with a different body `409`), and a new
 * execution is a new key: running the workflow again is asking for the work again. Outside an execution (a trigger's
 * lifecycle hooks) there is nothing to derive it from and a key is random, as before.
 */
function idempotencyKey(ctx, method, path, body, itemIndex) {
  const execution = typeof ctx.getExecutionId === "function" ? ctx.getExecutionId() : undefined;
  if (!execution || itemIndex === undefined || itemIndex === null) return randomUUID();
  const instance = typeof ctx.getInstanceId === "function" ? ctx.getInstanceId() : "";
  const workflow = typeof ctx.getWorkflow === "function" ? ctx.getWorkflow()?.id : "";
  const name = JSON.stringify([instance, workflow, execution, ctx.getNode()?.name, itemIndex, method, path, body ?? null]);
  const h = createHash("sha1").update("n8n-nodes-imagestep\n").update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // RFC 4122 version 5: a name-based UUID
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function baseUrl(ctx) {
  const creds = await ctx.getCredentials(CREDENTIAL);
  return String(creds?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * One API call. Resolves `{ data, meta, replayed }`; throws NodeApiError on any non-2xx that is left after
 * {@link withRetries}.
 * @param {object} ctx n8n function context
 * @param {"GET"|"POST"|"PUT"|"DELETE"} method
 * @param {string} path `/api/v1/...`
 * @param {{ body?: any, qs?: object, idempotencyKey?: string, itemIndex?: number, timeoutMs?: number }} [opts]
 *   `itemIndex` — the input item this write is for, which the key is derived from ({@link idempotencyKey})
 */
async function apiRequest(ctx, method, path, opts = {}) {
  const isWrite = method !== "GET" && method !== "HEAD";
  const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (isWrite) headers["Idempotency-Key"] = opts.idempotencyKey || idempotencyKey(ctx, method, path, opts.body, opts.itemIndex);
  const request = {
    method,
    url: `${await baseUrl(ctx)}${path}`,
    headers,
    qs: opts.qs,
    json: true,
    returnFullResponse: true,
    ignoreHttpStatusErrors: true
  };
  if (opts.body !== undefined) request.body = opts.body;
  if (opts.timeoutMs) request.timeout = opts.timeoutMs;
  return withRetries(async () => {
    const res = await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, request);
    const status = Number(res.statusCode);
    const json = parseBody(res.body);
    if (status >= 200 && status < 300) {
      const enveloped = json && typeof json === "object" && ("success" in json || "data" in json || "error" in json);
      return {
        data: status === 204 ? null : enveloped ? json.data : json,
        meta: enveloped ? json.meta : undefined,
        replayed: String(header(res.headers, "idempotency-replayed")) === "true"
      };
    }
    throw toNodeApiError(ctx, status, json, `${method} ${path}`, res.headers);
  });
}

/**
 * A call whose body and response are BYTES — the synchronous face (contract §9).
 *
 * Separate from {@link apiRequest} rather than a branch inside it: that one asks n8n for `json:
 * true` on both sides and stamps an Idempotency-Key on every write, and this needs the opposite of
 * all three. No Idempotency-Key is the documented exception — these endpoints create nothing that
 * survives the response, so there is no outcome to replay. It retries like every other call: every retryable answer
 * on this lane carries `Retry-After`, and the body is a Buffer already in hand (contract §9 — who carries the retry).
 *
 * @returns {Promise<{ buffer: Buffer, mimeType: string }>}
 */
async function apiRequestBinary(ctx, path, { qs, body, contentType }) {
  const request = {
    method: "POST",
    url: `${await baseUrl(ctx)}${path}`,
    headers: { Accept: "*/*", "User-Agent": USER_AGENT, ...(contentType ? { "Content-Type": contentType } : {}) },
    qs,
    body,
    json: false,
    encoding: "arraybuffer",
    returnFullResponse: true,
    ignoreHttpStatusErrors: true
  };
  return withRetries(async () => {
    const res = await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, request);
    const status = Number(res.statusCode);
    const buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body || []);
    const mimeType = String(header(res.headers, "content-type") || "application/octet-stream").split(";")[0];
    if (status >= 200 && status < 300 && !mimeType.startsWith("application/json")) {
      return { buffer, mimeType };
    }
    const json = parseBody(buffer.toString("utf8"));
    if (status >= 200 && status < 300) return { json: json?.data ?? json, mimeType };
    throw toNodeApiError(ctx, status, json, `POST ${path}`, res.headers);
  });
}

/** Which ops the API says may run synchronously — the catalogue {@link listOps} reads. Read, never hard-coded. */
async function syncEndpoints(ctx) {
  return Object.fromEntries((await listOps(ctx)).map((o) => [o.op, o.syncEndpoint || null]));
}

function parseBody(body) {
  if (body === undefined || body === null || body === "") return null;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return { message: body.slice(0, 200) };
  }
}

function header(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

/**
 * Contract §2 → n8n error: `code` and `param` in the message (what an operator reads in the
 * execution log), `retryable` in the description (what a retry-on-fail branch reads), the raw
 * envelope kept as the error's JSON for expressions on the error output. `requestId` (contract
 * §11: quote it when reporting a failure) comes from the envelope, or from `X-Request-Id` when the
 * body is not one — the same rule as both SDKs and the MCP server (#277).
 */
function toNodeApiError(ctx, status, json, where, headers) {
  const e = (json && json.error) || {};
  const requestId = e.requestId ?? header(headers, "x-request-id") ?? null;
  const code = e.code || (status >= 500 ? "internal_error" : "unknown_error");
  const retryable = e.retryable ?? status >= 500;
  const messageText = e.message || json?.message || `HTTP ${status}`;
  const message = `ImageStep ${code}${e.param ? ` (param: ${e.param})` : ""}: ${messageText}`;
  const description = `${where} → ${status}. retryable=${retryable}${e.details ? `; details=${JSON.stringify(e.details)}` : ""}${requestId ? `; requestId=${requestId}` : ""}`;
  const error = new NodeApiError(
    ctx.getNode(),
    { code, message: messageText, retryable, param: e.param ?? null, details: e.details ?? null, requestId, status },
    {
      message,
      description,
      httpCode: String(status)
    }
  );
  error.code = code;
  error.retryable = retryable;
  error.param = e.param ?? null;
  error.requestId = requestId;
  // Seconds, 0 included — HTTP reads that as "now". Absent, blank or an HTTP-date leaves the backoff schedule to it.
  const retryAfter = String(header(headers, "retry-after") ?? "").trim();
  error.retryAfter = retryAfter && Number(retryAfter) >= 0 ? Number(retryAfter) : null;
  return error;
}

// ── Assets ────────────────────────────────────────────────────────────────────────────────────

/**
 * Upload the binary property of one input item: stage (presigned PUT) → PUT the bytes with the
 * binary's mime type → finish → (optionally) poll until ingest has written dimensions / metadata.
 * @returns {Promise<object>} the asset
 */
async function uploadBinary(
  ctx,
  itemIndex,
  binaryProperty,
  { collection, retentionDays, wait = true, waitSeconds = 120, intervalMs } = {}
) {
  const meta = ctx.helpers.assertBinaryData(itemIndex, binaryProperty);
  const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryProperty);
  const fileName = meta.fileName || `upload${meta.fileExtension ? `.${meta.fileExtension}` : ""}`;
  const mimeType = meta.mimeType || "application/octet-stream";
  const sha1Hash = createHash("sha1").update(buffer).digest("hex");

  const staged = (
    await apiRequest(ctx, "POST", "/api/v1/assets/stage-upload", { body: [{ fileName, fileSize: buffer.length, sha1Hash }], itemIndex })
  ).data;
  const stage = Array.isArray(staged) ? staged[0] : staged;
  if (!stage || stage.error) {
    throw new NodeOperationError(ctx.getNode(), `ImageStep invalid_param (param: file): ${stage?.error || "upload rejected"}`, {
      itemIndex,
      description: "retryable=false"
    });
  }
  // Same bytes already ingested by this account → reuse that asset (one API round-trip, no upload).
  // Otherwise ALWAYS PUT: the presigned slot is a fresh, empty object even when `exists` is true.
  if (stage.exists && stage.existingAssetId) {
    const existing = (await apiRequest(ctx, "GET", `/api/v1/assets/${encodeURIComponent(stage.existingAssetId)}`)).data;
    if (existing && existing.status === "DONE") return existing;
  }
  // Storage, not the API: no credential, no envelope. n8n's plain httpRequest streams the Buffer.
  await ctx.helpers.httpRequest({
    method: "PUT",
    url: stage.url,
    body: buffer,
    // Both headers are signed into the presigned URL (#48); the service picks the Content-Type from
    // the file name, so echo `stage.contentType` rather than n8n's binary metadata.
    headers: { "Content-Type": stage.contentType || mimeType, "Content-Length": String(buffer.length) },
    json: false
  });
  const created = (
    await apiRequest(ctx, "POST", "/api/v1/assets/finish-upload", {
      // Which staged object, its name, the collection (#232) and how long to keep it (#591): the service knows the rest.
      body: [{ objectId: stage.objectId, name: fileName, collection: collection || undefined, retentionDays: retentionDays || undefined }],
      itemIndex
    })
  ).data;
  const asset = Array.isArray(created) ? created[0] : created;
  if (!wait) return asset;
  return waitAssetReady(ctx, asset.id, { timeoutMs: waitSeconds * 1000, intervalMs });
}

/** URLs per `POST /api/v1/assets/from-url`: the service's `IngestController.MAX_URLS`. */
const URLS_PER_INGEST = 20;
/** Ids per `POST /api/v1/assets/status`: the service's `AssetController.MAX_PREVIEW_IDS`. */
const IDS_PER_STATUS = 100;

/**
 * Have the service fetch public image URLs and create assets (imagestep#219): nothing is downloaded into
 * n8n, which on n8n Cloud has nowhere to put it anyway. One result per URL, in order — `{ url, asset }` or
 * `{ url, error }` — so one dead link does not cost the rest of the list.
 */
async function uploadFromUrls(ctx, urls, { collection, retentionDays, wait = true, intervalMs, itemIndex } = {}) {
  // Twenty to a request (#525): the service refuses a longer list whole (`IngestController.MAX_URLS`), and the field
  // takes any number.
  const results = [];
  for (let at = 0; at < urls.length; at += URLS_PER_INGEST) {
    const body = {
      urls: urls.slice(at, at + URLS_PER_INGEST),
      collection: collection || undefined,
      retentionDays: retentionDays || undefined
    };
    results.push(...((await apiRequest(ctx, "POST", "/api/v1/assets/from-url", { body, itemIndex })).data || []));
  }
  const created = results.filter((r) => !r.error).map((r) => r.id);
  const ready = wait && created.length ? await waitAssetsReady(ctx, created, { intervalMs }) : null;
  return results.map((r) => (r.error ? { url: r.url, error: r.error } : { url: r.url, asset: ready ? ready.get(r.id) : r }));
}

/** One asset: {@link waitAssetsReady} for one id. */
async function waitAssetReady(ctx, id, opts = {}) {
  return (await waitAssetsReady(ctx, [id], opts)).get(id);
}

/**
 * Wait until none of `ids` is PROCESSING — one batch-status call per tick for all of them (#233; #525: they used to be
 * waited for one after another, a 1.5 s floor each), then one read of each whole asset, eight at a time.
 * @returns {Promise<Map<string, object>>}
 */
async function waitAssetsReady(ctx, ids, { intervalMs = 1500, timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const unique = [...new Set(ids)];
  let pending = unique;
  for (;;) {
    const still = [];
    for (let at = 0; at < pending.length; at += IDS_PER_STATUS) {
      const batch = pending.slice(at, at + IDS_PER_STATUS);
      const items = (await apiRequest(ctx, "POST", "/api/v1/assets/status", { body: { ids: batch } })).data?.items || [];
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const id of batch) {
        const item = byId.get(id);
        if (!item) throw new NodeOperationError(ctx.getNode(), `Asset ${id} was not found`, { description: "retryable=false" });
        if (item.status === "PROCESSING") still.push(item);
      }
    }
    if (!still.length) break;
    if (Date.now() > deadline) {
      const what = still.length === 1 ? `Asset ${still[0].id} still ${still[0].status}` : `${still.length} assets still PROCESSING`;
      throw Object.assign(
        new NodeOperationError(ctx.getNode(), `${what} after ${timeoutMs} ms`, {
          description: "retryable=true — the ingest pipeline is slow or stuck; run Asset → Get later"
        }),
        { retryable: true } // what Continue On Fail writes into the row (#570), not only the description
      );
    }
    pending = still.map((item) => item.id);
    await sleep(intervalMs);
  }
  const read = [];
  for (let at = 0; at < unique.length; at += 8) read.push(...(await Promise.all(unique.slice(at, at + 8).map((id) => getAsset(ctx, id)))));
  return new Map(unique.map((id, n) => [id, read[n]]));
}

async function getAsset(ctx, id) {
  return (await apiRequest(ctx, "GET", `/api/v1/assets/${encodeURIComponent(id)}`)).data;
}

/** One page of a listing, the unset filters left off the query string. */
async function listPage(ctx, path, params) {
  const qs = {};
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs[k] = v;
  const { data, meta } = await apiRequest(ctx, "GET", path, { qs });
  return { items: data || [], meta };
}

async function listAssets(ctx, params) {
  return listPage(ctx, "/api/v1/assets", params);
}

/** The account's collections, most recently added to first (imagestep#349). */
async function listCollections(ctx, params) {
  return listPage(ctx, "/api/v1/assets/collections", params);
}

/** Publish → each asset gets a stable `publicUrl` on the CDN. */
async function publishAssets(ctx, ids, { published = true, itemIndex } = {}) {
  const list = [].concat(ids).filter(Boolean);
  if (!list.length) return [];
  return (await apiRequest(ctx, "POST", "/api/v1/assets/update", { body: { ids: list, published }, itemIndex })).data || [];
}

// ── Jobs ──────────────────────────────────────────────────────────────────────────────────────

/** The longest the service holds one request open for a job (contract §5, imagestep#355); it clamps to this too. */
const MAX_SERVER_WAIT_SECONDS = 60;
/** How much longer than the window it asked for a request is given, so the node's own timeout never ends a wait. */
const WAIT_GRACE_MS = 15_000;

function serverWaitSeconds(msLeft) {
  return Math.max(1, Math.min(MAX_SERVER_WAIT_SECONDS, Math.ceil(msLeft / 1000)));
}

/**
 * `waitMs` starts the wait on the submit itself (#355): a job of one item that settles inside the service's window comes
 * back finished, in one round trip. The service ignores it on a batch and on a dry run.
 */
async function submitJob(ctx, body, { dryRun = false, waitMs = 0, itemIndex } = {}) {
  if (dryRun || !waitMs) return (await apiRequest(ctx, "POST", `/api/v1/jobs${dryRun ? "?dryRun=true" : ""}`, { body, itemIndex })).data;
  const seconds = serverWaitSeconds(waitMs);
  return (
    await apiRequest(ctx, "POST", "/api/v1/jobs", {
      body: { ...body, wait: seconds },
      timeoutMs: seconds * 1000 + WAIT_GRACE_MS,
      itemIndex
    })
  ).data;
}

/** One job; `waitSeconds` long-polls — the service holds the response until the job is terminal or the window closes. */
async function getJob(ctx, id, { waitSeconds = 0 } = {}) {
  const opts = waitSeconds ? { qs: { wait: waitSeconds }, timeoutMs: waitSeconds * 1000 + WAIT_GRACE_MS } : {};
  return (await apiRequest(ctx, "GET", `/api/v1/jobs/${encodeURIComponent(id)}`, opts)).data;
}

/**
 * Wait until the job is terminal. The SERVICE does the waiting (#355): each read is `GET /jobs/{id}?wait=<up to 60 s>`,
 * which answers the moment the job settles; `intervalMs` is only a floor between reads, for a service that answers early.
 * Never throws on FAILED — the jobRef says so per item, and a workflow decides (an error output is not the place for
 * "3 of 200 items failed"). `known` is the job as a submit just returned it: already finished, it costs no read.
 *
 * Running out of time throws, so a workflow that expected outputs stops visibly and Retry On Fail — the same submit, the
 * same key — picks the same job back up. But the job is still running, and the error says so in the fields a workflow
 * branches on (#570): `retryable: true`, `timedOut: true` and the `job` itself, which Continue On Fail turns into the job
 * handle. It carried none of them, and a Continue On Fail row read `internal_error`, `retryable: false`.
 */
async function waitJob(ctx, id, { intervalMs = 1000, timeoutMs = 180_000, known } = {}) {
  const deadline = Date.now() + timeoutMs;
  let job = known;
  for (;;) {
    const asked = Date.now();
    if (!job) job = await getJob(ctx, id, { waitSeconds: serverWaitSeconds(deadline - asked) });
    if (TERMINAL.has(job.status)) return job;
    if (Date.now() >= deadline) {
      throw Object.assign(
        new NodeOperationError(
          ctx.getNode(),
          `Job ${id} still ${job.status} after ${timeoutMs} ms — it keeps running; continue with Job → Wait on its id`,
          {
            description:
              "retryable=true — raise Wait Seconds, continue with Job → Wait, or set Wait for Result off and use the ImageStep Trigger (job.completed) instead of waiting"
          }
        ),
        { retryable: true, timedOut: true, job }
      );
    }
    const floor = known ? 0 : intervalMs - (Date.now() - asked);
    if (floor > 0) await sleep(Math.min(floor, Math.max(0, deadline - Date.now())));
    job = null;
    known = null;
  }
}

/**
 * Rows per page of a listing — the service's ceiling (`perPage` ≤ 100) — and ids per publish in {@link collectOutputs}:
 * a publish answers every asset it touched, and an answer over 512 KB is not kept for an idempotent replay (contract §3),
 * so a bigger one would turn the replay Retry On Fail relies on (#521) into `409 idempotency_key_reuse`.
 */
const PAGE = 100;

/**
 * The result assets of a job, in item order (failed items have none) — read from `GET /api/v1/assets?jobId=`, a page at
 * a time, as both SDKs do (#441). Not from `job.items`: the job document inlines only its first 100 items
 * (`itemsTruncated`, #440), so reading the ids off it dropped every output after the hundredth without a word (#522);
 * and one `GET /assets/{id}` per output was N requests at once against a 600-a-minute budget. Each page after the first
 * is the `meta.nextCursor` the previous one carried (#493), never a page number the service would re-count.
 */
async function jobOutputs(ctx, job) {
  const rows = [];
  for (let at = { page: 0 }; ;) {
    const { items, meta } = await listAssets(ctx, { jobId: job.id, perPage: PAGE, ...at });
    rows.push(...items);
    if (!meta?.hasMore) break;
    if (!meta.nextCursor) throw new Error("the listing said hasMore but sent no meta.nextCursor");
    at = { cursor: meta.nextCursor };
  }
  return inItemOrder(rows, job);
}

/**
 * The listing is newest-first, which for a batch is neither item order nor settle order; an item knows its own output.
 * Rows no inlined item names — past the first 100 — keep the listing's order, after the rest. (The SDKs' `inItemOrder`.)
 */
function inItemOrder(assets, job) {
  const order = new Map();
  for (const [index, item] of (job?.items || []).entries()) {
    if (item?.resultAssetId && !order.has(item.resultAssetId)) order.set(item.resultAssetId, index);
  }
  if (order.size === 0) return assets;
  const at = (asset) => (order.has(asset.id) ? order.get(asset.id) : Number.MAX_SAFE_INTEGER);
  return assets.slice().sort((a, b) => at(a) - at(b));
}

/** Outputs of a job, published when asked (a page of ids per call, see {@link PAGE}), ready for `jobRef(job, outputs)`. */
async function collectOutputs(ctx, job, { publish, itemIndex }) {
  const none = typeof job.completedItems === "number" ? job.completedItems === 0 : !(job.items || []).some((i) => i.resultAssetId);
  if (none) return [];
  const outputs = await jobOutputs(ctx, job);
  if (!publish || outputs.every((a) => a.publicUrl)) return outputs;
  const published = [];
  for (let at = 0; at < outputs.length; at += PAGE) {
    const chunk = outputs.slice(at, at + PAGE);
    if (chunk.every((a) => a.publicUrl)) published.push(...chunk);
    else {
      const byId = new Map(
        (
          await publishAssets(
            ctx,
            chunk.map((a) => a.id),
            { itemIndex }
          )
        ).map((a) => [a.id, a])
      );
      published.push(...chunk.map((a) => byId.get(a.id) || a));
    }
  }
  return published;
}

/** Fetch one published output from the CDN into an n8n binary (`{ buffer, mimeType, fileName }`). */
async function downloadOutput(ctx, asset) {
  if (!asset.publicUrl) {
    throw new NodeOperationError(ctx.getNode(), `Asset ${asset.id} has no publicUrl — enable Publish to download outputs`, {
      description: "retryable=false"
    });
  }
  const res = await ctx.helpers.httpRequest({ method: "GET", url: asset.publicUrl, encoding: "arraybuffer", returnFullResponse: true });
  const buffer = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
  const mimeType = asset.image?.mimeType || String(header(res.headers, "content-type") || "application/octet-stream").split(";")[0];
  return { buffer, mimeType, fileName: asset.name || asset.id };
}

// ── Catalogues (design-time dropdowns) ─────────────────────────────────────────────────────────

async function listOps(ctx) {
  return (await apiRequest(ctx, "GET", "/api/v1/ops")).data || [];
}

async function listPresets(ctx) {
  const [builtin, user] = await Promise.all([
    apiRequest(ctx, "GET", "/api/v1/presets", { qs: { filter: "builtin" } }),
    apiRequest(ctx, "GET", "/api/v1/presets", { qs: { filter: "user" } })
  ]);
  return [...(builtin.data || []), ...(user.data || [])];
}

// ── Webhook endpoints (trigger lifecycle) ──────────────────────────────────────────────────────

async function createWebhookEndpoint(ctx, { url, events, description }) {
  return (await apiRequest(ctx, "POST", "/api/v1/webhook-endpoints", { body: { url, events, description } })).data;
}

async function getWebhookEndpoint(ctx, id) {
  return (await apiRequest(ctx, "GET", `/api/v1/webhook-endpoints/${encodeURIComponent(id)}`)).data;
}

async function deleteWebhookEndpoint(ctx, id) {
  await apiRequest(ctx, "DELETE", `/api/v1/webhook-endpoints/${encodeURIComponent(id)}`);
}

module.exports = {
  RETRY,
  CREDENTIAL,
  idempotencyKey,
  uploadBinary,
  uploadFromUrls,
  getAsset,
  listAssets,
  listCollections,
  publishAssets,
  submitJob,
  getJob,
  waitJob,
  collectOutputs,
  downloadOutput,
  listOps,
  listPresets,
  createWebhookEndpoint,
  getWebhookEndpoint,
  deleteWebhookEndpoint,
  apiRequestBinary,
  syncEndpoints
};
