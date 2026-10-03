"use strict";

/**
 * The atomic-op vocabulary (docs/api-contract.md §8). The live list comes from `GET /api/v1/ops`
 * at design time; this is the fallback the dropdown shows when that request fails (no credential
 * yet, network down), so the node stays usable and a workflow imported from a template still
 * resolves its `op` value.
 *
 * Generated, not typed (#571): `static-ops.json` is the committed catalogue (`apps/service/openapi/ops.json`) cut to
 * the job ops and their op / kind / description, written by `scripts/static-ops.mjs`. A hand-kept copy drifted twice —
 * `render_template` missing (#94), descriptions that were not the catalogue's — and the repo root's
 * `test/ops-catalogue.test.js` is red when the file no longer matches `ops.json`.
 */
const STATIC_OPS = require("./static-ops.json");

/** Ops that take a prompt — decides when the Prompt field is shown. */
const PROMPT_OPS = ["generate", "edit", "analyze"];

/** Kinds the dropdown lists; `sync` ops (read_metadata) are answered by Asset → Get, not by a job. */
const JOB_KINDS = new Set(["ai", "deterministic"]);

/** Map the live catalogue (or the static fallback) to n8n dropdown options. */
function toOpOptions(ops) {
  // `typicalSeconds` (#357) rides on the description: it is what a person choosing Wait Seconds wants to see, and it
  // comes from the catalogue — the fallback list carries none, so offline the dropdown simply says nothing about time.
  return ops
    .filter((o) => o && o.op && JOB_KINDS.has(o.kind))
    .map((o) => ({
      name: o.op,
      value: o.op,
      description: `${o.description || ""}${o.typicalSeconds ? ` Typically ~${o.typicalSeconds} s for one item.` : ""}`.trim()
    }));
}

module.exports = { STATIC_OPS, PROMPT_OPS, toOpOptions };
