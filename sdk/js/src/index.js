import { ImageStepError, JobFailedError } from "./errors.js";
import { constructWebhookEvent, verifyWebhookSignature } from "./webhooks.js";

export { ImageStepError, JobFailedError, verifyWebhookSignature, constructWebhookEvent };

const DEFAULT_BASE_URL = "https://api.imagestep.dev";
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * The longest the service holds a request open for a job (contract §5, imagestep#355). It clamps to this too; the SDK
 * asks for no more so that its own request timeout — this plus {@link WAIT_GRACE_MS} — is never the thing that fires.
 */
const MAX_SERVER_WAIT_SECONDS = 60;
const WAIT_GRACE_MS = 15_000;

/** URLs per `POST /api/v1/assets/from-url` — the service's `IngestController.MAX_URLS`; more is `400 invalid_param` (#525). */
const URLS_PER_INGEST = 20;
/** Ids per `POST /api/v1/assets/status` — the service's `AssetController.MAX_PREVIEW_IDS`. */
const IDS_PER_STATUS = 100;
/** Files per stage-upload / finish-upload — the service's `UploadController.MAX_STAGE_UPLOAD_ITEMS` (ledger C73). */
const FILES_PER_STAGE = 500;
/**
 * The slowest link a storage PUT is given time for, in bytes per millisecond (~2 Mbit/s). The PUT is timed as a request
 * plus this long per byte (#567): a 100 MB file on a slow uplink is not cut off by a timeout meant for a JSON answer, and
 * a PUT that hangs still ends.
 */
const STORAGE_BYTES_PER_MS = 256;

/** `wait: true | {timeoutMs, …}` → the seconds to ask the service to hold the submit for. */
function serverWaitSeconds(wait) {
  const timeoutMs = typeof wait === "object" && wait.timeoutMs !== undefined ? wait.timeoutMs : Infinity;
  return Math.max(1, Math.min(MAX_SERVER_WAIT_SECONDS, Math.ceil(timeoutMs / 1000)));
}
const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  bmp: "image/bmp",
  jxl: "image/jxl",
  jp2: "image/jp2",
  j2k: "image/jp2",
  psd: "image/vnd.adobe.photoshop",
  ico: "image/vnd.microsoft.icon",
  svg: "image/svg+xml",
  dng: "image/x-adobe-dng",
  cr2: "image/x-canon-cr2",
  arw: "image/x-sony-arw",
  nef: "image/x-nikon-nef",
  raf: "image/x-fuji-raf"
};

function mimeFromName(name, fallback = "application/octet-stream") {
  const ext = String(name || "")
    .split(".")
    .pop()
    .toLowerCase();
  return MIME_BY_EXT[ext] || fallback;
}

const onNode = typeof process !== "undefined" && Boolean(process.versions?.node);

/**
 * SHA-1 of bytes in hand. On Node through `node:crypto`, which reads the view in place; WebCrypto (browsers, edge
 * runtimes) copies its input first, which for a 100 MB upload was one more 100 MB (#528).
 */
