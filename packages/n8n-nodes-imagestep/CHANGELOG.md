# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## 0.1.3 — 2026-10-03

### Changed

- The node is written in TypeScript, in the layout of n8n's node starter: `credentials/ImageStepApi.credentials.ts`,
  `nodes/ImageStep/ImageStep.node.ts` and `nodes/ImageStepTrigger/ImageStepTrigger.node.ts`, compiled by `tsc` with
  `strict` on. n8n's Creator Portal asks for TypeScript sources before it verifies a node. The built package is the
  same: `dist/` keeps its paths, the nodes and the credential keep their names, fields and defaults, and there are
  still no runtime dependencies.

## 0.1.2 — 2026-10-03

### Changed

- The sources moved from `src/` to the package root (`nodes/`, `credentials/`, `lib/`), where n8n's Creator Portal and
  its scanner look for them in the source repository. The built package (`dist/`) is unchanged.

## 0.1.1 — 2026-10-03

### Fixed

- Passes n8n's community package scan: `package.json` names an author with an email, and the node waits with
  n8n-workflow's `sleep` helper instead of the `setTimeout` global.

## 0.1.0 — 2026-10-03

First release of the [ImageStep](https://imagestep.dev) community node for [n8n](https://n8n.io).

- **ImageStep** node with four resources: Asset (upload an n8n binary or upload from URLs, get, list, list
  collections, publish), Operation (every op in the catalogue: generate, edit, remove background, upscale, resize,
  convert and more), Preset (run a saved, versioned list of steps) and Job (get, or wait until it settles, with its
  outputs).
- **ImageStep Trigger** starts a workflow when a job finishes, from a signed webhook, so nothing polls.
- Every run can be priced first with Dry Run; `retryable` errors are retried inside the node with one
  `Idempotency-Key`, so a retry never charges twice.
- Two workflow templates ship in the package. Zero runtime dependencies: every request goes through n8n's own HTTP
  helpers.
