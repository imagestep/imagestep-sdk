// Field photo ingest: a folder of phone photos (HEIC) → upload → EXIF date + GPS → collection
// `YYYY-MM/<lat,lon>` → publish → manifest CSV with stable URLs. No reverse geocoding: coords only.
//
//   IMAGESTEP_API_KEY=is_sk_… node ingest.mjs ./photos [--out manifest.csv] [--concurrency 4]
//
// IMAGESTEP_BASE_URL points it at another API host.
import { readdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { ImageStep } from "imagestep";

const argv = process.argv.slice(2);
const dir = argv.find((a) => !a.startsWith("--"));
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const outFile = opt("out", dir ? join(dir, "manifest.csv") : "manifest.csv");
const concurrency = Number(opt("concurrency", 4));
const EXTENSIONS = new Set([".heic", ".heif", ".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".dng"]);

if (!process.env.IMAGESTEP_API_KEY) fail("set IMAGESTEP_API_KEY");
if (!dir) fail("usage: node ingest.mjs ./photos");

const client = new ImageStep({ apiKey: process.env.IMAGESTEP_API_KEY, baseUrl: process.env.IMAGESTEP_BASE_URL });
const files = (await readdir(dir)).filter((f) => EXTENSIONS.has(extname(f).toLowerCase())).sort();
if (!files.length) fail(`no photos in ${dir}`);
console.log(`${files.length} photos, ${concurrency} uploads at a time`);

// 1. Upload the folder: staged in one call, the bytes sent `concurrency` at a time, finished in one call, then one
//    status call per tick until every ingest has written dimensions + EXIF. One result per file, in order — a file the
//    service refuses costs only itself. Same bytes as an earlier run (sha1) come back as that asset.
const uploaded = await client.assets.uploadMany(
  files.map((f) => join(dir, f)),
  { concurrency }
);

// 2. read_metadata needs no call: the uploaded asset already carries its EXIF, under exiftool's names —
//    DateTimeOriginal as an ISO-8601 instant, GPSLatitude / GPSLongitude as signed decimals. An upload the service
//    took but could not decode comes back FAILED rather than as an error.
const rows = uploaded.map(({ asset, error }, n) => {
  if (asset?.status === "DONE") return place(files[n], asset);
  console.error(`${files[n]}: ${error ? `${error.code} ${error.message}` : "ingest FAILED — not an image the service can read"}`);
  return { file: files[n], collection: "failed", publicUrl: "" };
});

// 3. Each place into its collection — a flat label, not a folder tree — one call per place, then publish them all.
const filed = rows.filter((r) => r.assetId);
for (const collection of new Set(filed.map((r) => r.collection)))
  await client.assets.setCollection(
    filed.filter((r) => r.collection === collection).map((r) => r.assetId),
    collection
  );
const published = filed.length ? await client.assets.publish(filed.map((r) => r.assetId)) : [];
const urls = new Map(published.map((a) => [a.id, a.publicUrl ?? ""]));
for (const row of filed) {
  row.publicUrl = urls.get(row.assetId) ?? "";
  console.log(`${row.file} → ${row.collection} → ${row.publicUrl || "(no public host configured)"}`);
}

const header = ["file", "assetId", "takenAt", "latitude", "longitude", "collection", "width", "height", "publicUrl"];
const csv = [header.join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";
await writeFile(outFile, csv);
console.log(`wrote ${outFile} (${rows.length} rows)`);
// One line a program can read: what this run made.
console.log(
  JSON.stringify({ recipe: "field-photo-ingest", rows: rows.map(({ file, assetId, collection }) => ({ file, assetId, collection })) })
);

function place(file, asset) {
  const metadata = asset.metadata || {};
  const takenAt = metadata.DateTimeOriginal ? new Date(metadata.DateTimeOriginal) : null;
  const month = takenAt && !Number.isNaN(takenAt.getTime()) ? takenAt.toISOString().slice(0, 7) : "unknown-date";
  const lat = parseFloat(metadata.GPSLatitude);
  const lon = parseFloat(metadata.GPSLongitude);
  const hasGps = Number.isFinite(lat) && Number.isFinite(lon);
  return {
    file,
    assetId: asset.id,
    takenAt: month === "unknown-date" ? "" : takenAt.toISOString(),
    latitude: hasGps ? lat : "",
    longitude: hasGps ? lon : "",
    collection: `${month}/${hasGps ? `${lat.toFixed(3)},${lon.toFixed(3)}` : "no-gps"}`,
    width: asset.image?.width ?? "",
    height: asset.image?.height ?? ""
  };
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
