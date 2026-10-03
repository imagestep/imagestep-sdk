# imagestep

The image step for your automations — one API key, one job handle, one stable URL.
Generate, edit, remove backgrounds, upscale, convert and read metadata from Python 3.10+.
One runtime dependency (`httpx`), a sync and an async client, typed (TypedDicts generated from
the API's OpenAPI document).

```python
import os
from imagestep import ImageStep

client = ImageStep(api_key=os.environ["IMAGESTEP_API_KEY"])

asset = client.assets.upload("./product.jpg")                     # stage → PUT → finish → ready
job = client.ops.remove_bg(asset["id"], wait=True)                # or any op: upscale, resize, convert, generate…
[cutout] = client.jobs.outputs(job)
[published] = client.assets.publish(cutout["id"])
print(published["publicUrl"])                                     # https://cdn.imagestep.dev/<id>
```

**Only want the image back?** One call, nothing stored:

```python
small = client.images.transform("resize", file="./product.jpg", parameters={"width": 1200})
open("out.jpg", "wb").write(small)

# One op does one thing. Resize AND re-encode is two steps — save them as a preset and run it in one call:
webp = client.images.transform(None, file="./product.jpg", preset="web-optimize")
# your own render template, then a PNG from it (pin a version with f"{card['id']}@1")
card = client.templates.create({"name": "price-card", "html": "<h1>{{ title }}</h1>", "width": 1200, "height": 630})
png = client.images.render(card["id"], {"title": "Hello"})
```

Two paths, and the line between them is not speed — it is **who carries the retry**. `ops.*` gives
you a job: this service promises to finish it, which is what buys progress, cancellation, webhooks
and an `asset_id`. `images.*` runs while you wait and stores nothing, because you are still holding
the input, so a failure costs you one re-send. AI ops and batches are always jobs.

## Install

```sh
pip install imagestep
```

`ImageStep()` with no arguments reads `IMAGESTEP_API_KEY` (and `IMAGESTEP_BASE_URL`, default
`https://api.imagestep.dev`). `AsyncImageStep` has the identical surface with every method
awaitable — `async with AsyncImageStep() as client: await client.ops.upscale(...)`, and that
includes `images.*` (`await client.images.transform("resize", file=…, parameters={"width": 1200})`).

`construct_webhook_event` raises `WebhookSignatureError` when the signature does not check out; the
JavaScript SDK throws a plain `Error` there, and takes its key as an argument rather than from the
environment (it also runs on edge runtimes that have no `process.env`).

## What you get

|                                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client.ops.run(op, variants=[...])`   | one call, one asset per variant — the whole set of social sizes                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `client.ops`                           | `list` `get` `run` `estimate` `remove_bg` `upscale` `restore_face` `colorize` `analyze` `generate` `edit` `resize` `convert` `compress` `crop` `pad` `grayscale` `rotate` `flip` `flop` `trim` `flatten` `adjust` `mask` `blur_region` `overlay` `caption` `read_metadata` — the atomic-op vocabulary: `run(op, **opts)` submits any op as a job, `estimate` prices one without creating anything, and the rest are one helper per op |
| `client.images`                        | `sync_endpoints` `supports` `transform` `transform_result` `render` `metadata` — the synchronous face: `transform(op, file=… \| url=… \| asset_id=…, parameters={…})` → `bytes`, `transform_result(…)` → a `BinaryResult` with `content_type` / `width` / `height` as well, `render(template_id, data)` → PNG, `metadata(file)` → dict. Which ops may go this way is `GET /api/v1/ops`, never a list in this package |
| `client.assets`                        | `upload` `upload_many` `from_url` `wait_ready` `status` `download` `get` `list` `iterate` `collections` `iterate_collections` `rename_collection` `publish` `unpublish` `set_collection` `tag` `delete` — `upload()` takes a path · bytes · a binary file object, dedupes by sha1 and waits for ingest; `upload_many()` does many at once (one stage and one finish call per 500, `concurrency` PUTs, one status call per tick); `from_url()` has the SERVICE fetch each link instead, 20 to a request |
| `client.jobs`                          | `submit` `estimate` `get` `items` `iterate_items` `list` `iterate` `cancel` `resume` `wait` `outputs` — `wait(job_id, on_progress=…)` waits for completion (the service holds each read open — `GET /jobs/{id}?wait=` — so a five-second job costs one request, not a poll loop) and `outputs(job)` reads what it produced as list rows — one paged `GET /assets?job_id=`, not one read per item — or subscribe to `job.completed` webhooks instead of polling. The totals by status and type have no method — `client.get("/api/v1/jobs/counts")`; for one status, `list(status=…, per_page=1)` and read `meta["total"]` |
| `client.presets` | `list` `get` `create` `update` `delete` `delete_version` `import_` `run` — versioned lists of steps you save once and run by slug: `presets.run(slug, asset_ids, wait=True)` (`"slug@3"` pins version 3); `presets.import_()` (keyword clash); `presets.create({"name": …, "steps": [{"op": "generate", "prompt": "{{subject.hero}} on a rooftop"}], "subjects": [{"name": "hero", "referenceAssetIds": [asset_id], "descriptor": "a matte black bottle…"}]})` — the images pin the geometry (max 4 across all subjects, sent with the preset's `generate` / `edit` step) and the descriptor pins the words, expanding into the prompt wherever you write `{{subject.hero}}`; `get(slug)` exports `steps` + `subjects` + `version` + `versions`. A preset whose steps mix a model with other steps runs as **one** `chain` job, the image in between handed on for you; `jobs.estimate` prices it per segment in `steps` A preset keeps 50 versions on record: at the ceiling `update` is `422 resource_limit_exceeded` rather than dropping the oldest, and `delete_version(slug, n)` makes room — `slug@n` answers 404 from then on, so it is for versions nothing pins. |
| `client.templates` | `list` `iterate` `get` `versions` `create` `update` `delete` `import_` — HTML/CSS render templates; `list` is one page of rows without html / css, `get` the whole document; versioned: `update` saves `version + 1`, and `id@version` reads or renders one frozen version; a batch is a job: `ops.run("render_template", template_id=…, items=[…])` |
| `client.models` | `list` — the model catalogue with prices; `list("ai_image")` (default) or `list("analyze")` |
| `client.webhooks` | `list` `get` `create` `update` `delete` `rotate_secret` `test` `deliveries` `iterate_deliveries` `verify` `construct_event` — `create()` answers the signing secret once; `verify(raw_body, header, secret)` and `construct_event(…)` check a delivery's signature in your own handler |
| `client.agent` | `guidelines` `feedback` `reports` `iterate_reports` — what this API expects of an agent, and the channel for telling us an op you needed is missing |
| `client.usage` | `get` — credits charged, jobs created and items settled over a window, grouped by `op`, `key` or `day` |
| `ImageStepError` | every failure the API answers: `code` (closed set), `retryable` (what to branch on — without the service's own, true for a 429 or a 5xx), `param`, `details`, `retry_after`, and `request_id` — `error.requestId`, else the `X-Request-Id` header; quote it when reporting a failure. Writes carry an `Idempotency-Key` per call, reused across the SDK's own retries; pass `idempotency_key` to make your own retry the same submission |

## Pagination

Every list takes `page` (from 0) and `per_page` (100 by default and at most) and answers a `Page` —
`items` plus `meta` (`total`, `page`, `perPage`, `hasMore`, `nextCursor`). Out of range is clamped, not
refused, and `meta` reports the page actually served. Pass `cursor=meta["nextCursor"]` instead of a page
number to read the rows after it: the service counts nothing then (no `total`, no `page`), and page 1 000
costs what page 1 did.

Don't write the loop — each listing has an iterator that walks to the end, following the `nextCursor` each
*answer* carries:

```python
for asset in client.assets.iterate(collection="shoot-01"):
    print(asset["id"])
```

`assets.iterate` · `assets.iterate_collections` · `jobs.iterate` · `jobs.iterate_items(id)` · `templates.iterate` ·
`webhooks.iterate_deliveries(id)` · `agent.iterate_reports`, on both clients (`async for` on `AsyncImageStep`).
Pass `cursor=` (or `page=`) to resume a walk.

Every signature, parameter and return shape: **<https://imagestep.dev/docs/sdk>** — one reference for
both SDKs, held against these sources by a test.