async function sha1Hex(bytes) {
  if (onNode) {
    const { createHash } = await import("node:crypto");
    return createHash("sha1").update(bytes).digest("hex");
  }
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-1 and size of a file, read as a stream: the file is never whole in memory (#528). Node only. */
async function sha1OfPath(path) {
  const [{ createHash }, { createReadStream }] = await Promise.all([import("node:crypto"), import("node:fs")]);
  const hash = createHash("sha1");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha1Hash: hash.digest("hex"), size };
}

/** A body fetch can only read once — a web ReadableStream, a Node stream, any async iterable — needs `duplex: "half"`. */
function isStreamBody(body) {
  return Boolean(body) && (typeof body.getReader === "function" || typeof body[Symbol.asyncIterator] === "function");
}

function chunks(list, size) {
  const out = [];
  for (let at = 0; at < list.length; at += size) out.push(list.slice(at, at + size));
  return out;
}

/** `worker` over `items`, at most `limit` at a time; results in input order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

/**
 * Wait until none of `ids` is PROCESSING — ONE `POST /assets/status` per tick for all of them (#233, ≤ 100 ids a call),
 * not one poll per asset (#525: twenty URLs ingesting for three ticks were sixty status calls) — then read each once.
 * @returns {Promise<Map<string, import("../index.js").Asset>>}
 */
async function waitAllReady(assets, ids, { intervalMs = 1500, timeoutMs = 120_000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(ids);
  for (;;) {
    let stuck = null;
    for (const batch of chunks([...pending], IDS_PER_STATUS)) {
      const seen = new Set();
      for (const item of await assets.status(batch, { signal })) {
        seen.add(item.id);
        if (item.status !== "PROCESSING") pending.delete(item.id);
        else stuck = item;
      }
      const missing = batch.find((id) => !seen.has(id));
      if (missing)
        throw new ImageStepError({
          status: 404,
          code: "asset_not_found",
          message: `Asset ${missing} was not found`,
          retryable: false,
          param: "id"
        });
    }
    if (!pending.size) break;
    if (Date.now() > deadline)
      throw new JobFailedError(
        stuck,
        pending.size === 1
          ? `Asset ${stuck.id} still ${stuck.status} after ${timeoutMs} ms`
          : `${pending.size} assets still PROCESSING after ${timeoutMs} ms`
      );
    await sleep(intervalMs, signal);
  }
  const read = await mapLimit(ids, 8, (id) => assets.get(id, { signal }));
  return new Map(ids.map((id, n) => [id, read[n]]));
}

/**
 * The upload flow behind {@link Assets#upload} and {@link Assets#uploadMany} (#525): stage a batch in one call per 500,
 * PUT the bytes `concurrency` at a time, finish the batch in one call, then wait for all of them with one status call per
 * tick. One result per input, in order — `{ name, asset }` or `{ name, error }`, the error an {@link ImageStepError}
 * that `upload` throws and `uploadMany` answers — so a file the service refuses costs only itself. `named` (`upload`'s
 * `name` / `mimeType`) applies to every input, so only `upload` passes it.
 */
async function uploadAll(assets, inputs, opts, named = {}) {
  const { concurrency = 4, signal } = opts;
  const results = [];
  for (const batch of chunks([].concat(inputs), FILES_PER_STAGE)) {
    const files = await mapLimit(batch, concurrency, (input) => describeUpload(input, named));
    const staged = (
      await assets.client.post(
        "/api/v1/assets/stage-upload",
        files.map((f) => ({ fileName: f.name, fileSize: f.size, sha1Hash: f.sha1Hash })),
        { signal }
      )
    ).data;
    const outcome = new Array(files.length);
    const toFinish = [];
    await mapLimit(files, concurrency, async (file, n) => {
      const stage = staged[n];
      if (stage.error) {
        const error = new ImageStepError({ status: 400, code: "invalid_param", message: stage.error, retryable: false, param: "file" });
        outcome[n] = { name: file.name, error };
        return;
      }
      // Same bytes already ingested (sha1 match) → reuse that asset unless the caller wants a fresh row. The presigned
      // slot is fresh and EMPTY either way, so anything that goes on to finish-upload must PUT first (the first release
      // skipped the PUT on `exists` and produced assets whose object did not exist — prod 2026-09-08).
      if (stage.exists && stage.existingAssetId && opts.reuseExisting !== false) {
        const existing = await assets.get(stage.existingAssetId, { signal }).catch(() => null);
        if (existing && existing.status === "DONE") {
          outcome[n] = { name: file.name, asset: existing };
          return;
        }
      }
      // `stage.contentType` and the byte length are BOTH signed into the presigned URL (#48), so this PUT has to echo
      // them exactly — the service derives the type from the file name. `mimeType` is only the fallback. It goes through
      // `send` like any request (#567): timed, and a network failure or a 429 / 5xx from storage sent again — the same
      // bytes to the same URL, so a second PUT cannot make a second object.
      const client = assets.client;
      const init = {
        method: "PUT",
        headers: { "Content-Type": stage.contentType || file.mimeType, "Content-Length": String(file.size) },
        body: uploadBody(file),
        ...(file.body ? {} : { duplex: "half" })
      };
      const timeoutMs = client.timeoutMs + Math.ceil(file.size / STORAGE_BYTES_PER_MS);
      try {
        await send(client, stage.url, init, { attempts: client.maxRetries + 1, timeoutMs, signal }, () => null);
      } catch (err) {
        if (!(err instanceof ImageStepError)) throw err;
        const message = `Upload to storage failed (${err.status})`;
        const error = new ImageStepError({ status: err.status, code: "internal_error", message, retryable: true, requestUrl: stage.url });
        outcome[n] = { name: file.name, error };
        return;
      }
      toFinish.push(n);
    });
    toFinish.sort((a, b) => a - b);
    if (toFinish.length) {
      const created = (
        await assets.client.post(
          "/api/v1/assets/finish-upload",
          // Which staged object, its name, the collection, the tags (#232, #334) and how long to keep it (#591): the service
          // knows the rest.
          toFinish.map((n) => ({
            objectId: staged[n].objectId,
            name: files[n].name,
            collection: opts.collection,
            tags: opts.tags,
            retentionDays: opts.retentionDays
          })),
          { signal }
        )
      ).data;
      toFinish.forEach((n, k) => (outcome[n] = { name: files[n].name, asset: created[k] }));
    }
    results.push(...outcome);
  }
  const made = results.filter((r) => r.asset?.status === "PROCESSING").map((r) => r.asset.id);
  if (opts.wait === false || !made.length) return results;
  const ready = await waitAllReady(assets, made, { signal });
  return results.map((r) => (r.asset && ready.has(r.asset.id) ? { name: r.name, asset: ready.get(r.asset.id) } : r));
}

/**
 * What {@link Assets#uploadMany} needs before staging — name, type, size and SHA-1 — without keeping the bytes of every
 * file in memory at once: a path is read to be hashed and read again to be sent, a Blob stays a Blob (the runtime
 * streams it), bytes stay the caller's.
 */
async function describeUpload(input, opts = {}) {
  if (typeof input === "string") {
    // A path is hashed as a stream and sent as a stream: its bytes are never whole in memory (#528).
    const { basename } = await import("node:path");
    const name = opts.name || basename(input);
    return { input, name, mimeType: opts.mimeType || mimeFromName(name), ...(await sha1OfPath(input)), body: null };
  }
  const { bytes, name, mimeType } = await toUploadable(input, opts);
  const body = typeof Blob !== "undefined" && input instanceof Blob ? input : bytes;
  return { input, name, mimeType, size: bytes.byteLength, sha1Hash: await sha1Hex(bytes), body };
}

/**
 * What the storage PUT of a described upload sends: the kept body, or the path's bytes read as fetch pulls them — made
 * afresh for each attempt, since the last one consumed its stream.
 */
function uploadBody(file) {
  return file.body || (() => readLazily(file.input));
}

/**
 * A path as a body that opens the file on fetch's first read, not before. A `createReadStream` opens at once, so a body
 * nobody reads — a fetch that failed before sending, a stubbed one — held a descriptor and, once the file was gone,
 * threw an ENOENT no one could catch (and `destroy()` does not stop the open already queued). Read, a missing file
 * rejects the fetch like any other body error.
 */
async function* readLazily(path) {
  const { createReadStream } = await import("node:fs");
  yield* createReadStream(path);
}

/** Normalise every accepted upload input to { bytes: Uint8Array, name, mimeType }. */
async function toUploadable(input, opts) {
  let bytes;
  let name = opts.name;
  let mimeType = opts.mimeType;
  if (typeof input === "string") {
    // A path — Node only. Dynamic import keeps the module edge-safe.
    const { readFile } = await import("node:fs/promises");
    const { basename } = await import("node:path");
    bytes = await readFile(input); // a Buffer is already a Uint8Array: no second copy (#528)
    name = name || basename(input);
  } else if (typeof Blob !== "undefined" && input instanceof Blob) {
    bytes = new Uint8Array(await input.arrayBuffer());
    name = name || input.name;
    mimeType = mimeType || input.type || undefined;
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new TypeError("upload() accepts a file path (Node), a Blob/File, an ArrayBuffer or a Uint8Array/Buffer");
  }
  name = name || "upload.bin";
  return { bytes, name, mimeType: mimeType || mimeFromName(name) };
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function query(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    q.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

/**
 * Walk a listing to its end, a row at a time (imagestep#437, #493).
 *
 * A page is 100 rows and the answer says whether there is another (`meta.hasMore`) and where it starts
 * (`meta.nextCursor`), so walking one is four lines — and four lines that every caller would write slightly
 * differently, one of them off by one. The first request is an ordinary one (`params.page` if you give it); every
 * later one sends the cursor back instead of a page number, so page 1 000 costs the service what page 1 did and
 * nothing is counted — a walk by page number re-reads every earlier row and re-counts the filter on every page.
 * `params.cursor` resumes a walk where an earlier one stopped.
 *
 * It yields rows, not pages: a caller that wanted pages already has `list()`.
 */
async function* walk(readPage, params = {}) {
  const { page, ...rest } = params;
  let next = params;
  for (;;) {
    const { items, meta } = await readPage(next);
    for (const item of items || []) yield item;
    if (!meta?.hasMore) return;
    // Never a silent stop halfway: a listing that says there is more must say where.
    if (!meta.nextCursor) throw new Error("the listing said hasMore but sent no meta.nextCursor");
    next = { ...rest, cursor: meta.nextCursor };
  }
}

/**
 * The run's products in the order its items name them (imagestep#441). The listing that produced them is ordered
 * newest-first, which for a batch is neither item order nor settle order; an item, though, knows its own output.
 * Rows no item names — a job whose items the caller did not fetch — keep the listing's order, after the rest.
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

/**
 * Can this body go on the wire a second time?
 *
 * A retry re-sends what it was given, so anything consumed by the first attempt — a
 * `ReadableStream`, an async iterable — must not get one: the second request would carry an empty
 * or truncated body and the server would answer about THAT, which is worse than the error being
 * retried. Bytes, a string and a Blob can all be read again.
 */
function isReplayable(body) {
  if (body === undefined || body === null || typeof body === "string") return true;
  if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) return true;
  return typeof Blob !== "undefined" && body instanceof Blob;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason || new Error("aborted"));
      },
      { once: true }
    );
  });
}

/**
 * `Retry-After` in seconds — 0 included, which HTTP reads as "now". Absent, blank or an HTTP-date is null, and the
 * backoff schedule decides.
 */
function retryAfterSeconds(value) {
  const seconds = value == null || value.trim() === "" ? NaN : Number(value);
  return seconds >= 0 ? seconds : null;
}

/** Who is calling: the key, when the client has one (the public reads need none), and the User-Agent. */
function identity(client) {
  return { ...(client.apiKey && { Authorization: `ApiKey ${client.apiKey}` }), "User-Agent": client.userAgent };
}

/** A non-2xx answer as the {@link ImageStepError} the contract's error envelope describes (§2). */
async function errorFrom(res, url) {
  const text = await res.text();
  const json = parseJson(text);
  const e = json?.error || {};
  return new ImageStepError({
    status: res.status,
    code: e.code,
    message: e.message || json?.message || text?.slice(0, 200) || res.statusText,
    retryable: e.retryable,
    param: e.param,
    details: e.details,
    retryAfter: retryAfterSeconds(res.headers.get("Retry-After")),
    requestUrl: url,
    requestId: e.requestId ?? res.headers.get("X-Request-Id")
  });
}

