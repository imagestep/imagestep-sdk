---
name: imagestep
description: Run an image step — generate, edit, remove background, upscale, convert, read metadata — through the ImageStep CLI, priced before it spends and returned as an asset id and a stable URL. Use when an automation, a script or a repo needs an image produced or changed.
---

# ImageStep from the shell

Use this when a task needs an image produced or changed and the result must be referenceable
afterwards: a URL to hand on, a cost you can predict, a failure you can classify. The vehicle is the
`imagestep` CLI; it talks to the same public API every SDK uses, and a script you leave behind is an
automation the human can audit and run again.

**MCP or CLI?** If an ImageStep MCP server is already configured and the job needs no local files
and no script, use its tools. Inside a repo or a terminal, with local files, a directory to batch,
or a script worth keeping, use the CLI.

## Before the first call

1. **The binary.** `imagestep --version`. If it is missing: `pnpm dlx imagestep-cli --version`,
   `npx imagestep-cli --version`, or install it with `pnpm add -g imagestep-cli` (Node ≥ 22.19).
2. **The key.** Export `IMAGESTEP_API_KEY=is_sk_…`; the environment wins over any stored config and
   nothing is written to disk. **Do not run `imagestep login` yourself** — it opens a browser and
   waits for a person. Ask the human for a key (they create one at https://imagestep.dev/keys or
   run `imagestep login` in their own terminal), then continue.
3. **The vocabulary.** `imagestep ops list -o json` — no key needed. Every entry carries `op`, `kind`
   (`ai`, `deterministic` or `sync`), `params` (the whole parameter contract), `pricing` (an AI
   op: the default model's price and `creditsPerUsd` to turn credits into dollars; a deterministic
   op: `basis: process_quota` — free on paid plans; on Free one unit of the monthly allowance, and
   past it `overageCredits` from the balance) and
   `syncEndpoint` when the op can answer without a job. `imagestep ops get upscale` shows one op, with an `example` request the service has validated — copy it and swap the asset id. **Never hard-code an op list**; the catalogue
   is the list.
4. **The rules.** `imagestep guidelines` prints the operating contract. Read it once.

## Choosing the shape of the call

| You want | Run | Why |
| --- | --- | --- |
| One deterministic op on a local file, result on disk | `imagestep image resize ./in.jpg --width 1200 --out ./out.jpg` | Bytes in, bytes out, nothing stored; free on a paid plan, one run of the monthly allowance on Free (paid from the balance past it). Every `syncEndpoint` op is a subcommand; `--dir ./out` batches a list of files. |
| Anything with a model in it, or a result to keep | `imagestep jobs submit --op … --wait -o json` | A job owns the retry, the settlement and the cancellation; its outputs are assets. |
| Two or more ops in a row (remove the background, then resize) | save them as one preset — `imagestep preset create -f <preset.json>` — then `jobs submit --preset-id <slug> --asset-ids …` | Any chain of steps, models included, is one job: one price, one settlement, one thing to follow. The images in between are cleaned up for you. Only reach for one job per op, joined by the `assetId` from `jobs outputs`, when the steps are decided by something you learn in between. |
| The same chain over and over | the same preset, pinned: `jobs submit --preset-id <slug>@<n>` | Versioned, so a batch run months apart is the same batch. |
| Several images, one operation | one `jobs submit` with `--asset-ids a,b,c` | Per-item progress and per-item failure, one settlement. |

## The loop

1. **Get the inputs in.** `imagestep asset upload ./photo.jpg -c <collection> -o json` for local files,
   `imagestep asset from-url <url> -o json` for a public URL. Carry the asset ids.
2. **Price it.** `imagestep jobs estimate --op upscale --asset-ids <id> --params '{"scaleFactor":2}' -o json`
   is a dry run of the exact body you are about to submit: `estimatedCredits` (÷ the catalogue's
   `creditsPerUsd` for dollars), `creditBalance` and `sufficientCredit`; for a deterministic op the
   credits are 0 and `processCountLeft` is the number that matters. Do this before any batch
   you did not price a moment ago. An image you have not uploaded yet is priced by count:
   `--image-count <n>` in place of (or beside) `--asset-ids` — the price depends on the op, model and
   parameters, never on the pixels. That is also how a chain is priced up front: a later step's input
   does not exist yet, so estimate it with `--image-count 1`. **`sufficientCredit: false` means stop and tell the human**:
   the account needs credits, and no change to the request fixes that.
3. **Run it.** The same flags on `imagestep jobs submit … --wait -o json` (`--timeout <seconds>`,
   default 600). `--params '<json>'` is the job's `parameters` object, whatever the op: for a
   deterministic op its keys are the op's `params` entries (`{"width":256}`, `{"format":"webp"}`),
   for an AI op they are the keys the catalogue lists under `params.parameters`
   (`{"scaleFactor":2}`); the prompt goes in `-p`. Every output is a new asset — a job never
   overwrites the one it read, so the input id stays valid for the next step. The CLI sends an
   `Idempotency-Key` and retries a transient answer with the same key, so a retry never becomes a
   second job. `--wait` exits 0 when the job completed, 1 when it failed or was cancelled, 2 when the
   timeout ran out — the job keeps running; resume with `imagestep jobs wait <id> -o json`.
