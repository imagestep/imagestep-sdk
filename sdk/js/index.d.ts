// Hand-written surface types for the JS SDK. Wire shapes come from the generated
// types/openapi.d.ts (regenerated from the service's OpenAPI document; CI fails on drift).
import type { components } from "./types/openapi.js";

export type Asset = components["schemas"]["Asset"] & { publicUrl?: string | null };
/** One row of `assets.list()` (imagestep#339): names, labels and measured size; `assets.get()` has the rest. */
export type AssetSummary = components["schemas"]["AssetSummary"];
/** One row of `assets.collections()` (imagestep#349): a collection's name, how many assets are in it, and when the latest was added. */
export type CollectionSummary = components["schemas"]["CollectionSummary"];
export type CollectionRenamed = components["schemas"]["CollectionRenamed"];
export type Job = components["schemas"]["Job"];
/** One row of `jobs.list` (imagestep#280): the counts and what ran — `items` only on `jobs.get`. */
export type JobSummary = components["schemas"]["JobSummary"];
export type JobItem = components["schemas"]["JobItem"];
export type JobRequest = components["schemas"]["JobRequest"];
export type OpDefinition = components["schemas"]["OpDefinition"];
export type PresetData = components["schemas"]["PresetData"];
export type TemplateData = components["schemas"]["TemplateData"];
export type TemplateSummary = components["schemas"]["TemplateSummary"];
export type ModelDTO = components["schemas"]["ModelDTO"];
export type WebhookEndpoint = components["schemas"]["WebhookEndpoint"];
export type WebhookDelivery = components["schemas"]["WebhookDeliverySummary"];
/** The delivery row's own name in the document (imagestep#436); `WebhookDelivery` stays as the word the docs use. */
export type WebhookDeliverySummary = components["schemas"]["WebhookDeliverySummary"];
export type PageMeta = components["schemas"]["PageMeta"];
/** What `usage.get` answers: the window, its `total` and one `Bucket` per group (contract §11). */
export type UsageSummary = components["schemas"]["Usage"];
export type ApiError = components["schemas"]["ApiError"];

/** Every op `POST /api/v1/jobs` takes — the L1 vocabulary of `OpsCatalog` (contract §8). */
export type OpName =
  | "generate"
  | "edit"
  | "remove_bg"
  | "upscale"
  | "restore_face"
  | "colorize"
  | "analyze"
  | "resize"
  | "convert"
  | "compress"
  | "crop"
  | "pad"
  | "grayscale"
  | "rotate"
  | "flip"
  | "flop"
  | "trim"
  | "overlay"
  | "caption"
  | "mask"
  | "blur_region"
  | "adjust"
  | "flatten"
  | "render_template"
  | "read_metadata";

/**
 * What `?dryRun=true` answers with (contract §5). Read from the generated document rather than written out here:
 * it used to be a hand copy, and it had already lost `presetName`, `presetVersion`, `processCountLeft` and
 * `prompt` before a chain's `steps[]` was added to it (imagestep#247). The service declares the shape on the
 * endpoint, so the two SDKs and this file all follow it.
 */
export type JobEstimate = components["schemas"]["JobEstimate"];

/** One segment of a `chain` estimate: `{index, op, model?, costPerItem, bound?}` (imagestep#246). */
export type JobEstimateStep = components["schemas"]["StepEstimate"];

export interface ImageStepOptions {
  /**
   * An API key from the console. Without one no `Authorization` is sent: the public reads (`ops.list` / `ops.get`,
   * `agent.guidelines`) work, and every other call is the service's own `401 unauthorized`.
   */
  apiKey?: string;
  baseUrl?: string;
  /** Your own `fetch`: tests, proxies, a self-signed local certificate. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxRetries?: number;
  /** Replaces `imagestep-js/<version>` — a tool built on this package names itself. */
  userAgent?: string;
}

/**
 * Waiting for a job. The service does the waiting (imagestep#355): a submit carries `wait`, and each read is
 * `GET /jobs/{id}?wait=<up to 60 s>`, which answers the moment the job settles.
 */
