"use strict";

const { NodeConnectionTypes, NodeOperationError } = require("n8n-workflow");
const api = require("../../lib/api");
const { assetRef, jobRef, buildOpJobBody, buildPresetJobBody, normaliseIds, parseParameters } = require("../../lib/refs");
const { STATIC_OPS, toOpOptions } = require("../../lib/ops");
const { properties } = require("./description");

const MAIN = (NodeConnectionTypes && NodeConnectionTypes.Main) || "main";

/**
 * How many input items run at once (#523): the synchronous lane's per-account ceiling (`api.sync.max-concurrent-per-account`
 * in the service's application.yml, 4 — the CLI `image` group's default too), so a node of 100 resizes uses the lane
 * the account has instead of a quarter of it. Only a synchronous op actually runs four-wide: every other item — a job,
 * an upload, a preset — takes {@link serialLane} one at a time, because a job item holds one of the account's few open
 * waits (contract §5.1) for up to its Wait Seconds, and a job is already where the service does the batching.
 */
const ITEM_CONCURRENCY = 4;

/** Thrown for an item that was still queued when another item failed the node: it never ran, so it has no row. */
const NOT_STARTED = Symbol("not started");

/**
 * ImageStep — the image step for your automations. One node: Asset (upload · get · list ·
 * publish), Operation (run one atomic op), Preset (run a saved pipeline), Job (get · wait).
 * Talks to the public REST API only (the `api-key-accessible` group), through n8n's own HTTP
 * helpers; outputs are references (`assetRef` / `jobRef`) with an optional binary download.
 */
class ImageStep {
  constructor() {
    this.description = {
      displayName: "ImageStep",
      name: "imageStep",
      icon: "file:imagestep.svg",
      group: ["transform"],
      version: 1,
      subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
      description: "Generate, edit, remove background, upscale, resize and convert images — the image step for your automations",
      defaults: { name: "ImageStep" },
      inputs: [MAIN],
      outputs: [MAIN],
      usableAsTool: true,
      credentials: [{ name: api.CREDENTIAL, required: true }],
      properties
    };

    this.methods = {
      loadOptions: {
        /** Live op catalogue (`GET /api/v1/ops`), static list when the request fails. */
        async getOps() {
          try {
            const options = toOpOptions(await api.listOps(this));
            return options.length ? options : toOpOptions(STATIC_OPS);
          } catch {
            return toOpOptions(STATIC_OPS);
          }
        },
        /** Built-in presets first, then the account's own; value = id, label = slug. */
        async getPresets() {
          const presets = await api.listPresets(this);
          return presets.map((p) => ({
            name: p.slug || p.name || p.id,
            value: p.id,
            description: [p.builtIn ? "built-in" : "yours", p.description].filter(Boolean).join(" · ")
          }));
        }
      }
    };
  }

  async execute() {
    const items = this.getInputData();
    const resource = this.getNodeParameter("resource", 0);
    const operation = this.getNodeParameter("operation", 0);
    // Per execution, not per item (#523): the op catalogue is read at most once — it was one `GET /api/v1/ops` per item.
    let catalogue;
    const lanes = {
      syncEndpoints: () => (catalogue ??= api.syncEndpoints(this)),
      serial: serialLane(),
      // Set by the failing item itself, before its turn on the serial lane passes to the next one.
      halted: false
    };
    const results = new Array(items.length);
    let failure = null;
    let next = 0;

    // A pool of ITEM_CONCURRENCY workers over the items; the output keeps item order and each row's pairedItem.
    const worker = async () => {
      while (!failure && !lanes.halted && next < items.length) {
        const i = next++;
        try {
          results[i] = (await runOne(this, resource, operation, i, lanes)).map((item) => ({ ...item, pairedItem: { item: i } }));
        } catch (error) {
          if (error === NOT_STARTED) continue;
          if (this.continueOnFail()) {
            // Wait Seconds ran out (#570): the job is still running, so the row is its handle, flagged `timedOut` — the
            // field to branch on before Job → Wait — rather than an error row that reads like a failed job.
            const handle = error.timedOut && error.job ? { ...jobRef(error.job), timedOut: true } : {};
            results[i] = [
              {
                json: {
                  ...handle,
                  error: error.message,
                  code: error.timedOut ? null : error.code || "internal_error",
                  param: error.param ?? null,
                  retryable: error.retryable ?? false
                },
                pairedItem: { item: i }
              }
            ];
            continue;
          }
          if (error.itemIndex === undefined) error.itemIndex = i;
          // No new item starts after a failure; of the items already running, the first one to fail is reported.
          if (!failure || error.itemIndex < failure.itemIndex) failure = error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, items.length) }, worker));
    if (failure) throw failure;
    return [results.flat().filter(Boolean)];
  }
}

