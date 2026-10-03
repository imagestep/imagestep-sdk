import { readFileSync } from "node:fs";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ImageStep, ImageStepError, JobFailedError } from "imagestep";
import { z } from "zod";
import { assertPublicUrl } from "./safe-url.js";

// The version a client sees in the handshake is the one that was published, read rather than
// retyped — a literal here agrees with package.json exactly until the first release bumps one.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** A job in one of these has stopped; anything else is still moving. */
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
/**
 * How long a drainable (hosted) server lets the service hold a submit before reading on (#632): well inside the 25 s a
 * SIGTERM waits for the calls in flight (bin/imagestep-mcp.js), so a shutdown never has to cut a submit to exit. A job
 * that settles inside it still comes back from the one request (#355).
 */
const DRAINABLE_SUBMIT_HOLD_SECONDS = 15;

/**
 * The `transform` tool's op list as of this release — a FALLBACK, not the vocabulary (#94).
 *
 * The vocabulary is `GET /api/v1/ops`, and {@link createServerWithCatalogue} reads it so an op
 * added to the API is callable here without a release. This list is what the tool schema falls back
 * to when that request cannot be made (no network, a bad key, the service down): a tool with no
 * enum at all would be worse than a slightly old one, and the description says which it is.
 */
export const FALLBACK_TRANSFORM_OPS = [
  "edit",
  "remove_bg",
  "upscale",
  "restore_face",
  "colorize",
  "analyze",
  "resize",
  "convert",
  "compress",
  "crop",
  "pad",
  "grayscale",
  "rotate",
  "flip",
  "flop",
  "trim",
  "flatten",
  "adjust",
  "mask",
  "blur_region",
  "overlay",
  "caption",
  "render_template",
  "read_metadata"
];

/** The deterministic ones among them — the ones an agent can run without spending credits. */
export const FALLBACK_DETERMINISTIC_OPS = [
  "resize",
  "convert",
  "compress",
  "crop",
  "pad",
  "grayscale",
  "rotate",
  "flip",
  "flop",
  "trim",
  "flatten",
  "adjust",
  "mask",
  "blur_region",
  "overlay",
  "caption",
  "render_template"
];

/** The ones among them that take no image — a template plus rows (#276). */
export const FALLBACK_ASSET_FREE_OPS = ["render_template"];

/**
 * Which ops this server offers, from a catalogue when it has one.
 *
 * Every op but `generate`, which has its own tool. `render_template` used to be dropped along with it because both
 * answer `requiresAssets: false` — which left the one catalogue op that takes a template plus rows instead of an image
 * unreachable from MCP while n8n offered it (#276). `assetFree` is how the input check tells those ops apart, read off
 * the catalogue rather than named here.
 */
export function toolOps(catalogue) {
  const usable = (catalogue || []).filter((o) => o && o.op && o.op !== "generate");
  if (!usable.length)
    return { ops: FALLBACK_TRANSFORM_OPS, deterministic: FALLBACK_DETERMINISTIC_OPS, assetFree: FALLBACK_ASSET_FREE_OPS, live: false };
  return {
    ops: usable.map((o) => o.op),
    deterministic: usable.filter((o) => o.kind === "deterministic").map((o) => o.op),
    assetFree: usable.filter((o) => o.requiresAssets === false).map((o) => o.op),
    live: true
  };
}

/**
 * What each AI op costs on its default model, read off the catalogue's own `pricing` (#224) — so the
 * number an agent sees in a tool description is the one the service publishes, and a price change
 * reaches it without a release. Empty when the catalogue could not be read; the note then says
 * "see the estimate" as it always did.
 */
export function aiPrices(catalogue) {
  return (catalogue || [])
    .filter((o) => o && o.kind === "ai" && o.pricing?.defaultModel)
    .map((o) => {
      const m = o.pricing.defaultModel;
      return `${o.op} ${m.priceRange || `$${m.priceFrom}`}/item on ${m.id}`;
    });
}

/**
 * How long one item usually takes, per op, as the catalogue measured it (`typicalSeconds`, imagestep#357) — so an agent
 * sizes `wait_seconds` from the service's own figures instead of from a list of "fast ops" written down here. Ops with
 * no figure are left out rather than guessed at; with no catalogue there is no line at all.
 */
export function typicalDurations(catalogue) {
  const timed = (catalogue || []).filter((o) => o && o.op && o.typicalSeconds);
  if (!timed.length) return "";
  const deterministic = timed.filter((o) => o.kind === "deterministic");
  const same = deterministic.length > 1 && deterministic.every((o) => o.typicalSeconds === deterministic[0].typicalSeconds);
  const lines = timed.filter((o) => !(same && o.kind === "deterministic")).map((o) => `${o.op} ~${o.typicalSeconds} s`);
  if (same) lines.push(`deterministic ops ~${deterministic[0].typicalSeconds} s`);
  return `Typical time for ONE item as a job, on the default model (a hint, not a promise — a batch, another model or a cold provider is slower): ${lines.join(", ")}. `;
}

/**
 * The values a parameter's catalogue description lists — `webp · jpeg · png` at its start — or null. That list is how the
 * catalogue names a closed set; the eval's fake account (eval/fake.mjs) refuses by the same reading.
 */
