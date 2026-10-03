# imagestep

The image step for your automations — one API key, one job handle, one stable URL.
Generate, edit, remove backgrounds, upscale, convert and read metadata from Node 20+, Deno,
Bun or an edge runtime. Zero runtime dependencies (native `fetch`), ESM + CJS, typed.

```js
import { ImageStep } from "imagestep";

const client = new ImageStep({ apiKey: process.env.IMAGESTEP_API_KEY });

const asset = await client.assets.upload("./product.jpg"); // stage → PUT → finish → ready
const job = await client.ops.removeBg(asset.id, { wait: true }); // or any op: upscale, resize, convert, generate…
const [cutout] = await client.jobs.outputs(job);
const [published] = await client.assets.publish(cutout.id);
console.log(published.publicUrl); // https://cdn.imagestep.dev/<id>
```

**Only want the image back?** One call, nothing stored:

```js
const small = await client.images.transform("resize", { file: "./product.jpg", parameters: { width: 1200 } });
await writeFile("out.jpg", small);

// One op does one thing. Resize AND re-encode is two steps — save them as a preset, run it in one call:
const webp = await client.images.transform(null, { file: "./product.jpg", preset: "web-optimize" });
// your own render template, then a PNG from it (pin a version with `${card.id}@1`)
const card = await client.templates.create({ name: "price-card", html: "<h1>{{ title }}</h1>", width: 1200, height: 630 });
const png = await client.images.render(card.id, { title: "Hello" });
```

Two paths, and the line between them is not speed — it is **who carries the retry**. `ops.*` gives
you a job: this service promises to finish it, which is what buys progress, cancellation, webhooks
and an `asset_id`. `images.*` runs while you wait and stores nothing, because you are still holding
the input, so a failure costs you one re-send. AI ops and batches are always jobs.

## Install

```sh
pnpm add imagestep     # npm install imagestep
```

`new ImageStep({ apiKey })` takes the key explicitly: **this package reads no environment variables**,
so it behaves the same in Node, a Cloudflare Worker and a test where `process` may not exist. (The
Python SDK, the CLI and the MCP server do read `IMAGESTEP_API_KEY` — those are processes you start,
not a library you embed.) One more deliberate difference from the Python SDK: on a bad signature
`constructWebhookEvent` throws a plain `Error`, where Python raises `WebhookSignatureError`.

Without a key the client sends no `Authorization`: the public reads (`ops.list`, `ops.get`, `agent.guidelines`) work
before you have one, and every other call is the service's `401`. `userAgent` names a tool built on this package (the
CLI sends `imagestep-cli/<version>`), and `fetch` takes your own — a proxy, a test, a self-signed local certificate.

## What you get