/** A one-at-a-time queue: `run(fn)` starts `fn` once every earlier `fn` has settled, in call order. */
function serialLane() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** One input item → zero or more output items ({ json, binary? }). A synchronous op runs as is; the rest queue. */
async function runOne(ctx, resource, operation, i, lanes) {
  if (
    resource === "op" &&
    operation === "run" &&
    !ctx.getNodeParameter("storeResult", i, false) &&
    !ctx.getNodeParameter("dryRun", i, false)
  ) {
    // Store Result off (the default) means: transform the binary we were handed and give the result straight back. No
    // asset, no publish, no polling — and, crucially, nothing of the customer's is made world-readable just so the
    // workflow can read its own output, which is what the job path had to do (publish → fetch from the CDN).
    const sync = await runSyncOp(ctx, i, ctx.getNodeParameter("op", i), lanes);
    if (sync) return sync;
  }
  return lanes.serial(async () => {
    if (lanes.halted) throw NOT_STARTED; // an earlier item failed the node while this one waited its turn
    try {
      return await runQueued(ctx, resource, operation, i);
    } catch (error) {
      if (!ctx.continueOnFail()) lanes.halted = true;
      throw error;
    }
  });
}

/** Everything that is not a synchronous op: uploads, jobs, presets, reads. */
async function runQueued(ctx, resource, operation, i) {
  const p = (name, fallback) => ctx.getNodeParameter(name, i, fallback);

  if (resource === "asset") {
    if (operation === "upload") {
      const asset = await api.uploadBinary(ctx, i, p("binaryProperty", "data"), {
        collection: p("collection", ""),
        retentionDays: p("retentionDays", 0),
        wait: p("waitForReady", true)
      });
      return [{ json: assetRef(asset) }];
    }
    if (operation === "uploadFromUrl") {
      const urls = String(p("urls", ""))
        .split(/[\s,]+/)
        .map((u) => u.trim())
        .filter(Boolean);
      const results = await api.uploadFromUrls(ctx, urls, {
        collection: p("collection", ""),
        retentionDays: p("retentionDays", 0),
        wait: p("waitForReady", true),
        itemIndex: i
      });
      // One output item per URL, a failed one included: a workflow routes the misses instead of stopping on them.
      return results.map((r) => ({ json: r.error ? { url: r.url, error: r.error } : { url: r.url, ...assetRef(r.asset) } }));
    }
    if (operation === "get") return [{ json: assetRef(await api.getAsset(ctx, p("assetId"))) }];
    // A cursor (the nextCursor of an earlier List, #493) says where the page starts, so the Page field is not sent with it.
    const position = () => (p("cursor", "") ? { cursor: p("cursor", "") } : { page: p("page", 0) });
    if (operation === "list") {
      const { items, meta } = await api.listAssets(ctx, {
        collection: p("collection", ""),
        q: p("q", ""),
        mime: p("mime", ""),
        status: p("status", ""),
        createdFrom: p("createdFrom", ""),
        createdTo: p("createdTo", ""),
        ...position(),
        perPage: p("perPage", 100)
      });
      return items.map((a) => ({
        json: { ...assetRef(a), page: meta?.page, total: meta?.total, hasMore: meta?.hasMore, nextCursor: meta?.nextCursor ?? null }
      }));
    }
    if (operation === "listCollections") {
      const { items, meta } = await api.listCollections(ctx, { q: p("q", ""), ...position(), perPage: p("perPage", 100) });
      return items.map((c) => ({
        json: {
          collection: c.collection,
          count: c.count,
          lastAddedAt: c.lastCreatedAt ? new Date(c.lastCreatedAt).toISOString() : undefined,
          page: meta?.page,
          total: meta?.total,
          hasMore: meta?.hasMore,
          nextCursor: meta?.nextCursor ?? null
        }
      }));
    }
    if (operation === "publish") {
      const ids = normaliseIds(p("assetIds"));
      if (!ids.length) throw new NodeOperationError(ctx.getNode(), "Asset IDs is empty", { itemIndex: i });
      return (await api.publishAssets(ctx, ids, { itemIndex: i })).map((a) => ({ json: assetRef(a) }));
    }
  }

  if (resource === "op" && operation === "run") {
    const op = p("op");
    const options = p("options", {});
    const input = await resolveInputAssets(ctx, i, options);
    const body = buildOpJobBody({
      op,
      assetIds: input.assetIds,
      imageCount: input.imageCount,
      prompt: p("prompt", ""),
      count: op === "generate" ? p("count", 1) : undefined,
      model: options.model,
      parameters: parseParameters(p("parameters", "{}")),
      collection: options.collection,
      retentionDays: options.retentionDays
    });
    return runJob(ctx, i, body);
  }

  if (resource === "preset" && operation === "run") {
    const options = p("options", {});
    const fromPrompt = p("inputMode", "binary") === "none";
    const { assetIds, imageCount } = await resolveInputAssets(ctx, i, options);
    if (!assetIds.length && !imageCount && !fromPrompt)
      throw new NodeOperationError(ctx.getNode(), "A preset needs at least one input asset", { itemIndex: i });
    return runJob(
      ctx,
      i,
      buildPresetJobBody({
        presetId: p("preset"),
        assetIds,
        imageCount,
        version: p("presetVersion", 0),
        collection: options.collection,
        retentionDays: options.retentionDays,
        prompt: p("prompt", ""),
        count: p("count", 0),
        fromPrompt
      })
    );
  }

  if (resource === "job") {
    const id = p("jobId");
    const job = operation === "wait" ? await api.waitJob(ctx, id, { timeoutMs: p("waitSeconds", 180) * 1000 }) : await api.getJob(ctx, id);
    return finish(ctx, job, { publish: p("publish", true), download: p("downloadOutput", false), itemIndex: i });
  }

  throw new NodeOperationError(ctx.getNode(), `Unsupported: ${resource}.${operation}`, { itemIndex: i });
}