export function listedValues(param) {
  const parts = (param?.description || "").split(/[(.—]/)[0].trim().split(" · ");
  return parts.length > 1 && parts.every((v) => /^[a-z0-9]+$/.test(v)) ? parts : null;
}

/**
 * The parameter contract of every op, one line each, read off the catalogue's `params` (#281).
 *
 * `transform`'s `parameters` used to be described by a hand-written line that named five ops and missed most of their
 * parameters — and an MCP-only client has no other way to read the contract, so an agent guessed, got
 * `400 invalid_param` and retried. Names, types and defaults, not every description: those would put the whole catalogue
 * into every session, and the resource `imagestep://ops/{op}` carries them for the op the agent is about to call.
 *
 * Three things the catalogue says are kept, because the tool-choice eval (#557, eval/README.md) measured what leaving them
 * out cost: the values a parameter takes when its description lists them; what a REQUIRED parameter means — it is the one
 * an agent cannot leave out, so the one it must not guess (a rotation's direction, a template's rows); and for an AI op,
 * its one open `parameters` object as the catalogue describes it. That op's `model` and `prompt` are fields of the tool,
 * not keys inside `parameters`, and listing them there read as the keys to fill: upscale was asked for `{scale: 2}` in
 * every run of two models.
 */
export function paramsContract(catalogue) {
  return (catalogue || [])
    .filter((o) => o && o.op && o.op !== "generate" && o.kind !== "sync")
    .map((o) => {
      const entries = Object.entries(o.params || {});
      if (o.kind === "ai" && o.params?.parameters) return `${o.op}: ${o.params.parameters.description || "model-specific parameters"}`;
      const params = entries
        .filter(([name]) => !(o.kind === "ai" && (name === "model" || name === "prompt")))
        .map(([name, p]) => {
          const d = p?.default;
          const dflt = d === undefined || d === null ? "" : `=${typeof d === "string" ? d : JSON.stringify(d)}`;
          const values = listedValues(p);
          const required = /\(required\)/.test(p?.description || "");
          const meaning = required && !values ? `: ${p.description.replace(/\s*\(required\)/, "").replace(/\.$/, "")}` : "";
          return `${name}(${values ? values.join("|") : p?.type || "any"}${dflt}${required ? `, required${meaning}` : ""})`;
        });
      return `${o.op}: ${params.length ? params.join(", ") : "no parameters"}`;
    });
}

/**
 * The ops a saved preset's step may name (#279): every job op but `render_template`, whose input is rows of data rather
 * than an asset (apps/service/doc/presets.md §1). `generate` is one — a consistency preset is a generate or edit step
 * with subjects — and `read_metadata` is not: an endpoint answers it, not a job.
 */
export function presetStepOps(catalogue) {
  const usable = (catalogue || []).filter((o) => o && o.op && o.kind !== "sync" && o.op !== "render_template");
  if (usable.length) return usable.map((o) => o.op);
  return ["generate", ...FALLBACK_TRANSFORM_OPS.filter((op) => op !== "read_metadata" && op !== "render_template")];
}

/** The modes `GET /api/v1/ai-models` answers for — and so the `imagestep://models/{mode}` resources that exist. */
const MODEL_MODES = ["ai_image", "analyze"];

function costNote(deterministic, prices = []) {
  const ai = prices.length ? `${prices.join("; ")}; another model has its own price` : "see the estimate";
  return (
    `Cost: AI ops charge credits per item (${ai}); deterministic ops (${deterministic.join("/")}) ` +
    "are free on paid plans and count against the Free plan's monthly quota. Set dry_run=true to get the exact price without " +
    "spending. Errors come back structured: `retryable` says whether the same call can be retried; `param` names the input to fix."
  );
}

/** Compact, reference-only view of an asset — never bytes, never a data URL. */
export function assetRef(a) {
  if (!a) return null;
  return {
    assetId: a.id,
    name: a.name,
    status: a.status,
    // A list row carries these flat (imagestep#339); a full record under `image`.
    mimeType: a.mimeType ?? a.image?.mimeType,
    width: a.width ?? a.image?.width,
    height: a.height ?? a.image?.height,
    size: a.size ?? a.image?.size,
    collection: a.collection || undefined,
    tags: a.tags?.length ? a.tags : undefined,
    publicUrl: a.publicUrl || undefined,
    expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : undefined
  };
}

/**
 * The job handle an agent gets back, and the trace it can answer from (contract §11, imagestep#125).
 *
 * Each item carries who ran it, on what model, how long it took and what it cost — so "did that step
 * work, why not, and should I pay for it again" is answerable from the tool result rather than from a
 * dashboard the agent cannot open. Every field is passed through, never recomputed: a number this
 * layer derived would disagree with the API's the first time one of them changed.
 */
export function jobRef(job, outputs, outputsTotal, outputsCursor) {
  const items = (job.items || []).map((i) => ({
    index: i.index,
    status: i.status,
    sourceAssetId: i.sourceAssetId,
    resultAssetId: i.resultAssetId,
    error: i.error || i.errorMessage || undefined,
    errorCode: i.errorCode,
    retryable: i.retryable,
    variant: i.variant,
    // A `chain` item is delivered once per segment (imagestep#246): the segment it is on, and the one it failed on —
    // where a resume starts it again, which is what an agent weighing a resume needs (#573).
    step: i.step,
    failedStep: i.failedStep,
    provider: i.provider,
    model: i.model,
    durationMs: i.durationMs,
    credits: i.credits,
    startedAt: i.startedAt,
    finishedAt: i.finishedAt
  }));
  return {
    jobId: job.id,
    type: job.type,
    status: job.status,
    op: job.op,
    presetId: job.presetId,
    presetVersion: job.presetVersion,
    templateId: job.templateId,
    templateVersion: job.templateVersion,
    totalItems: job.totalItems ?? items.length,
    // The service inlines the first page of items and says when there are more (imagestep#440). Saying so here is
    // the whole point of the cap: a page of items lands in a context, and a context is a viewport.
    itemsNote: job.itemsTruncated ? itemsNote(job, items.length) : undefined,
    itemsCursor: job.itemsCursor,
    completedItems: job.completedItems ?? items.filter((i) => i.status === "COMPLETED").length,
    failedItems: job.failedItems ?? items.filter((i) => i.status === "FAILED").length,
    creditsCharged: job.creditsCharged ?? job.actualCredits,
    // A failed job's verdict on its items (#294): retryable when any failed item is, so a resume is worth its price.
    errorCode: job.errorCode,
    retryable: job.retryable,
    expiresAt: job.expiresAt,
    items,
    outputs: outputs?.map(assetRef),
    // The same viewport rule for what the job made (#520): the first OUTPUTS_INLINE of them, and where the rest are.
    outputsTruncated: outputs && outputsTotal > outputs.length ? true : undefined,
    // The cursor is where the listing those outputs came from stopped (#493), so the next call reads exactly the rest; a
    // published run's outputs were read whole and reordered, so there is no such point and the walk starts over.
    outputsNote:
      outputs && outputsTotal > outputs.length
        ? `Only the first ${outputs.length} outputs of ${outputsTotal} are here. ` +
          (outputsCursor
            ? `Read the rest with search_assets {"job_id": "${job.id}", "cursor": "${outputsCursor}"} and follow its nextCursor.`
            : `Read them all with search_assets {"job_id": "${job.id}"} and follow its nextCursor.`)
        : undefined
  };
}

/**
 * Where the rest of a job's items are, as job_status calls (#573): an agent that has only this server cannot call the
 * REST listing. A job_status answer knows the cursor that reads on; a write tool's answer carries the job document's
 * first page and no listing read, so it names the job_status call that answers with one.
 */
function itemsNote(job, shown) {
  const failed = `job_status {"job_id": "${job.id}", "items_status": "FAILED"} reads just the ones a resume would run again.`;
  if (!job.itemsCursor) {
    return (
      `Only the first ${shown} items of ${job.totalItems} are here. job_status {"job_id": "${job.id}"} answers with the ` +
      `itemsCursor that reads on from them; ${failed}`
    );
  }
  const status = job.itemsStatus ? `, "items_status": "${job.itemsStatus}"` : "";
  return (
    `More items follow these ${shown}: read on with job_status {"job_id": "${job.id}"${status}, "items_cursor": ` +
    `"${job.itemsCursor}"} and follow each answer's itemsCursor until it has none.${job.itemsStatus ? "" : ` ${failed}`}`
  );
}

/**
 * How many of a job's outputs a tool answer carries (#520) — search_assets' default page, so `search_assets {job_id,
 * cursor}` carries on exactly where the answer stopped. #440 capped the items a job document inlines for the same
 * reason; the outputs were still the whole run: 500 of them were ~221 KB, ~60k tokens, in one tool result.
 */
export const OUTPUTS_INLINE = 20;

/** The run's products in its items' order; rows no inlined item names keep the listing's order, after the rest. */
function inItemOrder(assets, job) {
  const order = new Map();
  for (const [index, item] of (job?.items || []).entries()) {
    if (item?.resultAssetId && !order.has(item.resultAssetId)) order.set(item.resultAssetId, index);
  }
  const at = (asset) => (order.has(asset.id) ? order.get(asset.id) : Number.MAX_SAFE_INTEGER);
  return assets.slice().sort((a, b) => at(a) - at(b));
}

/**
 * File extensions for what the synchronous lane can produce (`OpsCatalog.FORMATS`, plus the JSON
 * the metadata route answers with). An unknown type falls back to its subtype when that is a plain
 * token, so a format the API learns is still named something better than `.bin`.
 */
const EXTENSION_BY_MIME = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/tiff": "tiff",
  "application/json": "json"
};

export function extensionFor(mimeType) {
  const known = EXTENSION_BY_MIME[mimeType];
  if (known) return known;
  const subtype = String(mimeType || "")
    .split(";")[0]
    .split("/")[1];
  return /^[a-z0-9]+$/.test(subtype || "") ? subtype : "bin";
}

let scratch;

/**
 * One temp directory per PROCESS, removed on exit.
 *
 * It used to be one `mkdtemp` per call and nothing ever removed them, so a long-lived stdio server
 * left a directory behind for every image an agent touched (#95). `exit` covers the ordinary end of
 * a stdio server (the client closes stdin); a killed process leaves the directory to the OS's own
 * temp sweep, which is what that sweep is for.
 */
async function scratchDir() {
  if (!scratch) {
    const { mkdtemp } = await import("node:fs/promises");
    const { rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    scratch = await mkdtemp(join(tmpdir(), "imagestep-"));
    process.once("exit", () => {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Exiting anyway; a leftover temp directory is not worth a stack trace on the way out.
      }
    });
  }
  return scratch;
}

