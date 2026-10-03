// imagestep#315 — the fixture `tsc` compiles in `test/types.test.js`. `index.d.ts` is the whole API
// to a TypeScript caller, and it is hand-written: every resource, option and parameter below was
// either missing or wrong once, so each line here is a regression that a name-level check
// (`test/sdk-surface.test.js`) cannot see. Nothing runs — it only has to type-check.
import { ImageStep } from "../../index.js";
import type { Asset, Job, JobEstimate, OpName, TransformResult, UsageSummary } from "../../index.js";

const client = new ImageStep({ apiKey: "sk_test" });

export async function synchronousFace(): Promise<void> {
  // The whole `images` resource was absent from the declarations while the methods existed.
  const bytes: Uint8Array | Record<string, unknown> = await client.images.transform("resize", {
    file: "./product.jpg",
    parameters: { width: 1200 }
  });
  // @ts-expect-error — an op parameter beside the input is refused (imagestep#470).
  await client.images.transform("resize", { file: "./product.jpg", width: 1200 });
  const measured: TransformResult = await client.images.transformResult(null, { preset: "web-optimize", url: "https://e.dev/a.jpg" });
  const png = await client.images.render("builtin-template-og-image", { title: "Hello" });
  const exif = await client.images.metadata("./product.jpg");
  const supported: boolean = await client.images.supports("convert");
  const endpoints: Record<string, string | null> = await client.images.syncEndpoints();
  void [bytes, measured, png, exif, supported, endpoints];
}

export async function opHelpers(): Promise<void> {
  // Ten deterministic helpers shipped without declarations.
  const job: Job = await client.ops.rotate("asset_1", { angle: 90, background: "#ffffff" });
  await client.ops.flip("asset_1");
  await client.ops.flop("asset_1");
  await client.ops.trim("asset_1", { threshold: 12 });
  await client.ops.flatten("asset_1", { background: "#ffffff" });
  await client.ops.adjust("asset_1", { brightness: 1.1, contrast: 1.2 });
  await client.ops.mask("asset_1", { shape: "rounded", radius: 24 });
  await client.ops.blurRegion("asset_1", { left: 10, top: 10, width: 120, height: 80, pixelate: 8 });
  await client.ops.overlay("asset_1", { layerAssetId: "asset_logo", gravity: "southeast", scale: 0.2 });
  await client.ops.caption("asset_1", { text: "$19.99", gravity: "south", background: "#000000" });
  void job;
}

export async function jobOptions(): Promise<void> {
  // `variants` (contract §8) and the dry run's narrowed return type.
  const set: Job = await client.ops.run("resize", {
    assetIds: ["asset_1"],
    variants: [
      { name: "og", parameters: { width: 1200, height: 630 } },
      { name: "square", parameters: { width: 1080, height: 1080 } }
    ],
    wait: { intervalMs: 2000 }
  });
  // imagestep#331: a job never overwrites its input, so there is no mode to pick.
  // @ts-expect-error `mode` was removed
  await client.ops.run("resize", { assetIds: "asset_1", mode: "REPLACE_MEDIA" });
  // @ts-expect-error `mode` was removed
  await client.presets.run("web-optimize", "asset_1", { mode: "NEW_MEDIA" });
  const estimate: JobEstimate = await client.ops.run("upscale", { assetIds: "asset_1", dryRun: true });
  const op: OpName = "render_template";
  void [set, estimate, op];
}

export async function assetOptions(): Promise<void> {
  // `reuseExisting`, the two-value `view`, and capture bounds as epoch millis.
  const asset: Asset = await client.assets.upload("./product.jpg", { reuseExisting: false, collection: "catalogue" });
  const page = await client.assets.list({ view: "PUBLISHED", takenFrom: 1_700_000_000_000, source: "upload", q: "bottle" });
  void [asset, page];
}

export async function spend(): Promise<UsageSummary> {
  // The `usage` resource was absent from the declarations too.
  return client.usage.get({ groupBy: "day", from: "2026-09-01" });
}