/**
 * The images the current item runs on: `{ assetIds }` uploaded from the binary property, taken from the field, or none.
 *
 * A Dry Run over a Binary File uploads nothing (#572): it answers `{ assetIds: [], imageCount: 1 }`, and the service
 * prices the one image by count (imagestep#586) — the price depends on the op, model and parameters, never on the
 * pixels. Pricing it used to mean uploading it, and Dry Run, which says nothing is created, left an asset behind that
 * counted against the quota. The binary still has to be there, as it would for the run.
 */
async function resolveInputAssets(ctx, i, { collection, retentionDays } = {}) {
  const mode = ctx.getNodeParameter("inputMode", i, "binary");
  if (mode === "assetIds") return { assetIds: normaliseIds(ctx.getNodeParameter("assetIds", i, "")) };
  if (mode === "binary") {
    const property = ctx.getNodeParameter("binaryProperty", i, "data");
    if (ctx.getNodeParameter("dryRun", i, false)) {
      ctx.helpers.assertBinaryData(i, property);
      return { assetIds: [], imageCount: 1 };
    }
    const asset = await api.uploadBinary(ctx, i, property, { collection, retentionDays, wait: true });
    return { assetIds: [asset.id] };
  }
  return { assetIds: [] };
}

/**
 * Submit (or price) a job, then wait / publish / download per the node's switches.
 *
 * Publish Outputs and Download Outputs show only while Store Result is on (description.js), and n8n answers a hidden
 * field with the fallback read here — for Publish, on. So an AI op, or a preset, left at Store Result off published
 * every output to a public URL while the field said nothing is published (#564). Off, a job still runs and is waited
 * for, and its outputs come back as asset ids that nobody else can read.
 */
async function runJob(ctx, i, body) {
  const dryRun = ctx.getNodeParameter("dryRun", i, false);
  if (dryRun) return [{ json: { dryRun: true, request: body, estimate: await api.submitJob(ctx, body, { dryRun: true, itemIndex: i }) } }];
  if (!ctx.getNodeParameter("wait", i, true)) return [{ json: jobRef(await api.submitJob(ctx, body, { itemIndex: i })) }];
  const timeoutMs = ctx.getNodeParameter("waitSeconds", i, 180) * 1000;
  const started = Date.now();
  const job = await api.submitJob(ctx, body, { waitMs: timeoutMs, itemIndex: i });
  const done = await api.waitJob(ctx, job.id, { timeoutMs: Math.max(0, timeoutMs - (Date.now() - started)), known: job });
  const store = ctx.getNodeParameter("storeResult", i, false);
  return finish(ctx, done, {
    publish: store && ctx.getNodeParameter("publish", i, true),
    download: store && ctx.getNodeParameter("downloadOutput", i, false),
    itemIndex: i
  });
}