function ok(payload) {
  // Compact (#520): the indentation was a quarter of every answer, and a context pays for whitespace like anything else.
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

/**
 * The names an input or a request is made of, which no op takes as a parameter (#470). `parameters` is the agent's to
 * fill, and it once reached the SDK spread over the input this server built: `{"file": "/proc/self/environ"}` named a
 * file on the MCP host for the SDK to read, and `{"url": null}` cleared the URL so that it would. The SDK now keeps the
 * two apart; this answers the agent by name instead of passing the key on to be refused one round trip later.
 */
const NOT_OP_PARAMETERS = ["file", "url", "urls", "assetId", "assetIds", "preset", "response", "signal", "op"];

function assertOpParameters(parameters, param) {
  const key = Object.keys(parameters || {}).find((k) => NOT_OP_PARAMETERS.includes(k));
  if (key)
    throw Object.assign(new Error(`'${key}' is not an op parameter — images go in asset_ids, file_paths or urls`), {
      code: "invalid_param",
      param: `${param}.${key}`
    });
}

function fail(err) {
  const e =
    err instanceof ImageStepError
      ? {
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          param: err.param,
          details: err.details,
          status: err.status,
          // The service's id for the failed call (contract §11) — what a person needs to find it in the logs.
          requestId: err.requestId ?? undefined
        }
      : err instanceof JobFailedError
        ? { code: "job_failed", message: err.message, retryable: false, job: jobRef(err.job) }
        : {
            code: err?.code || "internal_error",
            message: err?.message || String(err),
            retryable: err?.retryable ?? false,
            param: err?.param
          };
  return { content: [{ type: "text", text: JSON.stringify({ error: e }, null, 2) }], structuredContent: { error: e }, isError: true };
}

const waitSchema = z
  .boolean()
  .default(true)
  .describe(
    "Wait for the job to finish (up to wait_seconds) and return its outputs. false → return the job handle now; poll with job_status."
  );
/**
 * `wait_seconds`, with the hosted server's cap when there is one (#275). Clamped rather than refused: an agent that asks
 * for 300 s wants the answer, and the timedOut handle it gets at the cap is the same one a slow job gives anyway.
 */
function waitSecondsSchema(maxWaitSeconds, typical = "") {
  const schema = z.number().int().min(5).max(600);
  if (!maxWaitSeconds) return schema.default(180).describe(`How long to wait when wait=true. ${typical}`.trim());
  return schema
    .default(Math.min(180, maxWaitSeconds))
    .describe(
      `How long to wait when wait=true. ${typical}This hosted server waits at most ${maxWaitSeconds} s per call (a longer value is clamped); ` +
        "past that it returns the job handle with timedOut: true — poll job_status."
    );
}
const publishSchema = z
  .boolean()
  .default(true)
  .describe("Publish result assets so each output has a stable publicUrl on the CDN — the output itself at full size, not a thumbnail.");
const dryRunSchema = z.boolean().default(false).describe("Price only — nothing is created or charged.");
/**
 * transform and run_preset, which take images, price them without storing any (#572 → #586). Pricing a file or a URL
 * used to mean uploading it — a dry run that said "nothing is created" left an asset, counted against the quota, behind —
 * and then #572 refused them instead. The price never depended on the image, only on the op, model, parameters and how
 * many, so the service now takes the count (`imageCount`, contract §5) and nothing is uploaded or fetched.
 */
const imageDryRunSchema = z
  .boolean()
  .default(false)
  .describe(
    "Price only — nothing is created, uploaded or charged. asset_ids are priced as themselves; file_paths and urls by how " +
      "many there are, since the price depends on the op, model and parameters, never on the image."
  );

/**
 * The images a dry run prices by count (#586): the files and URLs it will not upload. File paths still need a server
 * that can read them — the run that follows would refuse them — so that refusal comes first, as it would on a run.
 */
function unstoredCount({ dry_run, file_paths, urls }, allowLocalFiles) {
  if (!dry_run) return 0;
  if (file_paths?.length && !allowLocalFiles)
    throw Object.assign(new Error("file_paths is only available when the server runs locally over stdio; use urls or asset_ids"), {
      code: "invalid_param",
      param: "file_paths"
    });
  return (file_paths?.length || 0) + (urls?.length || 0);
}
/** job_status's own publish: off by default, because checking on a job must not make its results public (#278). */
const statusPublishSchema = z
  .boolean()
  .default(false)
  .describe(
    "Also publish the outputs so each has a stable publicUrl on the CDN. Off by default — checking on a job does not make " +
      "its results public; pass true when you want the URLs."
  );

/**
 * MCP tool annotations (#278): the hints a client reads to decide whether a call needs a person's confirmation. All seven
 * reach the ImageStep API, an open world from the client's side. The three that submit work create jobs and spend
 * credits, and none is idempotent on its own — the same call twice is two jobs unless the agent passes an
 * idempotency_key. save_preset and send_feedback write for free and are no more idempotent without a key (#279).
 * None is destructive: every job writes new assets and never overwrites the one it read (#331) — run_preset carried the
 * hint while its `mode: REPLACE_MEDIA` could.
 */
const READ_TOOL = { readOnlyHint: true, openWorldHint: true };
const WRITE_TOOL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
/**
 * The Idempotency-Key of the job submission (contract §3). The SDK makes one per call, which covers its own retries
 * and nothing else: when the MCP client times out and the agent calls the tool again, a fresh key is a second job and
 * a second charge. Only the agent knows that two calls are the same attempt, so the key has to be its to give.
 */
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe(
    "Your key for this submission. Calling again with the same key and the same arguments returns the job the first call " +
      "created instead of submitting (and charging for) a second one; the same key with different arguments is refused " +
      "with idempotency_key_reuse. Use one when you might retry after a timeout."
  );
/** The same key for the two writes that are not jobs (#279): a retried save or report returns what the first call answered. */
const writeKeySchema = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe(
    "Your key for this write. Calling again with the same key and the same arguments returns what the first call answered " +
      "instead of writing twice; the same key with different arguments is refused with idempotency_key_reuse."
  );
const collectionSchema = z
  .string()
  .max(200)
  .optional()
  .describe(
    "Collection to put the new assets in (an opaque name; search_assets filters on it). Without one, an output made from an asset is in that asset's collection."
  );

/** How long to keep what a call stores (imagestep#591): the images it takes in and the ones it makes. Shorter only. */
const retentionDaysSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe(
    "Keep what this call stores — the images you hand it and the ones it makes — this many days instead of the account's plan retention. Shorter only: more is kept for the plan's time. Use it when the outputs are consumed at once (posted, sent on) and need not be kept."
  );
const assetIdsSchema = z.array(z.string().min(1)).max(500).optional().describe("Existing asset ids to process.");
const filePathsSchema = z
  .array(z.string().min(1))
  .max(100)
  .optional()
  .describe("Local files to upload first (only when the server runs on your machine over stdio).");
const urlsSchema = z.array(z.url()).max(100).optional().describe("Public http(s) image URLs to ingest first.");

/** The one place a client is constructed, so both entry points below build the same one. */
function clientFor(options) {
  return options.client || new ImageStep({ apiKey: options.apiKey, baseUrl: options.baseUrl, fetch: options.fetch });
}

/**
 * Build one MCP server bound to one API key. Asset-by-reference only: images never
 * enter the context window — the server returns ids, sizes and public URLs.
 *
 * Synchronous, so it cannot read the op catalogue: pass one in `catalogue` (that is what
 * {@link createServerWithCatalogue} does), or the tool schema uses
 * {@link FALLBACK_TRANSFORM_OPS} and says so.
 *
 * `maxWaitSeconds` caps how long a write tool holds the call open — the hosted transport sets it (src/http.js, #275).
 * `drain` is the hosted server's shutdown (#632): when it aborts, a call still waiting for its job answers at once with
 * the handle, as a wait that ran out does, instead of being cut when the process exits.
 *
 * @param {{ apiKey: string, baseUrl?: string, fetch?: typeof fetch, allowLocalFiles?: boolean, client?: ImageStep, catalogue?: object[], maxWaitSeconds?: number, drain?: AbortSignal }} options
 */
export function createServer(options) {
  const client = clientFor(options);
  const allowLocalFiles = options.allowLocalFiles ?? false;
  const catalogue = toolOps(options.catalogue);
  // The ops that make an image from nothing but words. Read off the catalogue (`requiresAssets: false`, less the one whose
  // input is rows of data); `generate` when the catalogue could not be read.
  const promptOnlyOps = (options.catalogue || []).some((o) => o?.op)
    ? options.catalogue.filter((o) => o?.requiresAssets === false && o.op !== "render_template").map((o) => o.op)
    : ["generate"];
  const startsWithoutAnImage = (preset) => promptOnlyOps.includes(preset?.steps?.[0]?.op);
  const STEP_OPS = presetStepOps(options.catalogue);
  const maxWaitSeconds = options.maxWaitSeconds;
  const drain = options.drain;
  const WAIT_SECONDS = waitSecondsSchema(maxWaitSeconds, typicalDurations(options.catalogue));
  // What the `transform` inputs mean, from the catalogue when there is one (#281) — the fallback says it is one.
  const contract = paramsContract(options.catalogue);
  const PARAMETERS_NOTE = contract.length
    ? "Op parameters as name(type=default), from the live catalogue — never invent one. For an AI op the line is what goes " +
      "in parameters for its model; model and prompt are fields of their own. Each op's full contract with " +
      "descriptions, and an `example` request the service has validated (copy its parameters), is the resource imagestep://ops/{op}.\n" +
      contract.join("\n")
    : "Op parameters — resize {width,height,fit}; convert {format,quality}; crop {left,top,width,height}; pad {top,bottom,left,right,background}; " +
      "upscale {scaleFactor} … (built-in summary: GET /api/v1/ops could not be read; the resource imagestep://ops/{op} has the contract when it can be).";
  const liveOps = (options.catalogue || []).filter((o) => o && o.op && o.op !== "generate");
  const promptRequired = liveOps.filter((o) => o.requiresPrompt).map((o) => o.op);
  const promptOptional = liveOps.filter((o) => !o.requiresPrompt && o.defaultPrompt).map((o) => o.op);
  const PROMPT_NOTE = contract.length
    ? [
        promptRequired.length ? `Required for op=${promptRequired.join(", ")}` : "No op requires one",
        promptOptional.length ? `optional for ${promptOptional.join(", ")} (it has a default)` : null,
        "ignored by the other ops."
      ]
        .filter(Boolean)
        .join("; ")
    : "Required for op=edit.";
  const COST_NOTE = costNote(catalogue.deterministic, aiPrices(options.catalogue));
  const server = new McpServer(
    { name: "imagestep", version },
    {
      instructions:
        "ImageStep is the image step for automations: upload or reference assets, run one atomic op or a saved preset as a job, " +
        "and get back asset ids + public URLs. Never ask for image bytes — pass asset ids, local file paths (stdio only) or public URLs. " +
        "Price with dry_run before large batches. A chain you run twice is a preset: save it with save_preset, then run_preset the " +
        "slug@version it answers with. When ImageStep cannot do what you need, report it with send_feedback instead of working around it."
    }
  );

  async function ingest({ asset_ids, file_paths, urls, collection, retention_days }) {
    const ids = [...(asset_ids || [])];
    if (file_paths?.length) {
      if (!allowLocalFiles)
        throw Object.assign(new Error("file_paths is only available when the server runs locally over stdio; use urls or asset_ids"), {
          code: "invalid_param",
          param: "file_paths"
        });
      // One stage, bounded-concurrent PUTs, one finish and one status call per tick (#525): file by file, 15–20 files ran
      // past an MCP client's 60 s request timeout while the uploads carried on — and a retry uploaded them again.
      for (const r of await client.assets.uploadMany(file_paths, { collection, retentionDays: retention_days })) {
        if (r.error)
          throw Object.assign(new Error(`${r.name}: ${r.error.message}`), {
            code: r.error.code,
            param: "file_paths",
            retryable: r.error.retryable
          });
        ids.push(r.asset.id);
      }
    }
    if (urls?.length) {
      // The SERVICE fetches (imagestep#219): the hosted server has no business holding an agent's image
      // in memory, and the service's own fetch is the guarded one (its resolver refuses private
      // addresses at connect time). The check here stays as a fast, specific refusal before a round trip.
      // The schema keeps 100 URLs; the SDK sends them twenty to a request, the service's ceiling (#525).
      const checked = [];
      for (const u of urls) checked.push(String(await assertPublicUrl(u)));
      for (const r of await client.assets.fromUrl(checked, { collection, retentionDays: retention_days })) {
        if (r.error)
          throw Object.assign(new Error(`${r.url}: ${r.error.message}`), {
            code: r.error.code,
            param: "urls",
            retryable: r.error.retryable
          });
        ids.push(r.asset.id);
      }
    }
    return ids;
  }

  /**
   * The synchronous fast path (imagestep#85).
   *
   * A `resize` used to be: upload → create an asset → submit a job → poll → fetch the asset →
   * publish it to a public URL just to look at it. An agent doing five image steps spent half a
   * minute and left ten assets behind. When the input is bytes the agent is holding and the op has
   * a synchronous form, none of that is needed.
   *
   * It applies only when ALL of these hold, and each one is a reason, not a filter:
   * - the op has a `syncEndpoint` in `GET /api/v1/ops` — **asked, never hard-coded**, so a new
   *   deterministic op is fast here without this file changing;
   * - the input is `file_paths` or `urls`, not `asset_ids` — an image already stored has nothing
   *   to gain, and would have to be downloaded to be sent back;
   * - `wait` is true — `wait: false` only means something when there is a job handle to return.
   *
   * Everything else still goes through the job engine, unchanged.
   */
  async function canRunSync(op, { asset_ids, file_paths, urls, wait, variants }) {
    if (!wait) return false;
    if (variants?.length) return false; // one image in, one image out — a set of sizes is a job
    if (asset_ids?.length) return false;
    const sources = (file_paths?.length || 0) + (urls?.length || 0);
    if (sources !== 1) return false; // one image in, one image out
    if (file_paths?.length && !allowLocalFiles) return false;
    try {
      return await client.images.supports(op);
    } catch {
      // The catalogue is unreachable — fall back to the job path rather than fail the call.
      return false;
    }
  }

  /**
   * Runs the op synchronously and returns where the bytes went. **Bytes never enter the context
   * window** — the same rule the job path follows, for the same reason: a base64 image is tokens
   * an agent pays for and cannot read.
   *
   * WHERE they went depends on where this server is running, and that is the whole of #118:
   *
   * - **stdio (local)**: a file in this process's temp directory. The agent is on this machine, so
   *   a path is the cheapest possible handle — nothing is uploaded, nothing is stored in the
   *   account. The file is named for what it actually is (#95); it used to be `<op>-<ts>.bin`
   *   whatever came back, so an agent handing the path to the next tool — or to a person — had to
   *   guess the format of a file we had just been told the type of.
   * - **hosted (HTTP)**: a signed URL, via the service's `?response=url` (contract §9). The agent
   *   is on another machine, so a path into THIS container's `/tmp` is an answer it cannot read —
   *   it was one before this, which is the defect. The link lives ~5 minutes and the bytes go to a
   *   short-lived temp object swept by the bucket's lifecycle rule, so nothing lands in the
   *   customer's asset catalogue either way and `stored: false` stays true in both modes.
   *
   * `allowLocalFiles` is the same flag that decides whether `file_paths` is accepted, and it means
   * the same thing here: "the caller and this process share a filesystem". Hosted mode sets it
   * false (src/http.js).
   */
  async function runSync(op, { file_paths, urls, parameters }) {
    const started = Date.now();
    // A URL gets the same gate here as on the job path (#96): `urls` must be public, and one input
    // must not be judged by which transport happens to carry it. The service refuses a private
    // address too (`SyncInputResolver` → `WebhookTargetGuard`), so this is about the contract being
    // one contract — plus a round trip saved and the same wording the agent already knows.
    const input = file_paths?.length ? { file: file_paths[0] } : { url: String(await assertPublicUrl(urls[0])) };
    const wantsUrl = !allowLocalFiles;
    // The caller's parameters travel in their own slot and can name nothing but an op parameter (#470): spread over
    // `input`, a `file` among them was a path on THIS host that the SDK read, before any key was checked.
    const result = await client.images.transformResult(op, {
      ...input,
      parameters: parameters || {},
      ...(wantsUrl ? { response: "url" } : {})
    });

    const common = { mode: "sync", op, durationMs: Date.now() - started, stored: false };

    if (wantsUrl) {
      // `?response=url` answers in JSON: { url, contentType, bytes, expiresInSeconds, width?, height? }.
      const body = result.json || {};
      return ok({
        ...common,
        url: body.url,
        mimeType: body.contentType ?? result.contentType,
        width: body.width ?? result.width,
        height: body.height ?? result.height,
        bytes: body.bytes,
        expiresInSeconds: body.expiresInSeconds,
        note:
          "Ran synchronously: nothing was stored in the account and no asset id exists. Submit it as a job if you need one. " +
          `The link above expires in about ${Math.round((body.expiresInSeconds ?? 300) / 60)} minute(s) — download it now, or ` +
          "submit the work as a job if you need a permanent URL."
      });
    }

    const { bytes, contentType, width, height } = result;
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(await scratchDir(), `${op}-${Date.now()}.${extensionFor(contentType)}`);
    await writeFile(path, bytes);

    return ok({
      ...common,
      path,
      mimeType: contentType,
      width,
      height,
      bytes: bytes.length,
      note:
        "Ran synchronously: nothing was stored in the account and no asset id exists. Submit it as a job if you need one. " +
        "The file is in this server's temp directory and is deleted when the server exits — copy it if you need it to last."
    });
  }

  /**
   * Submit and, with `wait`, hold on for the result — the first leg of the wait riding on the submit itself (#355, #520):
   * a job that settles inside the service's window comes back finished from the one request, with no read after it.
   * `submit(wait)` is the SDK call with the wait options it should pass on (`undefined` for a bare submit).
   */
  async function submitAndFinish(submit, input) {
    if (!input.wait) return finish(await submit(undefined), input);
    const waited = maxWaitSeconds ? Math.min(input.wait_seconds, maxWaitSeconds) : input.wait_seconds;
    // A server that can be drained holds the submit for less (#632). The submit is the one request a shutdown must not
    // cut — until it answers, the caller has no job id, and a retry is a second job and a second charge — so it cannot
    // take the drain's signal, and its hold has to end inside the drain's budget. The rest of the wait is reads, which can.
    const firstLeg = drain ? Math.min(waited, DRAINABLE_SUBMIT_HOLD_SECONDS) : waited;
    const started = Date.now();
    let job;
    try {
      job = await submit({ timeoutMs: firstLeg * 1000, throwOnFailure: false });
    } catch (err) {
      const running = firstLeg < waited && err instanceof JobFailedError && err.job && !TERMINAL.has(err.job.status);
      if (running) return finish(err.job, input, waited * 1000 - (Date.now() - started));
      const pending = stillRunning(err, input);
      if (pending) return pending;
      throw err;
    }
    return finish(job, input);
  }

  /**
   * A preset that does not exist, answered with the ones that do (#557). No tool lists presets, so a name guessed from the
   * task ("the standard thumbnail preset") had nothing to correct it: in the eval, agents guessed slugs one refusal at a
   * time, or saved their own copy of a built-in they could not find. Best effort — if the list cannot be read, the
   * refusal is answered as it came.
   */
  async function withPresetsNamed(err) {
    try {
      const presets = await client.presets.list();
      err.message = `${err.message}. Presets on this account: ${presets.map((p) => `${p.slug} (${p.name})`).join(", ")}`;
    } catch {
      // The refusal is still the answer.
    }
    return err;
  }

  /** Running out of patience is not a failure: the handle, and how to pick it up (#274). Null when `err` is anything else. */
  function stillRunning(err, { wait_seconds }) {
    if (!(err instanceof JobFailedError && err.job && !TERMINAL.has(err.job.status))) return null;
    const waited = maxWaitSeconds ? Math.min(wait_seconds, maxWaitSeconds) : wait_seconds;
    const capped = waited < wait_seconds ? ` (this hosted server waits at most ${maxWaitSeconds} s per call)` : "";
    return ok({
      ...jobRef(err.job),
      timedOut: true,
      note:
        `Still ${err.job.status} after ${waited} s of waiting${capped} — nothing was cancelled and the job keeps running ` +
        `(and will be charged for what completes). Poll job_status with jobId ${err.job.id}; do not submit it again.`
    });
  }

  /** The server is shutting down mid-wait (#632): the handle, the same shape as a wait that ran out. */
  function drained(job) {
    return ok({
      ...jobRef(job),
      timedOut: true,
      note:
        `This server is restarting, so it stopped waiting — the job was ${job.status} when it did. Nothing was cancelled and ` +
        `the job keeps running (and will be charged for what completes). Poll job_status with jobId ${job.id}; do not submit it again.`
    });
  }

  /**
   * The items a job_status answer carries (#573): the job document's first page, unless the agent asked for a page of
   * the items listing — `status` for the items in one state, `cursor` to read on from an earlier answer — or that first
   * page is not all of them, when it is read from the listing too, because only the listing says where the rest start.
   * The page comes back as the job's `items`, with the cursor to the next one while there is one.
   */
  async function itemsPage(job, status, cursor) {
    if (!status && !cursor && !job.itemsTruncated) return job;
    const { items, meta } = await client.jobs.items(job.id, { status, cursor });
    const more = Boolean(meta?.hasMore && meta.nextCursor);
    return { ...job, items, itemsTruncated: more || undefined, itemsCursor: more ? meta.nextCursor : undefined, itemsStatus: status };
  }

  /**
   * A finished job's outputs as an answer carries them: the first {@link OUTPUTS_INLINE} and the total (#520). With
   * `publish`, EVERY output is published — that is what the agent asked for — and only the first page comes back.
   */
  async function outputsOf(job, { publish }) {
    if (!publish) {
      const { items, meta } = await client.assets.list({ jobId: job.id, perPage: OUTPUTS_INLINE, page: 0 });
      return { outputs: inItemOrder(items, job), total: meta?.total ?? items.length, cursor: meta?.nextCursor };
    }
    const all = await client.jobs.outputs(job);
    const unpublished = all.filter((a) => !a.published && !a.publicUrl).map((a) => a.id);
    const byId = new Map(all.map((a) => [a.id, a]));
    for (let at = 0; at < unpublished.length; at += 500) {
      for (const a of await client.assets.publish(unpublished.slice(at, at + 500))) byId.set(a.id, a);
    }
    return { outputs: all.slice(0, OUTPUTS_INLINE).map((a) => byId.get(a.id)), total: all.length };
  }

  /** `leftMs`: what is left of the wait when its first leg was the submit's (#632); the whole of it otherwise. */
  async function finish(job, input, leftMs) {
    if (!input.wait) return ok(jobRef(job));
    const waited = maxWaitSeconds ? Math.min(input.wait_seconds, maxWaitSeconds) : input.wait_seconds;
    let done = TERMINAL.has(job.status) ? job : null;
    // Already draining: a read started now would not see the abort that came before it.
    if (!done && drain?.aborted) return drained(job);
    try {
      done ??= await client.jobs.wait(job.id, { timeoutMs: leftMs ?? waited * 1000, throwOnFailure: false, signal: drain }, job);
    } catch (err) {
      if (drain?.aborted) return drained(job);
      // `throwOnFailure: false` quiets a terminal failure, not the deadline: the SDK still throws JobFailedError when the
      // job is merely slow. Reported as `job_failed` / `retryable: false`, that told an agent to stop — about a job that
      // was still running and about to be charged — and invited it to submit the same work again (#274).
      const pending = stillRunning(err, input);
      if (pending) return pending;
      throw err;
    }
    if (done.type === "parse") return ok({ ...jobRef(done), analyses: await analysesOf(done) });
    const { outputs, total, cursor } = await outputsOf(done, input);
    return ok(jobRef(done, outputs, total, cursor));
  }

  /**
   * Each analyzed input's answer, which is its job item's output (imagestep#338) — one per item, in item order, so two
   * runs over one asset never read each other's. analyze creates no asset (imagestep#202): there is nothing to publish,
   * and publishing someone's originals because they were analyzed would be the wrong default by a long way.
   */
  async function analysesOf(job) {
    // The job document carries the first page of items (imagestep#440); an analyze batch bigger than that keeps its
    // remaining answers behind the items endpoint, and an answer left out is the whole point of the call missing.
    // A for-await, not `Array.fromAsync`: that is Node 22, and `engines` says 20.
    let items = job.items || [];
    if (job.itemsTruncated) {
      items = [];
      for await (const item of client.jobs.iterateItems(job.id, { status: "COMPLETED" })) items.push(item);
    }
    return items.filter((i) => i.status === "COMPLETED" && i.output).map((i) => ({ assetId: i.sourceAssetId, output: i.output }));
  }

  /**
   * The operating contract, as a resource rather than a tool (imagestep#127).
   *
   * A tool is something an agent decides to call; the rules are something it should have read.
   * Exposing them as a resource means a client can attach them to the session the way it attaches
   * a file, and `instructions` above stays the one-paragraph version rather than growing into the
   * whole contract.
   *
   * It is fetched live, not baked in: the service owns the wording and bumps its own `version`, so
   * a package released months ago still serves today's rules. When the service cannot be reached
   * the read fails rather than returning stale advice invented here.
   */
  server.registerResource(
    "agent-guidelines",
    "imagestep://agent-guidelines",
    {
      title: "ImageStep agent operating guidelines",
      description:
        "How to drive ImageStep so the human can take over: read the op catalogue, price before you spend, " +
        "branch on `retryable`, keep batches consistent with a preset, and report a missing capability instead " +
        "of working around it.",
      mimeType: "text/markdown"
    },
    async (uri) => {
      const guidelines = await client.agent.guidelines();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: `<!-- version ${guidelines.version}, updated ${guidelines.updated} -->\n\n${guidelines.markdown}`
          }
        ]
      };
    }
  );

  function jsonContents(uri, data) {
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(data, null, 2) }] };
  }

  /**
   * The op catalogue and the model catalogue as resources (#281) — resources, not tools, so the tool count stays small.
   * They are how an MCP-only client (Claude Desktop: no curl, no console) reads what a parameter means or what a model
   * costs. Live, like the guidelines: a read that cannot reach the service fails rather than answering from a copy.
   */
  server.registerResource(
    "ops",
    "imagestep://ops",
    {
      title: "ImageStep op catalogue",
      description:
        "GET /api/v1/ops: every op with its parameter contract (type, default, description), prompt and asset requirements, " +
        "default model, pricing, and whether it has a synchronous form.",
      mimeType: "application/json"
    },
    async (uri) => {
      const ops = await fetchCatalogue(client, { baseUrl: options.baseUrl || "" });
      if (!ops) throw new Error("the op catalogue could not be read (GET /api/v1/ops)");
      return jsonContents(uri, ops);
    }
  );

  server.registerResource(
    "op",
    new ResourceTemplate("imagestep://ops/{op}", {
      list: options.catalogue?.length
        ? async () => ({
            resources: options.catalogue
              .filter((o) => o && o.op)
              .map((o) => ({ uri: `imagestep://ops/${o.op}`, name: o.op, description: o.description, mimeType: "application/json" }))
          })
        : undefined
    }),
    {
      title: "One op's contract",
      description: "One entry of GET /api/v1/ops: its parameters with type, default and description, and its price.",
      mimeType: "application/json"
    },
    async (uri, { op }) => jsonContents(uri, await client.ops.get(String(op)))
  );

  server.registerResource(
    "models",
    new ResourceTemplate("imagestep://models/{mode}", {
      list: async () => ({
        resources: MODEL_MODES.map((mode) => ({ uri: `imagestep://models/${mode}`, name: `models-${mode}`, mimeType: "application/json" }))
      })
    }),
    {
      title: "Model catalogue with prices",
      description: "GET /api/v1/ai-models?mode=: ai_image (generate, edit and the AI image ops) or analyze.",
      mimeType: "application/json"
    },
    async (uri, { mode }) => {
      if (!MODEL_MODES.includes(String(mode))) throw new Error(`mode must be one of ${MODEL_MODES.join(", ")}`);
      return jsonContents(uri, await client.models.list(String(mode)));
    }
  );

  /**
   * What the account has spent, by op, over the last 30 days (#279) — a resource like the catalogues, because a budget is
   * something an agent reads before a batch, not an action it takes. The window and grouping are the API's defaults; a
   * finer question is the REST endpoint's.
   */
  server.registerResource(
    "usage",
    "imagestep://usage",
    {
      title: "Spend by op, last 30 days",
      description:
        "GET /api/v1/usage?groupBy=op: credits charged, jobs created, items settled and synchronous calls per op over the last " +
        "30 days — the numbers a budget is held against. Read it before a large batch.",
      mimeType: "application/json"
    },
    async (uri) => jsonContents(uri, await client.usage.get({ groupBy: "op" }))
  );

  server.registerTool(
    "generate",
    {
      title: "Generate images from a prompt",
      annotations: WRITE_TOOL,
      description:
        "Text → image(s). Returns asset ids and public URLs, never bytes. " +
        "For a recurring character or product, pass `preset`: a saved preset (save_preset) whose generate step carries its " +
        "`subjects` — reference images plus a locked descriptor — so every image in a batch shows the same one; pin it as " +
        "slug@version when the batch has to match a later run. " +
        COST_NOTE,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000),
        count: z.number().int().min(1).max(10).default(1),
        model: z
          .string()
          .optional()
          .describe(
            "Image model id (default: the op's defaultModel, see the resource imagestep://ops/generate). " +
              "Models with their prices: the resource imagestep://models/ai_image."
          ),
        parameters: z.record(z.string(), z.any()).optional().describe('Model-specific parameters, e.g. {"aspectRatio": "16:9"}.'),
        preset: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A saved preset (slug, id, or slug@version to run exactly that version) whose generate step supplies the model, " +
              "default parameters and consistency subjects; {{subject.<name>}} in its prompt expands to the subject's descriptor. " +
              "Your prompt, model and parameters still override it."
          ),
        collection: collectionSchema,
        retention_days: retentionDaysSchema,
        dry_run: dryRunSchema,
        idempotency_key: idempotencyKeySchema,
        wait: waitSchema,
        wait_seconds: WAIT_SECONDS,
        publish: publishSchema
      })
    },
    async (input) => {
      try {
        const opts = {
          prompt: input.prompt,
          count: input.count,
          model: input.model,
          parameters: input.parameters,
          presetId: input.preset,
          collection: input.collection,
          retentionDays: input.retention_days
        };
        if (input.dry_run) return ok({ estimate: await client.ops.estimate("generate", opts) });
        return await submitAndFinish((wait) => client.ops.run("generate", { ...opts, idempotencyKey: input.idempotency_key, wait }), input);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "transform",
    {
      title: "Run one atomic op on assets, or render a template",
      annotations: WRITE_TOOL,
      description:
        "Apply one operation to one or more images, or render a template: " +
        catalogue.ops.join(", ") +
        (catalogue.live
          ? ". "
          : " (built-in list — GET /api/v1/ops could not be read, so an op added since this release may be missing). ") +
        "Inputs are asset ids, local file paths (stdio) or public URLs. " +
        "ONE local file or URL with a deterministic op runs synchronously and NOTHING is stored in the account (no asset id): " +
        (allowLocalFiles
          ? "the result is written to a temp file on this machine and the answer carries its `path`. "
          : "the answer carries a signed `url` that expires in about five minutes — download it, or run the work as a job if you need a permanent URL. ") +
        "Several images, asset ids, or any AI op run as a job and " +
        "return asset ids and public URLs. Neither mode ever returns image bytes. " +
        "render_template takes no images: parameters {templateId (id or id@version), items: [one object of template variables per PNG]}. " +
        "variants gives several outputs from one call as ONE job (e.g. every social size). " +
        "read_metadata costs no credits; a local file stores nothing, but urls are ingested first, so each becomes an asset in the account and counts toward its asset quota. " +
        COST_NOTE,
      inputSchema: z.object({
        op: z.enum(catalogue.ops),
        asset_ids: assetIdsSchema,
        file_paths: filePathsSchema,
        urls: urlsSchema,
        prompt: z.string().max(4000).optional().describe(PROMPT_NOTE),
        model: z
          .string()
          .optional()
          .describe(
            "Override the op's default model (AI ops). Models with their prices: the resource imagestep://models/ai_image " +
              "(imagestep://models/analyze for analyze)."
          ),
        parameters: z.record(z.string(), z.any()).optional().describe(PARAMETERS_NOTE),
        variants: z
          .array(
            z.object({
              name: z.string().min(1).max(100).optional().describe("Unique within the call; each result item carries it as `variant`."),
              parameters: z
                .record(z.string(), z.any())
                .describe("This variant's parameters, merged over the shared top-level `parameters`.")
            })
          )
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Several outputs from one call (contract §8): the op runs once per variant for every input image, in ONE job, and each " +
              'variant is a new asset. Top-level `parameters` are the shared half, e.g. parameters {fit:"cover"} with variants ' +
              '[{"name":"ig","parameters":{"width":1080,"height":1350}},{"name":"x","parameters":{"width":1600,"height":900}}].'
          ),
        collection: collectionSchema,
        retention_days: retentionDaysSchema,
        dry_run: imageDryRunSchema,
        idempotency_key: idempotencyKeySchema,
        wait: waitSchema,
        wait_seconds: WAIT_SECONDS,
        publish: publishSchema
      })
    },
    async (input) => {
      try {
        assertOpParameters(input.parameters, "parameters");
        input.variants?.forEach((v, i) => assertOpParameters(v.parameters, `variants[${i}].parameters`));
        // read_metadata on bytes the agent is holding needs no asset at all, and it is free.
        // read_metadata on a local file needs no asset at all, and it is free. A URL still goes
        // the long way: the metadata call takes bytes, and fetching it here just to hand it back
        // would duplicate what ingest already does.
        if (input.op === "read_metadata" && !input.asset_ids?.length && input.file_paths?.length === 1 && allowLocalFiles) {
          return ok({ mode: "sync", stored: false, ...(await client.images.metadata(input.file_paths[0])) });
        }
        // An op that takes no image (render_template) runs on its parameters alone. Images handed to it are refused, not
        // ignored: ingesting them would upload and store files the job never reads.
        const assetFree = catalogue.assetFree.includes(input.op);
        if (assetFree && (input.asset_ids?.length || input.file_paths?.length || input.urls?.length))
          throw Object.assign(new Error(`${input.op} takes no images — pass its inputs in parameters (templateId and items)`), {
            code: "invalid_param",
            param: "asset_ids"
          });
        const unstored = unstoredCount(input, allowLocalFiles);
        if (!assetFree && !input.dry_run && (await canRunSync(input.op, input))) {
          return await runSync(input.op, input);
        }

        const assetIds = assetFree ? [] : input.dry_run ? [...(input.asset_ids || [])] : await ingest(input);
        if (!assetFree && !assetIds.length && !unstored)
          throw Object.assign(new Error("give at least one of asset_ids, file_paths or urls"), {
            code: "invalid_param",
            param: "asset_ids"
          });
        if (input.op === "read_metadata") {
          return ok({ assets: await Promise.all(assetIds.map((id) => client.ops.readMetadata(id))) });
        }
        const opts = {
          assetIds: assetFree ? undefined : assetIds,
          ...(unstored ? { imageCount: unstored } : {}),
          prompt: input.prompt,
          model: input.model,
          parameters: input.parameters,
          collection: input.collection,
          retentionDays: input.retention_days,
          ...(input.variants?.length ? { variants: input.variants } : {})
        };
        if (input.dry_run) return ok({ estimate: await client.ops.estimate(input.op, opts) });
        return await submitAndFinish((wait) => client.ops.run(input.op, { ...opts, idempotencyKey: input.idempotency_key, wait }), input);
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "run_preset",
    {
      title: "Run a saved preset (a versioned list of steps) on assets",
      annotations: WRITE_TOOL,
      description:
        "Presets are the way to chain ops (resize → convert → sharpen…) and to keep output consistent across batches. " +
        "Pass the preset slug or id (built-ins like builtin-util-to-webp, or your own), or slug@version — what save_preset " +
        "answers with — to run exactly that version. A preset whose first step is generate starts from its prompt and takes no " +
        "images: call it with the preset alone, or with a prompt of your own for this run and a count. " +
        "For a recurring character or product, a preset's `subjects` carry both halves of consistency — the " +
        "reference images pin the geometry and each subject's locked `descriptor` expands into the prompt wherever " +
        "the preset's prompt or yours writes {{subject.<name>}} — so a new scene is a new prompt here, not a new version, " +
        "and it names the subject as {{subject.<name>}} instead of re-describing it. " +
        COST_NOTE,
      inputSchema: z.object({
        preset: z.string().min(1).describe("Preset slug or id, or slug@version to run exactly that version."),
        prompt: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "This run's prompt, in place of the one on the preset's AI step. {{subject.<name>}} expands to that subject's " +
              "descriptor. A preset of several steps, or with no AI step, refuses it (invalid_param on prompt)."
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many images a preset that starts from a prompt makes; default 1. With images, one output per input."),
        asset_ids: assetIdsSchema,
        file_paths: filePathsSchema,
        urls: urlsSchema,
        collection: collectionSchema,
        retention_days: retentionDaysSchema,
        dry_run: imageDryRunSchema,
        idempotency_key: idempotencyKeySchema,
        wait: waitSchema,
        wait_seconds: WAIT_SECONDS,
        publish: publishSchema
      })
    },
    async (input) => {
      try {
        const unstored = unstoredCount(input, allowLocalFiles);
        const assetIds = input.dry_run ? [...(input.asset_ids || [])] : await ingest(input);
        // Read only to decide or to describe (#520): with an image in hand nothing below needs the preset's full export.
        const preset = assetIds.length && !input.dry_run ? null : await client.presets.get(input.preset);
        // A preset that starts from a prompt takes no image (#380): save_preset tells an agent to save "generate + subjects"
        // for a consistent batch, and until this looked at the preset, nothing over MCP could then run it. Anything else
        // with no image is still refused here, by name, before a job is priced.
        if (!assetIds.length && !unstored && !startsWithoutAnImage(preset))
          throw Object.assign(
            new Error("give at least one of asset_ids, file_paths or urls — this preset's first step works on an image"),
            {
              code: "invalid_param",
              param: "asset_ids"
            }
          );
        // The reference as given, not the id it resolved to (#279, #250): `slug@version` is how a run stays the version
        // save_preset answered with — the id alone runs whatever the current version is by then.
        if (input.dry_run)
          return ok({
            preset: { id: preset.id, slug: preset.slug, version: preset.version, steps: preset.steps?.length },
            estimate: await client.presets.run(input.preset, assetIds, {
              dryRun: true,
              ...(unstored ? { imageCount: unstored } : {}),
              collection: input.collection,
              retentionDays: input.retention_days,
              prompt: input.prompt,
              count: input.count
            })
          });
        // prompt and count go as given: which presets take a prompt is the service's rule (a chain or a deterministic
        // preset is 400 invalid_param on prompt), and fail() hands that refusal to the agent as it came (#461).
        return await submitAndFinish(
          (wait) =>
            client.presets.run(input.preset, assetIds, {
              idempotencyKey: input.idempotency_key,
              collection: input.collection,
              retentionDays: input.retention_days,
              prompt: input.prompt,
              count: input.count,
              wait
            }),
          input
        );
      } catch (err) {
        return fail(err?.code === "preset_not_found" ? await withPresetsNamed(err) : err);
      }
    }
  );

  /**
   * The one L2 write an MCP-only client can make (#279, decision B). The guidelines say a chain run twice is a preset and a
   * consistent batch is a preset with subjects; with no shell and no console, an MCP client could do neither and strung
   * ops together one job at a time — PRD §3.0's fourth rule broken at run time. Steps are L1 ops only: a registry step
   * (`{operation, params}`) is authored where a person reviews it, never in a tool schema.
   */
  server.registerTool(
    "save_preset",
    {
      title: "Save a preset (a named, versioned list of op steps)",
      annotations: WRITE_TOOL,
      description:
        "Save steps you will run again as a preset, then run it with run_preset. Save one when you have run the same chain twice, " +
        "or when a batch has to stay consistent (a preset with subjects). Each step is one op from the catalogue with the parameters " +
        "transform takes for it (the resource imagestep://ops/{op}); the service checks every step before storing anything and refuses " +
        "a bad one with invalid_param naming steps[i] — including an order that cannot run: an op that answers with JSON " +
        "(analyze) anywhere but last, or one that reads no image (generate) in a preset of several steps. Steps may mix " +
        "deterministic ops and AI ops: a preset with an AI step beside other steps runs as one chain job, and run_preset's " +
        "dry_run prices it step by step. Answers `warnings` when the steps are legal but probably not what you meant. " +
        "Answers `preset` as slug@version: pass that to run_preset so a later run is this version. " +
        "A slug already in use is refused; pick another. Free: no credits, no job.",
      inputSchema: z.object({
        name: z.string().min(1).max(200).describe("What a person sees in the console."),
        slug: z.string().min(1).max(100).optional().describe("URL-safe identifier; derived from name when omitted. builtin- is reserved."),
        description: z.string().max(2000).optional().describe("One sentence on what the preset is for."),
        steps: z
          .array(
            z.object({
              op: z.enum(STEP_OPS),
              model: z.string().optional().describe("AI steps only: the model. Default: the op's defaultModel."),
              prompt: z.string().max(4000).optional().describe("AI steps only. {{subject.<name>}} expands to that subject's descriptor."),
              parameters: z.record(z.string(), z.any()).optional().describe("The op's parameters — the same contract transform takes.")
            })
          )
          .min(1)
          .max(20)
          .describe("Run in order, one op per step."),
        subjects: z
          .array(
            z.object({
              name: z.string().min(1).max(64).describe("Referenced in a prompt as {{subject.<name>}}."),
              referenceAssetIds: z
                .array(z.string().min(1))
                .min(1)
                .max(4)
                .describe("Your own finished assets; they pin the geometry. At most four across all subjects."),
              descriptor: z.string().min(1).max(2000).describe("Colour and material only — the images carry the shape.")
            })
          )
          .max(4)
          .optional()
          .describe("Consistency for a recurring character or product. Needs a generate or edit step."),
        idempotency_key: writeKeySchema
      })
    },
    async (input) => {
      try {
        const saved = await client.presets.create(
          { name: input.name, slug: input.slug, description: input.description, steps: input.steps, subjects: input.subjects },
          { idempotencyKey: input.idempotency_key }
        );
        const ref = `${saved.slug}@${saved.version}`;
        return ok({
          preset: ref,
          id: saved.id,
          slug: saved.slug,
          version: saved.version,
          steps: saved.steps?.length ?? input.steps.length,
          // The preset was saved either way (imagestep#416); this is the client that has nowhere else to read them,
          // since it has no console and does not see the HTTP response.
          ...(saved.warnings?.length ? { warnings: saved.warnings } : {}),
          note: `Run it with run_preset {preset: "${ref}"}. Changing its steps later makes a new version; this one stays runnable as ${ref}.`
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "job_status",
    {
      title: "Job status and outputs",
      annotations: READ_TOOL,
      description:
        "Progress of a job by id (per-item states) and, once finished, its output asset ids — with public URLs for outputs already published, or pass publish:true. " +
        "Items come a page at a time: items_cursor reads on, items_status reads only the items in one state (FAILED: what a resume would run again). Free.",
      inputSchema: z.object({
        job_id: z.string().min(1),
        publish: statusPublishSchema,
        items_status: z
          .enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"])
          .optional()
          .describe(
            "Only the job's items in this state, a page at a time — FAILED is what a resume would run again. The answer's items are that page; its itemsCursor reads on."
          ),
        items_cursor: z
          .string()
          .max(500)
          .optional()
          .describe("The itemsCursor of an earlier job_status answer: the items after it. Send the same items_status as that call, if any.")
      })
    },
    async ({ job_id, publish, items_status, items_cursor }) => {
      try {
        const job = await client.jobs.get(job_id);
        // The analyses and the outputs' order read the job document; only the items shown are the page asked for.
        const shown = await itemsPage(job, items_status, items_cursor);
        // The same answer finish() gives: `transform {op: analyze, wait: false}` then job_status is the path the
        // guidelines recommend, and without this it ended in an empty `outputs` and no answer (#274).
        if (job.type === "parse") {
          const completed = (job.items || []).some((i) => i.status === "COMPLETED") || job.completedItems > 0;
          return ok(completed ? { ...jobRef(shown), analyses: await analysesOf(job) } : jobRef(shown));
        }
        if (job.status !== "COMPLETED") return ok(jobRef(shown));
        const { outputs, total, cursor } = await outputsOf(job, { publish });
        return ok(jobRef(shown, outputs, total, cursor));
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "search_assets",
    {
      title: "Search assets",
      annotations: READ_TOOL,
      description:
        "Find assets by collection, name/keyword, mime type, tag, size, ingest state or when they were made. Returns references (id, dimensions, tags, publicUrl, expiry) — never bytes. " +
        'With group_by "collection" it lists your collections instead — check a name before filtering or submitting into it, since a ' +
        "misspelt one is simply a new collection. Free.",
      inputSchema: z.object({
        group_by: z
          .enum(["collection"])
          .optional()
          .describe(
            '"collection" lists your collections (name, asset count, when the latest was added), most recently added to first, ' +
              "instead of assets; only q (part of the name), page, cursor and per_page apply."
          ),
        q: z.string().max(200).optional().describe("Keyword in name / metadata; with group_by, part of a collection's name."),
        collection: z.string().max(200).optional().describe("Collection name, matched exactly."),
        tag: z.string().max(100).optional().describe("One of the asset's tags — the caller's own labels — matched exactly."),
        mime: z.string().max(100).optional().describe("e.g. image/png"),
        view: z.enum(["ALL", "PUBLISHED"]).default("ALL"),
        min_width: z.number().int().optional(),
        min_height: z.number().int().optional(),
        status: z
          .enum(["PROCESSING", "DONE", "FAILED"])
          .optional()
          .describe("Ingest state. FAILED is an upload whose ingest never finished — check this after uploading a batch."),
        created_from: z
          .string()
          .max(40)
          .optional()
          .describe("Only assets made since: an ISO-8601 date or instant in UTC (2026-09-14), or epoch millis."),
        created_to: z.string().max(40).optional().describe("Only assets made before; a bare date covers the whole of that day."),
        has_collection: z
          .boolean()
          .optional()
          .describe("false is everything not in a collection — what to tidy up. Cannot be combined with collection."),
        job_id: z
          .string()
          .max(100)
          .optional()
          .describe("Everything one job produced — the id job_status returns. An upload has no job and never matches."),
        page: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Page number from 0; leave it out to start from the top, and when you send cursor."),
        // #493: the way to read on. A page number makes the service re-read and re-count every row before it.
        cursor: z
          .string()
          .max(500)
          .optional()
          .describe("The nextCursor of the previous answer: the rows after it. Send it unchanged, with the same filters; not with page."),
        // The REST default is 100 (imagestep#435); this tool asks for less on purpose. A page lands in your
        // context, and a context is a viewport — the same reason the console's grid asks for 48. Ask for more
        // when you are collecting ids rather than reading rows.
        per_page: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Page size. 100 is the maximum; 20 keeps a browse cheap in context.")
      })
    },
    async (input) => {
      try {
        if (input.group_by === "collection") {
          // The collections are a grouping of the assets (#349); an asset filter would not narrow it, so it is refused, not ignored.
          const extra = [
            "collection",
            "tag",
            "mime",
            "min_width",
            "min_height",
            "status",
            "created_from",
            "created_to",
            "has_collection"
          ].filter((k) => input[k] !== undefined);
          if (input.view !== "ALL") extra.push("view");
          if (extra.length)
            throw Object.assign(new Error(`group_by takes only q, page, cursor and per_page, not ${extra.join(", ")}`), {
              code: "invalid_param",
              param: "group_by"
            });
          const { items, meta } = await client.assets.collections({
            q: input.q,
            page: input.page,
            cursor: input.cursor,
            perPage: input.per_page
          });
          return ok({
            collections: items.map((c) => ({
              collection: c.collection,
              count: c.count,
              lastAddedAt: c.lastCreatedAt ? new Date(c.lastCreatedAt).toISOString() : undefined
            })),
            page: meta?.page,
            perPage: meta?.perPage,
            total: meta?.total,
            hasMore: meta?.hasMore,
            nextCursor: meta?.nextCursor ?? undefined
          });
        }
        const { items, meta } = await client.assets.list({
          q: input.q,
          collection: input.collection,
          tag: input.tag,
          mime: input.mime,
          view: input.view,
          minWidth: input.min_width,
          minHeight: input.min_height,
          status: input.status,
          createdFrom: input.created_from,
          createdTo: input.created_to,
          hasCollection: input.has_collection,
          jobId: input.job_id,
          page: input.page,
          cursor: input.cursor,
          perPage: input.per_page
        });
        return ok({
          assets: items.map(assetRef),
          page: meta?.page,
          perPage: meta?.perPage,
          total: meta?.total,
          hasMore: meta?.hasMore,
          nextCursor: meta?.nextCursor ?? undefined
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  /**
   * PRD §3.1 put this on the v2 list; #279 brought it in. The contract's §7 tells an agent that a missing capability is a
   * report, not a detour — and for an MCP-only client that rule had no channel. The report is free, so it never loses to the
   * workaround on price.
   */
  server.registerTool(
    "send_feedback",
    {
      title: "Report what ImageStep could not do",
      annotations: WRITE_TOOL,
      // The first sentence is the trigger, not the purpose (#557): with "report it here … then tell the person", Claude
      // Haiku told the person and never reported — 26 of 27 runs of the tasks ImageStep cannot do.
      description:
        "Call this whenever you conclude ImageStep cannot do what the task asks — before you tell the person, every time. " +
        "That covers an input or output it cannot handle, an action none of these tools performs, an op that does not exist, a " +
        "parameter that is missing, a result that is wrong. Saying so in your reply reaches only the person; this reaches the " +
        "people who build ImageStep. Report instead of working around the gap with other ops. Free: no credits, no job.",
      inputSchema: z.object({
        kind: z
          .enum(["capability_gap", "bug", "other"])
          .describe("capability_gap: something ImageStep cannot do. bug: something it does wrong."),
        message: z.string().min(1).max(4000).describe("What you needed, what you tried, what happened."),
        op: z.string().max(64).optional().describe("The op it concerns — one that does not exist yet is the most useful report."),
        context: z
          .record(z.string(), z.any())
          .optional()
          .describe(
            "What helps reproduce it: ids, parameters, the requestId of a failed call. At most 4000 characters once encoded; never image bytes or keys."
          ),
        idempotency_key: writeKeySchema
      })
    },
    async (input) => {
      try {
        const report = await client.agent.feedback({
          kind: input.kind,
          message: input.message,
          op: input.op,
          context: input.context,
          idempotencyKey: input.idempotency_key
        });
        return ok({
          reported: true,
          ...(report?.id ? { id: report.id } : {}),
          kind: input.kind,
          note: "Logged. Tell the person what could not be done rather than working around it."
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}

const CATALOGUE_TTL_MS = 5 * 60_000;
const catalogueCache = new Map();

/** Tests share a module, so they have to be able to forget what a previous one cached. */
export function clearCatalogueCache() {
  catalogueCache.clear();
}

/**
 * `GET /api/v1/ops`, cached per base URL for five minutes.
 *
 * Cached because the hosted transport builds one server PER REQUEST (`src/http.js`): asking again
 * for every `tools/call` would put a round trip in front of every tool an agent runs, to learn
 * something that changes on deploys. The catalogue is the same for every account, so one entry per
 * base URL is the right shape. A failure is not cached — the next request tries again.
 *
 * @returns {Promise<object[]|null>} the catalogue, or null when it could not be read
 */
export async function fetchCatalogue(client, { baseUrl = "", ttlMs = CATALOGUE_TTL_MS } = {}) {
  const hit = catalogueCache.get(baseUrl);
  if (hit && Date.now() - hit.at < ttlMs) return hit.ops;
  try {
    const ops = await client.ops.list();
    if (Array.isArray(ops) && ops.length) {
      catalogueCache.set(baseUrl, { at: Date.now(), ops });
      return ops;
    }
  } catch {
    // Unreachable catalogue → the fallback list. A server that refuses to start because it could
    // not read a dropdown is worse than one whose dropdown is a release old.
  }
  return null;
}

/**
 * {@link createServer} with the op catalogue read first — the entry point both transports use.
 *
 * README §1's rule is that every surface enumerates `GET /api/v1/ops` instead of carrying its own
 * list. The MCP server asked the catalogue whether an op could run SYNCHRONOUSLY but still decided
 * whether it could be called at all from a hard-coded enum, so a deterministic op added to the API
 * was uncallable here until the package shipped again (#94).
 */
export async function createServerWithCatalogue(options) {
  const client = clientFor(options);
  return createServer({ ...options, client, catalogue: await fetchCatalogue(client, { baseUrl: options.baseUrl || "" }) });
}