/**
 * The one transport every call uses — {@link ImageStep#request}, {@link ImageStep#requestBinary}, and the storage PUT
 * and download, which have no API envelope but the same need of a timeout and a retry (#567): up to `attempts` tries of
 * `init`, each with its own timeout, the caller's `signal` honoured throughout. A 2xx — or the 3xx of a `redirect:
 * "manual"` request, which asked to see it — is `read(res)`'s to answer. A failure below HTTP is tried again after
 * 250 ms, 500 ms, …; a `retryable` error answer after its `Retry-After`, else 500 ms, 1 s, …. The request is re-sent
 * unchanged, Idempotency-Key included; a body given as a function is made again for each attempt.
 */
async function send(client, url, init, { attempts, timeoutMs, signal }, read) {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    // The message names the request: a script that gave up on a hung call has to say which one.
    const timer = setTimeout(
      () => controller.abort(new Error(`ImageStep ${init.method} ${url} timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    let res;
    try {
      const body = typeof init.body === "function" ? init.body() : init.body;
      res = await client.fetch(url, { ...init, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (signal?.aborted || attempt >= attempts) throw err;
      await sleep(250 * 2 ** (attempt - 1), signal);
      continue;
    }
    clearTimeout(timer);
    if (res.ok || (init.redirect === "manual" && res.status >= 300 && res.status < 400)) return read(res);
    const error = await errorFrom(res, url);
    if (!error.retryable || attempt >= attempts) throw error;
    await sleep(error.retryAfter != null ? error.retryAfter * 1000 : 500 * 2 ** (attempt - 1), signal);
  }
}

/**
 * @typedef {object} ImageStepOptions
 * @property {string} [apiKey]      an API key from the console (`is_sk_…`). Without one no `Authorization` is sent:
 *                                  the public reads (`ops.list` / `ops.get`, `agent.guidelines`) work, and every other
 *                                  call is the service's own `401 unauthorized`
 * @property {string} [baseUrl]     defaults to https://api.imagestep.dev
 * @property {typeof fetch} [fetch] custom fetch (tests, proxies, a self-signed local certificate)
 * @property {number} [timeoutMs]   per-request timeout, default 60 s
 * @property {number} [maxRetries]  retries on `retryable` errors and network failures, default 2
 * @property {string} [userAgent]   replaces `imagestep-js/<version>` — a tool built on this package names itself
 */
export class ImageStep {
  /** @param {ImageStepOptions} options */
  constructor(options = {}) {
    this.apiKey = options.apiKey || null;
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.userAgent = options.userAgent || "imagestep-js/0.1.0";

    this.ops = new Ops(this);
    this.images = new Images(this);
    this.assets = new Assets(this);
    this.jobs = new Jobs(this);
    this.presets = new Presets(this);
    this.templates = new Templates(this);
    this.agent = new Agent(this);
    this.models = new Models(this);
    this.webhooks = new Webhooks(this);
    this.usage = new Usage(this);
  }

  /**
   * One HTTP call. Unwraps the `{success,data,error,meta}` envelope, turns an error body into an
   * ImageStepError, adds an Idempotency-Key to every write, and retries `retryable` failures.
   * @returns {Promise<{ data: any, meta?: any, replayed: boolean, headers: Headers }>}
   */
  async request(method, path, { body, headers = {}, idempotencyKey, signal, retries, timeoutMs = this.timeoutMs } = {}) {
    const h = { ...identity(this), Accept: "application/json", ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (method !== "GET" && method !== "HEAD") h["Idempotency-Key"] = idempotencyKey || crypto.randomUUID();
    const init = { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) };
    return send(this, `${this.baseUrl}${path}`, init, { attempts: (retries ?? this.maxRetries) + 1, timeoutMs, signal }, async (res) => {
      if (res.status === 204) return { data: null, replayed: false, headers: res.headers };
      const json = parseJson(await res.text());
      // Public endpoints answer bare JSON; everything under /api/v1 uses the envelope.
      const enveloped = json && typeof json === "object" && ("success" in json || "data" in json || "error" in json);
      return {
        data: enveloped ? json.data : json,
        meta: enveloped ? json.meta : undefined,
        replayed: res.headers.get("Idempotency-Replayed") === "true",
        headers: res.headers
      };
    });
  }

  /**
   * A call whose body and/or response are BYTES, not JSON — the synchronous image face
   * (`/api/v1/images/*`, contract §9). Separate from {@link request} on purpose rather than
   * bolted onto it: that one JSON-stringifies every body and parses every response, and three of
   * the four things this has to do (send a raw body, read a raw body, send no Idempotency-Key)
   * are exactly the opposite.
   *
   * No `Idempotency-Key`: the synchronous endpoints are the documented exception (contract §9).
   * They create nothing that survives the response, so there is no outcome to replay — and the
   * caller still holds the input, which is the premise the whole path rests on.
   *
   * **That same premise is why this retries** (#98). `rate_limited` and the three
   * `provider_unavailable` reasons are all `retryable`, they all carry `Retry-After`, and the input
   * is still in memory here — re-sending costs nothing and creates nothing. Not retrying made the
   * fastest path in the API the only one that gave up on the first 429.
   *
   * The exception is a body that can only be sent once: {@link isReplayable} is the whole rule, and
   * a stream gets a single attempt rather than a silently truncated second one.
   *
   * @returns {Promise<{ bytes: Uint8Array, contentType: string, headers: Headers }>}
   */
  async requestBinary(path, { body, contentType, accept = "*/*", signal, retries, timeoutMs = this.timeoutMs } = {}) {
    const headers = { ...identity(this), Accept: accept };
    if (contentType) headers["Content-Type"] = contentType;
    // A stream body is only readable once and Node's fetch refuses one without `duplex: "half"` (#528).
    const init = { method: "POST", headers, body, ...(isStreamBody(body) ? { duplex: "half" } : {}) };
    const attempts = isReplayable(body) ? (retries ?? this.maxRetries) + 1 : 1;
    return send(this, `${this.baseUrl}${path}`, init, { attempts, timeoutMs, signal }, async (res) => {
      const type = res.headers.get("Content-Type") || "application/octet-stream";
      if (!type.startsWith("application/json")) {
        return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: type, headers: res.headers };
      }
      // A JSON body on a 2xx means `?response=url` or the metadata endpoint.
      const json = parseJson(await res.text());
      return { json: json?.data ?? json, contentType: type, headers: res.headers };
    });
  }

  async get(path, opts) {
    return this.request("GET", path, opts);
  }
  async post(path, body, opts) {
    return this.request("POST", path, { ...opts, body });
  }
  async put(path, body, opts) {
    return this.request("PUT", path, { ...opts, body });
  }
  async del(path, opts) {
    return this.request("DELETE", path, opts);
  }
}

/** The atomic-op catalogue and the one-call way to run an op. */
/** The keys `POST /api/v1/images/transform` reads for itself; every other query key is an op parameter (contract §9). */
const TRANSFORM_QUERY_KEYS = ["op", "preset", "response"];

/**
 * The synchronous face: bytes in, bytes out, nothing stored (contract §9).
 *
 * <p>When to reach for this instead of {@link Ops}: you are holding an image and only want the
 * result back. When NOT to: AI ops, batches, or anything you want an `asset_id` for — those are
 * jobs, because a job is what pays for the retry, settlement and cancellation they need.
 */
class Images {
  constructor(client) {
    this.client = client;
    this._syncEndpoints = null;
  }

  /**
   * Which ops may run synchronously, straight from `GET /api/v1/ops`. Read, never hard-coded: a
   * deterministic op added to the catalogue is supported here without this file changing.
   * @returns {Promise<Record<string, string|null>>} op → syncEndpoint
   */
  async syncEndpoints() {
    if (!this._syncEndpoints) {
      const ops = await this.client.ops.list();
      this._syncEndpoints = Object.fromEntries(ops.map((o) => [o.op, o.syncEndpoint ?? null]));
    }
    return this._syncEndpoints;
  }

  /** True when `op` has a synchronous form. */
  async supports(op) {
    return Boolean((await this.syncEndpoints())[op]);
  }

  /**
   * Run one deterministic op, or a deterministic preset, on one image.
   *
   * The op's own parameters go in `input.parameters`, never beside `file` / `url` (#470): one flat bag meant a caller
   * spreading parameters it did not write — an agent's, a form's — could name a local file for this process to read.
   *
   * @param {string|null} op  an op name, or null when using `preset`
   * @param {object} input
   * @param {string|Uint8Array|ArrayBuffer|Blob|ReadableStream} [input.file] bytes, or a local path (Node)
   * @param {string} [input.url]      fetch the input from here
   * @param {string} [input.assetId]  use one of your own stored assets
   * @param {string} [input.preset]   a deterministic preset id or slug, instead of `op`
   * @param {"url"} [input.response]  return a signed URL instead of the bytes
   * @param {Record<string, string|number|boolean>} [input.parameters]  the op's parameters, e.g. `{ width: 1200 }`
   * @returns {Promise<Uint8Array|object>} the bytes, or `{url, contentType, bytes, …}` for response:"url"
   */
  async transform(op, input = {}) {
    const res = await this.transformResult(op, input);
    return res.json ?? res.bytes;
  }

  /**
   * {@link transform}, plus what the service said about the result: its `contentType` and the
   * width / height it measured (`X-ImageStep-Width` / `-Height`).
   *
   * `transform` answers the common question — "give me the bytes" — and throws the rest away, which
   * leaves anyone who has to NAME the result (pick a file extension, report the new size) deriving
   * it again from the bytes, or guessing (#95). The endpoint already says it; this hands it over.
   *
   * @returns {Promise<{ bytes?: Uint8Array, json?: object, contentType: string, width: number|null, height: number|null }>}
   */
  async transformResult(op, input = {}) {
    const { file, url, assetId, preset, response, signal, parameters = {}, ...stray } = input;
    if (Object.keys(stray).length) {
      throw new TypeError(
        `ImageStep: images.transform takes the op's parameters in \`parameters\` — got ${Object.keys(stray).join(", ")} beside them`
      );
    }
    // op / preset / response are the query string's own keys: a parameter by one of those names would replace it.
    const clash = Object.keys(parameters).find((k) => TRANSFORM_QUERY_KEYS.includes(k));
    if (clash) {
      throw new ImageStepError({
        status: 0,
        code: "invalid_param",
        message: `'${clash}' is not an op parameter`,
        retryable: false,
        param: `parameters.${clash}`
      });
    }
    if (op && !(await this.supports(op))) {
      throw new ImageStepError({
        status: 0,
        code: "invalid_param",
        message: `'${op}' has no synchronous form — submit it as a job with client.ops.run("${op}", …)`,
        retryable: false,
        param: "op"
      });
    }

    const query = new URLSearchParams();
    if (op) query.set("op", op);
    if (preset) query.set("preset", preset);
    if (response) query.set("response", response);
    for (const [k, v] of Object.entries(parameters)) {
      if (v !== undefined && v !== null) query.set(k, String(v));
    }

    // A reference goes in a JSON body; bytes go in the body raw.
    const sent = url || assetId ? { body: JSON.stringify({ url, assetId }), contentType: "application/json" } : await toBody(file);
    const res = await this.client.requestBinary(`/api/v1/images/transform?${query}`, { ...sent, signal });
    return {
      bytes: res.bytes,
      json: res.json,
      contentType: res.contentType,
      width: headerNumber(res.headers, "X-ImageStep-Width"),
      height: headerNumber(res.headers, "X-ImageStep-Height")
    };
  }

  /** One template row → one PNG. A batch is a job (`ops.run("render_template", {items})`). */
  async render(templateId, data = {}, { signal } = {}) {
    const res = await this.client.requestBinary("/api/v1/images/render", {
      body: JSON.stringify({ templateId, data }),
      contentType: "application/json",
      signal
    });
    return res.json ?? res.bytes;
  }

  /** EXIF, GPS, dimensions, format and SHA-1. Free, and it stores nothing. */
  async metadata(file, { signal } = {}) {
    const { body, contentType } = await toBody(file);
    const res = await this.client.requestBinary("/api/v1/images/metadata", {
      body,
      contentType,
      accept: "application/json",
      signal
    });
    return res.json;
  }
}

/** A measurement header, as a number — absent, blank and unparseable all mean "not measured". */
function headerNumber(headers, name) {
  const raw = headers?.get(name);
  const n = raw == null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Accepts what a caller is likely to be holding. A string is read as a file path, and `node:fs` is
 * imported lazily so this module still loads on an edge runtime that has no filesystem.
 */
async function toBody(file) {
  if (file === undefined || file === null) {
    throw new TypeError("ImageStep: give one of file, url or assetId");
  }
  if (typeof file === "string") {
    const { readFile } = await import("node:fs/promises");
    return { body: await readFile(file), contentType: contentTypeFor(file) };
  }
  return { body: file, contentType: undefined };
}

function contentTypeFor(path) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const known = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    gif: "image/gif",
    tiff: "image/tiff",
    tif: "image/tiff",
    heic: "image/heic",
    heif: "image/heif",
    bmp: "image/bmp",
    jxl: "image/jxl",
    jp2: "image/jp2",
    j2k: "image/jp2",
    psd: "image/vnd.adobe.photoshop",
    ico: "image/vnd.microsoft.icon"
  };
  return known[ext] || "application/octet-stream";
}

class Ops {
  constructor(client) {
    this.client = client;
  }

  /** @returns {Promise<import("../index.js").OpDefinition[]>} */
  async list() {
    return (await this.client.get("/api/v1/ops")).data;
  }

  /** @returns {Promise<import("../index.js").OpDefinition>} */
  async get(op) {
    return (await this.client.get(`/api/v1/ops/${encodeURIComponent(op)}`)).data;
  }

  /**
   * Submit an op as a job. `assetIds` may be one id or many; `wait: true` polls to completion
   * and resolves with the job (throws JobFailedError if it did not complete). Every output is a new asset: a job
   * never overwrites the one it read (imagestep#331).
   * @param {string} op
   * `imageCount` goes with `dryRun` only: images not stored yet, priced as that many more `assetIds` (imagestep#586).
   * @param {{ assetIds?: string|string[], prompt?: string, count?: number, model?: string, parameters?: object,
   *           collection?: string, retentionDays?: number, dryRun?: boolean, imageCount?: number, wait?: boolean|object,
   *           idempotencyKey?: string, signal?: AbortSignal }} [opts] `retentionDays` keeps the outputs (and the job's
   *           record) this many days instead of your plan's retention — shorter only (imagestep#591).
   */
  async run(op, opts = {}) {
    const { assetIds, dryRun, wait, idempotencyKey, signal, ...rest } = opts;
    const body = { op, ...rest };
    if (assetIds !== undefined) body.assetIds = Array.isArray(assetIds) ? assetIds : [assetIds];
    if (dryRun) return (await this.client.post("/api/v1/jobs?dryRun=true", body, { idempotencyKey, signal })).data;
    return this.client.jobs._submitAndWait(body, wait, { idempotencyKey, signal });
  }

  /** Price an op without creating anything. */
  async estimate(op, opts = {}) {
    return this.run(op, { ...opts, dryRun: true });
  }

  removeBg(assetIds, opts) {
    return this.run("remove_bg", { ...opts, assetIds });
  }
  upscale(assetIds, opts) {
    return this.run("upscale", { ...opts, assetIds });
  }
  restoreFace(assetIds, opts) {
    return this.run("restore_face", { ...opts, assetIds });
  }
  colorize(assetIds, opts) {
    return this.run("colorize", { ...opts, assetIds });
  }
  /** Structured JSON about each image: each job item's `output` (imagestep#338); the default answer's tags also join the asset's. */
  analyze(assetIds, opts) {
    return this.run("analyze", { ...opts, assetIds });
  }
  generate(prompt, opts) {
    return this.run("generate", { ...opts, prompt });
  }
  edit(assetIds, prompt, opts) {
    return this.run("edit", { ...opts, assetIds, prompt });
  }
  resize(assetIds, parameters, opts) {
    return this.run("resize", { ...opts, assetIds, parameters });
  }
  convert(assetIds, parameters, opts) {
    return this.run("convert", { ...opts, assetIds, parameters });
  }
  compress(assetIds, parameters, opts) {
    return this.run("compress", { ...opts, assetIds, parameters });
  }
  crop(assetIds, parameters, opts) {
    return this.run("crop", { ...opts, assetIds, parameters });
  }
  pad(assetIds, parameters, opts) {
    return this.run("pad", { ...opts, assetIds, parameters });
  }
  grayscale(assetIds, opts) {
    return this.run("grayscale", { ...opts, assetIds });
  }
  rotate(assetIds, parameters, opts) {
    return this.run("rotate", { ...opts, assetIds, parameters });
  }
  flip(assetIds, opts) {
    return this.run("flip", { ...opts, assetIds });
  }
  flop(assetIds, opts) {
    return this.run("flop", { ...opts, assetIds });
  }
  trim(assetIds, parameters, opts) {
    return this.run("trim", { ...opts, assetIds, parameters });
  }
  flatten(assetIds, parameters, opts) {
    return this.run("flatten", { ...opts, assetIds, parameters });
  }
  adjust(assetIds, parameters, opts) {
    return this.run("adjust", { ...opts, assetIds, parameters });
  }
  mask(assetIds, parameters, opts) {
    return this.run("mask", { ...opts, assetIds, parameters });
  }
  blurRegion(assetIds, parameters, opts) {
    return this.run("blur_region", { ...opts, assetIds, parameters });
  }
  overlay(assetIds, parameters, opts) {
    return this.run("overlay", { ...opts, assetIds, parameters });
  }
  caption(assetIds, parameters, opts) {
    return this.run("caption", { ...opts, assetIds, parameters });
  }

  /** `read_metadata` is synchronous: the asset already carries EXIF / GPS / dimensions / hash. */
  async readMetadata(assetId) {
    const asset = await this.client.assets.get(assetId);
    return { id: asset.id, name: asset.name, image: asset.image, metadata: asset.metadata, expiresAt: asset.expiresAt };
  }
}

class Assets {
  constructor(client) {
    this.client = client;
  }

  /**
   * Upload one file: stage (presigned PUT) → PUT the bytes → finish → (optionally) wait until the
   * ingest pipeline has written dimensions/metadata (status DONE).
   * @param {string|Blob|ArrayBuffer|Uint8Array} input file path (Node), Blob/File, or bytes
   * @param {{ name?: string, mimeType?: string, collection?: string, tags?: string[], retentionDays?: number, wait?: boolean, reuseExisting?: boolean, signal?: AbortSignal }} [opts]
   *   `reuseExisting` (default true): bytes ingested before come back as that asset instead of a new one, with its own tags.
   *   `retentionDays`: keep it this many days instead of your plan's retention — shorter only (imagestep#591).
   * @returns {Promise<import("../index.js").Asset>}
   */
  async upload(input, opts = {}) {
    const [result] = await uploadAll(this, [input], opts, opts);
    if (result.error) throw result.error;
    return result.asset;
  }

  /**
   * Ingest images by URL: the SERVICE fetches each one (imagestep#219), so nothing is downloaded here.
   * One result per URL, in order — `{ url, asset }` or `{ url, error }` — so one bad link costs only itself.
   * @param {string[]} urls public http(s) image URLs — any number: they go to the service twenty to a request (#525)
   * @param {{ collection?: string, tags?: string[], retentionDays?: number, wait?: boolean, signal?: AbortSignal }} [opts] `wait` (default true) polls the created
   *   assets until ingest is done — one status call per tick for all of them.
   * @returns {Promise<Array<{ url: string, asset?: import("../index.js").Asset, error?: { code: string, message: string, retryable: boolean, param?: string } }>>}
   */
  async fromUrl(urls, opts = {}) {
    // Twenty to a request (#525): the service refuses a longer list whole, so a caller with 21 got one 400 for all of them.
    const results = [];
    for (const batch of chunks([].concat(urls), URLS_PER_INGEST)) {
      const body = { urls: batch, collection: opts.collection, tags: opts.tags, retentionDays: opts.retentionDays };
      results.push(...(await this.client.post("/api/v1/assets/from-url", body, { signal: opts.signal })).data);
    }
    const created = results.filter((r) => !r.error).map((r) => r.id);
    const ready = opts.wait === false || !created.length ? null : await waitAllReady(this, created, { signal: opts.signal });
    return results.map((r) => (r.error ? { url: r.url, error: r.error } : { url: r.url, asset: ready ? ready.get(r.id) : r }));
  }

  /**
   * Upload many files at once (#525): stage them in one call per 500, PUT the bytes `concurrency` at a time, finish them
   * in one call per 500, then wait for all of them with one status call per tick. `upload()` in a loop was five round
   * trips and at least one 1.5 s poll per file, one file after another. One result per input, in order — `{ name, asset }`
   * or `{ name, error }` — so a file the service refuses costs only itself.
   * @param {Array<string|Blob|ArrayBuffer|Uint8Array>} inputs file paths (Node), Blobs/Files, or bytes
   * @param {{ concurrency?: number, collection?: string, tags?: string[], retentionDays?: number, wait?: boolean, reuseExisting?: boolean, signal?: AbortSignal }} [opts]
   * @returns {Promise<Array<{ name: string, asset?: import("../index.js").Asset, error?: { code: string, message: string, retryable: boolean, param?: string } }>>}
   */
  async uploadMany(inputs, opts = {}) {
    return (await uploadAll(this, inputs, opts)).map(({ name, asset, error }) => {
      if (!error) return { name, asset };
      const { code, message, retryable, param } = error;
      return { name, error: { code, message, retryable, ...(param ? { param } : {}) } };
    });
  }

  /**
   * Poll until the asset leaves PROCESSING — one batch-status call per tick (#233), then one read of the whole
   * asset. The per-asset `GET` poll this replaced wrote an audit row per asset per tick.
   */
  async waitReady(id, { intervalMs = 1500, timeoutMs = 120_000, signal } = {}) {
    return (await waitAllReady(this, [id], { intervalMs, timeoutMs, signal })).get(id);
  }

  /**
   * Ingest state of up to 100 of your assets in one call (#233): `{ id, status, width?, height? }` in request
   * order; ids that are not yours are absent. Nothing is signed and no audit row is written.
   * @param {string|string[]} ids
   */
  async status(ids, { signal } = {}) {
    return (await this.client.post("/api/v1/assets/status", { ids: [].concat(ids) }, { signal })).data.items;
  }

  /**
   * The asset's private bytes (#233). `GET /assets/{id}/content` answers a redirect to a short-lived signed URL;
   * the redirect is followed here, WITHOUT the API key — the URL carries its own signature, and storage has no
   * business seeing the key. `variant` is readable (default: full size, in a type a browser shows),
   * original (the bytes as uploaded or produced) or preview (a 400 px wide WebP). Node (and other runtimes whose fetch
   * exposes a manual redirect) only: a browser hides the Location of a manual redirect. Both legs are timed and retried
   * like any request (#567).
   * @returns {Promise<{ bytes: Uint8Array, contentType: string }>}
   */
  async download(id, { variant = "readable", signal } = {}) {
    const client = this.client;
    const url = `${client.baseUrl}/api/v1/assets/${encodeURIComponent(id)}/content${query({ variant })}`;
    const opts = { attempts: client.maxRetries + 1, timeoutMs: client.timeoutMs, signal };
    const init = { method: "GET", headers: { ...identity(client), Accept: "application/json" }, redirect: "manual" };
    const location = await send(client, url, init, opts, async (res) => {
      const to = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && to) return to;
      throw new ImageStepError({ status: res.status, message: `content answered ${res.status} without a redirect`, requestUrl: url });
    });
    try {
      return await send(client, location, { method: "GET" }, opts, async (file) => ({
        bytes: new Uint8Array(await file.arrayBuffer()),
        contentType: file.headers.get("Content-Type") || "application/octet-stream"
      }));
    } catch (err) {
      if (!(err instanceof ImageStepError)) throw err;
      const message = `Download from storage failed (${err.status})`;
      throw new ImageStepError({ status: err.status, code: "internal_error", message, retryable: true, requestUrl: location });
    }
  }

  async get(id, opts) {
    return (await this.client.get(`/api/v1/assets/${encodeURIComponent(id)}`, opts)).data;
  }

  /**
   * Every filter is optional and they compose. `q` is free text over the name and camera make/model;
   * `source` is the originating operation (upload · process · ai-generate · ai-edit · render).
   * @param {{ page?: number, perPage?: number, cursor?: string, collection?: string, tag?: string, mime?: string,
   *           q?: string,
   *           source?: string, view?: "ALL"|"PUBLISHED", minWidth?: number, maxWidth?: number,
   *           minHeight?: number, maxHeight?: number, takenFrom?: number|string, takenTo?: number|string,
   *           createdFrom?: number|string, createdTo?: number|string,
   *           status?: "PROCESSING"|"DONE"|"FAILED", includeIntermediate?: boolean, hasCollection?: boolean,
   *           jobId?: string, op?: string }} [params]
   *   `takenFrom` / `takenTo` (the EXIF capture date) and `createdFrom` / `createdTo` (when this service made the
   *   asset) take epoch millis or an ISO-8601 date read in UTC, and a bare date as an upper bound covers the whole
   *   of that day; `status` is the ingest state —
   *   `FAILED` is an upload whose ingest never finished; `includeIntermediate` shows a chain's scratch
   *   images, which are out of the library by default (imagestep#246); `hasCollection: false` is everything you have
   *   not filed, and cannot be combined with `collection`; `jobId` and `op` are what one run, or one op, produced
   *   (imagestep#430) — an upload has neither and never matches.
   * @returns {Promise<{ items: import("../index.js").AssetSummary[], meta: import("../index.js").PageMeta }>} list rows
   *   (imagestep#339) — `get(id)` has the image facts, metadata and lineage.
   */
  async list(params = {}) {
    const { data, meta } = await this.client.get(`/api/v1/assets${query(params)}`);
    return { items: data, meta };
  }

  /**
   * Every asset the filters match, a row at a time, paging as it goes (imagestep#437):
   * `for await (const asset of client.assets.iterate({ collection: "shoot-01" })) …`.
   * Same parameters as {@link list}; `page` or `cursor` is where to start.
   */
  iterate(params = {}) {
    return walk((p) => this.list(p), params);
  }

  /**
   * Your collections, most recently added to first, each with how many assets are in it (imagestep#349). `q` narrows
   * to names containing it, case-insensitively. A misspelt collection is simply a new one — this is how to check.
   * @param {{ q?: string, page?: number, perPage?: number, cursor?: string }} [params]
   */
  async collections(params = {}) {
    const { data, meta } = await this.client.get(`/api/v1/assets/collections${query(params)}`);
    return { items: data, meta };
  }

  /** Every collection, one at a time, paging as it goes (imagestep#437). Same parameters as {@link collections}. */
  iterateCollections(params = {}) {
    return walk((p) => this.collections(p), params);
  }

  /** Move every asset in collection `from` to `to` — a rename, a merge, or with `to: ""` taking them out (imagestep#349). */
  async renameCollection(from, to, opts = {}) {
    return (await this.client.post("/api/v1/assets/collections/rename", { from, to: to ?? "" }, opts)).data;
  }

  /** Publish → the asset gets a stable `publicUrl` on the CDN: the asset itself at full size, not a thumbnail. */
  async publish(ids, published = true) {
    return (await this.client.post("/api/v1/assets/update", { ids: [].concat(ids), published })).data;
  }
  unpublish(ids) {
    return this.publish(ids, false);
  }

  /** Put assets in a collection; `null` or `""` takes them out of theirs (imagestep#348). */
  async setCollection(ids, collection) {
    return (await this.client.post("/api/v1/assets/update", { ids: [].concat(ids), collection: collection ?? "" })).data;
  }

  /** Replace the tags on assets (`[]` clears them); `list({ tag })` finds them again (imagestep#334). */
  async tag(ids, tags) {
    return (await this.client.post("/api/v1/assets/update", { ids: [].concat(ids), tags: [].concat(tags) })).data;
  }

  async delete(ids) {
    const list = [].concat(ids);
    if (list.length === 1) {
      await this.client.del(`/api/v1/assets/${encodeURIComponent(list[0])}`);
      return { deleted: 1 };
    }
    return (await this.client.post("/api/v1/assets/delete", { ids: list })).data;
  }
}

