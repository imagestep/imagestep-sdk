# Field photo ingest — HEIC in, dated · geotagged · stable URLs out

Phone photos from the field (HEIC, straight off an iPhone) → **EXIF date and GPS read** → each photo filed in the
collection `YYYY-MM/<lat,lon>` → published → a **manifest CSV** with a stable URL per photo. No reverse geocoding:
the collection name carries coordinates (3 decimals ≈ 100 m), which is what a GIS tool, a map link or a later
geocoding pass wants anyway.

Reading metadata costs nothing and needs no job: once an upload has finished ingesting, the asset already carries its
EXIF under exiftool's names — `DateTimeOriginal` as an ISO-8601 instant, `GPSLatitude` / `GPSLongitude` as signed
decimals — so the upload's answer is the read. HEIC is decoded server-side; the published file is a browser-friendly
rendition.

## What you need

- An ImageStep API key (`IMAGESTEP_API_KEY`).
- **Script**: Node 20+ and a folder of photos (`.heic` / `.jpg` / `.png`; anything without EXIF still ingests, it just
  lands under `unknown-date/no-gps`). `examples/field/` is one, with one photo whose EXIF says August 2026 in
  Yosemite Valley.
- **n8n**: Google Drive + Google Sheets credentials and the `n8n-nodes-imagestep` node — its ImageStep credential also
  signs the one HTTP Request node that files and publishes (the node has no "set collection" operation). A Drive
  folder the phone syncs into, and a sheet as the manifest.

## Run the script

```sh
pnpm install
export IMAGESTEP_API_KEY=is_sk_…
node field-photo-ingest/ingest.mjs examples/field          # writes examples/field/manifest.csv
node field-photo-ingest/ingest.mjs ./photos --out site-a.csv --concurrency 4
```

The whole folder goes up with one `assets.uploadMany` — staged and finished in one call each, the bytes sent four at a
time (`--concurrency`), one status call per tick until every ingest is done; a file the service refuses costs only its
own row, and sha1 dedupe means a re-run reuses what is already there. Then per photo, from the asset the upload
returned: `DateTimeOriginal` → `YYYY-MM`, `GPSLatitude` / `GPSLongitude` → `lat,lon`. Each place is filed with one
`assets.setCollection(ids, "2026-08/37.746,-119.594")`, and everything is published with one `assets.publish(ids)`.
The manifest has `file, assetId, takenAt, latitude, longitude, collection, width, height, publicUrl`. Later,
`client.assets.list({ collection: "2026-08/37.746,-119.594" })` returns the photos of one place and month, and
`client.assets.collections()` lists every place you have filed.

## Run the n8n template

Import `n8n-template.json`, then set the Drive folder on **New Field Photo**, the sheet on **Append Manifest Row**, and
the ImageStep credential on the three ImageStep nodes and on **Collection & Publish** (HTTP Request → Authentication:
Predefined Credential Type → ImageStep API). Sync a photo into the folder: within a minute it is in the sheet with its
date, coordinates, collection and URL.

## What it costs

Nothing per photo beyond your plan's asset quota: upload, metadata, filing and publishing are all free. Retention
follows the plan the asset was created under.