export interface WaitOptions {
  /** A floor between reads, for a service that answers early; not a polling interval. Default 1000. */
  intervalMs?: number;
  timeoutMs?: number;
  onProgress?: (job: Job) => void;
  signal?: AbortSignal;
  throwOnFailure?: boolean;
}

export interface RunOptions {
  assetIds?: string | string[];
  prompt?: string;
  count?: number;
  model?: string;
  parameters?: Record<string, unknown>;
  /** Run the op once per entry, one asset each; each entry's `parameters` merge over the top-level ones. Deterministic ops only (contract §8). */
  variants?: Array<{ name?: string; parameters?: Record<string, unknown> }>;
  /** `render_template` only: the template, as an id or `id@version` (imagestep#391). */
  templateId?: string;
  /** `render_template` only: one object of the template's variables per image it makes. */
  items?: Array<Record<string, unknown>>;
  /** Removed (imagestep#331): every output is a new asset and a job never overwrites its input. The service answers `400 invalid_param` to it. */
  mode?: never;
  /** The collection the outputs go in; without one, an output made from an asset is in that asset's collection. */
  collection?: string;
  /**
   * Keep what this makes this many days instead of your plan's retention — shorter only; more is kept for the plan's time
   * (imagestep#591). The asset's `expiresAt` says what was stamped.
   */
  retentionDays?: number;
  dryRun?: boolean;
  /**
   * With `dryRun` only (imagestep#586): images you have not stored yet, priced as that many more `assetIds` — nothing is
   * uploaded to ask. A submit needs the images themselves; the service refuses it without `dryRun`.
   */
  imageCount?: number;
  wait?: boolean | WaitOptions;
  idempotencyKey?: string;
  signal?: AbortSignal;
}
type RunResult<O extends RunOptions> = O extends { dryRun: true } ? JobEstimate : Job;

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  retries?: number;
  /** This call's own per-attempt timeout, instead of the client's. */
  timeoutMs?: number;
}
export interface RequestResult<T = unknown> {
  data: T;
  meta?: PageMeta;
  replayed: boolean;
  headers: Headers;
}

export class ImageStepError extends Error {
  status: number;
  /** From the closed set; `null` when the answer carried no error envelope (a proxy's 502) — `status` and `retryable` still say what happened. */
  code: string | null;
  retryable: boolean;
  param: string | null;
  details: Record<string, unknown> | null;
  retryAfter: number | null;
  requestUrl?: string;
  /** `error.requestId`, else the `X-Request-Id` header — quote it when reporting a failure (contract §11). */
  requestId: string | null;
}
export class JobFailedError extends Error {
  job: Job;
  retryable: false;
}

export function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
  opts?: { toleranceSeconds?: number; now?: number }
): Promise<boolean>;
export function constructWebhookEvent<T = Record<string, unknown>>(
  rawBody: string,
  header: string,
  secret: string,
  opts?: { toleranceSeconds?: number; now?: number }
): Promise<{ id: string; type: string; createdAt: string; data: T }>;