/**
 * What this key has spent (contract §11, imagestep#125). Credits charged, jobs created and items
 * settled over a window, grouped by `op`, `key` or `day` — the shape a budget is held against, which
 * the credit ledger is not.
 */
class Usage {
  constructor(client) {
    this.client = client;
  }

  /**
   * @param {{ from?: string, to?: string, groupBy?: "op"|"key"|"day" }} [params]
   *        `from`/`to` are `YYYY-MM-DD` or ISO-8601 instants; the window defaults to the last 30 days.
   */
  async get(params = {}) {
    return (await this.client.get(`/api/v1/usage${query(params)}`)).data;
  }
}

class Jobs {
  constructor(client) {
    this.client = client;
  }

  /**
   * Submit a raw job request (`type` + `presetId` …) — `ops.run()` is the usual entry point. `wait` (`true`, or the
   * options of {@link wait}) holds on for the result the way `ops.run` does: the first leg rides on the submit itself.
   */
  async submit(request, { wait, ...opts } = {}) {
    if (wait) return this._submitAndWait(request, wait, opts);
    return (await this.client.post("/api/v1/jobs", request, opts)).data;
  }
  async estimate(request, opts) {
    return (await this.client.post("/api/v1/jobs?dryRun=true", request, opts)).data;
  }
  /**
   * One job. `wait` (seconds, at most 60) long-polls: the service holds the response until the job is terminal or the
   * window closes, and answers with the job as it stands either way.
   */
  async get(id, { wait, ...opts } = {}) {
    const seconds = wait ? Math.max(1, Math.min(MAX_SERVER_WAIT_SECONDS, Math.ceil(wait))) : 0;
    const path = `/api/v1/jobs/${encodeURIComponent(id)}${seconds ? `?wait=${seconds}` : ""}`;
    // The request has to outlive the window it asked for, or the client's own timeout is what ends the wait.
    const timeoutMs = seconds ? Math.max(this.client.timeoutMs, seconds * 1000 + WAIT_GRACE_MS) : this.client.timeoutMs;
    return (await this.client.get(path, { ...opts, timeoutMs })).data;
  }

