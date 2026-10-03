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

import { createHash, randomUUID } from "node:crypto";
import { NodeApiError, NodeOperationError, sleep } from "n8n-workflow";
import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  IWebhookFunctions,
  JsonObject
} from "n8n-workflow";
import type { OpEntry } from "./ops";
import type { Asset, Job, JobBody } from "./refs";

/** Every n8n context this layer is called from: a node's execute, a dropdown's loadOptions, a trigger's hooks and webhook. */
export type Context = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

/** A failure as this layer throws it: n8n's error plus the contract's fields a retry and a workflow branch on. */
export type Failure = Error & {
  code?: string;
  retryable?: boolean;
  retryAfter?: number | null;
  param?: string | null;
  requestId?: string | null;
  httpCode?: string | null;
  timedOut?: boolean;
  job?: Job;
  itemIndex?: number;
  cause?: unknown;
};

/**
 * What a failed item throws to n8n: the errors this package makes (NodeApiError, NodeOperationError) as they are, and
 * anything else — a parameter that does not parse, a connection that never answered — as a NodeOperationError for that
 * item, keeping the `code` and `retryable` a Continue On Fail row reports. n8n shows its own two error types with the
 * node and the item they came from.
 */
export function asNodeError(ctx: Context, error: unknown, itemIndex?: number): Failure {
  if (error instanceof NodeApiError || error instanceof NodeOperationError) return error as Failure;
  const raw = (error ?? {}) as Failure;
  const wrapped: Failure = new NodeOperationError(ctx.getNode(), error instanceof Error ? error : String(error), { itemIndex });
  if (raw.code !== undefined) wrapped.code = raw.code;
  if (typeof raw.retryable === "boolean") wrapped.retryable = raw.retryable;
  return wrapped;
}

/** A listing's `meta` (contract §4). */
export interface PageMeta {
  page?: number;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
}