export interface UploadOptions {
  name?: string;
  mimeType?: string;
  /** The collection to put the new asset in: an opaque label, matched exactly by `assets.list({ collection })`. */
  collection?: string;
  /** Your own labels for the new asset (imagestep#334); `assets.list({ tag })` matches them exactly. */
  tags?: string[];
  /**
   * Keep what this makes this many days instead of your plan's retention — shorter only; more is kept for the plan's time
   * (imagestep#591). The asset's `expiresAt` says what was stamped.
   */
  retentionDays?: number;
  wait?: boolean;
  /** Default true: bytes ingested before come back as that asset instead of a new one (sha1 match), with its own tags. */
  reuseExisting?: boolean;
  signal?: AbortSignal;
}
export interface AssetListParams {
  page?: number;
  perPage?: number;
  /** `meta.nextCursor` of the previous page: the rows after it, uncounted (imagestep#493). Not with `page`. */
  cursor?: string;
  collection?: string;
  tag?: string;
  mime?: string;
  q?: string;
  view?: "ALL" | "PUBLISHED";
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /**
   * Capture-date bounds (EXIF DateTimeOriginal), as epoch millis or an ISO-8601 date read in UTC; a bare date
   * as an upper bound covers the whole of that day (imagestep#429).
   */
  takenFrom?: number | string;
  takenTo?: number | string;
  /** The same two forms, over when this service made or ingested the asset — an automation's own axis. */
  createdFrom?: number | string;
  createdTo?: number | string;
  source?: string;
  /** Ingest state; `FAILED` is an upload whose ingest never finished (imagestep#428). */
  status?: "PROCESSING" | "DONE" | "FAILED";
  /** Include a chain's intermediate products (imagestep#246); they are out of the library by default. */
  includeIntermediate?: boolean;
  /** Whether it is in a collection at all; `false` is everything you have not filed. Not with `collection` (imagestep#431). */
  hasCollection?: boolean;
  /** Everything one run produced (imagestep#430); an upload has no job and never matches. */
  jobId?: string;
  /** Only what this op produced, as `GET /api/v1/ops` names it; an upload has no op and never matches. */
  op?: string;
}

declare class Ops {
  list(): Promise<OpDefinition[]>;
  get(op: OpName | string): Promise<OpDefinition>;
  run<O extends RunOptions>(op: OpName | string, opts?: O): Promise<RunResult<O>>;
  estimate(op: OpName | string, opts?: RunOptions): Promise<JobEstimate>;
  removeBg<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  upscale<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  restoreFace<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  colorize<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  /** Structured JSON about each image: each job item's `output` (imagestep#338); the default answer's tags also join the asset's `tags`. */
  analyze<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  generate<O extends RunOptions>(prompt: string, opts?: O): Promise<RunResult<O>>;
  edit<O extends RunOptions>(assetIds: string | string[], prompt: string, opts?: O): Promise<RunResult<O>>;
  resize<O extends RunOptions>(
    assetIds: string | string[],
    parameters: {
      width?: number;
      height?: number;
      fit?: "cover" | "contain" | "fill" | "inside" | "outside";
      /** Which part `cover` keeps, or where `contain` places the image: a compass point, or `attention` / `entropy`. */
      gravity?: string;
      /** The letterbox colour for `fit: "contain"` only. Default: transparent, or white when the result is a JPEG. */
      background?: string;
      /** Default true: never upscale. A `cover` / `fill` box bigger than the image shrinks, shape kept, to the biggest one it covers (imagestep#463). */
      withoutEnlargement?: boolean;
      /** Default false. Turn the box to the image's orientation first: a portrait image asked for 1800×1200 gets 1200×1800. Needs width and height (imagestep#612). */
      matchOrientation?: boolean;
    },
    opts?: O
  ): Promise<RunResult<O>>;
  convert<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { format: "webp" | "jpeg" | "jpg" | "png" | "avif" | "gif" | "tiff"; quality?: number },
    opts?: O
  ): Promise<RunResult<O>>;
  compress<O extends RunOptions>(
    assetIds: string | string[],
    parameters?: { quality?: number; format?: "webp" | "jpeg" | "png" | "avif" },
    opts?: O
  ): Promise<RunResult<O>>;
  crop<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { left?: number; top?: number; width: number; height: number },
    opts?: O
  ): Promise<RunResult<O>>;
  pad<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { top?: number; bottom?: number; left?: number; right?: number; background?: string },
    opts?: O
  ): Promise<RunResult<O>>;
  grayscale<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  rotate<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { angle: number; background?: string },
    opts?: O
  ): Promise<RunResult<O>>;
  flip<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  flop<O extends RunOptions>(assetIds: string | string[], opts?: O): Promise<RunResult<O>>;
  trim<O extends RunOptions>(
    assetIds: string | string[],
    parameters?: { threshold?: number; background?: string },
    opts?: O
  ): Promise<RunResult<O>>;
  flatten<O extends RunOptions>(assetIds: string | string[], parameters?: { background?: string }, opts?: O): Promise<RunResult<O>>;
  adjust<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { brightness?: number; saturation?: number; hue?: number; lightness?: number; contrast?: number },
    opts?: O
  ): Promise<RunResult<O>>;
  mask<O extends RunOptions>(
    assetIds: string | string[],
    parameters?: { shape?: "circle" | "rounded"; radius?: number },
    opts?: O
  ): Promise<RunResult<O>>;
  blurRegion<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { width: number; height: number; left?: number; top?: number; sigma?: number; pixelate?: number },
    opts?: O
  ): Promise<RunResult<O>>;
  /** Job only: the layer is a stored asset of yours, and the synchronous endpoints hold no credential for one. */
  overlay<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { layerAssetId: string; gravity?: string; scale?: number; opacity?: number; margin?: number; tile?: boolean },
    opts?: O
  ): Promise<RunResult<O>>;
  caption<O extends RunOptions>(
    assetIds: string | string[],
    parameters: { text: string; font?: string; size?: number; color?: string; background?: string; gravity?: string; margin?: number },
    opts?: O
  ): Promise<RunResult<O>>;
  readMetadata(assetId: string): Promise<Pick<Asset, "id" | "name" | "image" | "metadata" | "expiresAt">>;
}

