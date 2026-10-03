# n8n-nodes-imagestep

The [ImageStep](https://imagestep.dev) node for [n8n](https://n8n.io) — the image step for your
automations. Generate, edit, remove backgrounds, upscale, resize, convert and read metadata from
one node, hand n8n binaries straight to the API (no signed-upload glue), and get back asset ids
and stable public URLs. A trigger node starts a workflow when a job finishes, from a signed
webhook, so nothing polls.

Zero runtime dependencies: every request goes through n8n's own HTTP helpers.

- [Installation](#installation)
- [Credentials](#credentials)
- [The ImageStep node](#the-imagestep-node)
- [The ImageStep Trigger](#the-imagestep-trigger)
- [Templates](#templates)
- [Errors, cost and idempotency](#errors-cost-and-idempotency)
- [Compatibility](#compatibility)
- [Resources](#resources)
- [Version history](#version-history)

## Installation

In n8n: **Settings → Community Nodes → Install**, enter `n8n-nodes-imagestep`, accept the risk
prompt, install. Self-hosted from a shell:

```sh
npm install n8n-nodes-imagestep
```

Then restart n8n; **ImageStep** and **ImageStep Trigger** appear in the node picker. Follow the
[n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/) for
the details of your deployment.

## Credentials

Create an **ImageStep API** credential:

| Field | Value |
|---|---|
| API Key | an API key from the ImageStep console (Settings → API keys) |
| Base URL | `https://api.imagestep.dev` — change only for a self-hosted or staging ImageStep |

The credential test reads the key's own usage (`GET /api/v1/usage`), which only a valid key can: a
red test means the key is wrong or revoked, or the Base URL does not reach ImageStep. Requests are
sent as `Authorization: ApiKey …`.

## The ImageStep node

One node, a **Resource** and an **Operation** dropdown. It is marked usable as an AI-agent tool.

### Resource: Asset

- **Upload** — takes the binary property of the input item (default `data`), stages the upload,
  PUTs the bytes with the binary's mime type, finishes the upload and, with *Wait Until Ready* on,
  waits until dimensions and metadata are written. Optional *Collection*, an opaque
  name you can filter on later. Output: an asset reference (`assetId`, `name`, `status`,
  `mimeType`, `width`, `height`, `size`, `collection`, `publicUrl`, `expiresAt`).
- **Upload From URL** — *Image URLs* (commas or new lines, any number — sent 20 to a request and
  waited for together): ImageStep fetches each one
  and creates the asset, so nothing is downloaded into n8n. Same *Collection* and *Wait Until
  Ready*. One output item per URL: the asset reference plus `url`, or `{ url, error }` for a link
  that is private, dead or not an image — route those instead of stopping the workflow.
- **Get** — one asset by id, the same reference shape.
- **List** — filter by *Collection* (exact match), *Search*, *MIME Type*; paginate with *Page* / *Per
  Page*, or read on with *Cursor* — the `nextCursor` a previous List carried, which reads the page after it
  without counting. One output item per asset, each carrying `page`, `total`, `hasMore`, `nextCursor`.
- **List Collections** — one output item per collection (`collection`, `count`, `lastAddedAt`), most recently
  added to first; *Name Contains* narrows it, *Page* / *Per Page* / *Cursor* as above. The way to check a collection's
  name before an op puts results in it — a misspelt name is simply a new collection.
- **Publish** — comma-separated asset ids → each comes back with its stable `publicUrl` on the
  CDN: the asset itself at full size, not its thumbnail.

### Resource: Operation

- **Run** — one atomic operation, synchronously or as a job (see **Store Result** below). The **Op**
  dropdown is loaded live from `GET /api/v1/ops` (only job ops: AI and deterministic) and falls back
  to the built-in list
  `generate · edit · remove_bg · upscale · restore_face · colorize · analyze · resize · convert · compress ·
  crop · pad · grayscale · rotate · flip · flop · trim · flatten · adjust · mask · blur_region · overlay · caption · render_template` when that call fails
  — generated from the service's committed catalogue, so its descriptions are the catalogue's own. Fields:
  - **Input** — *Binary File* (the item's binary property), *Asset IDs* (comma-separated; one job
    over all of them), or *None* (for `generate`).
  - **Store Result** (default **off**) — off: one image in, the transformed bytes straight back out.
    Nothing is created in the account, nothing is published, nothing is polled — which matters
    because the job path had to publish the customer's image to a public URL just so the workflow
    could read its own output. On: it runs as a job, so you get an asset id, a permanent URL,
    progress and webhooks. Which ops may take the off path is the API's answer
    (`GET /api/v1/ops` → `syncEndpoint`), never a list in this package: AI ops always run as a job,
    and so does anything that is not one image — several *Asset IDs*, *None*, or a catalogue this
    node could not reach. One *Asset ID* does take it (the reference form of the endpoint: the
    service reads its own bucket), and *Binary File* comes back on the property it went in on.
    The catalogue is read once per execution, and off-path items run four at a time — the
    account's synchronous-lane ceiling; items that become jobs, uploads and presets still run one
    at a time, each holding one of the account's open job waits. Output order and `pairedItem`
    follow the input either way. An item that has to run as a job while Store Result is off is
    still waited for, but **nothing is published**: its outputs come back as asset ids with no
    `publicUrl`. Turn Store Result on to reach the Wait, Publish and Download switches below.
  - **Prompt** (generate / edit), **Count** (generate).
  - **Parameters** — JSON, e.g. `{"width": 1200, "fit": "inside"}` for `resize`,
    `{"format": "webp", "quality": 80}` for `convert`, `{"scaleFactor": 2}` for `upscale`. Every
    contract is in `GET /api/v1/ops`; a wrong value is a `400 invalid_param` naming the parameter,
    before any credit is spent.
  - **Dry Run** — price only; nothing is created or uploaded. Output: `{ dryRun: true, request, estimate }` with
    `estimatedCredits`, `sufficientCredit`, `assetCountLeft`. *Asset IDs* are priced as themselves; a
    *Binary File* is priced as one image (`imageCount: 1` in `request`) without being uploaded — the
    price depends on the op, model and parameters, never on the pixels.
  - **Wait for Result** (default on, shown with Store Result on) with **Wait Seconds** (default 180).
    Off → the job handle is returned immediately; continue with Job → Wait or the trigger.
  - **Publish Outputs** (default on, shown with Store Result on) → each output has a `publicUrl`.
  - **Download Outputs** — fetch each output into the binary property `data`, one output item per
    result (needs Publish).
  - **Options** — *Model* (override the op's default AI model), *Collection* (where the outputs go; default the input's). An op carries a
    model, never a preset: a fixed set of steps is a **Preset**, run from the Preset resource below.

  Output: a job reference — `jobId`, `type`, `status`, `totalItems`, `completedItems`,
  `failedItems`, `creditsCharged`, `items[]` (per-item status, `sourceAssetId`, `resultAssetId`,
  `error`, `errorCode`, `retryable`, `provider`, `model`, `credits`, and for a `chain` the `step`
  it is on and the `failedStep` it failed on — the first 100 items; past that `itemsTruncated` is
  `true`), and once finished `outputs[]` (asset references with `publicUrl`) — every output of the
  job, however many items it had, in item order. It is the same shape the ImageStep MCP server returns, so an agent and a workflow
  read the same fields. With **Dry Run** the output is `{ dryRun, request, estimate }` instead, and
  a chain's estimate carries `steps[]` — the price segment by segment.

### Resource: Preset

- **Run** — a saved, versioned list of steps over assets. The **Preset** dropdown lists built-ins
  first (`util-to-webp`, …) then the account's own; the value is the preset id. **Version** pins one
  version — `0` (the default) runs whichever is current when the workflow runs, `3` runs the steps
  saved as version 3 however the preset has moved on since. Every result is a new asset; the source is never
  overwritten; *Options → Collection* says which collection the results go in. Same Input / Dry Run / Store Result /
  Wait / Publish / Download switches as Operation → Run — except that a preset always runs as a job, so
  **Store Result** off means the job is waited for and nothing is published (the outputs come back as asset
  ids), and on shows Wait, Publish and Download.

  A preset whose steps mix a model with other steps — remove the background, then resize — runs as
  **one** `chain` job: one price, one settlement, and the image each step makes for the next is
  handed on and cleaned up for you.

### Resource: Job

- **Get** — the job reference by id; if the job is finished its outputs are collected and (with
  *Publish Outputs*) published.
- **Wait** — wait until the job is terminal (up to *Wait Seconds*), then as Get. The service does the waiting: the node reads `GET /jobs/{id}?wait=`, which answers the moment the job settles, so nothing polls on an interval.

## The ImageStep Trigger

A webhook trigger. On activation it registers an endpoint on your account
(`POST /api/v1/webhook-endpoints`) pointing at the workflow's webhook URL and subscribed to the
selected **Events** — `job.completed` and `job.failed` by default, the per-item events
`job.item.completed` / `job.item.failed` opt-in (a 500-item job sends 500 of those). The endpoint
id and its signing secret (shown once by the API) are kept in the node's static data; on
deactivation the endpoint is deleted.

Every delivery is verified before the workflow runs: `ImageStep-Signature: t=<epoch>,v1=<hex>`
is HMAC-SHA256 over `"<t>.<raw body>"` with the stored secret, the timestamp must be within
**Signature Tolerance** (default 300 s, the replay guard), and comparison is constant-time. A
delivery that fails is answered `401` and never reaches the workflow. A good one is answered
`200` immediately and emits one item: `{ id, type, createdAt, attempt, data }` where `data` is
the event payload (`jobId`, `type`, `status`, `totalItems`, `completedItems`, `failedItems`,
`creditsCharged`). Deduplicate on `id` if you must be exactly-once — the API retries
un-acknowledged deliveries for 24 h.

Two things to know:

- ImageStep only registers **`https://` URLs on public hosts** (never loopback / private
  ranges). A local n8n on `http://localhost:5678` cannot activate this trigger — set
  `WEBHOOK_URL` to your public tunnel or use n8n cloud.
- The signature is over the raw request bytes. n8n exposes them as `rawBody`; if a reverse proxy
  or an older n8n strips that, the node falls back to re-serialising the parsed JSON, which
  verifies only when the serialisation is byte-identical. If deliveries show up as `401` in the
  endpoint's delivery log, that fallback is the first thing to check.

## Templates

`templates/` holds two importable workflows with their own [README](./templates/README.md). They
ship in the npm package: a self-hosted n8n that installed it from a shell has them under
`node_modules/n8n-nodes-imagestep/templates/`.

1. **Google Drive folder → `remove_bg` → Google Sheets** — new file in a folder, background
   removed, a row with the public URL.
2. **Google Sheets prompt → `generate` → publish → write the URL back** to the same row.

The longer pipelines — product trio (one upload → cut-out · packshot · web size), the same character
on every card, the same product in every scene, a template per row — are n8n templates in the
open-source [recipes](https://github.com/imagestep/imagestep-sdk/tree/main/recipes), each beside a Node
script that runs the same pipeline.

## Errors, cost and idempotency

- An API error becomes an n8n error whose message reads `ImageStep <code> (param: <name>):
  <message>` and whose description carries `retryable=true|false`. `code` is from the closed set
  in the [API contract](https://imagestep.dev/docs/errors#codes) (`invalid_param`,
  `insufficient_credit`, `rate_limited`, `provider_unavailable`, …). With **Continue On Fail** the
  item becomes `{ error, code, param, retryable }` instead of stopping the run; with **Retry On
  Fail**, branch on `retryable`.
- A job that finishes with failed items is **not** an error: `failedItems` and each
  `items[].error` say what happened, and the successful outputs are still returned.
- Nor is a job that outlasts **Wait Seconds** a failed one: it keeps running (and is charged for
  what completes). The item fails with `Job … still PROCESSING` and `retryable=true`, so **Retry
  On Fail** picks the same job back up; with **Continue On Fail** the item is the job reference
  itself with `timedOut: true` beside `error` — branch on it and continue with Job → Wait.
- AI ops charge credits per item; deterministic ops (`resize`, `convert`, `compress`, `crop`,
  `pad`, `grayscale`, `rotate`, `flip`, `flop`, `trim`, `flatten`, `adjust`, `mask`, `blur_region`, `overlay`, `caption`) are free on paid plans. **Dry Run** shows the exact price.
- Every write carries an `Idempotency-Key` derived from the execution, the node, the item and the
  request, and a `retryable` answer is tried twice more with that same key, waiting what
  `Retry-After` says. So **Retry On Fail**, which runs the node again over every input item, gets
  back the jobs an earlier try already submitted instead of creating and charging them again.
  A refusal — `insufficient_credit` above all — is not retried; its description carries the
  `details`, `topUpUrl` among them, for whoever reads the failed run. Running the workflow again is
  a new execution, and does the work again.

## Compatibility

Tested against n8n's `n8n-workflow` 2.x API; requires Node 18+. No runtime dependencies.

## Resources

- Documentation and support: <https://imagestep.dev/docs/n8n>
- API reference: <https://imagestep.dev/docs/api>
- Support and bug reports: <https://imagestep.dev/support> (mention the n8n node)
- n8n community nodes: <https://docs.n8n.io/integrations/community-nodes/>

## Version history

See [CHANGELOG.md](./CHANGELOG.md).

- **0.1.0** — first release: ImageStep node (Asset · Operation · Preset · Job), ImageStep
  Trigger (signed webhooks), two templates.

## License

MIT
