// Product scenes: 1–3 photos of one product → one new scene per line of a text file, the same product in every one
// (a preset subject) → every ad size from ONE resize job with variants → published.
//
//   IMAGESTEP_API_KEY=is_sk_… node scenes.mjs --refs bottle-front.jpg,bottle-side.jpg \
//     --describe "a matte black insulated bottle, brushed steel lid, CASA in small serif on the front" --scenes scenes.txt
//
// Options: --preset <slug> (default product-scenes) · --model <id> (default google/gemini-3.1-flash-image) ·
// --sizes <name:WxH,…> (default ig:1080x1350,x:1600x900,pin:1000x1500) · --collection <name> (default product-scenes) ·
// --dry-run (price only, spend nothing). IMAGESTEP_BASE_URL points it at another API host.
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { ImageStep } from "imagestep";

const args = parseArgs(process.argv.slice(2));
const refs = (args.refs || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const slug = args.preset || "product-scenes";
const model = args.model || "google/gemini-3.1-flash-image";
const collection = args.collection || "product-scenes";
const descriptor = (args.describe || "").trim();
const sizes = String(args.sizes || "ig:1080x1350,x:1600x900,pin:1000x1500")
  .split(",")
  .map((s) => /^([a-z0-9-]+):(\d+)x(\d+)$/i.exec(s.trim()))
  .filter(Boolean)
  .map(([, name, w, h]) => ({ name, parameters: { width: Number(w), height: Number(h) } }));

if (!process.env.IMAGESTEP_API_KEY) fail("set IMAGESTEP_API_KEY");
if (!refs.length || refs.length > 3) fail("--refs needs 1-3 photos of the product");
if (!descriptor) fail('--describe needs the locked wording, e.g. --describe "a matte black insulated bottle, brushed steel lid"');
if (!args.scenes) fail("--scenes needs a text file, one scene per line");
if (!sizes.length) fail("--sizes looks like ig:1080x1350,x:1600x900");

const scenes = (await readFile(args.scenes, "utf8"))
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith("#"));
if (!scenes.length) fail(`${args.scenes} has no scenes`);

const client = new ImageStep({ apiKey: process.env.IMAGESTEP_API_KEY, baseUrl: process.env.IMAGESTEP_BASE_URL });

// 1. The product photos → assets, and the preset that carries them as a subject. The images pin the shape; the
//    descriptor pins what a photo cannot (the colour under other light, the words on the label). Changing either is a
//    new preset version, and this run pins the one it saved.
const referenceAssetIds = [];
for (const file of refs) {
  const asset = await client.assets.upload(file, { collection: `${collection}-references`, wait: true });
  referenceAssetIds.push(asset.id);
  console.log(`reference ${basename(file)} → ${asset.id}`);
}
const preset = await upsertPreset({ name: "product", referenceAssetIds, descriptor });
const pinned = `${preset.slug}@${preset.version}`;
console.log(`preset ${pinned} (${model}), ${scenes.length} scenes × ${sizes.length} sizes`);

// 2. Price the whole run first: the model call per scene; the sizes are a deterministic job.
const estimate = await client.presets.run(pinned, [], { prompt: promptFor(scenes[0]), dryRun: true });
console.log(
  `dry run: ${estimate.estimatedCredits} credits per scene × ${scenes.length} (balance ${estimate.creditBalance}); the sizes are deterministic ops, priced by plan`
);
if (args["dry-run"]) process.exit(0);

// 3. One job per scene — each scene is its own prompt over the same subject, no input image. Two at a time (the AI
//    concurrency limit).
const made = [];
for (let i = 0; i < scenes.length; i += 2) {
  const batch = scenes.slice(i, i + 2).map(async (scene) => {
    const job = await client.presets.run(pinned, [], { prompt: promptFor(scene), collection, wait: { timeoutMs: 300_000 } });
    const [asset] = await client.jobs.outputs(job);
    console.log(`scene "${scene}" → ${asset.id} (job ${job.id})`);
    return { scene, jobId: job.id, assetId: asset.id };
  });
  made.push(...(await Promise.all(batch)));
}

// 4. Every size of every scene in ONE job: the scenes by id, one variant per size, cropped to the busiest region.
//    `withoutEnlargement: false` because a generated image is 1024 px and the sizes are bigger: resize never upscales
//    by default, and a cover box it may not fill comes back in the right shape but smaller (1080×1350 → 819×1024).
const sized = await client.ops.resize(
  made.map((m) => m.assetId),
  { fit: "cover", gravity: "attention", withoutEnlargement: false },
  { variants: sizes, collection, wait: { timeoutMs: 180_000 } }
);
const outputs = await client.jobs.outputs(sized);
const published = await client.assets.publish(outputs.map((a) => a.id));
for (const asset of published) console.log(`${asset.name} → ${asset.publicUrl ?? "(no public host configured)"}`);
// One line a program can read: what this run made.
console.log(
  JSON.stringify({
    recipe: "product-scenes",
    preset: pinned,
    referenceAssetIds,
    scenes: made,
    sizesJobId: sized.id,
    sized: published.map((a) => ({ assetId: a.id, name: a.name, width: a.image?.width, height: a.image?.height }))
  })
);

function promptFor(scene) {
  return `{{subject.product}} ${scene}. Product photography, the product sharp and fully in frame, no text.`;
}

async function upsertPreset(subject) {
  const steps = [
    {
      op: "generate",
      model,
      prompt: "{{subject.product}} on a plain studio background. Product photography, the product sharp and fully in frame, no text.",
      parameters: { aspectRatio: "1:1" }
    }
  ];
  try {
    const existing = await client.presets.get(slug);
    const same =
      JSON.stringify(existing.subjects || []) === JSON.stringify([subject]) && JSON.stringify(existing.steps) === JSON.stringify(steps);
    return same ? existing : client.presets.update(slug, { subjects: [subject], steps });
  } catch (err) {
    if (err.status !== 404) throw err;
    return client.presets.create({
      name: "Product scenes",
      slug,
      description: "The same product in a new scene: the subject pins the product, each call brings the scene.",
      subjects: [subject],
      steps
    });
  }
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

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