/** Input for the synchronous face: the image, and the op's parameters in `parameters` (contract §9). */
export interface TransformInput {
  /** Bytes, a Blob/File, a stream, or a local path (Node). */
  file?: string | Blob | ArrayBuffer | Uint8Array | ReadableStream;
  /** Fetch the input from here instead. */
  url?: string;
  /** Use one of your own stored assets instead. */
  assetId?: string;
  /** A deterministic preset id or slug, instead of `op`. */
  preset?: string;
  /** Answer a signed URL instead of the bytes. */
  response?: "url";
  signal?: AbortSignal;
  /** The op's own parameters, e.g. `{ width: 1200 }` — never beside the input's names (imagestep#470). */
  parameters?: Record<string, string | number | boolean>;
}
export interface TransformResult {
  bytes?: Uint8Array;
  json?: Record<string, unknown>;
  contentType: string;
  /** What the service measured (`X-ImageStep-Width` / `-Height`); null when it did not say. */
  width: number | null;
  height: number | null;
}

/**
 * The synchronous face (contract §9): bytes in, bytes out, nothing stored. Not for AI ops, batches,
 * or anything you want an `assetId` for — those are jobs.
 */
declare class Images {
  /** op → its `syncEndpoint`, straight from `GET /api/v1/ops`; never a list in this package. */
  syncEndpoints(): Promise<Record<string, string | null>>;
  supports(op: OpName | string): Promise<boolean>;
  transform(op: OpName | string | null, input?: TransformInput): Promise<Uint8Array | Record<string, unknown>>;
  /** `transform`, plus the `contentType` and the size the service measured (imagestep#95). */
  transformResult(op: OpName | string | null, input?: TransformInput): Promise<TransformResult>;
  /** One template row → one PNG. A batch is a job: `ops.run("render_template", { templateId, items })`. */
  render(
    templateId: string,
    data?: Record<string, unknown>,
    opts?: { signal?: AbortSignal }
  ): Promise<Uint8Array | Record<string, unknown>>;
  /** EXIF, GPS, dimensions, format and SHA-1. Free, and it stores nothing. */
  metadata(file: string | Blob | ArrayBuffer | Uint8Array, opts?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

declare class Assets {
  upload(input: string | Blob | ArrayBuffer | Uint8Array, opts?: UploadOptions): Promise<Asset>;
  /** Ingest images by URL — the service fetches them (imagestep#219), twenty to a request (#525). One result per URL, in order. */
  fromUrl(
    urls: string[],
    opts?: { collection?: string; tags?: string[]; retentionDays?: number; wait?: boolean; signal?: AbortSignal }
  ): Promise<Array<{ url: string; asset?: Asset; error?: { code: string; message: string; retryable: boolean; param?: string } }>>;
  /**
   * Upload many files at once (imagestep#525): one stage and one finish call per 500, `concurrency` PUTs at a time (default
   * 4), one status call per tick while they ingest. One result per input, in order.
   */
  uploadMany(
    inputs: Array<string | Blob | ArrayBuffer | Uint8Array>,
    opts?: {
      concurrency?: number;
      collection?: string;
      tags?: string[];
      retentionDays?: number;
      wait?: boolean;
      reuseExisting?: boolean;
      signal?: AbortSignal;
    }
  ): Promise<Array<{ name: string; asset?: Asset; error?: { code: string; message: string; retryable: boolean; param?: string } }>>;
  waitReady(id: string, opts?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Asset>;
  /** Ingest state of up to 100 of your assets in one call (imagestep#233); ids that are not yours are absent. */
  status(
    ids: string | string[],
    opts?: { signal?: AbortSignal }
  ): Promise<Array<{ id: string; status: "PROCESSING" | "DONE" | "FAILED"; width?: number; height?: number }>>;
  /** The asset's private bytes: follows the signed redirect without sending the API key to storage (imagestep#233). */
  download(
    id: string,
    opts?: { variant?: "readable" | "original" | "preview"; signal?: AbortSignal }
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  get(id: string, opts?: { signal?: AbortSignal }): Promise<Asset>;
  list(params?: AssetListParams): Promise<{ items: AssetSummary[]; meta: PageMeta }>;
  /** Every asset the filters match, a row at a time, paging as it goes (imagestep#437). */
  iterate(params?: AssetListParams): AsyncGenerator<AssetSummary, void, undefined>;
  /** Your collections, most recently added to first; `q` narrows to names containing it. */
  collections(params?: {
    q?: string;
    page?: number;
    perPage?: number;
    cursor?: string;
  }): Promise<{ items: CollectionSummary[]; meta: PageMeta }>;
  /** Every collection, one at a time, paging as it goes (imagestep#437). */
  iterateCollections(params?: {
    q?: string;
    page?: number;
    perPage?: number;
    cursor?: string;
  }): AsyncGenerator<CollectionSummary, void, undefined>;
  /** Move every asset in `from` to `to`; `null` or `""` takes them out of any collection. */
  renameCollection(from: string, to: string | null, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<CollectionRenamed>;
  publish(ids: string | string[], published?: boolean): Promise<Asset[]>;
  unpublish(ids: string | string[]): Promise<Asset[]>;
  /** Put assets in a collection; `null` or `""` takes them out of theirs. At most 200 characters; `job:` names are reserved. */
  setCollection(ids: string | string[], collection: string | null): Promise<Asset[]>;
  /** Replace the tags on assets; `[]` clears them (imagestep#334). */
  tag(ids: string | string[], tags: string[]): Promise<Asset[]>;
  delete(ids: string | string[]): Promise<{ deleted?: number } & Record<string, unknown>>;
}

declare class Jobs {
  /** `wait` holds on for the result, as `ops.run` does: the first leg rides on the submit itself. */
  submit(request: JobRequest, opts?: RequestOptions & { wait?: boolean | WaitOptions }): Promise<Job>;
  estimate(request: JobRequest, opts?: RequestOptions): Promise<JobEstimate>;
  /** `wait` (seconds, at most 60) long-polls: the service holds the response until the job is terminal or the window closes. */
  get(id: string, opts?: { signal?: AbortSignal; wait?: number }): Promise<Job>;
  /**
   * `preset` narrows to the jobs that ran one: a slug or id for every version, `slug@version` for the pinned one.
   * `op` is what a job was submitted as, `rootJobId` every attempt of one logical job, and the window takes epoch
   * millis or an ISO-8601 date read as UTC (imagestep#442).
   */
  list(params?: JobListParams): Promise<{ items: JobSummary[]; meta: PageMeta }>;
  /** Every job the filters match, a row at a time, paging as it goes (imagestep#437). */
  iterate(params?: JobListParams): AsyncGenerator<JobSummary, void, undefined>;
  /**
   * One page of a job's items (imagestep#440). A job document carries the first 100 inline and sets
   * `itemsTruncated` when there are more; each row carries the `index` the rest of the API names it by.
   */
  items(
    id: string,
    params?: { page?: number; perPage?: number; cursor?: string; status?: string }
  ): Promise<{ items: JobItem[]; meta: PageMeta }>;
  /** Every item of a job, one at a time, paging as it goes (imagestep#440). */
  iterateItems(
    id: string,
    params?: { page?: number; perPage?: number; cursor?: string; status?: string }
  ): AsyncGenerator<JobItem, void, undefined>;
  cancel(id: string): Promise<Job>;
  resume(id: string): Promise<Job>;
  wait(id: string, opts?: WaitOptions): Promise<Job>;
  /** The run's products as list rows, in item order — one paged `GET /assets?jobId=` (imagestep#441). */
  outputs(job: Job | string): Promise<AssetSummary[]>;
}

export interface JobListParams {
  page?: number;
  perPage?: number;
  /** `meta.nextCursor` of the previous page: the rows after it, uncounted (imagestep#493). Not with `page`. */
  cursor?: string;
  status?: string;
  type?: string;
  op?: string;
  preset?: string;
  rootJobId?: string;
  createdFrom?: number | string;
  createdTo?: number | string;
}

/** Render templates (imagestep#24 / #234): versioned — `update` saves `version + 1`, and `id@version` reads or renders one frozen version. */
declare class Templates {
  /** One page; rows carry no `html` / `css` — `get(id)` returns the whole document (imagestep#497). */
  list(
    filter?: "builtin" | "user",
    params?: { page?: number; perPage?: number; cursor?: string }
  ): Promise<{ items: TemplateSummary[]; meta: PageMeta }>;
  /** Every template, a row at a time, paging as it goes. */
  iterate(filter?: "builtin" | "user"): AsyncGenerator<TemplateSummary, void, undefined>;
  get(id: string): Promise<TemplateData>;
  versions(id: string): Promise<TemplateData[]>;
  create(template: TemplateData): Promise<TemplateData>;
  /** A new version from only what changes — the service merges the body over the current one (imagestep#376). */
  update(id: string, template: Partial<TemplateData>): Promise<TemplateData>;
  delete(id: string): Promise<void>;
  import(templates: TemplateData[]): Promise<components["schemas"]["BatchImportResultDTOTemplateData"]>;
}

declare class Presets {
  /** Rows carry no `versions` unless `includeVersions` is set; `versionCount` says how many there are (imagestep#444). */
  list(filter?: "builtin" | "user", opts?: { includeVersions?: boolean }): Promise<PresetData[]>;
  /** The export shape: the current steps and subjects, and every superseded version. */
  get(slug: string): Promise<PresetData>;
  create(preset: PresetData, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<PresetData>;
  /** Only what changes: the service merges the body over the current preset; new steps or subjects are a new version. */
  update(slug: string, preset: Partial<PresetData>): Promise<PresetData>;
  delete(slug: string): Promise<void>;
  /**
   * Drops one superseded version (imagestep#445): `slug@version` is `404 preset_not_found` from then on, and it is
   * the way past the 50-version ceiling a further `update` is refused at. The current version cannot be deleted.
   */
  deleteVersion(slug: string, version: number): Promise<void>;
  import(presets: PresetData[]): Promise<unknown>;
  run<
    O extends {
      wait?: boolean | WaitOptions;
      /** Removed (imagestep#331) — see `RunOptions.mode`. */
      mode?: never;
      /** The collection the outputs go in; default each input's. */
      collection?: string;
      /** Keep the outputs this many days instead of your plan's retention — shorter only (imagestep#591). */
      retentionDays?: number;
      /** This run's prompt for the preset's one AI step (imagestep#461); a chain or a deterministic preset refuses it. */
      prompt?: string;
      /** How many images a preset that starts from a prompt makes; default 1. */
      count?: number;
      dryRun?: boolean;
      /** With `dryRun` only (imagestep#586): images not stored yet, priced as that many more `assetIds`. */
      imageCount?: number;
      signal?: AbortSignal;
      idempotencyKey?: string;
    }
  >(presetId: string, assetIds: string | string[], opts?: O): Promise<O extends { dryRun: true } ? JobEstimate : Job>;
}

/**
 * What this key has spent (contract §11, imagestep#125): credits charged, jobs created and items
 * settled over a window, grouped by `op`, `key` or `day`.
 */
declare class Usage {
  /** `from`/`to` are `YYYY-MM-DD` or ISO-8601 instants; the window defaults to the last 30 days. */
  get(params?: { from?: string; to?: string; groupBy?: "op" | "key" | "day" }): Promise<UsageSummary>;
}

/** The model catalogue with prices. */
declare class Models {
  list(mode?: "ai_image" | "analyze"): Promise<ModelDTO[]>;
}

declare class Webhooks {
  list(): Promise<WebhookEndpoint[]>;
  get(id: string): Promise<WebhookEndpoint>;
  create(input: { url: string; events?: string[]; description?: string; enabled?: boolean }): Promise<WebhookEndpoint & { secret: string }>;
  update(id: string, patch: Partial<{ url: string; events: string[]; description: string; enabled: boolean }>): Promise<WebhookEndpoint>;
  delete(id: string): Promise<void>;
  rotateSecret(id: string): Promise<WebhookEndpoint & { secret: string }>;
  test(id: string): Promise<WebhookDelivery>;
  deliveries(
    id: string,
    params?: { page?: number; perPage?: number; cursor?: string }
  ): Promise<{ items: WebhookDelivery[]; meta: PageMeta }>;
  /** Every delivery to one endpoint, newest first, one at a time, paging as it goes (imagestep#437). */
  iterateDeliveries(
    id: string,
    params?: { page?: number; perPage?: number; cursor?: string }
  ): AsyncGenerator<WebhookDelivery, void, undefined>;
  verify: typeof verifyWebhookSignature;
  constructEvent: typeof constructWebhookEvent;
}

export interface AgentGuidelines {
  version: number;
  updated: string;
  markdown: string;
}

export interface FeedbackReport {
  kind: "capability_gap" | "bug" | "other";
  message: string;
  op?: string;
  context?: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface Feedback {
  id: string;
  kind: string;
  op?: string;
  message: string;
  context?: Record<string, unknown>;
  /** The key it was reported with; absent when a signed-in console session filed it. */
  apiKeyId?: string;
  createdAt: string;
}

export class Agent {
  guidelines(): Promise<AgentGuidelines>;
  feedback(report: FeedbackReport): Promise<Feedback>;
  reports(params?: { page?: number; perPage?: number; cursor?: string }): Promise<{ items: Feedback[]; meta: PageMeta }>;
  /** Every report this account has filed, one at a time, paging as it goes (imagestep#437). */
  iterateReports(params?: { page?: number; perPage?: number; cursor?: string }): AsyncGenerator<Feedback, void, undefined>;
}

export class ImageStep {
  constructor(options?: ImageStepOptions);
  apiKey: string | null;
  baseUrl: string;
  agent: Agent;
  ops: Ops;
  images: Images;
  assets: Assets;
  jobs: Jobs;
  presets: Presets;
  templates: Templates;
  models: Models;
  webhooks: Webhooks;
  usage: Usage;
  request<T = unknown>(method: string, path: string, opts?: RequestOptions): Promise<RequestResult<T>>;
  /** The raw-bytes call the synchronous endpoints use: no JSON envelope, `bytes` or `json` depending on what came back. */
  requestBinary(
    path: string,
    opts?: { body?: BodyInit; contentType?: string; accept?: string; signal?: AbortSignal; retries?: number; timeoutMs?: number }
  ): Promise<{ bytes?: Uint8Array; json?: unknown; contentType: string; headers: Headers }>;
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<RequestResult<T>>;
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<RequestResult<T>>;
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<RequestResult<T>>;
  del<T = unknown>(path: string, opts?: RequestOptions): Promise<RequestResult<T>>;
}
export default ImageStep;
