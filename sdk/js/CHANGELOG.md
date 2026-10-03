# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## 0.1.0 — Unreleased

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
