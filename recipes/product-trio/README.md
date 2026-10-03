# Product trio — cut-out · white packshot · web size, from one photo

One product photo in → **three variants out, in parallel**, each with its own stable URL:

| Variant | Op | Kind | What for |
|---|---|---|---|
| cut-out | `remove_bg` | AI | transparent PNG for compositing, ads, marketplaces |
| white packshot | `pad` (120 px, `#ffffff`) | deterministic | catalogue / marketplace listing with breathing room |
| web size | `resize` (1200 px, `fit: inside`) | deterministic | product page hero, fast to load |

Same product in all three because they all start from the same upload — no re-shooting, no
re-generation. The AI op and the two deterministic ops run side by side as three jobs.

## What you need

- An ImageStep API key (`IMAGESTEP_API_KEY`).
- **Script**: Node 20+ and a product photo (JPEG / PNG / WebP / HEIC all fine).
- **n8n**: the Google Drive and Google Sheets credentials plus the `n8n-nodes-imagestep` node; a
  Drive folder to drop photos into and a Sheet with columns `file`, `variant`, `publicUrl`,
  `width`, `height`, `jobId`.

## Run the script

```sh
pnpm install
export IMAGESTEP_API_KEY=is_sk_…
node product-trio/trio.mjs examples/product.jpg --dry-run     # price first
node product-trio/trio.mjs examples/product.jpg
```

It uploads once, prices the AI op, then runs the three ops with `Promise.all`, waits for all
three, publishes every output and prints one JSON line per variant (`variant`, `assetId`,
`publicUrl`, `width`, `height`, `jobId`). Optional: `--pad 160`, `--width 1600`, `--collection shop`.

Want the packshot padded around the *cut-out* rather than the raw photo? Chain it: pass the
cut-out's `assetId` to a second `pad` — or send the chain as one job (`steps: [remove_bg, pad]`),
and save it as a preset once it is worth a name. The
[marketplace cut-out](https://imagestep.dev/docs/recipes?utm_source=github&utm_medium=recipes#marketplace-cutout)
is that chain, finished.

## Run the n8n template

Import `n8n-template.json`, then set the Drive folder on **New Product Photo**, the Sheet on
**Append Manifest Row**, and the ImageStep credential on the four ImageStep nodes. The three
branch nodes have *Store Result* on: each output is kept as an asset with its own URL. Drop a photo in
the folder: within a minute the sheet has three rows for it, one per variant, with URLs.

## What it costs

`remove_bg` is the only AI op here — one charge per image, shown by the dry run. `pad` and
`resize` are deterministic and free on paid plans. Three variants of one photo = one AI charge.