  /**
   * One page of a job's items (imagestep#440). A job document carries the first 100 inline and sets
   * `itemsTruncated` when there are more; this is how to read the rest, and `{ status: "FAILED" }` is how to read
   * just the ones a resume would run again. Each row carries the `index` the rest of the API names it by.
   * @param {string} id
   * @param {{ page?: number, perPage?: number, cursor?: string, status?: string }} [params]
   */
  async items(id, params = {}) {
    const { data, meta } = await this.client.get(`/api/v1/jobs/${encodeURIComponent(id)}/items${query(params)}`);
    return { items: data, meta };
  }

  /** Every item of a job, one at a time, paging as it goes (imagestep#437). Same parameters as {@link items}. */
  iterateItems(id, params = {}) {
    return walk((p) => this.items(id, p), params);
  }

  /**
   * Submit, and — when `wait` is given — hold on for the result. The first leg of the wait rides on the submit itself
   * (`wait` in the body: a job of one item that settles inside the window comes back finished, in one round trip); what
   * is left is {@link wait}. `ops.run` and `presets.run` both end here.
   */
  async _submitAndWait(body, wait, { idempotencyKey, signal } = {}) {
    if (!wait) return (await this.client.post("/api/v1/jobs", body, { idempotencyKey, signal })).data;
    const opts = typeof wait === "object" ? wait : {};
    const seconds = serverWaitSeconds(wait);
    const started = Date.now();
    const { data } = await this.client.post(
      "/api/v1/jobs",
      { ...body, wait: seconds },
      { idempotencyKey, signal, timeoutMs: Math.max(this.client.timeoutMs, seconds * 1000 + WAIT_GRACE_MS) }
    );
    const timeoutMs = opts.timeoutMs === undefined ? undefined : Math.max(0, opts.timeoutMs - (Date.now() - started));
    return this.wait(data.id, { ...opts, ...(timeoutMs === undefined ? {} : { timeoutMs }), signal }, data);
  }
  /**
   * Your jobs, newest first. Every filter is optional and they compose: `status`, `type`, `op` (what it was
   * submitted as), `preset` (a slug or id for every version, `slug@version` for the pinned one), `rootJobId`
   * (every attempt of one logical job) and the `createdFrom` / `createdTo` window — epoch millis or an ISO-8601
   * date read as UTC, a bare date as an upper bound covering the whole of that day (imagestep#442). `cursor` is the
   * previous page's `meta.nextCursor` (imagestep#493) — what {@link iterate} follows, so jobs you submit while it
   * walks cannot shift the pages under it.
   * @param {{ page?: number, perPage?: number, cursor?: string, status?: string, type?: string, op?: string,
   *           preset?: string, rootJobId?: string, createdFrom?: number|string, createdTo?: number|string }} [params]
   */
  async list(params = {}) {
    const { data, meta } = await this.client.get(`/api/v1/jobs${query(params)}`);
    return { items: data, meta };
  }

