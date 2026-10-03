import { describe, expect, it } from "vitest";
import { assetRef, jobRef, buildOpJobBody, buildPresetJobBody, normaliseIds, parseParameters } from "../lib/refs.ts";
import { toOpOptions, PROMPT_OPS } from "../lib/ops.ts";
import { verifySignature, parseSignatureHeader } from "../lib/signature.ts";
import { signBody } from "./fake-context.js";

describe("job body builders (docs/api-contract.md §8)", () => {
  it("builds an op request with only the fields that were given", () => {
    expect(buildOpJobBody({ op: "remove_bg", assetIds: "ast_1, ast_2" })).toEqual({ op: "remove_bg", assetIds: ["ast_1", "ast_2"] });
    expect(buildOpJobBody({ op: "generate", prompt: "a red bicycle", count: "2", model: "m", parameters: {}, collection: "" })).toEqual({
      op: "generate",
      prompt: "a red bicycle",
      count: 2,
      model: "m"
    });
    expect(buildOpJobBody({ op: "resize", assetIds: ["a"], parameters: { width: 1200, fit: "inside" }, collection: "shop" })).toEqual({
      op: "resize",
      assetIds: ["a"],
      parameters: { width: 1200, fit: "inside" },
      collection: "shop"
    });
    // imagestep#249 — an op carries a model, never a preset. A fixed set of steps is a preset, and a preset is the
    // Preset resource, not an option hidden under an op: `presetId` here made the op's own Prompt / Model
    // silently the override of something the field did not show.
    expect(buildOpJobBody({ op: "generate", prompt: "on a rooftop", count: 4, presetId: "builtin-consistent-character" })).toEqual({
      op: "generate",
      prompt: "on a rooftop",
      count: 4
    });
    expect(() => buildOpJobBody({})).toThrow(/op is required/);
  });

  // imagestep#591 — Retention Days reaches the job; its default 0 is the plan's, so it is left out.
  it("sends Retention Days with a job only when one is set", () => {
    expect(buildOpJobBody({ op: "upscale", assetIds: ["a"], retentionDays: 7 }).retentionDays).toBe(7);
    expect(buildOpJobBody({ op: "upscale", assetIds: ["a"], retentionDays: 0 })).not.toHaveProperty("retentionDays");
    expect(buildPresetJobBody({ presetId: "p", assetIds: ["a"], retentionDays: 3 }).retentionDays).toBe(3);
    expect(buildPresetJobBody({ presetId: "p", assetIds: ["a"] })).not.toHaveProperty("retentionDays");
  });

  it("builds a preset request, leaving the job type to the preset, and refuses an empty asset list", () => {
    expect(buildPresetJobBody({ presetId: "builtin-util-to-webp", assetIds: ["a", "b"] })).toEqual({
      presetId: "builtin-util-to-webp",
      assetIds: ["a", "b"]
    });
    expect(() => buildPresetJobBody({ presetId: "p", assetIds: "" })).toThrow(/at least one asset/);
    // imagestep#249 — the Version field pins one version; 0 (the default) and an expression that already spells
    // its own `slug@version` are both left as they are.
    expect(buildPresetJobBody({ presetId: "web-optimize", assetIds: "a", version: 3 }).presetId).toBe("web-optimize@3");
    expect(buildPresetJobBody({ presetId: "web-optimize", assetIds: "a", version: 0 }).presetId).toBe("web-optimize");
    expect(buildPresetJobBody({ presetId: "web-optimize", assetIds: "a" }).presetId).toBe("web-optimize");
    expect(buildPresetJobBody({ presetId: "web-optimize@2", assetIds: "a", version: 3 }).presetId).toBe("web-optimize@2");
  });

  /** imagestep#460 — a consistency preset's scene rides on the request; a preset that starts from a prompt takes no image. */
  it("sends a preset run's prompt and count only when given, and takes no asset when it starts from a prompt", () => {
    expect(
      buildPresetJobBody({ presetId: "carousel", assetIds: "", prompt: "{{subject.hero}} on a pier", count: 4, fromPrompt: true })
    ).toEqual({
      presetId: "carousel",
      assetIds: [],
      prompt: "{{subject.hero}} on a pier",
      count: 4
    });
    const plain = buildPresetJobBody({ presetId: "p", assetIds: "a", prompt: "", count: 0 });
    expect(plain).not.toHaveProperty("prompt");
    expect(plain).not.toHaveProperty("count");
    expect(() => buildPresetJobBody({ presetId: "p", assetIds: "", fromPrompt: false })).toThrow(/at least one asset/);
  });

  it("sends the preset run's collection with the job, so outputs go there and not only the uploaded input", () => {
    expect(buildPresetJobBody({ presetId: "p", assetIds: "a", collection: "shop" })).toEqual({
      presetId: "p",
      assetIds: ["a"],
      collection: "shop"
    });
    expect(buildPresetJobBody({ presetId: "p", assetIds: "a", collection: "" })).not.toHaveProperty("collection");
  });

  it("normalises ids from arrays, commas, whitespace and newlines", () => {
    expect(normaliseIds(" a ,b\nc  d,")).toEqual(["a", "b", "c", "d"]);
    expect(normaliseIds(["a", " ", "b"])).toEqual(["a", "b"]);
    expect(normaliseIds(undefined)).toEqual([]);
  });

  it("parses the Parameters field from JSON text or an object", () => {
    expect(parseParameters('{"width": 10}')).toEqual({ width: 10 });
    expect(parseParameters({ width: 10 })).toEqual({ width: 10 });
    expect(parseParameters("")).toBeUndefined();
    expect(parseParameters("{}")).toEqual({});
    expect(() => parseParameters("{nope")).toThrow(/JSON object/);
  });
});

