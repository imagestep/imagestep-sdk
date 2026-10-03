import type { IDisplayOptions, INodeProperties, INodePropertyOptions, NodeParameterValue } from "n8n-workflow";
import { PROMPT_OPS, STATIC_OPS, toOpOptions } from "../../lib/ops";

/**
 * The ImageStep node's parameter surface: one node, `resource` × `operation` dropdowns, the n8n
 * convention. Kept apart from the runtime so the tests can walk it without instantiating n8n.
 */
export const RESOURCES: INodePropertyOptions[] = [
  { name: "Asset", value: "asset", description: "Upload, look up, list or publish images" },
  { name: "Operation", value: "op", description: "Run one atomic operation — remove_bg, upscale, resize, generate …" },
  { name: "Preset", value: "preset", description: "Run a saved pipeline (a versioned chain of operations)" },
  { name: "Job", value: "job", description: "Read or wait for a job and collect its outputs" }
];

export const OPERATIONS: Record<string, INodePropertyOptions[]> = {
  asset: [
    { name: "Upload", value: "upload", action: "Upload an asset", description: "Upload a binary file from the input item" },
    {
      name: "Upload From URL",
      value: "uploadFromUrl",
      action: "Upload assets from URLs",
      description: "Have ImageStep fetch public image URLs and create an asset from each — nothing is downloaded into n8n"
    },
    { name: "Get", value: "get", action: "Get an asset", description: "Fetch one asset by ID (dimensions, metadata, public URL)" },
    {
      name: "List",
      value: "list",
      action: "List assets",
      description: "Search assets by collection, keyword, mime type, ingest state or when they were made"
    },
    {
      name: "List Collections",
      value: "listCollections",
      action: "List collections",
      description: "Your collections with how many assets each holds, most recently added to first"
    },
    {
      name: "Publish",
      value: "publish",
      action: "Publish assets",
      description: "Publish assets so each gets a stable public URL on the CDN"
    }
  ],
  op: [{ name: "Run", value: "run", action: "Run an operation", description: "Submit one atomic operation as a job" }],
  preset: [{ name: "Run", value: "run", action: "Run a preset", description: "Run a saved preset over assets as a job" }],
  job: [
    { name: "Get", value: "get", action: "Get a job", description: "Read a job's status and, once finished, its outputs" },
    { name: "Wait", value: "wait", action: "Wait for a job", description: "Poll a job until it finishes and return its outputs" }
  ]
};

type Shown = string | string[];
type Conditions = Record<string, NodeParameterValue[]>;

function show(resource: Shown, operation?: Shown, extra?: Conditions): { displayOptions: IDisplayOptions } {
  const cond: Conditions = { resource: ([] as string[]).concat(resource) };
  if (operation) cond.operation = ([] as string[]).concat(operation);
  return { displayOptions: { show: { ...cond, ...(extra || {}) } } };
}

// ── Shared field builders (a name may repeat with disjoint displayOptions — the n8n idiom) ──

function inputModeFields(
  resource: Shown,
  operation: Shown,
  { allowNone, noneDescription = "No input image (generate)" }: { allowNone?: boolean; noneDescription?: string } = {}
): INodeProperties[] {
  const options: INodePropertyOptions[] = [
    { name: "Binary File", value: "binary", description: "Upload the binary property of the input item first" },
    { name: "Asset IDs", value: "assetIds", description: "Existing ImageStep asset IDs" }
  ];
  if (allowNone) options.push({ name: "None", value: "none", description: noneDescription });
  return [
    {
      displayName: "Input",
      name: "inputMode",
      type: "options",
      options,
      default: "binary",
      description: "Where the image(s) to process come from",
      ...show(resource, operation)
    },
    {
      displayName: "Binary Property",
      name: "binaryProperty",
      type: "string",
      default: "data",
      required: true,
      description: "Name of the binary property holding the image",
      ...show(resource, operation, { inputMode: ["binary"] })
    },
    {
      displayName: "Asset IDs",
      name: "assetIds",
      type: "string",
      default: "",
      required: true,
      placeholder: "ast_… or a comma-separated list",
      description: "One asset ID, or several separated by commas — one job over all of them",
      ...show(resource, operation, { inputMode: ["assetIds"] })
    }
  ];
}

