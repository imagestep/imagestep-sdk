# Social carousel — one character, every card

Sheet rows (`headline`, `subline`) → **4 on-brand images per row** with the same character (or product) on all of
them → published → the URLs written back into the sheet.

The trick is one ImageStep **preset with a subject**: `{name, referenceAssetIds, descriptor}`. Drift has two halves
and a subject closes both. The 1–3 reference images pin the geometry — every `generate` call made through the preset
sends them to the model. The `descriptor` pins the words: colour under other lighting, material, the text on a label,
none of which a photo states on its own. Each row's prompt writes `{{subject.hero}}` instead of re-describing them, and
the server expands it to the stored wording, so the run three weeks from now says exactly what today's run said. Change
either half and the preset gets a new version; every row records the version that drew it.

## What you need

- An ImageStep API key (`IMAGESTEP_API_KEY`, from the console).
- 1–3 clean reference images of the character / product (front-facing, plain background works best).
  `examples/hero.jpg` is one.
- One sentence of locked wording for them (`--describe`) — what the pictures cannot say themselves.
- **Script**: Node 20+, the rows as a CSV (`headline,subline` — export your sheet, or start from `rows.example.csv`).
- **n8n**: the Google Sheets credential and the `n8n-nodes-imagestep` community node; a sheet with columns `headline`,
  `subline`, `url1`…`url4`, `jobId`, `status`.

## Run the script

```sh
pnpm install                  # in the repo root
export IMAGESTEP_API_KEY=is_sk_…
node social-carousel/carousel.mjs --refs examples/hero.jpg \
  --describe "a woman in her thirties with short silver hair, a navy rain jacket and a mustard beanie" \
  --rows social-carousel/rows.example.csv --dry-run
node social-carousel/carousel.mjs --refs examples/hero.jpg \
  --describe "a woman in her thirties with short silver hair, a navy rain jacket and a mustard beanie" \
  --rows social-carousel/rows.example.csv
```

What it does, in order:

1. uploads the reference images (sha1 dedupe — re-runs reuse them),
2. saves the preset `carousel-brand`: one `generate` step and one subject — or, when the images, the wording or the
   step changed, saves its next version — and pins the version it saved (`carousel-brand@2`),
3. prices one row with `dryRun` and prints it. Stops there with `--dry-run`,
4. per row: one job through the pinned preset with `count: 4` — the row's prompt replaces the step's prompt and names
   the subject rather than re-describing it — waits, publishes, collects `publicUrl`s (two rows at a time),
5. writes `rows.example.out.csv` with `preset`, `jobId`, `url1`…`url4`.

Options: `--preset <slug>`, `--per-row <n>`, `--out <file>`, `--subject <name>` (default `hero`), `--describe <words>`,
`--model <id>` (any model that takes text and several images: the Gemini image models, GPT-Image; a single-image model
is refused as `invalid_param` on `subjects` before anything is charged).

## Run the n8n template

**On n8n's template library**: not listed yet — the link goes here once it is approved.
<!-- n8n-template-url: replace the line above with the public https://n8n.io/workflows/<id>-… URL (imagestep#459) -->

Save the preset once with the script above (or in the console's playground). Then import `n8n-template.json`
(Workflows → Import from file). The yellow note on the canvas is the same setup in short; the white ones label each
step:

1. **Google Sheets Trigger** / **Write URLs Back** — pick your spreadsheet and sheet.
2. **Build the Prompt** — the row's scene, with `{{subject.hero}}` where the character goes. It is built in a Code node
   because n8n reads `{{ }}` in a field as its own expression.
3. **Generate 4 Cards** — ImageStep **Preset → Run** on `carousel-brand`, Input *None*, the prompt from the step before,
   Count 4. Set your ImageStep credential. *Version* pins one version of the preset; 0 runs the current one.
4. Add a row with `headline` and `subline`; within a minute the row has `url1`…`url4`.

## Check consistency (the acceptance step)

Open `url1`…`url4` of one row side by side, then of a second row: same face, hair, outfit and proportions — a
different scene. Score each against the reference (1–5) and note the preset version; a batch that drifts is a reason to
add a second reference image or tighten the descriptor, and either is a new version you can compare against the old.

## What it costs

`generate` is an AI op: one charge per image, so 4 per row; the exact figure is the dry run (`estimatedCredits`)
printed before anything runs. Uploads, publishing and the preset itself are free. The n8n node has a *Dry Run* switch
for the same number.