|                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.ops.run(op, { variants })`    | one call, one asset per variant — the whole set of social sizes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `client.ops`                          | `list` `get` `run` `estimate` `removeBg` `upscale` `restoreFace` `colorize` `analyze` `generate` `edit` `resize` `convert` `compress` `crop` `pad` `grayscale` `rotate` `flip` `flop` `trim` `flatten` `adjust` `mask` `blurRegion` `overlay` `caption` `readMetadata` — the atomic-op vocabulary: `run(op, opts)` submits any op as a job, `estimate` prices one without creating anything, and the rest are one helper per op |
| `client.images`                       | `syncEndpoints` `supports` `transform` `transformResult` `render` `metadata` — the synchronous face: `transform(op, { file \| url \| assetId, parameters })` → `Uint8Array` (the op's parameters only ever in `parameters`, never beside `file`), `transformResult(…)` → the same plus `contentType` / `width` / `height`, `render(templateId, data)` → PNG, `metadata(file)` → JSON. Which ops may go this way is `GET /api/v1/ops`, never a list in this package |
| `client.assets`                       | `upload` `uploadMany` `fromUrl` `waitReady` `status` `download` `get` `list` `iterate` `collections` `iterateCollections` `renameCollection` `publish` `unpublish` `setCollection` `tag` `delete` — `upload()` takes a path · Blob/File · bytes, dedupes by sha1 and waits for ingest; `uploadMany()` does many at once (one stage and one finish call per 500, `concurrency` PUTs, one status call per tick); `fromUrl()` has the SERVICE fetch each link instead, 20 to a request |
| `client.jobs`                         | `submit` `estimate` `get` `items` `iterateItems` `list` `iterate` `cancel` `resume` `wait` `outputs` — `submit(request, { wait })` holds on like `ops.run`; `wait(id, { onProgress })` waits for completion (the service holds each read open — `GET /jobs/{id}?wait=` — so a five-second job costs one request, not a poll loop) and `outputs(job)` reads what it produced as list rows — one paged `GET /assets?jobId=`, not one read per item — or subscribe to `job.completed` webhooks instead of polling. The totals by status and type have no method — `client.get("/api/v1/jobs/counts")`; for one status, `list({ status, perPage: 1 })` and read `meta.total` |
| `client.presets` | `list` `get` `create` `update` `delete` `deleteVersion` `import` `run` — versioned lists of steps you save once and run by slug: `presets.run(slug, assetIds, { wait: true })` (`"slug@3"` pins version 3); `presets.create({ name, steps: [{ op: "generate", prompt: "{{subject.hero}} on a rooftop" }], subjects: [{ name: "hero", referenceAssetIds: [assetId], descriptor: "a matte black bottle…" }] })` — the images pin the geometry (max 4 across all subjects, sent with the preset's `generate` / `edit` step) and the descriptor pins the words, expanding into the prompt wherever you write `{{subject.hero}}`; `get(slug)` exports `steps` + `subjects` + `version` + `versions`, `import()` replays them. A preset keeps 50 versions on record: at the ceiling `update` is `422 resource_limit_exceeded` rather than dropping the oldest, and `deleteVersion(slug, n)` makes room — `slug@n` answers 404 from then on, so it is for versions nothing pins. A preset whose steps mix a model with other steps runs as **one** `chain` job, the image in between handed on for you; `jobs.estimate` prices it per segment in `steps[]` |
| `client.templates` | `list` `iterate` `get` `versions` `create` `update` `delete` `import` — HTML/CSS render templates; `list` is one page of rows without html / css, `get` the whole document; versioned: `update` saves `version + 1`, and `id@version` reads or renders one frozen version |
| `client.models` | `list` — the model catalogue with prices; `list("ai_image")` (default) or `list("analyze")` |
| `client.webhooks` | `list` `get` `create` `update` `delete` `rotateSecret` `test` `deliveries` `iterateDeliveries` `verify` `constructEvent` — `create()` answers the signing secret once; `verify(rawBody, header, secret)` and `constructEvent(…)` check a delivery's signature in your own handler |
| `client.agent` | `guidelines` `feedback` `reports` `iterateReports` — what this API expects of an agent, and the channel for telling us an op you needed is missing |
| `client.usage` | `get` — credits charged, jobs created and items settled over a window, grouped by `op`, `key` or `day` |
| `ImageStepError` | every failure the API answers: `code` (closed set; `null` for an answer with no error envelope, such as a proxy's 502), `retryable` (what to branch on — without the service's own, true for a 429 or a 5xx), `param`, `details`, `retryAfter`, and `requestId` — `error.requestId`, else the `X-Request-Id` header; quote it when reporting a failure. Writes carry an `Idempotency-Key` per call, reused across the SDK's own retries; pass `idempotencyKey` to make your own retry the same submission |

## Pagination

Every list takes `page` (from 0) and `perPage` (100 by default and at most) and answers `{ items, meta }`,
where `meta` is `{ total, page, perPage, hasMore, nextCursor }`. Out of range is clamped, not refused, and
`meta` reports the page actually served. Pass `cursor: meta.nextCursor` instead of a page number to read the
rows after it: the service counts nothing then (no `total`, no `page`), and page 1 000 costs what page 1 did.

Don't write the loop — each listing has an iterator that walks to the end, following the `nextCursor` each
*answer* carries:

```js
for await (const asset of client.assets.iterate({ collection: "shoot-01" })) {
  console.log(asset.id);
}
```

`assets.iterate` · `assets.iterateCollections` · `jobs.iterate` · `jobs.iterateItems(id)` · `templates.iterate` ·
`webhooks.iterateDeliveries(id)` · `agent.iterateReports`. Pass `cursor` (or `page`) to resume a walk.

Every signature, parameter and return shape: **<https://imagestep.dev/docs/sdk>** — one reference for
both SDKs, held against these sources by a test.
