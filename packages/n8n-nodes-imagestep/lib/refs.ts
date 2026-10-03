import type { IDataObject } from "n8n-workflow";

/**
 * Asset-by-reference output shapes — the same `assetRef` / `jobRef` the MCP server returns
 * (packages/mcp/src/server.js), so a workflow and an agent read the same fields. Never bytes,
 * never a data URL: an output is an id, its dimensions and a public URL.
 */

/** The measured facts of an image: under `image` on a full record, flat on a list row (imagestep#339). */
interface ImageFacts {
  mimeType?: string;
  width?: number;
  height?: number;
  size?: number;
}

/** An asset document as the API returns it — the fields this package reads. */
export interface Asset extends ImageFacts {
  id: string;
  name?: string;
  status?: string;
  image?: ImageFacts | null;
  collection?: string | null;
  tags?: string[] | null;
  publicUrl?: string | null;
  expiresAt?: string | number | null;
  metadata?: IDataObject | null;
}

/** One item of a job document. */
export interface JobItem {
  status?: string;
  sourceAssetId?: string;
  resultAssetId?: string | null;
  error?: string;
  errorMessage?: string;
  errorCode?: string;
  retryable?: boolean;
  step?: number;
  failedStep?: number;
  provider?: string;
  model?: string;
  durationMs?: number;
  credits?: number;
  startedAt?: string;
  finishedAt?: string;
  output?: IDataObject;
}

/** A job document as the API returns it — the fields this package reads. */
export interface Job {
  id: string;
  type?: string;
  status: string;
  op?: string;
  presetId?: string;
  presetVersion?: number;
  templateId?: string;
  templateVersion?: number;
  totalItems?: number;
  completedItems?: number;
  failedItems?: number;
  creditsCharged?: number;
  actualCredits?: number;
  expiresAt?: string;
  items?: JobItem[];
  itemsTruncated?: boolean;
}

/** The body of `POST /api/v1/jobs`. */
export interface JobBody extends IDataObject {
  assetIds?: string[];
  imageCount?: number;
  prompt?: string;
  count?: number;
  collection?: string;
  retentionDays?: number;
}

function pick<T extends object>(object: T, keys: Array<keyof T>): Partial<T> {
  return Object.fromEntries(
    keys.filter((key) => object[key] !== undefined && object[key] !== null).map((key) => [key, object[key]])
  ) as Partial<T>;
}

export function assetRef(a: Asset): IDataObject;
export function assetRef(a: Asset | null | undefined): IDataObject | null;
export function assetRef(a: Asset | null | undefined): IDataObject | null {
  if (!a) return null;
  // A list row carries the measured facts flat (imagestep#339); a full record under `image`.
  const info: ImageFacts = { ...(a.image || {}), ...pick(a, ["mimeType", "width", "height", "size"]) };
  return {
    assetId: a.id,
    name: a.name,
    status: a.status,
    mimeType: info.mimeType,
    width: info.width,
    height: info.height,
    size: info.size,
    collection: a.collection || undefined,
    tags: a.tags?.length ? a.tags : undefined,
    publicUrl: a.publicUrl || undefined,
    expiresAt: a.expiresAt ? new Date(a.expiresAt).toISOString() : undefined,
    // `read_metadata` is a sync op answered by the asset itself (contract §8): exiftool's map rides on
    // Asset → Get so a workflow can file by `DateTimeOriginal` and `GPSLatitude` / `GPSLongitude` (imagestep#333).
    metadata: a.metadata || undefined
  };
}

/**
 * The job output shape, including each item's trace (contract §11, imagestep#125): who ran it, on
 * what, how long it took and what it cost. A workflow that branches on a failure can read
 * `items[n].retryable` and `items[n].provider` out of the node output instead of opening a console.
 */
