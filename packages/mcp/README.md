# @imagestep/mcp

The image pipeline for agents: **presets + assets + jobs**, as MCP tools. Images never enter
the context window — every tool takes and returns asset references (ids, sizes, public URLs).

| Tool | What it does |
|---|---|
| `generate` | prompt → image(s); returns asset ids + CDN URLs. `preset` runs it through a saved preset whose `subjects` keep a character or product identical across a batch (`slug@version` to pin) |
| `transform` | one atomic op — every op in `GET /api/v1/ops` but `generate`, read at startup (stdio) or per request (hosted), falling back to `edit` `remove_bg` `upscale` `restore_face` `colorize` `analyze` `resize` `convert` `compress` `crop` `pad` `grayscale` `rotate` `flip` `flop` `trim` `flatten` `adjust` `mask` `blur_region` `overlay` `caption` `render_template` `read_metadata` when the catalogue cannot be reached. `render_template` takes no images — `parameters: {templateId, items}`, one PNG per item. `variants` (≤ 20) runs the op once per variant in one job, every social size from one call. **Two modes, chosen by the input** — see below |
| `run_preset` | run a saved, versioned preset — a list of steps, by slug or `slug@version` (the way to chain ops and keep batches consistent) |
| `job_status` | per-item progress + outputs of a job (an `analyze` job answers with `analyses`). A write tool whose `wait_seconds` runs out returns the job handle with `timedOut: true` — not an error: the job keeps running and is charged for what completes, so poll this instead of submitting again. Read-only by default: pass `publish: true` to publish the outputs and get their public URLs. An answer carries at most 20 outputs (`search_assets`' page; past that `outputsTruncated` / `outputsNote` say to read on with `search_assets {job_id, cursor}`) — `publish: true` still publishes all of them. Items come a page at a time (the service's page): past the first, `itemsCursor` goes back as `items_cursor` for the next, and `items_status` (`FAILED`: what a resume would run again) reads only the items in one state; a `chain` item carries `step` / `failedStep` |
| `search_assets` | find assets by collection, keyword, mime, size — or, with `group_by: "collection"`, list your collections. One page per call; the answer's `nextCursor`, sent back as `cursor`, reads the next |
| `save_preset` | save a chain you will run again as a named, versioned preset — L1 `op` steps only, checked by the service before anything is stored; answers `slug@version` for `run_preset` to run pinned |
| `send_feedback` | report what ImageStep could not do (`capability_gap` · `bug` · `other`) instead of working around it — free |

Inputs are `asset_ids`, `urls` (public http(s), fetched and ingested by the service — never downloaded
by this server) or — when the server runs on
your machine over stdio — `file_paths`. Every tool that spends money has `dry_run` (exact price,
nothing created or uploaded — `asset_ids` are priced as themselves, `file_paths` / `urls` by how many)
and returns structured errors with `retryable`, `param` and the service's
`requestId` (quote it when reporting a failure), so a parameter mistake is refused **before** any
credit is charged.

The write tools (`generate` · `transform` · `run_preset` · `save_preset` · `send_feedback`) take an optional `idempotency_key`.
An MCP client that times out makes the agent call the tool again; with the same key
and the same arguments that second call returns what the first one answered — the job it created, the preset it saved — instead
of submitting (and charging for) another. The same key with different arguments is refused with
`idempotency_key_reuse`. Without a key, every call is a new submission.

Every tool carries MCP annotations, the hints a client reads to decide what needs your confirmation:
`job_status` and `search_assets` are `readOnlyHint`; the write tools are not idempotent (without a
key), and none is `destructiveHint`: every job writes new assets and never overwrites the one it read.


### `transform` has two modes and the agent does not choose

**Synchronous** when all of these hold: exactly ONE local file or URL, a deterministic op, and
`wait: true`. **Nothing is stored in the account** — no asset id exists afterwards, because none
was created. Sub-second, and the account stays clean.

Where the result goes depends on which of the two servers you are talking to, because the two do
not share a filesystem:

| | answer | lifetime |
|---|---|---|
| **stdio** (this package on your machine) | `path` — a temp file named for what the service says it produced (`convert-<ts>.avif`, not `.bin`) | until the server exits; every result of one server lives in one temp directory |
| **hosted** (`https://mcp.imagestep.dev/mcp`) | `url` — a signed link, plus `expiresInSeconds` | ~5 minutes; download it, or run the work as a job if you need a permanent URL |

Both carry `mimeType`, `width` and `height`, so the next tool does not have to guess. The hosted
answer is a URL for the obvious reason and it took a bug to notice it: your agent is not on the
machine the server runs on, so a path into that container's `/tmp` is an answer it cannot read.
Under the hood that is the API's own `?response=url`, which writes the bytes to a short-lived temp
object — still nothing in your asset catalogue.

**As a job** for everything else: several images, `asset_ids`, any AI op, or `wait: false`. You get
asset ids and public URLs, plus progress, cancellation and webhooks.

Which ops may go the first way is read from `GET /api/v1/ops` (`syncEndpoint`), never hard-coded —
a deterministic op added to the API is fast here without this package changing. If the catalogue
cannot be reached, the job path is used: slower is a better failure than wrong.

A `urls` input is judged the same on both paths: it must resolve to a public address, and it is
refused here — before anything leaves the process — not only by the service that would fetch it.
One input never gets two answers because of which transport happened to carry it.

**Neither mode ever returns image bytes.** An image in the context window is tokens the agent pays
for and cannot read; the answer is always a path, an id or a URL.