  /** Every job the filters match, a row at a time, paging as it goes (imagestep#437). Same parameters as {@link list}. */
  iterate(params = {}) {
    return walk((p) => this.list(p), params);
  }
  async cancel(id) {
    return (await this.client.post(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`)).data;
  }
  async resume(id) {
    return (await this.client.post(`/api/v1/jobs/${encodeURIComponent(id)}/resume`)).data;
  }

  /**
   * Wait until the job is terminal. The service does the waiting (imagestep#355): each read is
   * `GET /jobs/{id}?wait=<up to 60 s>`, which answers the moment the job settles, so there is no polling interval to tune
   * and a five-second job costs one request, not three. Prefer a webhook (`job.completed`) for anything long-running.
   *
   * `intervalMs` is only a floor between reads, for a service that answers early — an older one ignores `wait`. A read
   * turned away for now — `429 rate_limited` when the account already holds its share of open waits (contract §5.1),
   * a 503 — is asked again after its `Retry-After` (else `intervalMs`) for as long as the wait has left, once `request`
   * has spent its own retries on it; anything not `retryable` ends the wait.
   * @param {string} id
   * @param {{ intervalMs?: number, timeoutMs?: number, onProgress?: (job: object) => void, signal?: AbortSignal,
   *           throwOnFailure?: boolean }} [opts]
   * @param {object} [known] the job as a submit just returned it, so a job that is already terminal costs no read at all
   */
  async wait(id, { intervalMs = 1000, timeoutMs = 10 * 60_000, onProgress, signal, throwOnFailure = true } = {}, known) {
    const deadline = Date.now() + timeoutMs;
    let job = known;
    for (;;) {
      const asked = Date.now();
      if (!job) {
        try {
          job = await this.get(id, { signal, wait: Math.max(1, Math.ceil((deadline - asked) / 1000)) });
        } catch (error) {
          if (!error.retryable || signal?.aborted || Date.now() >= deadline) throw error;
          const pause = error.retryAfter != null ? error.retryAfter * 1000 : intervalMs;
          await sleep(Math.min(pause, Math.max(0, deadline - Date.now())), signal);
          continue;
        }
      }
      onProgress?.(job);
      if (TERMINAL.has(job.status)) {
        if (throwOnFailure && job.status !== "COMPLETED") throw new JobFailedError(job);
        return job;
      }
      if (Date.now() >= deadline) throw new JobFailedError(job, `Job ${id} still ${job.status} after ${timeoutMs} ms`);
      const elapsed = Date.now() - asked;
      if (!known && elapsed < intervalMs) await sleep(Math.min(intervalMs - elapsed, Math.max(0, deadline - Date.now())), signal);
      job = null;
      known = undefined;
    }
  }

  /**
   * What a finished job produced, as list rows — ONE paged listing of the run (imagestep#441), not one GET per item.
   *
   * `GET /assets?jobId=` is the same set by construction (imagestep#430): a chain's scratch images are out of it,
   * and an output the caller has since deleted is simply absent instead of failing the whole call with a 404. A
   * 500-item render used to be 500 requests — unbounded in flight, 500 of the account's rate-limit budget — and is
   * five. Rows are {@link AssetSummary}; `assets.get(id)` still has the image facts, metadata and lineage.
   *
   * In item order when the job document names them, which is what `submit` / `get` / `wait` all answer with;
   * anything they do not name keeps the listing's own order (newest first).
   */
  async outputs(job) {
    const jobId = typeof job === "string" ? job : job?.id;
    const rows = [];
    for await (const asset of this.client.assets.iterate({ jobId })) rows.push(asset);
    return inItemOrder(rows, typeof job === "string" ? null : job);
  }
}

/**
 * The agent contract face (imagestep#127): the rules, and somewhere to say what is missing.
 *
 * It is on the client rather than left to a raw fetch because §7 of the contract asks an agent to
 * report a gap instead of routing around it, and a rule whose only implementation is "construct
 * your own HTTP request" is a rule that loses to the workaround every time.
 */
class Agent {
  constructor(client) {
    this.client = client;
  }

  /**
   * The operating contract: how to discover ops, price a batch, decide on a retry, keep a batch
   * consistent, and what to do when ImageStep cannot do the thing. Public — no key is needed to
   * read it, and this call works before one exists.
   * @returns {Promise<{ version: number, updated: string, markdown: string }>}
   */
  async guidelines() {
    return (await this.client.get("/api/v1/agent-guidelines")).data;
  }

  /**
   * Report something ImageStep could not do. Free: no credit, no job.
   * @param {{ kind: "capability_gap"|"bug"|"other", message: string, op?: string, context?: object,
   *           idempotencyKey?: string, signal?: AbortSignal }} report
   */
  async feedback({ idempotencyKey, signal, ...report }) {
    return (await this.client.post("/api/v1/feedback", report, { idempotencyKey, signal })).data;
  }

  /** What this account has reported, newest first. */
  async reports({ page, perPage, cursor } = {}) {
    const { data, meta } = await this.client.get(`/api/v1/feedback${query({ page, perPage, cursor })}`);
    return { items: data, meta };
  }

  /** Every report this account has filed, one at a time, paging as it goes (imagestep#437). */
  iterateReports(params = {}) {
    return walk((p) => this.reports(p), params);
  }
}

class Presets {
  constructor(client) {
    this.client = client;
  }
  /**
   * The presets on this account, built-ins first. Each row is the current version — what it runs now and its `usage`;
   * `versions` is left off and `versionCount` says how many there are (imagestep#444). `includeVersions: true` brings
   * the history back, which is the export shape `import` takes; one preset's history is `get` and costs less.
   */
  async list(filter, { includeVersions } = {}) {
    return (await this.client.get(`/api/v1/presets${query({ filter, includeVersions })}`)).data;
  }
  /** One preset in the export shape: its current steps and subjects, and every superseded version. */
  async get(slug) {
    return (await this.client.get(`/api/v1/presets/${encodeURIComponent(slug)}`)).data;
  }
  /** Saves version 1. With `idempotencyKey`, a retried call returns the preset the first one saved (contract §3). */
  async create(preset, { idempotencyKey, signal } = {}) {
    return (await this.client.post("/api/v1/presets", preset, { idempotencyKey, signal })).data;
  }
  /** Only what changes: the service merges the body over the current preset. New steps or subjects are a new version. */
  async update(slug, preset) {
    return (await this.client.put(`/api/v1/presets/${encodeURIComponent(slug)}`, preset)).data;
  }
  async delete(slug) {
    await this.client.del(`/api/v1/presets/${encodeURIComponent(slug)}`);
  }
  /**
   * Drops one superseded version (imagestep#445). `slug@version` is `404 preset_not_found` afterwards and stays that
   * way — the numbering never reissues it — so this is for versions nothing pins. It is also the way past the version
   * ceiling: at 50 on record an `update` that would save another is `422 resource_limit_exceeded`, and deleting one
   * makes room. The current version cannot be deleted (`400 invalid_param`).
   */
  async deleteVersion(slug, version) {
    await this.client.del(`/api/v1/presets/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}`);
  }
  async import(presets) {
    return (await this.client.post("/api/v1/presets/import", presets)).data;
  }

  /**
   * Run a saved preset over assets as a job. `presetId` is a slug or id, or `slug@version` to pin one version; the
   * preset decides the job type (imagestep#245). `collection` is where the outputs go (default: each input's).
   * `prompt` replaces the prompt of the preset's one AI step for this run — a new scene for the same subjects, which
   * it names as `{{subject.<name>}}` — and `count` is how many images a preset that starts from a prompt makes
   * (default 1; pass `[]` as `assetIds`). A preset with several steps, or no AI step, refuses `prompt` (imagestep#461).
   * `imageCount` goes with `dryRun`: images not stored yet, priced as that many more `assetIds` (imagestep#586).
   */
  async run(presetId, assetIds, opts = {}) {
    const { wait, dryRun, signal, idempotencyKey, collection, prompt, count, imageCount, retentionDays } = opts;
    const body = { presetId, assetIds: [].concat(assetIds) };
    if (collection !== undefined) body.collection = collection;
    if (retentionDays !== undefined) body.retentionDays = retentionDays;
    if (prompt !== undefined) body.prompt = prompt;
    if (count !== undefined) body.count = count;
    if (imageCount !== undefined) body.imageCount = imageCount;
    if (dryRun) return (await this.client.post("/api/v1/jobs?dryRun=true", body, { signal, idempotencyKey })).data;
    return this.client.jobs._submitAndWait(body, wait, { idempotencyKey, signal });
  }
}

/**
 * Render templates (imagestep#24): HTML/CSS with `{{ var }}` placeholders that `images.render(templateId, data)` and the
 * `render_template` op turn into PNGs (#234 — the SDK could render one and not make one). Versioned: `update` never
 * edits in place, it saves `version + 1` and keeps the previous one readable as `{id}@{version}`, the spelling
 * `render` accepts to pin a version.
 */
class Templates {
  constructor(client) {
    this.client = client;
  }
  /**
   * One page of templates, built-ins first, then yours; `filter` is "builtin" or "user". Rows carry no `html` / `css`
   * (imagestep#497) — `get(id)` returns the whole document, which is also what `import` takes back.
   * @param {string} [filter]
   * @param {{ page?: number, perPage?: number, cursor?: string }} [params]
   */
  async list(filter, params = {}) {
    const { data, meta } = await this.client.get(`/api/v1/templates${query({ filter, ...params })}`);
    return { items: data, meta };
  }
  /** Every template, a row at a time, paging as it goes. Same `filter` as {@link list}. */
  iterate(filter) {
    return walk((p) => this.list(filter, p), {});
  }
  /** `id` is a template id, your own slug, or `id@version` for one frozen version. */
  async get(id) {
    return (await this.client.get(`/api/v1/templates/${encodeURIComponent(id)}`)).data;
  }
  /** Every version ever saved, newest first. */
  async versions(id) {
    return (await this.client.get(`/api/v1/templates/${encodeURIComponent(id)}/versions`)).data;
  }
  /** Creates version 1 from `{ name, html, css?, width, height, variables? }`. */
  async create(template) {
    return (await this.client.post("/api/v1/templates", template)).data;
  }
  /**
   * Saves a new version from only what changes — the service merges the body over the current one, so
   * `update(id, { width: 1080 })` is a whole call. The previous version stays readable (and renderable) as `{id}@{version}`.
   */
  async update(id, template) {
    return (await this.client.put(`/api/v1/templates/${encodeURIComponent(id)}`, template)).data;
  }
  /** Deletes the template and every version of it. */
  async delete(id) {
    await this.client.del(`/api/v1/templates/${encodeURIComponent(id)}`);
  }
  /** Takes template documents — what `get(id)` returns — and creates each as version 1; per-entry errors are reported, not thrown. */
  async import(templates) {
    return (await this.client.post("/api/v1/templates/import", templates)).data;
  }
}

/** The model catalogue with prices: `mode` is "ai_image" (the default) or "analyze". */
class Models {
  constructor(client) {
    this.client = client;
  }
  async list(mode = "ai_image") {
    return (await this.client.get(`/api/v1/ai-models${query({ mode })}`)).data;
  }
}

class Webhooks {
  constructor(client) {
    this.client = client;
  }
  async list() {
    return (await this.client.get("/api/v1/webhook-endpoints")).data;
  }
  async get(id) {
    return (await this.client.get(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}`)).data;
  }
  /** The `secret` in the response is shown once. */
  async create({ url, events, description, enabled }) {
    return (await this.client.post("/api/v1/webhook-endpoints", { url, events, description, enabled })).data;
  }
  async update(id, patch) {
    return (await this.client.put(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}`, patch)).data;
  }
  async delete(id) {
    await this.client.del(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}`);
  }
  async rotateSecret(id) {
    return (await this.client.post(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}/rotate-secret`)).data;
  }
  async test(id) {
    return (await this.client.post(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}/test`)).data;
  }
  async deliveries(id, params) {
    const { data, meta } = await this.client.get(`/api/v1/webhook-endpoints/${encodeURIComponent(id)}/deliveries${query(params)}`);
    return { items: data, meta };
  }

  /** Every delivery to one endpoint, newest first, one at a time, paging as it goes (imagestep#437). */
  iterateDeliveries(id, params = {}) {
    return walk((p) => this.deliveries(id, p), params);
  }
  verify(rawBody, header, secret, opts) {
    return verifyWebhookSignature(rawBody, header, secret, opts);
  }
  constructEvent(rawBody, header, secret, opts) {
    return constructWebhookEvent(rawBody, header, secret, opts);
  }
}

export default ImageStep;