export function jobRef(job: Job, outputs?: Asset[]): IDataObject {
  const items = (job.items || []).map((i) => ({
    status: i.status,
    sourceAssetId: i.sourceAssetId,
    resultAssetId: i.resultAssetId,
    error: i.error || i.errorMessage || undefined,
    errorCode: i.errorCode,
    retryable: i.retryable,
    // A `chain` item is delivered once per segment (imagestep#246): which one it is on, and which one it failed
    // on, is the single fact a branch on a failure cannot work out from the rest of this object.
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
    completedItems: job.completedItems ?? items.filter((i) => i.status === "COMPLETED").length,
    failedItems: job.failedItems ?? items.filter((i) => i.status === "FAILED").length,
    creditsCharged: job.creditsCharged ?? job.actualCredits,
    expiresAt: job.expiresAt,
    items,
    // The job document inlines its first 100 items (imagestep#440); `outputs` is every output all the same (#522).
    itemsTruncated: job.itemsTruncated || undefined,
    outputs: outputs ? outputs.map((o) => assetRef(o)) : undefined
  };
}

/**
 * Body of `POST /api/v1/jobs` for one atomic op (docs/api-contract.md §8). Empty / undefined
 * inputs are left out so the service applies its own defaults and `invalid_param` names only what
 * the caller actually sent.
 */
export function buildOpJobBody({
  op,
  assetIds,
  imageCount,
  prompt,
  count,
  model,
  parameters,
  collection,
  retentionDays
}: {
  op: string;
  assetIds?: unknown;
  imageCount?: number;
  prompt?: string;
  count?: number | string | null;
  model?: string;
  parameters?: IDataObject;
  collection?: string;
  retentionDays?: number | string;
}): JobBody {
  if (!op) throw new TypeError("op is required");
  const body: JobBody = { op };
  const ids = normaliseIds(assetIds);
  if (ids.length) body.assetIds = ids;
  // A Dry Run's images that were not uploaded to be priced (imagestep#586).
  if (imageCount) body.imageCount = imageCount;
  if (prompt) body.prompt = prompt;
  if (count !== undefined && count !== null && count !== "") body.count = Number(count);
  if (model) body.model = model;
  if (parameters && typeof parameters === "object" && Object.keys(parameters).length) body.parameters = parameters;
  if (collection) body.collection = collection;
  // Shorter than the plan's retention only (imagestep#591); 0 or empty is the plan's.
  if (Number(retentionDays) >= 1) body.retentionDays = Number(retentionDays);
  return body;
}

/**
 * Body of `POST /api/v1/jobs` for a saved preset over existing assets. The preset decides the job type
 * (imagestep#245), and `version` pins one of its versions — `slug@3` runs the steps that were saved as 3 however
 * the preset has moved on since. A ref that already carries an `@` is left alone, so an expression that builds
 * its own `slug@version` still works. Every output is a new asset — a job never overwrites its input (imagestep#331),
 * and goes in `collection` when one is given (else in its input's).
 *
 * `prompt` and `count` land on the preset's ONE AI step (contract §8): the prompt is how each item of a consistency
 * preset carries its own scene while the subjects stay fixed (imagestep#460). `fromPrompt` is the Input = None case — a
 * preset whose first step is `generate` takes no image (#373); whether this preset is one is the service's to say.
 */
export function buildPresetJobBody({
  presetId,
  assetIds,
  imageCount,
  version,
  collection,
  retentionDays,
  prompt,
  count,
  fromPrompt
}: {
  presetId: string;
  assetIds?: unknown;
  imageCount?: number;
  version?: number | string;
  collection?: string;
  retentionDays?: number | string;
  prompt?: string;
  count?: number | string;
  fromPrompt?: boolean;
}): JobBody {
  if (!presetId) throw new TypeError("presetId is required");
  const ids = normaliseIds(assetIds);
  if (!ids.length && !imageCount && !fromPrompt) throw new TypeError("at least one asset id is required");
  const body: JobBody = { presetId: pinVersion(presetId, version), assetIds: ids };
  if (imageCount) body.imageCount = imageCount;
  if (prompt) body.prompt = prompt;
  if (Number(count) >= 1) body.count = Number(count);
  if (collection) body.collection = collection;
  if (Number(retentionDays) >= 1) body.retentionDays = Number(retentionDays);
  return body;
}

/** `ref` at `version`, or as given when no version was asked for (or one is already on it). */
function pinVersion(ref: string, version: number | string | undefined): string {
  const wanted = Number(version);
  if (!Number.isInteger(wanted) || wanted < 1 || String(ref).includes("@")) return ref;
  return `${ref}@${wanted}`;
}

/** Accepts an array, a comma / newline separated string, or nothing. */
export function normaliseIds(assetIds: unknown): string[] {
  if (!assetIds) return [];
  const list: unknown[] = Array.isArray(assetIds) ? assetIds : String(assetIds).split(/[\s,]+/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

/** `parameters` arrives from n8n as a JSON string (type "json") or already as an object. */
export function parseParameters(value: unknown): IDataObject | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object") return value as IDataObject;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? (parsed as IDataObject) : undefined;
  } catch (cause) {
    throw new TypeError("Parameters must be a JSON object", { cause });
  }
}
