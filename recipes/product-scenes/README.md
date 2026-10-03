# Product scenes — the same product, a new scene, every ad size

1–3 photos of one product + one scene per line of a text file → **the same product in every scene** → **every ad size
of every scene from one job** → published.

Two things do the work:

- **A preset with a subject.** The product photos are the subject's reference images — they pin the shape — and
  `--describe` is its locked wording — what a photo cannot say: the colour under other light, the words on the label.
  Each scene's prompt writes `{{subject.product}}` where the product goes, and ImageStep expands it to the saved words,
  so scene 40 describes the product exactly as scene 1 did. Change the photos or the words and the preset gets a new
  version; this run pins the one it saved.
- **Variants.** The scenes go into ONE `resize` job by asset id, with one variant per size (`ig` 1080×1350, `x`
  1600×900, `pin` 1000×1500 by default), cropped to the busiest region — with `withoutEnlargement: false`, because a
  generated image is 1024 px and resize never upscales unless told to. Three scenes × three sizes = nine outputs,
  one call, one job to watch — and each output is named after its scene and variant (`… · ig`).

## What you need

- An ImageStep API key (`IMAGESTEP_API_KEY`).
- 1–3 clean photos of the product (plain background works best). `examples/product.jpg` is one.
- One sentence of locked wording (`--describe`).
- A text file with one scene per line — where the product is, not what it is (`scenes.example.txt`).
- **n8n**: the Google Sheets credential and the `n8n-nodes-imagestep` community node; a sheet with columns `scene`,
  `url`, `jobId`, `status`.

## Run the script

```sh
pnpm install
export IMAGESTEP_API_KEY=is_sk_…
node product-scenes/scenes.mjs --refs examples/product.jpg \
  --describe "a dark green enamel camping mug with a white rim and a small orange AMBERMOSS wordmark on the front" \
  --scenes product-scenes/scenes.example.txt --dry-run
node product-scenes/scenes.mjs --refs examples/product.jpg \
  --describe "a dark green enamel camping mug with a white rim and a small orange AMBERMOSS wordmark on the front" \
  --scenes product-scenes/scenes.example.txt
```

What it does, in order:

1. uploads the product photos (sha1 dedupe — re-runs reuse them),
2. saves the preset `product-scenes` — one `generate` step and one subject named `product` — or its next version when
   the photos, the words or the step changed, and pins the version it saved,
3. prices one scene with `dryRun` and prints it. Stops there with `--dry-run`,
4. one `generate` job per scene through the pinned preset (two at a time),
5. one `resize` job over every scene with `variants`, then publishes all of it and prints each output's URL.

Options: `--preset <slug>`, `--model <id>` (a model that takes text and several images: the Gemini image models,
GPT-Image), `--sizes ig:1080x1350,x:1600x900,pin:1000x1500`, `--collection <name>`.

## Run the n8n template

Save the preset once with the script above. Then import `n8n-template.json`:

1. **Google Sheets Trigger** / **Write Back to the Row** — pick your spreadsheet and sheet.
2. **Build the Prompt** — the row's `scene`, with `{{subject.product}}` where the product goes (built in a Code node:
   n8n reads `{{ }}` in a field as its own expression).
3. **Generate the Scene** — ImageStep **Preset → Run** on `product-scenes`, Input *None*, the prompt from the step before.
4. **Instagram Size (4:5)** — ImageStep **Operation → resize** on the scene's asset id, published. The node has no
   variants field, so for more sizes add one resize node per size (each reads the same asset id) — or run the script,
   which makes every size in one job.

## What it costs

`generate` is an AI op: one charge per scene, shown by the dry run. The sizes are a deterministic job — free on paid
plans, counted against the deterministic quota on Free.