4. **Read the result.** `imagestep jobs outputs <id> -o json` lists each output as `{assetId,
   publicUrl, …}` — the same ids the job document carries as `items[].resultAssetId`, and
   `publicUrl` is `null` until the asset is published; `--download ./dir` saves the bytes.
   `imagestep asset publish <id> -o json` returns the whole asset document; `.[0].publicUrl` is the
   URL that does not expire and the only link to hand on; `imagestep asset download <id>` is the
   private way back to the bytes.

```sh
export IMAGESTEP_API_KEY=is_sk_…
ID=$(imagestep asset upload ./product.jpg -c shoot-01 -o json | jq -r '.[0].assetId')
imagestep jobs estimate --op remove_bg --asset-ids "$ID" -o json                          # price step 1
imagestep jobs estimate --op upscale --image-count 1 --params '{"scaleFactor":2}' -o json   # price step 2: its input is not made yet
JOB=$(imagestep jobs submit --op remove_bg --asset-ids "$ID" --wait -o json | jq -r '.id')
CUT=$(imagestep jobs outputs "$JOB" -o json | jq -r '.[0].assetId')
JOB=$(imagestep jobs submit --op upscale --asset-ids "$CUT" --params '{"scaleFactor":2}' --wait -o json | jq -r '.id')
OUT=$(imagestep jobs outputs "$JOB" -o json | jq -r '.[0].assetId')
imagestep asset publish "$OUT" -o json | jq -r '.[0].publicUrl'
```

Always pass `-o json` from a script: stdout is then exactly one JSON document — the answer, or the
error — and every progress or status line is on stderr, so keep the two streams apart (no `2>&1`
into a parser). Defaults differ per command (`table`, `pretty`, `json`), so never rely on them.

## When it fails

With `-o json`, an error is `{"error": {"code", "message", "retryable", "param", "requestId",
"status"}}` on stdout and the exit code says which kind it is:

| exit | meaning | do |
| --- | --- | --- |
| 3 | the service refused this request, `retryable: false` | fix what `param` names; do not resend the same body. `param: null` (e.g. `insufficient_credit`) means the account, not the request, is the problem: stop and tell the human |
| 4 | the service failed transiently, `retryable: true` — or never answered (a network failure, a timeout) | wait, then run the same command again |
| 1 | a local failure (usage, a missing file, an unknown command, a delete without `-y`) | read stderr |

An `image` batch exits with the lowest code among its failed files: 4 only when every failure was transient.

**Branch on `retryable`, not on the message.** `code` is a closed set; `param` names the field to
fix; quote `requestId` when reporting a failure to a human.

**A job that was accepted and then failed is a different case.** `--wait` (or `jobs wait`) exits 1
and stdout is the job document, not an error envelope: `status` is `FAILED` (or `CANCELLED`),
`errorMessage` says how many items failed, and `actualCredits` is what was charged (a failed item is
not). Each failed item carries `error` (one sentence, for the human), `errorCode` and `retryable`,
and the job repeats the verdict — `retryable: true` when any failed item is. Branch on that, never on
the sentence:

- `retryable: true` (`provider_unavailable`, `internal_error`): `imagestep jobs resume <id> -o json`
  creates a new attempt (its `id` is new; `rootJobId` and `attemptNumber` link it) that retries only
  the failed items and is priced like the original — re-check `actualCredits` after it — and
  `imagestep jobs wait <new id> -o json` follows it. Resume once; if that attempt fails again, stop.
- `retryable: false` (`provider_rejected`, `asset_not_found`, `invalid_state`, `invalid_param`): do
  not resume — the same input fails the same way.
- No `errorCode` on a failed item (a deterministic op the processing worker could not run): treat it
  as not retryable.

When you stop, report it with `imagestep feedback send --kind bug -m "…" --op <op>` if it looks like
ImageStep's fault, and tell the human — do not switch models or resend until something changed.

## Rules that keep the work usable

- **References, not bytes.** Carry asset ids and URLs. Never read an image file into the context
  window: it costs tokens, loses fidelity and cannot be handed to the next step.
- **A chain is a list of steps; a preset is that list with a name and a version.** Run it once as
  `steps` on the job; save it as a preset when you will run it again, so the human can run it without
  you. What cannot be either — a step you only decide after seeing the one before it — is a sequence of
  jobs joined by asset ids.
- **Consistency is a preset, not a prompt.** Bind the reference images to the preset so every run in
  the batch — and the batch next month — starts from the same subject.
- **If ImageStep cannot do the thing, say so.** Report it with
  `imagestep feedback send --kind capability_gap -m "…" --op <op>` (`--kind bug` for something
  that should have worked) and tell the human. Do not
  silently substitute a local image library: the human asked for a step their automation can run
  without you.

## No Node on this machine?

The REST API is the same thing without the binary: `GET https://api.imagestep.dev/api/v1/ops` (no
key) is the catalogue, `POST /api/v1/jobs?dryRun=true` is the price, the same body without `dryRun`
is the job, `GET /api/v1/jobs/{id}` is the status. Errors carry the same `retryable`. Reference:
https://imagestep.dev/docs/api.

## Reference

- CLI: https://imagestep.dev/docs/cli · REST: https://imagestep.dev/docs/api
- Synchronous face: https://imagestep.dev/docs/sync
- MCP: https://imagestep.dev/docs/mcp · n8n node: https://imagestep.dev/docs/n8n
- Prices: https://imagestep.dev/pricing
