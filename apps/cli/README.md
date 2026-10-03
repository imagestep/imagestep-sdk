# ImageStep CLI (`imagestep-cli`)

The command-line client for [ImageStep](https://imagestep.dev): transform images synchronously
from the terminal, upload assets and sort them into collections, submit and follow jobs, manage presets and
models. It talks to ImageStep only through the public REST API, and **every call goes through the JS SDK**
([`imagestep`](https://www.npmjs.com/package/imagestep)): its timeouts, retries, Idempotency-Keys, pagination, job wait
and error type are this CLI's; the CLI adds only where the key and base URL come from and the `User-Agent`
(`imagestep-cli/<version>`).

Documentation: [imagestep.dev/docs/cli](https://imagestep.dev/docs/cli) · API reference:
[imagestep.dev/docs/api](https://imagestep.dev/docs/api).

---

## Contents

- [1. Install and first run](#1-install-and-first-run)
- [2. Login, credentials and environments](#2-login-credentials-and-environments)
- [3. `image`: the group that leaves no trace](#3-image-the-group-that-leaves-no-trace)
- [4. Command reference](#4-command-reference)
- [5. Output, confirmations and exit codes](#5-output-confirmations-and-exit-codes)

---

## 1. Install and first run

npm package `imagestep-cli`, binary `imagestep`, Node.js ≥ 22.19 (`engines`).

```sh
pnpm add -g imagestep-cli        # or: npm install -g imagestep-cli; without installing: pnpm dlx imagestep-cli
imagestep login                  # browser sign-in → a new API key is issued for you (§2)
imagestep image resize ./photo.jpg --width 1200 --out small.jpg   # local in, local out, nothing stored (§3)
imagestep asset upload ./photo.jpg -c shoot-01                    # upload into the collection "shoot-01"
imagestep asset list --collection shoot-01                        # list that collection
imagestep jobs list                                               # your jobs
imagestep --help · imagestep <command> --help
```

---

## 2. Login, credentials and environments

**`imagestep login` is the loopback-redirect flow** `gh` / `gcloud` / `stripe login` use, with an
authorization code and PKCE (RFC 7636, S256) so that **the key never travels in a URL**:

1. The CLI starts an HTTP listener bound to the loopback interface only, on the first free port of
   `127.0.0.1:3456`–`3465`, callback path `/callback`, with a 32-byte random `state` nonce and a fresh
   PKCE verifier that never leaves the process.
2. It opens `<authUrl>/cli-auth?callback=…&state=…&code_challenge=…&code_challenge_method=S256` (and
   prints the URL if no browser can be opened). You sign in to the console if you are not already,
   press one button, and the browser carries a **one-time code** back to the listener — single-use,
   dead after 60 s, worthless without the verifier.
3. The CLI trades the code and the verifier for the key at `POST /api/v1/cli-auth/token` (public —
   there is no credential yet). The key lands in `~/.imagestep/config.yml`. The wait is capped at
   5 minutes; declining in the console comes back as `error=access_denied` and the CLI exits 1 at once
   instead of sitting it out.

The listener checks `state` before it reads anything else: a request without this login's
nonce — any web page can make the browser send one — is answered 400 and ignored, and the CLI keeps
waiting; what the page echoes is HTML-escaped. `callback` must point at this machine's loopback, on one of the CLI's
ten ports — the console refuses any other.

| | |
|---|---|
| When a key is already stored | It is probed once with `GET /api/v1/ai-models?mode=ai_image` and reused if it works; `-f, --force` skips the reuse and always issues a new one |
| API host | `https://api.imagestep.dev`, sign-in at `https://imagestep.dev`. `IMAGESTEP_BASE_URL` points the CLI at another host |
| Config file | `~/.imagestep/config.yml`, exactly two keys: `env` (`prod` / `local`, default `prod`) and `tokens: { prod?, local? }`. Owner-only: the directory 0700, the file 0600; one found wider (an older CLI under a 022 umask) is narrowed on the next read, with one line on stderr |
| Environment variables | `IMAGESTEP_API_KEY` and `IMAGESTEP_BASE_URL` — the SDKs' names and precedence: **the environment wins over the config file**, and nothing is written to disk. That is the way in for CI, containers and agents with no browser: `IMAGESTEP_API_KEY=is_sk_… imagestep jobs list` works on a machine with no `~/.imagestep`. A base URL that names a preset selects it, stored key included. With the key exported, `login` says so and exits 0 without opening a browser, and `logout` **never revokes it** — it was not issued to this machine, and revoking it would break every other runner holding it; it clears only the stored keys and says the exported one is still valid. `LOG_LEVEL` (`error` · `warn` · `info` · `debug`, default `info`; every level goes to stderr) is the only other variable |

**`imagestep logout` revokes the key on the server first and then clears it**, in that order: clear
first and fail to revoke, and nothing left on the machine can name the key. It calls
`DELETE /api/v1/api-keys/self` (it takes no id, so "revoke someone else's" has no spelling in this
request; a 401 counts as already revoked). It clears every key stored on this machine. When the revoke fails the key is still cleared here,
but the command says the key is `STILL VALID` and points at `<authUrl>/keys` — "Logged out" over a
key that still works is the sentence someone reads after losing a laptop.

---

## 3. `image`: the group that leaves no trace

```sh
imagestep image resize ./in.jpg --width 1200 --out out.jpg
imagestep image compress ./photos/*.jpg -d ./out --quality 75
imagestep image run --preset web-optimize ./in.jpg --out out.webp
imagestep image metadata ./photo.dng -o table
```

No upload, no asset, no job, no publish: the bytes go up (`POST /api/v1/images/transform` /
`/images/metadata`, without an `Idempotency-Key` — the one documented exception, see
[imagestep.dev/docs/sync](https://imagestep.dev/docs/sync)), the result
comes back, and your account is exactly as it was. Every other command stores what it makes; this
group does not.

**Subcommands are generated from `GET /api/v1/ops`**: every op whose `syncEndpoint` is
`POST /api/v1/images/transform` becomes a subcommand, and its parameter contract becomes flags
(`--width 1200` exists because the API says it does). Which ones is the catalogue's answer, not this
file's — `imagestep image --help` lists what the API offers today, and a deterministic op added to the
API appears here without a CLI release.
`read_metadata` is not generated; AI ops are not here at all — they are jobs (`jobs`), because a job
is what pays for the retry, settlement and cancellation a provider call needs. Three fixed
subcommands: `run --preset <id|slug>` (a saved deterministic preset), `metadata` (EXIF / GPS /
dimensions / SHA-1) and `render --template <id|id@version> --data <json|@file> --out <file.png>`
(`POST /api/v1/images/render`: one row of data through a template into one PNG, retried like the
rest; for many rows submit `jobs submit --op render_template --template-id … --items …`).

Behaviours to know:

- **The catalogue is a public read.** `GET /api/v1/ops` is fetched without a key , so `imagestep image --help` lists every generated subcommand
  before `login`; running one without a key fails with "Not logged in". When the API is unreachable
  the group holds only `run` and `metadata`. The catalogue is fetched only for the `image` group
  itself — running an op, or `image` / `image -h` / `image --help` / `image <op> --help` — never for
  another command's help nor the fixed `metadata` / `run` / `render`, and it is given 3 s, not the 30 s
  of every other call, before the group parses without it.
- **Startup loads only what the command uses**: `cli-highlight` (terminal JSON / YAML),
  `undici` (self-signed TLS), `file-type` (MIME detection) and `open` (`login`) are loaded
  on first use; the JS SDK, which has no dependencies, loads at start (~4 ms). Measured 2026-09-24, median of 15
  interleaved runs on a busy machine (bare `node -e 0` 41 ms): `imagestep --version` 412 → 130 ms,
  `imagestep asset --help` 538 → 134 ms.
- **The CLI does not convert formats.** `--out` is written verbatim: `resize` returns bytes in the
  input format, so `--out x.webp` gives you a JPEG with a `.webp` name. Without `--out` the
  extension comes from the response `Content-Type`, read off the same extension ↔ MIME table
  `asset upload` uses (`src/utils/asset-utils.js`), falling back to the input's extension.
- **A result never replaces its input unless `--out` names it**. Without `--out` a result takes the input's name
  in the current directory (or `-d`), so a same-type result beside its input would land on it: that file is not written
  and fails, and the files not yet sent are not sent — each would be transformed, counted and thrown away the same way.
  The check compares the files, not their spelling (`IMG_1.JPG` and `IMG_1.jpg` on a case-insensitive disk are one).
- **The input's Content-Type is detected the way `asset upload` detects it**: magic bytes first,
  then that table for what has no signature (RAW, SVG). A file neither can name is refused before
  any bytes are sent — the service reads the format from that header and would 400 an
  `application/octet-stream` anyway. To change formats use `convert`, or save a two-step preset for `run`.

| Flag | Meaning |
|---|---|
| `--out <file>` | The output **file** (single input only), and the only way to write over the input. `-o, --output` still means the output **format** here, as in every other command — a flag never gets two meanings |
| `-d, --dir <directory>` | One output file per input; mutually exclusive with `--out` |
| `--concurrency <n>` | Files processed at once, default 4 |
| `--no-retry` | Disable retries |

**Retries** are what this has over a bare `curl`: when the server's error body says
`retryable: true` (the 429 / 503 cases) the call is attempted up to 3 times, honouring
`Retry-After` when present and otherwise backing off `500 × 2^(n−1)` ms — the SDK's `maxRetries`, as for every other
call (§5). This applies to the op
subcommands, `run` and `metadata` (which prints instead of writing, so takes neither `--out` nor
`-d`, but reads `--concurrency` files at a time like the rest). With several inputs, one bad
file fails alone, the rest carry on, and the run exits with the lowest code among the failed files (§5): 4 only when every
failure was transient, 3 when the service refused one, 1 when one never reached it. The exception is `insufficient_credit`
(past the plan's processing allowance a run is paid, and the balance cannot pay): every file after it would hear the
same, so the files not yet sent are not sent, with one line saying how many and where the balance is topped up. `jobs wait` likewise asks
again after `Retry-After` when a waited read is turned away (`rate_limited`, the account's share
of open waits), until its `--timeout`.

---

## 4. Command reference

One file per group under `src/commands/`. The table lists subcommands and the flags that matter;
`--help` has every flag.

| Group | Subcommands |
|---|---|
| `login` / `logout` | §2. `login -f, --force` |
| `image` | §3: `<op> <files...>` (generated) · `run --preset <id\|slug> <files...>` · `metadata <files...>` |
| `asset` | `upload <paths...>` (`-c, --collection <name>`; `--tags <a,b>`; `--concurrency` default 3; `-m, --mime-type <types...>` filter) · `list` (`-v, --view all\|published` · `-c, --collection` · `--tag` · `--mime` · `--source` · `--min/max-width` · `--min/max-height` · `--taken-from/-to` · `-q, --query` · `-p, --page` 0 · `-s, --per-page` 100 · `-a, --all` walks every page (following `meta.nextCursor`; not with `--page`) · `--cursor <c>` reads on from the `More: --cursor …` line the previous page printed (not with `--page`; with `--all` it walks on from there); filters stack) · `from-url <urls...> [-c, --collection <name>] [--tags <a,b>]` (`POST /api/v1/assets/from-url`: the service fetches each public URL; batches of 20; each URL succeeds or fails on its own with its `code` / `retryable`, and any failure exits 1) · `collections [-q <text>]` (your collections with their asset counts, most recently added to first) · `rename-collection <from> <to>` (moves every asset; `""` takes them out) · `get` · `download [--variant readable\|original\|preview] [-f <file>]` · `set-collection <ids...> -c <name>` (required; `""` takes them out) · `tag --tags <a,b>` (required; replaces the tags, `""` clears them) · `publish [--off]` · `delete <ids...> [-y]` (permanent — no trash, no restore) |
| `jobs` | `list` (`--status` · `--type` · `-p, --page` · `-s, --per-page` · `-a, --all` · `--cursor`) · `get` (`-o pretty\|json\|yaml`, default `pretty`, no table) · `estimate` · `submit [--wait [--timeout <s>]]` · `wait <id> [--timeout <s>]` · `outputs <id> [--download <dir> [--concurrency <n>]]` · `resume` · `cancel` |
| `preset` | Saved, versioned lists of steps: `list [-f user\|builtin]` · `get <slug\|id\|slug@version>` · `create [-f <preset.json>] [-n <name> -s <steps> --slug --description]` (`-f` takes a whole preset as it is printed — a `/docs/recipes` block, or `get -o json`; the id, version and a `builtin-` slug are dropped, and flags override the rest) · `update <slug> [-f] [flags]` (new steps or subjects are a new version; what you leave out carries over) · `delete <slug> [-y]` · `delete-version <slug> <version> [-y]` (drops that one version: `slug@version` answers 404 from then on and its number is never reused; it is how you make room at the 50-version limit; the current version cannot be deleted)· `import <json>` (a list of them). Built-ins (`builtin-preset-*`) are read-only |
| `template` | The input of `render_template`: `list [-f builtin\|user]` · `get <id\|id@version>` · `versions <id>` · `create [-f <doc.json>] [--name --html <s\|@file> --css <s\|@file> --width --height --variables a,b --slug]` (takes the shape `get -o json` prints; the ids, slug and version the service assigns are dropped) · `update <id> [-f] [flags]` (a new version; what you leave out carries over) · `delete <id> [-y]` · `import <file>`. Built-ins (`builtin-template-*`) are read-only — PUT / DELETE answer 403 |
| `models` | `list [-m ai_image\|analyze]` (default `ai_image`) |
| `ops` | **No login needed** (`GET /api/v1/ops` is public): `list` (op · kind · job type · ✓ when it also runs on the sync lane · pricing basis · price) · `get <op>` (the full entry — parameter contract and pricing; `-o table` prints one parameter per row) |
| `webhook` | Register a URL and stop polling ([imagestep.dev/docs/webhooks](https://imagestep.dev/docs/webhooks)): `list` (secret masked as `secretHint`) · `get <id>` · `create --url <https://…> [--events a,b] [--description]` · `update <id> [--url] [--events] [--description] [--enable\|--disable]` (`--enable` is the way back after an automatic disable) · `delete <id> [-y]` · `rotate-secret <id>` · `test <id>` (a synthetic `webhook.test` delivery now; exit 1 unless `DELIVERED`) · `deliveries <id> [-p] [-s]` (attempts, receiver status, error, next retry — where to look when an event did not arrive). **The signing secret is printed only by `create` and `rotate-secret`, once**; loopback and private-address URLs are refused by the service |
| `feedback` | The channel for a gap you hit: `send --kind capability_gap\|bug\|other -m <text\|@file> [--op <name>] [--context <json>]` (`POST /api/v1/feedback`) · `list [-p] [-s]` (what this account reported, newest first) |
| `guidelines` | Prints the agent operating contract (`GET /api/v1/agent-guidelines`, Markdown; `-o json` for the document). **No login needed** |
| `skill` | Prints the agent skill this CLI ships (`skills/imagestep/SKILL.md`, the same bytes the console serves at `/.well-known/agent-skills/imagestep/SKILL.md`); `--install claude-code` writes it to `~/.claude/skills/imagestep/SKILL.md` — the one install target. **No login needed** |
| `usage` | `[--from <YYYY-MM-DD\|instant>] [--to …] [-g, --group-by op\|key\|day]` — credits, jobs, items and sync calls from `GET /api/v1/usage`, default the last 30 days by op; the table ends with a `TOTAL` row |

**`jobs submit` / `estimate` take an `--op` from the catalogue** (`GET /api/v1/ops`; the service
derives the job type from it, so `--type` is not sent alongside), or the job-type + preset vocabulary:
`--op <op>` · `--type <ai-generate|ai-edit|parse|process|render|chain>` (only without `--op`;
a `--preset-id` decides it, else `ai-generate`) · `--asset-ids <a,b,c>` ·
`--count` · `--preset-id` · `-m, --model` · `-p, --prompt` (`@path` reads a file) · `--params <json>` ·
`-c, --collection` (where the outputs go; default the input's) · `--preset <json>` (an inline process pipeline) ·
`--variants <json>` (one output per entry, merged over `--params`: a whole set of sizes in one job) ·
`--template-id <id|id@version>` + `--items <json>` (`render_template`: one image per row). Every JSON flag takes a
string or a file path; the service validates them (≤ 20 variants, ≤ 500 rows) and names the field on a 400.
Every output is a new asset: a job never overwrites the asset it read, and there is no `--mode` to choose.
`estimate` is the same request with `?dryRun=true`: priced and validated, nothing created. Its
`--image-count <n>` prices images you have not uploaded yet, as that many more `--asset-ids` — `submit`
has no such flag, because a job needs the images.

```sh
imagestep asset upload ./shoot/*.jpg -c shoot-01
imagestep asset list --collection shoot-01 -o table
imagestep jobs estimate --op resize --asset-ids <id>,<id> --params '{"width":1200}'
imagestep jobs submit   --asset-ids <id>,<id> --preset-id builtin-util-web-optimize@1
imagestep jobs submit   --op generate --count 2 -p "a red bicycle on white"
# a recipe off https://imagestep.dev/docs/recipes, saved and run at the version it was saved at
imagestep preset create -f instagram-square.json
imagestep jobs submit   --asset-ids <id> --preset-id instagram-square@1
# three social sizes from each photo, one job (2 assets × 3 variants = 6 items in the estimate)
imagestep jobs estimate --op resize --asset-ids <id>,<id> --params '{"fit":"cover"}' \
  --variants '[{"name":"ig","parameters":{"width":1080,"height":1350}},{"name":"og","parameters":{"width":1200,"height":630}},{"name":"x","parameters":{"width":1600,"height":900}}]'
# one OG image per row of a file
imagestep jobs submit   --op render_template --template-id builtin-template-og-image --items rows.json
```

**From submit to published, in four commands** — the terminal's answer to "tell me when it is done"
(an automation's answer is a webhook):

```sh
imagestep jobs submit --op resize --asset-ids <id>,<id> --params '{"width":800}' --wait -o json   # 1. submit, and block until done
imagestep jobs wait <job-id> --timeout 900                                                        # 2. …or wait on one submitted earlier
imagestep jobs outputs <job-id> --download ./out                                                  # 3. every result asset, in item order, bytes saved
imagestep jobs items <job-id> --status FAILED -o json                                             #    …or just the items a resume would run again
imagestep asset publish <asset-id> <asset-id>                                                     # 4. give them public URLs
```

`--wait` / `wait` let the **service** wait: `submit --wait` carries `wait` in the body, so a one-item job that
settles inside the service's 60 s window comes back finished in that one call, and what is left is
`GET /api/v1/jobs/{id}?wait=` — a long-poll that answers the moment the job settles. One progress line on
stderr, and **exit 0 on COMPLETED, 1 on FAILED or CANCELLED, 2 when the job is still running at the
timeout** (default 600 s; nothing is cancelled). The final job is printed in the `-o` format.
`outputs` lists only items with a `resultAssetId` (name, status, dimensions, `publicUrl`, and the
`variant` when there is one); `--download` saves each through the same signed-redirect path as
`asset download`, so the API key never reaches storage.

**Collections, not a folder tree**: `-c, --collection <name>` is an opaque
string attached to each asset, matched exactly by `asset list -c`; the service checks the name (≤ 200
characters, no `job:` prefix) and `asset set-collection -c ""` takes assets out of theirs. Rules of
`asset upload`: without `-c` a collection `upload-<ISO timestamp>` is generated; the name is used as given;
a file named on the command line goes in exactly that collection, and only a directory uploaded whole
extends the name with each file's directory inside it (`./shoot -c s` puts `shoot/raw/b.png` in `s/raw`);
hidden files are skipped; files with the same SHA-1 are deduplicated by the server and shown as `Existing`
with the asset's id; files over 100 MB are not hashed. The upload runs in chunks of 500 files — the
service's ceiling on one stage-upload and one finish-upload call: each chunk is staged, uploaded
(`--concurrency` at a time) and finished (3 attempts, one Idempotency-Key) before the next is staged, so a
presigned URL is never older than its own chunk, and an interrupted run keeps the assets of the chunks
it finished (a rerun skips them by SHA-1). A PUT answered `403` — the URL's 60 minutes are up — is staged
again and sent once more.

---

## 5. Output, confirmations and exit codes

- **`-o, --output <json|yaml|table>`**: most read commands take it; `json` / `yaml` are highlighted
  by cli-highlight on a terminal and plain on a pipe — `FORCE_COLOR=1` does not colour a pipe —
  `table` is cli-table3. Exceptions: `jobs get` takes `pretty|json|yaml`;
  `preset delete` has no `-o`. `asset upload -o json|yaml` prints only the per-file results on stdout
  (progress goes to stderr); its default is `table`. An unknown format prints `Unknown format: X` and
  falls back to JSON. Log lines (`INFO` / `WARN` / `ERROR`) and status lines ("Job submitted
  successfully!", "Published 1 asset file(s)", "Job Estimate:") always go to stderr, so **with
  `-o json` stdout is exactly one JSON document** — the skill's acceptance run found `jq` failing on
  `jobs estimate` because its title was on stdout.
- **API errors** print as `<status> <code>: <message>` with a `parameter:` line, a line saying
  the failure is temporary and retrying may succeed when `retryable` is set, and last a
  `request id: …` line — the id to quote when reporting the failure. **With `-o json`
  the error is JSON on stdout instead** — `{"error": {"code", "message", "retryable", "param",
  "requestId", "status", "details"}}`, the contract's own shape, so one parser reads both the answer
  and the refusal; a local failure has `code: null`, and so does an answer that carried no error body (a
  proxy's 502), whose `status` and `retryable` say what happened, and a request nothing answered — `retryable: true`
  and no `status`.
- **Timeouts**: each attempt of a JSON call gives up after 30 s, of a call to the synchronous image lane after
  120 s (it uploads the image too), with a message naming the request that timed out.
- **Retries** are the SDK's: every call retries a `retryable: true` answer (429 / 503) or a dropped connection up to
  twice, honouring `Retry-After` (0 is "now"), **with the same `Idempotency-Key` on every attempt of a write** — a
  submit that landed before the error replays instead of creating a second job. The `image` group
  retries the same way (§3), and `--no-retry` makes it one attempt.
- **Exit codes carry the branch an agent takes**: **3** — the service refused this request
  and `retryable` is false (fix what `param` names, do not resend the same body); **4** — the
  service failed transiently, `retryable` true (for an answer with no contract body, the SDK's rule: a 429 or a
  5xx), or never answered — a network failure or a timeout, once the retries are spent: run the same command
  again; **1** — the failure never reached the service (usage, a missing file, an unknown command, a partially failed
  `asset upload`, a destructive command without `-y`). An `image` batch exits with the lowest code among its failed
  files (§3). `jobs wait` / `submit --wait` keep **2** for their own timeout, which is why the service codes
  start at 3. Bare `imagestep` prints help and exits 0. **A destructive command without `-y, --yes` exits 1 and
  deletes nothing, at a terminal too**: there is no prompt — a program in a pseudo-terminal would sit on one —
  and saying so with 0 would read as success.

---

## License

MIT