/**
 * What Store Result means on each resource. An op can hand the image straight back; a preset always runs as a job and
 * always keeps its outputs, so there the switch decides only whether they are published or downloaded (#564).
 */
const STORE_RESULT: Record<"op" | "preset", string> = {
  op: "Whether to keep the result in your ImageStep account. Off (default): the image is transformed while you wait and handed straight back as binary — nothing is stored and nothing is published. On: it runs as a job, so you get an asset ID, a permanent URL, progress and webhooks. AI operations and multiple images always run as a job: with this off, that job is waited for and nothing is published — its outputs come back as asset IDs; turn it on to choose Wait, Publish and Download.",
  preset:
    "A preset always runs as a job and keeps its outputs as assets. Off (default): the job is waited for and nothing is published — the outputs come back as asset IDs. On: choose whether to wait, and whether to publish and download the outputs."
};

function jobControlFields(resource: "op" | "preset", operation: Shown): INodeProperties[] {
  return [
    {
      displayName: "Dry Run",
      name: "dryRun",
      type: "boolean",
      default: false,
      description:
        "Whether to only price the job — nothing is created, uploaded or charged; the output is the estimate. A Binary File is priced as one image without being uploaded: the price depends on the op, model and parameters, never on the pixels.",
      ...show(resource, operation)
    },
    {
      displayName: "Store Result",
      name: "storeResult",
      type: "boolean",
      default: false,
      description: STORE_RESULT[resource],
      ...show(resource, operation)
    },
    {
      displayName: "Wait for Result",
      name: "wait",
      type: "boolean",
      default: true,
      description:
        "Whether to wait until the job finishes and return its outputs. Off: return the job handle now and use Job → Wait or the ImageStep Trigger.",
      ...show(resource, operation, { dryRun: [false], storeResult: [true] })
    },
    {
      displayName: "Wait Seconds",
      name: "waitSeconds",
      type: "number",
      default: 180,
      typeOptions: { minValue: 5, maxValue: 3600 },
      description: "How long to wait before giving up (the job keeps running)",
      ...show(resource, operation, { dryRun: [false], wait: [true], storeResult: [true] })
    },
    ...outputFields(resource, operation, { dryRun: [false], wait: [true], storeResult: [true] })
  ];
}

function outputFields(resource: Shown, operation: Shown, extra?: Conditions): INodeProperties[] {
  return [
    {
      displayName: "Publish Outputs",
      name: "publish",
      type: "boolean",
      default: true,
      description:
        "Whether to publish result assets so each output has a stable publicUrl on the CDN: the output itself at full size, not a thumbnail",
      ...show(resource, operation, extra)
    },
    {
      displayName: "Download Outputs",
      name: "downloadOutput",
      type: "boolean",
      default: false,
      description: "Whether to fetch each output into the binary property `data` — one item per output (needs Publish)",
      ...show(resource, operation, { ...(extra || {}), publish: [true] })
    }
  ];
}

/**
 * imagestep#591 — how long to keep what this node stores: an automation that posts its outputs at once need not keep them
 * the plan's full retention, which is what filled the asset ceiling. Shorter only; 0 is the plan's.
 */
function retentionOption(what: string): INodeProperties {
  return {
    displayName: "Retention Days",
    name: "retentionDays",
    type: "number",
    typeOptions: { minValue: 0 },
    default: 0,
    description: `Keep ${what} this many days instead of your plan's retention, then delete it. Shorter only: more keeps the plan's. 0 keeps the plan's.`
  };
}

function collectionOption(): INodeProperties {
  return {
    displayName: "Collection",
    name: "collection",
    type: "string",
    default: "",
    description: "Collection the outputs (and any file this node uploads) go in; without one an output is in its input's collection"
  };
}

