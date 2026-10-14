# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## Unreleased

### Deprecated

- `ModelDTO` (`models.list()`): the snake_case fields, `parameters`, `supported_parameters` and `created` go on
  2027-01-12 — https://imagestep.dev/docs/changelog#2026-10-14-model-fields. Read the camelCase fields beside them
  (`providerPrice`, `priceRange`, `maxInputEdge`, …) and `params`, the parameters a model takes in the shape of an op's
  `params` (typed `ModelParam`).
- `JobEvent` / `JobItemEvent` data: `jobId` on `job.completed` / `job.failed`, `creditsCharged` and `itemIndex` go on 2027-01-12 —
  https://imagestep.dev/docs/changelog#2026-10-14-webhook-names. Read `id`, `actualCredits` and `index` beside them,
  the names `jobs.get()` gives the same facts. New and staying: `cancelledItems` on the job events, `op` on all four.

### Changed

- **Breaking:** `assets.delete()` (sync and async) answers the same shape for one id as for several, the API's batch
  result `{"deletedCount": …, "deleted": [ids]}`, annotated `BatchDeleteResultDTO`. One id used to answer
  `{"deleted": 1}`, a shape the SDK made up; code that reads `["deleted"] == 1` now reads `["deletedCount"] == 1`.
  One id is still `DELETE /assets/{id}`, so an id that is not there still raises `404 asset_not_found`; several ids
  skip the ones already gone.
- `assets.upload_many()` / `upload()` (sync and async): a file the API will not stage fails with the API's own code
  ([API changelog](https://imagestep.dev/docs/changelog#2026-10-14-per-row-failures)) —
  `unsupported_format` (not an image; `param` `fileName`), `payload_too_large` (over 100 MB; `param` `fileSize`) or
  `invalid_param` (no size; `param` `fileSize`) — read from the API's new per-file `failure`. It used to be
  `invalid_param` on `file` for all three, a code the SDK made up.
- The generated `AssetError` TypedDict is now `ItemError` (in `imagestep._generated`): the same keys plus an optional
  `param`, and the type every per-row failure has.

- `ImageStepError.code` is `None` when the answer carried no error envelope — a proxy's HTML 502, an edge's bare 429 —
  as in the JavaScript SDK. It used to be `internal_error` for a 5xx and `unknown_error` otherwise; `unknown_error` is
  not a code the API sends, and `internal_error` claimed one it did not. Branch on `retryable` (unchanged: a 429 or a
  5xx is retryable) and `status` for those.

### Fixed

- `ModelDTO["supported_parameters"]` is typed `list[str]`: the keys a job's `parameters` may name on that model,
  derived by the API from the model's `parameters` (on some models it used to be a different, wrong list).
- `assets.iterate`, `jobs.iterate`, `jobs.iterate_items`, `jobs.outputs` and `agent.iterate_reports` (sync and async)
  annotated their items with types the module never imported, so `typing.get_type_hints` raised `NameError` and type
  checkers reported the names as undefined. Every public method's annotations now resolve, and a test holds them to it.
- Answers the API documents are typed with their generated TypedDicts instead of `dict[str, Any]`: `assets.status`
  (`AssetStatus`, including a failed asset's `error`), `assets.delete` (`BatchDeleteResultDTO`),
  `agent.feedback` (`Feedback`), `usage.get` (`UsageSummary`) and both `import_` methods. Annotations only — nothing
  changes at runtime.

### Added

- `JobEvent`, `JobItemEvent` and `WebhookTestEvent` have `apiVersion` (`"v1"`): the API now sends the version of an
  event body's shape with every event. What may change inside `v1`, and the changelog that announces anything
  breaking: https://imagestep.dev/docs/changelog.
- The resource types are importable from the package: `from imagestep import Asset, Job, JobSummary, UsageSummary`,
  and the rest of the names the JS SDK exports. They used to be reachable only through the private `_generated`
  module.
- `construct_webhook_event` is annotated with `WebhookEvent` (exported), the union of the generated `JobEvent`,
  `JobItemEvent` and `WebhookTestEvent` TypedDicts — a type checker narrows `data` on `event["type"]`. It used to be
  `dict[str, Any]`; the value is the same parsed JSON.
- `images.metadata` is annotated `ImageMetadata` and `images.transform` `bytes | SyncUrlResult` (sync and async), both
  generated TypedDicts and importable from the package. They used to be `dict[str, Any]`.

## 0.1.1 — 2026-10-03

### Changed

- The package's Repository link points to the public source repository,
  [imagestep/imagestep-sdk](https://github.com/imagestep/imagestep-sdk). No change to the code.

## 0.1.0 — 2026-10-03

First release of the Python SDK for the [ImageStep](https://imagestep.dev) API.

- `ImageStep` and `AsyncImageStep`, one surface for both: `assets` (upload, upload from URL, list and search,
  collections, tags, publish, download), `ops` (every op in the catalogue, plus a method per common op such as
  `remove_bg` and `upscale`), `images` (the synchronous lane: bytes in, bytes out, nothing stored), `jobs` (submit,
  dry-run estimate, wait, outputs, resume, cancel), `presets`, `templates`, `models`, `webhooks` (including
  signature verification), `agent` and `usage`.
- Reliability built in: a `retryable` answer is retried with `Retry-After` honoured, every write carries one
  `Idempotency-Key` across its attempts, and every failure is an `ImageStepError` with `code`, `retryable`,
  `param` and the service's request id.
- Python 3.10+, one runtime dependency (`httpx`), typed with TypedDicts generated from the API's OpenAPI document.
