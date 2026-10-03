# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

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