export const properties: INodeProperties[] = [
  {
    displayName: "Resource",
    name: "resource",
    type: "options",
    noDataExpression: true,
    options: RESOURCES,
    default: "op"
  },
  // One Operation dropdown per resource, written out: n8n's linter reads a parameter's default only from a literal.
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    options: OPERATIONS.asset,
    default: "upload",
    displayOptions: { show: { resource: ["asset"] } }
  },
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    options: OPERATIONS.op,
    default: "run",
    displayOptions: { show: { resource: ["op"] } }
  },
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    options: OPERATIONS.preset,
    default: "run",
    displayOptions: { show: { resource: ["preset"] } }
  },
  {
    displayName: "Operation",
    name: "operation",
    type: "options",
    noDataExpression: true,
    options: OPERATIONS.job,
    default: "get",
    displayOptions: { show: { resource: ["job"] } }
  },

  // ── Asset ──
  {
    displayName: "Image URLs",
    name: "urls",
    type: "string",
    typeOptions: { rows: 3 },
    default: "",
    required: true,
    placeholder: "https://cdn.example.com/shots/hero.png",
    description:
      "Public http(s) image URLs, separated by commas or new lines. ImageStep fetches them, 20 to a request; one output item per URL.",
    ...show("asset", "uploadFromUrl")
  },
  {
    displayName: "Binary Property",
    name: "binaryProperty",
    type: "string",
    default: "data",
    required: true,
    description: "Name of the binary property holding the file to upload",
    ...show("asset", "upload")
  },
  {
    displayName: "Collection",
    name: "collection",
    type: "string",
    default: "",
    description: "Collection to put the new asset in (an opaque name); filter on it later with Asset → List",
    ...show("asset", ["upload", "uploadFromUrl"])
  },
  { ...retentionOption("the new asset"), ...show("asset", ["upload", "uploadFromUrl"]) },
  {
    displayName: "Wait Until Ready",
    name: "waitForReady",
    type: "boolean",
    default: true,
    description: "Whether to wait until ingest has written dimensions and metadata (a few seconds for a photo)",
    ...show("asset", ["upload", "uploadFromUrl"])
  },
  {
    displayName: "Asset ID",
    name: "assetId",
    type: "string",
    default: "",
    required: true,
    ...show("asset", "get")
  },
  {
    displayName: "Collection",
    name: "collection",
    type: "string",
    default: "",
    description: "Only assets in this collection (exact match)",
    ...show("asset", "list")
  },
  {
    displayName: "Search",
    name: "q",
    type: "string",
    default: "",
    description: "Keyword in name / metadata",
    ...show("asset", "list")
  },
  {
    displayName: "Name Contains",
    name: "q",
    type: "string",
    default: "",
    description: "Only collections whose name contains this text (case-insensitive)",
    ...show("asset", "listCollections")
  },
  {
    displayName: "MIME Type",
    name: "mime",
    type: "string",
    default: "",
    placeholder: "image/png",
    ...show("asset", "list")
  },
  {
    displayName: "Status",
    name: "status",
    type: "options",
    default: "",
    description: "Ingest state. Failed is an upload whose ingest never finished — route those instead of processing them.",
    options: [
      { name: "Any", value: "" },
      { name: "Done", value: "DONE" },
      { name: "Failed", value: "FAILED" },
      { name: "Processing", value: "PROCESSING" }
    ],
    ...show("asset", "list")
  },
  {
    displayName: "Created After",
    name: "createdFrom",
    type: "string",
    default: "",
    placeholder: "2026-09-14",
    description: "Only assets made since this date (UTC) — how a scheduled workflow picks up what the last run left",
    ...show("asset", "list")
  },
  {
    displayName: "Created Before",
    name: "createdTo",
    type: "string",
    default: "",
    placeholder: "2026-09-21",
    description: "Only assets made before this date (UTC); a bare date covers the whole of that day",
    ...show("asset", "list")
  },
  {
    displayName: "Page",
    name: "page",
    type: "number",
    default: 0,
    typeOptions: { minValue: 0 },
    description: "Zero-based page number",
    ...show("asset", ["list", "listCollections"])
  },
  {
    displayName: "Cursor",
    name: "cursor",
    type: "string",
    default: "",
    placeholder: "the nextCursor of an earlier List",
    description:
      "The page after the one that returned this nextCursor, read without counting — how to read on through a large library. Page is ignored when this is set.",
    ...show("asset", ["list", "listCollections"])
  },
  {
    displayName: "Per Page",
    name: "perPage",
    type: "number",
    default: 100,
    typeOptions: { minValue: 1, maxValue: 100 },
    ...show("asset", ["list", "listCollections"])
  },
  {
    displayName: "Asset IDs",
    name: "assetIds",
    type: "string",
    default: "",
    required: true,
    placeholder: "ast_… or a comma-separated list",
    description: "Assets to publish — each comes back with its publicUrl, the asset itself at full size",
    ...show("asset", "publish")
  },

  // ── Operation ──
  {
    displayName: "Op Name or ID",
    name: "op",
    type: "options",
    typeOptions: { loadOptionsMethod: "getOps" },
    options: toOpOptions(STATIC_OPS),
    default: "remove_bg",
    required: true,
    description:
      'The atomic operation to run. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    ...show("op", "run")
  },
  ...inputModeFields("op", "run", { allowNone: true }),
  {
    displayName: "Prompt",
    name: "prompt",
    type: "string",
    typeOptions: { rows: 3 },
    default: "",
    description: "What to draw (generate) or the edit instruction (edit)",
    ...show("op", "run", { op: PROMPT_OPS })
  },
  {
    displayName: "Count",
    name: "count",
    type: "number",
    default: 1,
    typeOptions: { minValue: 1, maxValue: 10 },
    description: "Images to generate",
    ...show("op", "run", { op: ["generate"] })
  },
  {
    displayName: "Parameters",
    name: "parameters",
    type: "json",
    default: "{}",
    description:
      'Op parameters as JSON — resize {"width":1200,"fit":"inside"}; convert {"format":"webp","quality":80}; crop {"left","top","width","height"}; pad {"top","bottom","left","right","background"}; upscale {"scaleFactor":2}. GET /api/v1/ops lists every contract.',
    ...show("op", "run")
  },
  ...jobControlFields("op", "run"),
  {
    displayName: "Options",
    name: "options",
    type: "collection",
    placeholder: "Add option",
    default: {},
    options: [
      { displayName: "Model", name: "model", type: "string", default: "", description: "Override the op's default AI model (AI ops only)" },
      collectionOption(),
      retentionOption("the outputs (and any file this node uploads)")
    ],
    ...show("op", "run")
  },

  // ── Preset ──
  {
    displayName: "Preset Name or ID",
    name: "preset",
    type: "options",
    typeOptions: { loadOptionsMethod: "getPresets" },
    default: "",
    required: true,
    description:
      'A built-in preset or one saved in the console. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
    ...show("preset", "run")
  },
  {
    displayName: "Version",
    name: "presetVersion",
    type: "number",
    typeOptions: { minValue: 0 },
    default: 0,
    description:
      "Pin one version of the preset. 0 runs whichever version is current when the workflow runs; 3 runs the steps that were saved as version 3, however the preset has moved on since.",
    ...show("preset", "run")
  },
  ...inputModeFields("preset", "run", {
    allowNone: true,
    noneDescription: "No input image — the preset starts from a prompt (its first step is generate)"
  }),
  // imagestep#460 — the request-level prompt is how each item of a consistency preset gets its own scene while the
  // subjects stay fixed (contract §8). The node cannot know which preset has one AI step, so the service says so.
  {
    displayName: "Prompt",
    name: "prompt",
    type: "string",
    typeOptions: { rows: 3 },
    default: "",
    description:
      "Replaces the prompt on the preset's one AI step — the scene for this item. Write {{subject.&lt;name&gt;}} to use a subject's saved words instead of describing it again (in an expression, build the text in a Code node first: n8n reads {{ }} as its own). Empty runs the prompt saved on the preset; a preset with several steps or no AI step refuses one.",
    ...show("preset", "run")
  },
  {
    displayName: "Count",
    name: "count",
    type: "number",
    default: 0,
    typeOptions: { minValue: 0, maxValue: 10 },
    description: "Images to generate, for a preset that starts from a prompt. 0 leaves it to the preset (one).",
    ...show("preset", "run")
  },
  ...jobControlFields("preset", "run"),
  {
    displayName: "Options",
    name: "options",
    type: "collection",
    placeholder: "Add option",
    default: {},
    options: [collectionOption(), retentionOption("the outputs (and any file this node uploads)")],
    ...show("preset", "run")
  },

  // ── Job ──
  {
    displayName: "Job ID",
    name: "jobId",
    type: "string",
    default: "",
    required: true,
    ...show("job", ["get", "wait"])
  },
  {
    displayName: "Wait Seconds",
    name: "waitSeconds",
    type: "number",
    default: 180,
    typeOptions: { minValue: 5, maxValue: 3600 },
    ...show("job", "wait")
  },
  ...outputFields("job", ["get", "wait"])
];