describe("reference mappers (same shape as the MCP server)", () => {
  it("maps an asset to a reference, never bytes", () => {
    const ref = assetRef({
      id: "ast_1",
      name: "cat.png",
      status: "DONE",
      collection: "shop",
      tags: ["hero"],
      publicUrl: "https://cdn.test/ast_1",
      expiresAt: "2026-10-08T00:00:00Z",
      image: { mimeType: "image/png", width: 10, height: 20, size: 300 },
      metadata: { DateTimeOriginal: "2025-09-08T08:00:00.000Z", GPSLatitude: "48.858", GPSLongitude: "2.294" }
    });
    expect(ref).toEqual({
      assetId: "ast_1",
      name: "cat.png",
      status: "DONE",
      mimeType: "image/png",
      width: 10,
      height: 20,
      size: 300,
      collection: "shop",
      tags: ["hero"],
      publicUrl: "https://cdn.test/ast_1",
      expiresAt: "2026-10-08T00:00:00.000Z",
      metadata: { DateTimeOriginal: "2025-09-08T08:00:00.000Z", GPSLatitude: "48.858", GPSLongitude: "2.294" }
    });
    expect(assetRef(null)).toBeNull();
    // A list row (imagestep#339) carries the same facts flat, and maps to the same reference.
    expect(assetRef({ id: "ast_2", mimeType: "image/png", width: 10, height: 20, size: 300 })).toMatchObject({
      assetId: "ast_2",
      mimeType: "image/png",
      width: 10,
      height: 20,
      size: 300
    });
  });

  it("maps a job and its outputs, counting items when the service did not", () => {
    const ref = jobRef(
      {
        id: "job_1",
        type: "process",
        status: "COMPLETED",
        creditsCharged: 0,
        items: [
          { status: "COMPLETED", sourceAssetId: "a", resultAssetId: "out1" },
          { status: "FAILED", sourceAssetId: "b", errorMessage: "boom" }
        ]
      },
      [{ id: "out1", image: { width: 1 } }]
    );
    expect(ref.jobId).toBe("job_1");
    expect(ref.totalItems).toBe(2);
    expect(ref.completedItems).toBe(1);
    expect(ref.failedItems).toBe(1);
    expect(ref.items[1].error).toBe("boom");
    expect(ref.outputs).toEqual([expect.objectContaining({ assetId: "out1", width: 1 })]);
    expect(jobRef({ id: "j", items: [] }).outputs).toBeUndefined();
  });
});

describe("static op fallback", () => {
  // STATIC_OPS is generated from the service's committed catalogue (scripts/static-ops.mjs, #571); the repo root's
  // `test/ops-catalogue.test.js` is red when it is stale (#94).
  it("shows the Prompt field for generate, edit and analyze", () => {
    expect(PROMPT_OPS).toEqual(["generate", "edit", "analyze"]);
  });

  it("turns the live catalogue into dropdown options, dropping sync ops", () => {
    const opts = toOpOptions([
      { op: "remove_bg", kind: "ai", description: "d" },
      { op: "read_metadata", kind: "sync", description: "s" },
      { op: "resize", kind: "deterministic" }
    ]);
    expect(opts).toEqual([
      { name: "remove_bg", value: "remove_bg", description: "d" },
      { name: "resize", value: "resize", description: "" }
    ]);
  });

  it("says how long an op usually takes when the catalogue has measured it (#357), and nothing when it has not", () => {
    const opts = toOpOptions([
      { op: "remove_bg", kind: "ai", description: "Cut the subject out.", typicalSeconds: 5 },
      { op: "colorize", kind: "ai", description: "Colour it.", typicalSeconds: null }
    ]);
    expect(opts.map((o) => o.description)).toEqual(["Cut the subject out. Typically ~5 s for one item.", "Colour it."]);
  });
});

describe("webhook signature (docs/api-contract.md §6)", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "job.completed", data: { jobId: "job_1" } });
  const now = 1_757_318_400;

  it("accepts a good signature over the raw body, as string or Buffer", () => {
    const header = signBody(body, secret, now);
    expect(parseSignatureHeader(header)).toEqual({ timestamp: now, signature: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(verifySignature(body, header, secret, { now })).toBe(true);
    expect(verifySignature(Buffer.from(body), header, secret, { now })).toBe(true);
    expect(verifySignature(body, header.toUpperCase().replace("T=", "t=").replace("V1=", "v1="), secret, { now })).toBe(true);
  });

  it("rejects a tampered body, a wrong secret, a malformed header and a missing secret", () => {
    const header = signBody(body, secret, now);
    expect(verifySignature(body.replace("job_1", "job_2"), header, secret, { now })).toBe(false);
    expect(verifySignature(body, header, "other", { now })).toBe(false);
    expect(verifySignature(body, "v1=abc", secret, { now })).toBe(false);
    expect(verifySignature(body, "", secret, { now })).toBe(false);
    expect(verifySignature(body, header, "", { now })).toBe(false);
  });

  it("rejects a stale timestamp (replay guard) and honours the tolerance", () => {
    const header = signBody(body, secret, now - 600);
    expect(verifySignature(body, header, secret, { now })).toBe(false);
    expect(verifySignature(body, header, secret, { now, toleranceSeconds: 900 })).toBe(true);
  });
});