## Resources

| URI | What it is |
|---|---|
| `imagestep://ops` | `GET /api/v1/ops` as is — every op with its parameter contract (type, default, description), prompt and asset requirements, default model and pricing |
| `imagestep://ops/{op}` | one op's entry (template; listed per op when the catalogue was readable at startup) |
| `imagestep://models/{mode}` | `GET /api/v1/ai-models?mode=` — `ai_image` or `analyze`, with prices |
| `imagestep://usage` | `GET /api/v1/usage?groupBy=op` — what the account spent over the last 30 days, per op |
| `imagestep://agent-guidelines` | the operating contract (below) |

The catalogue resources exist because an MCP-only client (Claude Desktop) cannot curl the API or open
the console, and "never invent a parameter" is a rule it can only follow if it can read them.
`transform` also carries a one-line-per-op summary — `name(type=default)`, plus the values a parameter
takes when the catalogue lists them, what a required one means, and for an AI op the model's own
`parameters` object — generated from the same catalogue; when that could not be read, it falls back to
a built-in summary and says so. All five are
read live: a read that cannot reach the service fails rather than answering from a copy.

`imagestep://agent-guidelines` is the operating contract — read the op catalogue instead of
carrying a list, price with a dry run before spending, branch on `retryable` rather than the status
code, keep a batch consistent with a preset, and report a missing capability instead of working
around it. It is a resource rather than a tool because a tool is something an agent decides to
call and the rules are something it should have read, and it is fetched from the service on every
read, so a copy of this package released months ago still serves today's contract.

## Connect

Get an API key at <https://imagestep.dev/keys>.

**Claude Desktop** (`claude_desktop_config.json`) — local, can upload files from disk:

```json
{
  "mcpServers": {
    "imagestep": {
      "command": "npx",
      "args": ["-y", "@imagestep/mcp"],
      "env": { "IMAGESTEP_API_KEY": "is_sk_…" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`) — same shape:

```json
{ "mcpServers": { "imagestep": { "command": "npx", "args": ["-y", "@imagestep/mcp"], "env": { "IMAGESTEP_API_KEY": "is_sk_…" } } } }
```

**Claude Code** — local:

```sh
claude mcp add imagestep -e IMAGESTEP_API_KEY=is_sk_… -- npx -y @imagestep/mcp
```

**Remote (any client that speaks Streamable HTTP)** — nothing to install:

```sh
claude mcp add --transport http imagestep https://mcp.imagestep.dev/mcp --header "Authorization: Bearer is_sk_…"
```

The remote server is stateless: each request is served by a fresh server bound to the API key in
the `Authorization` header (`Bearer` or `ApiKey`). `file_paths` is disabled there; pass `urls` or
`asset_ids`.

**The remote server waits at most 90 s per tool call** (`wait_seconds` above that is clamped; the
default there is 90). It answers each call as one JSON body, so nothing reaches your client until the
tool returns, and Cloudflare's edge drops a response that has not started after 100 s — you would get
an HTML 524 with no job id while the job kept running. Past 90 s you get the job handle with
`timedOut: true` instead; poll `job_status`. Over stdio the wait is what you ask for (default 180 s,
max 600 s).

## Try it

> Upload ./product.jpg, remove the background, upscale it 2×, and give me the URL.

The agent calls `transform` (`remove_bg`, `file_paths`), then `transform` (`upscale`,
`asset_ids` = the previous output, `parameters: {"scaleFactor": 2}`), and reads `publicUrl` from
the last result. Three calls, zero image bytes in context.

## Run it yourself

```sh
IMAGESTEP_API_KEY=is_sk_… npx -y @imagestep/mcp            # stdio
npx -y @imagestep/mcp --http --port 8787                   # HTTP on /mcp, key per request
```

`IMAGESTEP_BASE_URL` points the server at another API host.

`--http` listens on `127.0.0.1` and answers only to `Host: localhost:<port>` / `127.0.0.1:<port>` / `[::1]:<port>` —
anything else is a 403 before a key is looked at, so a web page that rebinds a hostname of its own to your machine cannot
drive it. `--host 0.0.0.0` opens it to the network (the hosted image does that); add
`--allowed-hosts mcp.example.com,…` to hold it to the names you serve it under.

On SIGTERM / SIGINT `--http` stops taking connections, lets the calls in flight finish and exits 0 — at most 25 s, under
the hosted pod's 30 s grace. A call still waiting for its job answers at once with the job handle and `timedOut: true`, as
a wait that runs out does — poll `job_status`, don't submit again; for that the hosted server lets the service hold a
submit for at most 15 s before reading on. In the image node runs under tini, never as PID 1, which would ignore the signal.

## Does an agent pick the right tool?

`eval/` measures it: a minimal agent loop over this server's own `tools/list`, against a fake account
(no image is made, only model tokens are spent), tasks from the docs and recipes — a fifth of them
things ImageStep cannot do, where the right call is `send_feedback`. Tool choice, argument validity and
steps per model, with a spend cap:

```sh
OPENROUTER_API_KEY=… pnpm --filter @imagestep/mcp eval --runs 3 --budget 3
```

It is the regression signal for a tool description, an annotation or an error message, and it spends
money, so it is run on purpose rather than by habit. Not a test and not in CI. When to run it, what it
costs, how to measure a change step by step, how to read and write tasks, and the numbers so far:
[`eval/README.md`](eval/README.md).
