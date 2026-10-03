# Workflow templates

Two importable workflows (n8n → **Workflows → Import from file**). Every credential is a
`REPLACE_ME` placeholder and every Drive folder / spreadsheet id is a `REPLACE_WITH_…` string —
open each node once, pick your own from the list, and save. They are written against the official
Google nodes (`googleDriveTrigger` v1, `googleDrive` v3, `googleSheetsTrigger` v1, `googleSheets`
v4.5) and the ImageStep node at version 1.

| File | Flow | What it shows |
|---|---|---|
| `drive-folder-remove-bg-to-sheets.json` | Google Drive folder (new file) → download → **ImageStep `remove_bg`** (binary in) → Google Sheets append `{file, assetId, publicUrl, jobId, creditsCharged}` | Binary upload with no glue code: the node stages, PUTs and finishes the upload itself and returns a public URL per output. |
| `sheets-prompt-generate-publish.json` | Google Sheets row added (`prompt`, optional `aspectRatio`) → **ImageStep `generate`** → publish → Google Sheets update the same row with `imageUrl` / `assetId` / `status` | A no-input op driven by expressions; `Parameters` built with `JSON.stringify(...)`; writing back by `row_number`. |

More pipelines — the product trio (one upload → cut-out · white packshot · web size), one character on
every card, one product in every scene, a template rendered per row — are in the open-source
[recipes](https://github.com/imagestep/imagestep-sdk/tree/main/recipes), each as a Node script and an n8n
template, with the pictures a real run made on [/docs/recipes](https://imagestep.dev/docs/recipes#pipelines).

Notes that apply to both:

- **Cost**: `remove_bg` and `generate` are AI ops and charge credits per item. Set **Dry Run** on
  an ImageStep node to see the price of the run without creating anything; a *Binary File* input
  is priced as one image and not uploaded.
- **Wait**: the nodes poll with `Wait for Result = true` (up to `Wait Seconds`). For long batches
  turn it off, keep the `jobId`, and let the **ImageStep Trigger** (`job.completed`) resume the
  work in a second workflow.
- These files are documentation-grade exports: they were authored against the node descriptions
  and the official node parameter shapes, not executed inside a running n8n. Import, fill in
  credentials, and run the first one on a folder with a single image before pointing it at a
  thousand.
