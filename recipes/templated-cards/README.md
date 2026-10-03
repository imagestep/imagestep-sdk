# Templated cards — one HTML/CSS template, one card per row

Sheet rows (`brand`, `title`, `subtitle`, `price`, `cta`) → **one HTML/CSS template rendered once per row** → JPEG for
posting → published. No model anywhere: the same row always makes the same card.

- **The template** is plain HTML and CSS with `{{ var }}` placeholders (`template/card.html`, `template/card.css`),
  1080×1350. ImageStep saves it once and versions it: re-running with the same files reuses the version on record,
  changing a byte saves the next one, and every render job records the version it used — a card made in March can be
  made again from the same version in May.
- **One job per batch.** `render_template` takes up to 500 rows in one call, one PNG per row; a row that cannot render
  fails only its own item. The PNGs then go by asset id into one `convert` job, because what a feed wants is a JPEG.
- **What it will not do**: fetch from the internet while rendering. Templates render with JavaScript off and every
  external request blocked — the exceptions are `data:` URLs and a published asset's `publicUrl` on ImageStep's own
  host — so a card cannot change because a URL did.

## What you need

- An ImageStep API key (`IMAGESTEP_API_KEY`).
- **Script**: Node 20+ and the rows as a CSV — start from `rows.example.csv`.
- **n8n**: the Google Sheets credential and the `n8n-nodes-imagestep` community node; a sheet with columns `brand`,
  `title`, `subtitle`, `price`, `cta`, `url`, `jobId`.

## Run the script

```sh
pnpm install
export IMAGESTEP_API_KEY=is_sk_…
node templated-cards/cards.mjs --rows templated-cards/rows.example.csv --dry-run
node templated-cards/cards.mjs --rows templated-cards/rows.example.csv
```

It saves the template `promo-card` (or its next version), prices the batch, renders one PNG per row, converts them to
JPEG in one job, publishes them and prints one URL per row. Options: `--template <dir>` (a folder with your own
`card.html` + `card.css`), `--collection <name>`, `--quality <1-100>` (default 88).

## Run the n8n template

Save the template once with the script above. Then import `n8n-template.json`:

1. **Google Sheets Trigger** / **Write Back to the Row** — pick your spreadsheet and sheet.
2. **Render the Card** — ImageStep **Operation → render_template**, Input *None*; its *Parameters* build
   `{templateId: "promo-card", items: [<this row>]}`.
3. **To JPEG** — ImageStep **Operation → convert** on the rendered PNG's asset id, published.
4. Add a row; within a minute it has its card's URL.

## What it costs

No credits: `render_template` and `convert` are deterministic — free on paid plans, counted against the deterministic
quota on Free (each row is one render and one convert).