/**
 * The synchronous path: one image in, one image out, nothing stored.
 *
 * Returns null when this item cannot go that way, so the caller falls through to the job path. Two
 * questions decide it, and neither is a list kept in this file:
 *   - **may this op run synchronously** — the API's answer (`GET /api/v1/ops` → `syncEndpoint`), so
 *     a deterministic op added to the API works here without a release; AI ops have no
 *     `syncEndpoint` and never will;
 *   - **is this item one image** — {@link syncInput}, which reads `inputMode`.
 */
async function runSyncOp(ctx, i, op, lanes) {
  const p = (name, fallback) => ctx.getNodeParameter(name, i, fallback);
  let endpoints;
  try {
    endpoints = await lanes.syncEndpoints();
  } catch {
    return null; // catalogue unreachable → the job path still works. Slower beats wrong.
  }
  if (!endpoints[op]) return null;

  const input = await syncInput(ctx, i, p);
  if (!input) return null;

  const qs = { op, ...parseParameters(p("parameters", "{}")) };
  const { buffer: out, mimeType } = await api.apiRequestBinary(ctx, "/api/v1/images/transform", {
    qs,
    body: input.body,
    contentType: input.contentType
  });

  const fileName = renameExtension(input.fileName, mimeType);
  return [
    {
      json: { op, mode: "sync", stored: false, bytes: out.length, mimeType, ...input.json },
      binary: { [input.property]: await ctx.helpers.prepareBinaryData(out, fileName, mimeType) }
    }
  ];
}

/**
 * What the synchronous call sends for this item — or null when the item is not one image, which
 * means the job path (#92). The sync face takes bytes OR a reference, so `inputMode` decides which:
 *
 *   - **Binary File** → the bytes of that property, raw body, back out on the same property.
 *   - **Asset IDs**, exactly one → the JSON form `{"assetId"}` (contract §9): the service reads its
 *     own bucket, runs the op and hands the bytes straight back. Still nothing stored, still no
 *     publish — an asset you already own does not have to become a job to be resized. Several ids
 *     are a batch and a batch is a job; none is nothing to do here.
 *   - **None** (generate) → no input bytes at all, so there is nothing this path could send.
 *
 * `binaryProperty` is read at the TOP LEVEL, where `description.js` puts it — not off the Options
 * collection, which never carried it (#91).
 */
async function syncInput(ctx, i, p) {
  const mode = p("inputMode", "binary");
  if (mode === "binary") {
    const property = p("binaryProperty", "data");
    const meta = ctx.helpers.assertBinaryData(i, property);
    return {
      body: await ctx.helpers.getBinaryDataBuffer(i, property),
      contentType: meta.mimeType || "application/octet-stream",
      fileName: meta.fileName || "image",
      property
    };
  }
  if (mode === "assetIds") {
    const ids = normaliseIds(p("assetIds", ""));
    if (ids.length !== 1) return null;
    return {
      body: JSON.stringify({ assetId: ids[0] }),
      contentType: "application/json",
      fileName: ids[0],
      property: "data",
      json: { sourceAssetId: ids[0] }
    };
  }
  return null;
}

/** `photo.jpg` + `image/webp` → `photo.webp`, so a downstream Write File node does the right thing. */
function renameExtension(fileName, mimeType) {
  const ext = (mimeType.split("/")[1] || "").replace("jpeg", "jpg");
  if (!ext) return fileName;
  const dot = fileName.lastIndexOf(".");
  return (dot > 0 ? fileName.slice(0, dot) : fileName) + "." + ext;
}

/** jobRef with outputs — one item, or one item per output carrying the bytes when downloading. */
async function finish(ctx, job, { publish, download, itemIndex }) {
  // analyze writes its answer onto the input assets and creates none (imagestep#202): nothing to publish or download.
  if (job.type === "parse") return [{ json: { ...jobRef(job), analyses: analysesOf(job) } }];
  const outputs = await api.collectOutputs(ctx, job, { publish, itemIndex });
  const ref = jobRef(job, outputs);
  if (!download || !outputs.length) return [{ json: ref }];
  const out = [];
  for (const asset of outputs) {
    const { buffer, mimeType, fileName } = await api.downloadOutput(ctx, asset);
    out.push({
      json: { ...ref, output: assetRef(asset) },
      binary: { data: await ctx.helpers.prepareBinaryData(buffer, fileName, mimeType) }
    });
  }
  return out;
}

/** Each analyzed input's answer: its job item's output (imagestep#338), one per item, in item order. */
function analysesOf(job) {
  return (job.items || []).filter((i) => i.status === "COMPLETED" && i.output).map((i) => ({ assetId: i.sourceAssetId, output: i.output }));
}

module.exports = { ImageStep, ITEM_CONCURRENCY };
