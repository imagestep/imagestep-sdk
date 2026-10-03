# ImageStep recipes

Five complete, copy-and-ship image pipelines built on [ImageStep](https://imagestep.dev/?utm_source=github&utm_medium=recipes) —
the image step for your automations: generate, edit, remove background, upscale, convert and read metadata, over a
REST API with a [JS SDK](https://www.npmjs.com/package/imagestep) and an
[n8n node](https://www.npmjs.com/package/n8n-nodes-imagestep).

Each recipe runs two ways — as a Node script short enough to read in one sitting, or as an n8n workflow you import
from a file. The pictures each one makes, from a real run, are on
[imagestep.dev/docs/recipes](https://imagestep.dev/docs/recipes?utm_source=github&utm_medium=recipes#pipelines). MIT:
copy it, change it, ship it.

## The recipes

| Recipe | In | Out | What it shows |
|---|---|---|---|
| **[social-carousel](social-carousel/)** | sheet rows (`headline`, `subline`) + 1–3 reference images | 4 cards per row, the same character on every one, published, URLs written back | a preset **subject** keeps a character identical across rows and runs |
| **[product-scenes](product-scenes/)** | 1–3 photos of a product + one scene per line | the same product in every scene, then every ad size of every scene from one job | a subject for a product, and **variants**: many sizes, one call |
| **[product-trio](product-trio/)** | one product photo | a transparent cut-out, a white packshot and a 1200 px web size, in parallel | upload once, reference by id from every branch |
| **[templated-cards](templated-cards/)** | sheet rows (`brand`, `title`, `subtitle`, `price`, `cta`) | one 1080×1350 promo card per row, as JPEG, published | an HTML/CSS template rendered once per row, then converted |
| **[field-photo-ingest](field-photo-ingest/)** | a folder of phone photos (HEIC, JPEG) | each photo filed by EXIF month and GPS, published, plus a manifest CSV | metadata read on upload, a collection per place |

## Quick start

You need Node 20+ and an ImageStep API key ([console](https://imagestep.dev/keys?utm_source=github&utm_medium=recipes)
→ API keys).

```sh
pnpm install
export IMAGESTEP_API_KEY=is_sk_…
```

Every recipe that calls a model takes `--dry-run`: it prices the job, prints the estimate and stops. Run that first.
The inputs in [`examples/`](examples/) are enough to run all five from zero.

```sh
pnpm carousel --refs examples/hero.jpg --describe "a woman in her thirties with short silver hair, a navy rain jacket and a mustard beanie" \
  --rows social-carousel/rows.example.csv --dry-run
pnpm scenes --refs examples/product.jpg --describe "a dark green enamel camping mug with a white rim" \
  --scenes product-scenes/scenes.example.txt --dry-run
pnpm trio examples/product.jpg --dry-run
pnpm cards --rows templated-cards/rows.example.csv     # no model: nothing to price in credits
pnpm ingest examples/field                               # no model either
```

Flags, defaults and what each run costs are in that recipe's own README. `IMAGESTEP_BASE_URL` points every script at
another API host.

## What's in a recipe folder

| File | |
|---|---|
| `README.md` | what it does, what you need, how to run it, what it costs |
| `*.mjs` | the workflow as a Node script on the `imagestep` SDK; its last line of output is one JSON summary of what it made |
| `n8n-template.json` | the same workflow as an n8n export — **Workflows → Import from file** |

## What it costs

Deterministic ops (`resize`, `pad`, `convert`, `render_template`, reading metadata) cost no credits on paid plans and
count against the deterministic quota on Free; uploading, filing and publishing are free. AI ops (`generate`,
`remove_bg`) charge per image at a published USD price. The figure that matters is the one your dry run prints, never
this README.

## About the n8n templates

They are written against the official Google nodes (`googleSheetsTrigger` v1, `googleSheets` v4.5,
`googleDriveTrigger` v1, `googleDrive` v3, `merge` v3, `httpRequest` v4.2, `code` v2) and `n8n-nodes-imagestep` v1.
Every credential is a `REPLACE_ME` and every folder / spreadsheet id a `REPLACE_WITH_…`: open each node once, pick
yours from the list, save.

Every ImageStep node in them is checked against the node's own field definitions by the ImageStep repo's recipes test,
so a template does not set a field the node would silently drop on import. They have not been executed inside a live
n8n: run the first execution on one row or one file before pointing them at a thousand.

## License

MIT — see [LICENSE](LICENSE).
