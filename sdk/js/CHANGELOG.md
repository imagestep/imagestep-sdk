# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## 0.2.0 — 2026-10-24

### Changed

- **Breaking:** `assets.delete()` answers the same shape for one id as for several, the API's batch result
  `{ deletedCount, deleted }` with `deleted` listing the ids. One id used to answer `{ deleted: 1 }`, a shape the SDK
  made up; code that reads `deleted === 1` now reads `deletedCount === 1`. The return type is
  `BatchDeleteResultDTO` (it was a union with `{ deleted: 1 }`). One id is still `DELETE /assets/{id}`, so an id
  that is not there still throws `404 asset_not_found`; several ids skip the ones already gone.
- `assets.uploadMany()` / `upload()`: a file the API will not stage fails with the API's own code
  ([API changelog](https://imagestep.dev/docs/changelog#2026-10-14-per-row-failures)) — `unsupported_format`
  (not an image; `param` `fileName`), `payload_too_large` (over 100 MB; `param` `fileSize`) or `invalid_param` (no
  size; `param` `fileSize`) — read from the API's new per-file `failure`. It used to be `invalid_param` on `file` for
  all three, a code the SDK made up.
- The generated `AssetError` schema type is now `ItemError` (`components["schemas"]["ItemError"]`): the same fields,
  plus an optional `param`, and the type every per-row failure has (an asset's `error`, `fromUrl`'s, a staged file's,
  an import's `failures`). Code that names `components["schemas"]["AssetError"]` names `ItemError` instead.

### Deprecated

- `ModelDTO` (`models.list()`): the snake_case fields, `parameters`, `supported_parameters` and `created` go on
  2027-01-12 — https://imagestep.dev/docs/changelog#2026-10-14-model-fields. Read the camelCase fields beside them
  (`providerPrice`, `priceRange`, `maxInputEdge`, …) and `params`, the parameters a model takes in the shape of an op's
  `params` (typed `ModelParam`).
- `WebhookEvent` data: `jobId` on `job.completed` / `job.failed`, `creditsCharged` and `itemIndex` go on 2027-01-12 —
  https://imagestep.dev/docs/changelog#2026-10-14-webhook-names. Read `id`, `actualCredits` and `index` beside them,
  the names `jobs.get()` gives the same facts. New and staying: `cancelledItems` on the job events, `op` on all four.

### Added

- `WebhookEvent` has `apiVersion: "v1"`: the API now sends the version of an event body's shape with every event.
  What may change inside `v1`, and the changelog that announces anything breaking: https://imagestep.dev/docs/changelog.
- `constructWebhookEvent` returns a typed `WebhookEvent`: narrow on `event.type` and `event.data` has that event's
  fields (`creditsCharged` on `job.completed`, `itemIndex` and `errorCode` on `job.item.failed`), generated from the
  API's OpenAPI document, which now describes every webhook. `data` used to be `Record<string, unknown>`. Passing your
  own type, `constructWebhookEvent<MyData>(…)`, works as before.
- `images.metadata()` returns `ImageMetadata` and `images.transform(…, { response: "url" })` / `transformResult().json`
  return `SyncUrlResult` — both exported, both generated from the OpenAPI document, which now describes these two
  answers. They used to be `Record<string, unknown>`; the JSON is the same.

### Fixed

- `ModelDTO.supported_parameters` (`models.list()`) is `string[]`, the keys a job's `parameters` may name on that model.
  It was `unknown`, and on some models a different list: the Gemini models said `aspect_ratio` where a job takes
  `aspectRatio`, and the analyze models listed chat parameters an analyze job refuses.

## 0.1.0 — 2026-10-03

First release of the JavaScript SDK for the [ImageStep](https://imagestep.dev) API.

- One client, `new ImageStep({ apiKey })`, over the whole public API: `assets` (upload, upload from URL, list and
  search, collections, tags, publish, download), `ops` (every op in the catalogue, plus a method per common op such as
  `removeBg` and `upscale`), `images` (the synchronous lane: bytes in, bytes out, nothing stored), `jobs` (submit,
  dry-run estimate, wait, outputs, resume, cancel), `presets`, `templates`, `models`, `webhooks` (including
  signature verification), `agent` and `usage`.
- Reliability built in: a `retryable` answer is retried with `Retry-After` honoured, every write carries one
  `Idempotency-Key` across its attempts, and every failure is an `ImageStepError` with `code`, `retryable`,
  `param` and the service's request id.
- Zero runtime dependencies (native `fetch`), ESM and CommonJS, TypeScript types generated from the API's OpenAPI
  document. Runs on Node 20+, Deno, Bun and edge runtimes.