export const CREDENTIAL = "imageStepApi";
const USER_AGENT = "n8n-nodes-imagestep/0.1.0";
const DEFAULT_BASE_URL = "https://api.imagestep.dev";
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * How a retryable answer is retried (#521): twice more, as both SDKs do (#98), waiting what `Retry-After` says and
 * otherwise 0.5 s, 1 s (+ up to half again of jitter, so the items of one run do not come back in step). Mutable only
 * so a test does not sleep.
 */
export const RETRY = { retries: 2, baseMs: 500, maxWaitMs: 60_000 };
/** Failures below HTTP — no answer at all — that a second attempt can get past. */
const TRANSIENT = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/** Whether a failed call is worth a second attempt: the contract's `retryable`, or no HTTP answer at all. */
function worthRetrying(error: Failure | undefined): boolean {
  if (typeof error?.retryable === "boolean") return error.retryable;
  for (let e = error, depth = 0; e && depth < 4; e = e.cause as Failure | undefined, depth++)
    if (TRANSIENT.has(String(e.code))) return true;
  return false;
}

function retryDelay(attempt: number, retryAfter: number | null | undefined): number {
  if (retryAfter != null) return Math.min(retryAfter * 1000, RETRY.maxWaitMs);
  const base = RETRY.baseMs * 2 ** (attempt - 1);
  return base + Math.floor((Math.random() * base) / 2);
}

/** `send` once, and again on a failure {@link worthRetrying} — the caller's request is unchanged, key included. */
async function withRetries<T>(send: () => Promise<T>): Promise<T> {
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
export function idempotencyKey(ctx: Context, method: string, path: string, body: unknown, itemIndex: number | undefined): string {
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

async function baseUrl(ctx: Context): Promise<string> {
  const creds = await ctx.getCredentials(CREDENTIAL);
  return String(creds?.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * One API call. Resolves `{ data, meta, replayed }`; throws NodeApiError on any non-2xx that is left after
 * {@link withRetries}.
 * @param ctx n8n function context
 * @param path `/api/v1/...`
 * @param opts `itemIndex` — the input item this write is for, which the key is derived from ({@link idempotencyKey})
 */
async function apiRequest<T = unknown>(
  ctx: Context,
  method: IHttpRequestMethods,
  path: string,
  opts: { body?: IHttpRequestOptions["body"]; qs?: IDataObject; idempotencyKey?: string; itemIndex?: number; timeoutMs?: number } = {}
): Promise<{ data: T; meta?: PageMeta; replayed: boolean }> {
  const isWrite = method !== "GET" && method !== "HEAD";
  const headers: IDataObject = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (isWrite) headers["Idempotency-Key"] = opts.idempotencyKey || idempotencyKey(ctx, method, path, opts.body, opts.itemIndex);
  const request: IHttpRequestOptions = {
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
      const enveloped = !!json && typeof json === "object" && ("success" in json || "data" in json || "error" in json);
      return {
        data: (status === 204 ? null : enveloped ? json.data : json) as T,
        meta: enveloped ? (json.meta as PageMeta | undefined) : undefined,
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
 */
export async function apiRequestBinary(
  ctx: Context,
  path: string,
  { qs, body, contentType }: { qs?: IDataObject; body: Buffer | string; contentType?: string }
): Promise<{ buffer?: Buffer; json?: unknown; mimeType: string }> {
  const request: IHttpRequestOptions = {
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
export async function syncEndpoints(ctx: Context): Promise<Record<string, string | null>> {
  return Object.fromEntries((await listOps(ctx)).map((o) => [o.op, o.syncEndpoint || null]));
}

function parseBody(body: unknown): IDataObject | null {
  if (body === undefined || body === null || body === "") return null;
  if (typeof body !== "string") return body as IDataObject;
  try {
    return JSON.parse(body) as IDataObject;
  } catch {
    return { message: body.slice(0, 200) };
  }
}

function header(headers: IDataObject | undefined, name: string): unknown {
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
function toNodeApiError(ctx: Context, status: number, json: IDataObject | null, where: string, headers: IDataObject | undefined): Failure {
  const e = ((json && json.error) || {}) as {
    code?: string;
    message?: string;
    retryable?: boolean;
    param?: string;
    details?: IDataObject;
    requestId?: string;
  };
  const requestId = (e.requestId ?? header(headers, "x-request-id") ?? null) as string | null;
  const code = e.code || (status >= 500 ? "internal_error" : "unknown_error");
  const retryable = e.retryable ?? status >= 500;
  const messageText = e.message || (json?.message as string | undefined) || `HTTP ${status}`;
  const message = `ImageStep ${code}${e.param ? ` (param: ${e.param})` : ""}: ${messageText}`;
  const description = `${where} → ${status}. retryable=${retryable}${e.details ? `; details=${JSON.stringify(e.details)}` : ""}${requestId ? `; requestId=${requestId}` : ""}`;
  const error = new NodeApiError(
    ctx.getNode(),
    { code, message: messageText, retryable, param: e.param ?? null, details: e.details ?? null, requestId, status } as JsonObject,
    {
      message,
      description,
      httpCode: String(status)
    }
  );
  // Seconds, 0 included — HTTP reads that as "now". Absent, blank or an HTTP-date leaves the backoff schedule to it.
  const retryAfter = String(header(headers, "retry-after") ?? "").trim();
  return Object.assign(error, {
    code,
    retryable,
    param: e.param ?? null,
    requestId,
    retryAfter: retryAfter && Number(retryAfter) >= 0 ? Number(retryAfter) : null
  });
}

// ── Assets ────────────────────────────────────────────────────────────────────────────────────

/**
 * Upload the binary property of one input item: stage (presigned PUT) → PUT the bytes with the
 * binary's mime type → finish → (optionally) poll until ingest has written dimensions / metadata.
 * @returns the asset
 */
export async function uploadBinary(
  ctx: IExecuteFunctions,
  itemIndex: number,
  binaryProperty: string,
  {
    collection,
    retentionDays,
    wait = true,
    waitSeconds = 120,
    intervalMs
  }: { collection?: string; retentionDays?: number; wait?: boolean; waitSeconds?: number; intervalMs?: number } = {}
): Promise<Asset> {
  const meta = ctx.helpers.assertBinaryData(itemIndex, binaryProperty);
  const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, binaryProperty);
  const fileName = meta.fileName || `upload${meta.fileExtension ? `.${meta.fileExtension}` : ""}`;
  const mimeType = meta.mimeType || "application/octet-stream";
  const sha1Hash = createHash("sha1").update(buffer).digest("hex");

  const staged = (
    await apiRequest<Staged | Staged[]>(ctx, "POST", "/api/v1/assets/stage-upload", {
      body: [{ fileName, fileSize: buffer.length, sha1Hash }],
      itemIndex
    })
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
    const existing = (await apiRequest<Asset>(ctx, "GET", `/api/v1/assets/${encodeURIComponent(stage.existingAssetId)}`)).data;
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
    await apiRequest<Asset | Asset[]>(ctx, "POST", "/api/v1/assets/finish-upload", {
      // Which staged object, its name, the collection (#232) and how long to keep it (#591): the service knows the rest.
      body: [{ objectId: stage.objectId, name: fileName, collection: collection || undefined, retentionDays: retentionDays || undefined }],
      itemIndex
    })
  ).data;
  const asset = Array.isArray(created) ? created[0] : created;
  if (!wait) return asset;
  return waitAssetReady(ctx, asset.id, { timeoutMs: waitSeconds * 1000, intervalMs });
}

/** One answer of `POST /api/v1/assets/stage-upload`. */
interface Staged {
  url: string;
  objectId: string;
  contentType?: string;
  exists?: boolean;
  existingAssetId?: string;
  error?: string;
}

/** One answer of `POST /api/v1/assets/from-url`: an asset, or the reason that URL made none. */
type Ingested = Partial<Asset> & { url: string; error?: string };

/** URLs per `POST /api/v1/assets/from-url`: the service's `IngestController.MAX_URLS`. */
const URLS_PER_INGEST = 20;
/** Ids per `POST /api/v1/assets/status`: the service's `AssetController.MAX_PREVIEW_IDS`. */
const IDS_PER_STATUS = 100;

/**
 * Have the service fetch public image URLs and create assets (imagestep#219): nothing is downloaded into
 * n8n, which on n8n Cloud has nowhere to put it anyway. One result per URL, in order — `{ url, asset }` or
 * `{ url, error }` — so one dead link does not cost the rest of the list.
 */
export async function uploadFromUrls(
  ctx: Context,
  urls: string[],
  {
    collection,
    retentionDays,
    wait = true,
    intervalMs,
    itemIndex
  }: { collection?: string; retentionDays?: number; wait?: boolean; intervalMs?: number; itemIndex?: number } = {}
): Promise<Array<{ url: string; asset?: Asset; error?: string }>> {
  // Twenty to a request (#525): the service refuses a longer list whole (`IngestController.MAX_URLS`), and the field
  // takes any number.
  const results: Ingested[] = [];
  for (let at = 0; at < urls.length; at += URLS_PER_INGEST) {
    const body = {
      urls: urls.slice(at, at + URLS_PER_INGEST),
      collection: collection || undefined,
      retentionDays: retentionDays || undefined
    };
    results.push(...((await apiRequest<Ingested[] | null>(ctx, "POST", "/api/v1/assets/from-url", { body, itemIndex })).data || []));
  }
  const created = results.filter((r) => !r.error).map((r) => String(r.id));
  const ready = wait && created.length ? await waitAssetsReady(ctx, created, { intervalMs }) : null;
  return results.map((r) =>
    r.error ? { url: r.url, error: r.error } : { url: r.url, asset: ready ? ready.get(String(r.id)) : (r as Asset & { url: string }) }
  );
}

/** One asset: {@link waitAssetsReady} for one id. */
async function waitAssetReady(ctx: Context, id: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<Asset> {
  return (await waitAssetsReady(ctx, [id], opts)).get(id) as Asset;
}

/**
 * Wait until none of `ids` is PROCESSING — one batch-status call per tick for all of them (#233; #525: they used to be
 * waited for one after another, a 1.5 s floor each), then one read of each whole asset, eight at a time.
 */
async function waitAssetsReady(
  ctx: Context,
  ids: string[],
  { intervalMs = 1500, timeoutMs = 120_000 }: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<Map<string, Asset>> {
  const deadline = Date.now() + timeoutMs;
  const unique = [...new Set(ids)];
  let pending = unique;
  for (;;) {
    const still: Array<{ id: string; status: string }> = [];
    for (let at = 0; at < pending.length; at += IDS_PER_STATUS) {
      const batch = pending.slice(at, at + IDS_PER_STATUS);
      const items =
        (
          await apiRequest<{ items?: Array<{ id: string; status: string }> } | null>(ctx, "POST", "/api/v1/assets/status", {
            body: { ids: batch }
          })
        ).data?.items || [];
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
  const read: Asset[] = [];
  for (let at = 0; at < unique.length; at += 8) read.push(...(await Promise.all(unique.slice(at, at + 8).map((id) => getAsset(ctx, id)))));
  return new Map(unique.map((id, n) => [id, read[n]]));
}

export async function getAsset(ctx: Context, id: string): Promise<Asset> {
  return (await apiRequest<Asset>(ctx, "GET", `/api/v1/assets/${encodeURIComponent(id)}`)).data;
}

/** One page of a listing, the unset filters left off the query string. */
async function listPage<T>(ctx: Context, path: string, params: IDataObject | undefined): Promise<{ items: T[]; meta?: PageMeta }> {
  const qs: IDataObject = {};
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") qs[k] = v;
  const { data, meta } = await apiRequest<T[] | null>(ctx, "GET", path, { qs });
  return { items: data || [], meta };
}

export async function listAssets(ctx: Context, params?: IDataObject): Promise<{ items: Asset[]; meta?: PageMeta }> {
  return listPage<Asset>(ctx, "/api/v1/assets", params);
}

/** The account's collections, most recently added to first (imagestep#349). */
export async function listCollections(
  ctx: Context,
  params?: IDataObject
): Promise<{ items: Array<{ collection: string; count: number; lastCreatedAt?: string | number }>; meta?: PageMeta }> {
  return listPage(ctx, "/api/v1/assets/collections", params);
}

/** Publish → each asset gets a stable `publicUrl` on the CDN. */
export async function publishAssets(
  ctx: Context,
  ids: string | string[],
  { published = true, itemIndex }: { published?: boolean; itemIndex?: number } = {}
): Promise<Asset[]> {
  const list = ([] as string[]).concat(ids).filter(Boolean);
  if (!list.length) return [];
  return (await apiRequest<Asset[] | null>(ctx, "POST", "/api/v1/assets/update", { body: { ids: list, published }, itemIndex })).data || [];
}

// ── Jobs ──────────────────────────────────────────────────────────────────────────────────────

/** The longest the service holds one request open for a job (contract §5, imagestep#355); it clamps to this too. */
const MAX_SERVER_WAIT_SECONDS = 60;
/** How much longer than the window it asked for a request is given, so the node's own timeout never ends a wait. */
const WAIT_GRACE_MS = 15_000;

function serverWaitSeconds(msLeft: number): number {
  return Math.max(1, Math.min(MAX_SERVER_WAIT_SECONDS, Math.ceil(msLeft / 1000)));
}

/**
 * `waitMs` starts the wait on the submit itself (#355): a job of one item that settles inside the service's window comes
 * back finished, in one round trip. The service ignores it on a batch and on a dry run.
 */
export async function submitJob(
  ctx: Context,
  body: JobBody,
  { dryRun = false, waitMs = 0, itemIndex }: { dryRun?: boolean; waitMs?: number; itemIndex?: number } = {}
): Promise<Job> {
  if (dryRun || !waitMs)
    return (await apiRequest<Job>(ctx, "POST", `/api/v1/jobs${dryRun ? "?dryRun=true" : ""}`, { body, itemIndex })).data;
  const seconds = serverWaitSeconds(waitMs);
  return (
    await apiRequest<Job>(ctx, "POST", "/api/v1/jobs", {
      body: { ...body, wait: seconds },
      timeoutMs: seconds * 1000 + WAIT_GRACE_MS,
      itemIndex
    })
  ).data;
}

/** One job; `waitSeconds` long-polls — the service holds the response until the job is terminal or the window closes. */
export async function getJob(ctx: Context, id: string, { waitSeconds = 0 }: { waitSeconds?: number } = {}): Promise<Job> {
  const opts = waitSeconds ? { qs: { wait: waitSeconds }, timeoutMs: waitSeconds * 1000 + WAIT_GRACE_MS } : {};
  return (await apiRequest<Job>(ctx, "GET", `/api/v1/jobs/${encodeURIComponent(id)}`, opts)).data;
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
export async function waitJob(
  ctx: Context,
  id: string,
  { intervalMs = 1000, timeoutMs = 180_000, known }: { intervalMs?: number; timeoutMs?: number; known?: Job | null } = {}
): Promise<Job> {
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
async function jobOutputs(ctx: Context, job: Job): Promise<Asset[]> {
  const rows: Asset[] = [];
  for (let at: IDataObject = { page: 0 }; ;) {
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
function inItemOrder(assets: Asset[], job: Job): Asset[] {
  const order = new Map<string, number>();
  for (const [index, item] of (job?.items || []).entries()) {
    if (item?.resultAssetId && !order.has(item.resultAssetId)) order.set(item.resultAssetId, index);
  }
  if (order.size === 0) return assets;
  const at = (asset: Asset) => order.get(asset.id) ?? Number.MAX_SAFE_INTEGER;
  return assets.slice().sort((a, b) => at(a) - at(b));
}

/** Outputs of a job, published when asked (a page of ids per call, see {@link PAGE}), ready for `jobRef(job, outputs)`. */
export async function collectOutputs(
  ctx: Context,
  job: Job,
  { publish, itemIndex }: { publish: boolean; itemIndex?: number }
): Promise<Asset[]> {
  const none = typeof job.completedItems === "number" ? job.completedItems === 0 : !(job.items || []).some((i) => i.resultAssetId);
  if (none) return [];
  const outputs = await jobOutputs(ctx, job);
  if (!publish || outputs.every((a) => a.publicUrl)) return outputs;
  const published: Asset[] = [];
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
export async function downloadOutput(ctx: Context, asset: Asset): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
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

export async function listOps(ctx: Context): Promise<OpEntry[]> {
  return (await apiRequest<OpEntry[] | null>(ctx, "GET", "/api/v1/ops")).data || [];
}

/** A preset as the dropdown shows it. */
export interface Preset {
  id: string;
  slug?: string;
  name?: string;
  description?: string;
  builtIn?: boolean;
}

export async function listPresets(ctx: Context): Promise<Preset[]> {
  const [builtin, user] = await Promise.all([
    apiRequest<Preset[] | null>(ctx, "GET", "/api/v1/presets", { qs: { filter: "builtin" } }),
    apiRequest<Preset[] | null>(ctx, "GET", "/api/v1/presets", { qs: { filter: "user" } })
  ]);
  return [...(builtin.data || []), ...(user.data || [])];
}

// ── Webhook endpoints (trigger lifecycle) ──────────────────────────────────────────────────────

/** A webhook endpoint; `secret` comes back once, on creation. */
export interface WebhookEndpoint {
  id: string;
  url: string;
  secret?: string;
}

export async function createWebhookEndpoint(
  ctx: Context,
  { url, events, description }: { url: string; events: string[]; description: string }
): Promise<WebhookEndpoint> {
  return (await apiRequest<WebhookEndpoint>(ctx, "POST", "/api/v1/webhook-endpoints", { body: { url, events, description } })).data;
}

export async function getWebhookEndpoint(ctx: Context, id: string): Promise<WebhookEndpoint | null> {
  return (await apiRequest<WebhookEndpoint | null>(ctx, "GET", `/api/v1/webhook-endpoints/${encodeURIComponent(id)}`)).data;
}

export async function deleteWebhookEndpoint(ctx: Context, id: string): Promise<void> {
  await apiRequest(ctx, "DELETE", `/api/v1/webhook-endpoints/${encodeURIComponent(id)}`);
}
