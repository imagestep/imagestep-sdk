# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## 0.2.1 — 2026-10-26

### Fixed

- A one-image `transform` that runs synchronously and is refused for its input now names the input to fix as this
  tool calls it: `param` is `urls` or `file_paths`, where it used to be the API endpoint's own field (`url`, `file`),
  which no tool takes.

## 0.2.0 — 2026-10-24

### Added

- Every tool declares an `outputSchema`: `tools/list` shows the fields each tool can answer with before the first call,
  and a client that checks `structuredContent` against it is told when an answer does not match. The schemas are loose —
  every key is optional, since which ones an answer carries depends on the mode (a finished job, a wait that ran out, a
  dry run, a synchronous result, a refusal) — and a value passed through from the API may be `null`. A job's `items[]`
  and `outputs[]` have their own object schemas, the same shape the n8n node's references are held to.
- `--http` logs one JSON line per request on stdout (imagestep#872): the JSON-RPC method, the tool of a `tools/call`, the
  `clientInfo` of an `initialize`, the key's 12-character prefix, `keyValid` (from the key check under Security, 3 s
  timeout, never in the handshake's way), `statusCode` and `durationMs` — never the key, a tool's arguments or a prompt.

### Fixed

- A file (`file_paths`) or URL (`urls`) the service took but could not ingest — not an image it can read, say — is now
  a tool error carrying the asset's own reason (`code`, `message`, `retryable`: whether uploading it again can help),
  and no job is submitted on it. The job used to be accepted and fail item by item, with another code.
- Asset references carry `error` on a `FAILED` asset: why ingest failed, and whether uploading again can help.
- `save_preset`'s schema states what the service accepts: a subject's `descriptor` at most 300 characters (it said
  2000), its `name` matching `[a-z0-9][a-z0-9_-]{0,39}` (it said any 64 characters), a `slug` of lowercase letters,
  digits and single hyphens (it said any 100 characters), and up to 50 `steps` (it said 20, so a preset the API saves
  could not be saved here). An argument the service would refuse is now refused by the schema, before a round trip.
- `job_status` on a job with more items than its first page reads that page's cursor from the job itself instead of
  reading the page a second time from the items listing.

### Changed

- `transform`'s parameter line states each op parameter's allowed values and range from the catalogue's own fields —
  `fit(cover|contain|fill|inside|outside=inside)`, `width(integer 1..16384)`. It used to read the values out of the
  description's text, and could not see a range at all.
- A result saved to disk over stdio goes into a temp folder named `imagestep-mcp-…` (it was `imagestep-…`, a prefix
  every ImageStep tool shares), so it can be told apart and cleaned up on its own (imagestep#896).

### Security

- `--http` checks a key before calling the API on it (imagestep#882). The API counts failed authentications per source
  address, and every call a hosted server makes comes from that server's one address, so tool calls with made-up keys —
  about 60 a minute — locked every user of the server out with a 429, good keys included. A key the server has not seen
  is now checked once on the public catalogue path, and the answer, valid or not, stands for five minutes (kept as the
  key's SHA-256, at most 10 000 of each). A key known invalid gets the same `unauthorized` tool error the API gives,
  without reaching the API; a 401 the API does give is remembered. An address (`CF-Connecting-IP`, an IPv6 one by its
  /64) whose keys came back invalid 20 times in a minute gets HTTP `429` with `Retry-After` for any key the server has
  not seen yet; a key it already knows to be good keeps working. The handshake's check (#872) is the same check, so an
  `initialize` no longer asks about its key every time.

## 0.1.0 — 2026-10-03

First release of the [ImageStep](https://imagestep.dev) MCP server: the image pipeline for agents, as MCP tools.

- Tools: `generate`, `transform` (every op in the catalogue but `generate`), `run_preset`, `job_status`,
  `search_assets`, `save_preset` and `send_feedback`. Images never enter the context window: every tool takes and
  returns asset references (ids, sizes, public URLs).
- Every tool that spends money has `dry_run` (the exact price, nothing created), and every error carries
  `retryable`, `param` and the service's request id. Write tools take an optional `idempotency_key`, so a retried
  call returns what the first one did instead of doing it twice.
- Runs over stdio on your machine (`npx -y @imagestep/mcp`, local files as input) or over HTTP; the same server is
  hosted at `https://mcp.imagestep.dev/mcp`.
