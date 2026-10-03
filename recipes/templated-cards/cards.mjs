// Templated cards: sheet rows (brand, title, subtitle, price, cta) → one HTML/CSS template rendered once per row
// (render_template) → JPEG for posting → published. No model: every step is deterministic.
//
//   IMAGESTEP_API_KEY=is_sk_… node cards.mjs --rows rows.example.csv [--template ./template] [--dry-run]
//
// Options: --template <dir> (default the folder next to this script; card.html + card.css) · --collection <name>
// (default templated-cards) · --quality <1-100> (default 88). IMAGESTEP_BASE_URL points it at another API host.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImageStep } from "imagestep";

const args = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const templateDir = args.template || join(here, "template");
const collection = args.collection || "templated-cards";
const quality = Number(args.quality || 88);
const SLUG = "promo-card";

if (!process.env.IMAGESTEP_API_KEY) fail("set IMAGESTEP_API_KEY");
if (!args.rows) fail("--rows needs a CSV: brand,title,subtitle,price,cta");

const client = new ImageStep({ apiKey: process.env.IMAGESTEP_API_KEY, baseUrl: process.env.IMAGESTEP_BASE_URL });
const rows = parseCsv(await readFile(args.rows, "utf8"));
if (!rows.length) fail(`${args.rows} has no rows`);

// 1. The template: saved once, versioned. Re-running with the same HTML/CSS reuses the version on record; changing a
//    byte saves the next one, and this run pins the version it rendered with.
const template = await upsertTemplate({
  name: "Promo card",
  slug: SLUG,
  description: "1080×1350 product promo: brand, title, subtitle, a price badge and a call to action.",
  width: 1080,
  height: 1350,
  variables: ["brand", "title", "subtitle", "price", "cta"],
  html: await readFile(join(templateDir, "card.html"), "utf8"),
  css: await readFile(join(templateDir, "card.css"), "utf8")
});
const pinned = `${template.id}@${template.version}`;
console.log(`template ${template.slug} v${template.version} → ${rows.length} rows`);

// 2. Price it: a render item counts against the deterministic quota on Free, and costs no credits.
const estimate = await client.ops.run("render_template", { templateId: pinned, items: rows, dryRun: true });
console.log(
  `dry run: ${estimate.totalItems} renders, ${estimate.estimatedCredits ?? 0} credits (deterministic ops left: ${estimate.processCountLeft})`
);
if (args["dry-run"]) process.exit(0);

// 3. One render job, one PNG per row; one bad row fails only its own item.
const rendered = await client.ops.run("render_template", { templateId: pinned, items: rows, collection, wait: { timeoutMs: 180_000 } });
const pngs = await client.jobs.outputs(rendered);
console.log(`rendered ${pngs.length} cards (job ${rendered.id})`);

// 4. The PNGs by id into one convert job — what a feed wants is a JPEG — then publish.
const converted = await client.ops.convert(
  pngs.map((a) => a.id),
  { format: "jpeg", quality },
  { collection, wait: { timeoutMs: 120_000 } }
);
const jpegs = await client.jobs.outputs(converted);
const published = await client.assets.publish(jpegs.map((a) => a.id));
published.forEach((asset, i) => console.log(`${rows[i]?.title ?? asset.name} → ${asset.publicUrl ?? "(no public host configured)"}`));
// One line a program can read: what this run made.
console.log(
  JSON.stringify({
    recipe: "templated-cards",
    template: pinned,
    renderJobId: rendered.id,
    convertJobId: converted.id,
    cards: published.map((a, i) => ({ png: pngs[i]?.id, jpeg: a.id }))
  })
);

async function upsertTemplate(body) {
  let mine;
  try {
    mine = await client.templates.get(body.slug);
  } catch (err) {
    if (err.status !== 404) throw err;
    return client.templates.create(body);
  }
  const same =
    ["html", "css", "width", "height"].every((k) => mine[k] === body[k]) &&
    JSON.stringify(mine.variables) === JSON.stringify(body.variables);
  return same ? mine : client.templates.update(mine.id, body);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

// Minimal CSV: header row, quoted cells with "" escapes, no embedded newlines.
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

function splitCsvLine(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
