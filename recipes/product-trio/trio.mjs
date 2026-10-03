// Product trio: one product photo → cut-out (remove_bg) · white-padded packshot · 1200 px web size,
// in parallel, all from the same upload.
//
//   IMAGESTEP_API_KEY=is_sk_… node trio.mjs ./product.jpg [--pad 120] [--width 1200] [--collection product-trio] [--dry-run]
//
// IMAGESTEP_BASE_URL points it at another API host.
import { basename } from "node:path";
import { ImageStep } from "imagestep";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const pad = Number(opt("pad", 120));
const width = Number(opt("width", 1200));
const collection = opt("collection", "product-trio");
const dryRun = argv.includes("--dry-run");

if (!process.env.IMAGESTEP_API_KEY) fail("set IMAGESTEP_API_KEY");
if (!file) fail("usage: node trio.mjs ./product.jpg");

const client = new ImageStep({ apiKey: process.env.IMAGESTEP_API_KEY, baseUrl: process.env.IMAGESTEP_BASE_URL });

// 1. Upload once; every variant references this asset id.
const source = await client.assets.upload(file, { collection, wait: true });
console.log(`uploaded ${basename(file)} → ${source.id} (${source.image?.width}×${source.image?.height})`);

// 2. Price the one AI op before spending anything.
const estimate = await client.ops.removeBg(source.id, { dryRun: true });
console.log(
  `dry run: remove_bg ${estimate.estimatedCredits} credits · pad and resize are deterministic ops, priced by plan (balance ${estimate.creditBalance})`
);
if (dryRun) process.exit(0);

// 3. Three jobs, side by side. Every output is a new asset; the upload is never touched.
const wait = { timeoutMs: 240_000 };
const [cutout, packshot, web] = await Promise.all([
  client.ops.removeBg(source.id, { collection, wait }),
  client.ops.pad(source.id, { top: pad, bottom: pad, left: pad, right: pad, background: "#ffffff" }, { collection, wait }),
  client.ops.resize(source.id, { width, fit: "inside", withoutEnlargement: true }, { collection, wait })
]);

// 4. Publish and report.
const variants = [];
for (const [variant, job] of [
  ["cutout", cutout],
  ["packshot", packshot],
  ["web", web]
]) {
  const outputs = await client.jobs.outputs(job);
  const [asset] = await client.assets.publish(outputs.map((a) => a.id));
  const row = {
    variant,
    assetId: asset.id,
    publicUrl: asset.publicUrl,
    width: asset.image?.width,
    height: asset.image?.height,
    jobId: job.id
  };
  variants.push(row);
  console.log(JSON.stringify(row));
}
// One line a program can read: what this run made.
console.log(JSON.stringify({ recipe: "product-trio", sourceAssetId: source.id, variants }));

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
