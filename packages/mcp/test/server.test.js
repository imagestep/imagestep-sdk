import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ImageStep, ImageStepError, JobFailedError } from "imagestep";
import {
  clearCatalogueCache,
  createServer,
  createServerWithCatalogue,
  FALLBACK_TRANSFORM_OPS,
  OUTPUTS_INLINE,
  typicalDurations
} from "../src/server.js";
import { apiKeyFrom, HOSTED_MAX_WAIT_SECONDS, serveHttp } from "../src/http.js";
import { assertPublicUrl, isPrivateAddress } from "../src/safe-url.js";

const ADDRESSES = JSON.parse(readFileSync(new URL("../../../test/fixtures/outbound-addresses.json", import.meta.url), "utf8"));

/** A server wired to a fake ImageStep client; returns a connected MCP client. */
async function connect(fakeClient, opts = {}) {
  const server = createServer({ apiKey: "is_sk_test", client: fakeClient, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return client;
}

function fake(overrides = {}) {
  const c = new ImageStep({
    apiKey: "is_sk_test",
    fetch: () => {
      throw new Error("no network in tests");
    }
  });
  Object.assign(c.ops, overrides.ops);
  Object.assign(c.jobs, overrides.jobs);
  Object.assign(c.assets, overrides.assets);
  Object.assign(c.presets, overrides.presets);
  Object.assign(c.agent, overrides.agent);
  return c;
}

/**
 * imagestep#357 — an agent sizes `wait_seconds` from what the catalogue measured, not from a list of "fast ops" kept here.
 */
describe("typical durations", () => {
  const catalogue = [
    { op: "remove_bg", kind: "ai", typicalSeconds: 5 },
    { op: "colorize", kind: "ai", typicalSeconds: null },
    { op: "resize", kind: "deterministic", typicalSeconds: 3 },
    { op: "convert", kind: "deterministic", typicalSeconds: 3 }
  ];

  it("names each measured AI op, folds the deterministic ones into one figure, and leaves the unmeasured out", () => {
    const line = typicalDurations(catalogue);
    expect(line).toContain("remove_bg ~5 s");
    expect(line).toContain("deterministic ops ~3 s");
    expect(line).not.toContain("colorize");
    expect(line).not.toContain("resize ~");
    expect(line).toMatch(/a hint, not a promise/);
  });

  it("says nothing when there is no catalogue, rather than quoting figures of its own", () => {
    expect(typicalDurations(undefined)).toBe("");
    expect(typicalDurations([{ op: "remove_bg", kind: "ai" }])).toBe("");
  });

  it("reaches the agent in the description of wait_seconds", async () => {
    const mcp = await connect(fake(), { catalogue });
    const { tools } = await mcp.listTools();
    for (const name of ["generate", "transform", "run_preset"]) {
      expect(tools.find((t) => t.name === name).inputSchema.properties.wait_seconds.description).toContain("remove_bg ~5 s");
    }
  });
});

describe("tool surface", () => {
  it("exposes exactly these tools with schemas that name cost and retryable semantics", async () => {
    const mcp = await connect(fake());
    const { tools } = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "generate",
      "job_status",
      "run_preset",
      "save_preset",
      "search_assets",
      "send_feedback",
      "transform"
    ]);
    const transform = tools.find((t) => t.name === "transform");
    expect(transform.inputSchema.properties.op.enum).toEqual(FALLBACK_TRANSFORM_OPS);
    for (const name of ["generate", "transform", "run_preset"]) {
      const d = tools.find((t) => t.name === name).description;
      expect(d).toMatch(/dry_run/);
      expect(d).toMatch(/retryable/);
    }
  });
});

/**
 * imagestep#127 — the operating contract rides along as a resource, not a sixth tool.
 *
 * A tool is something an agent decides to call; the rules are something it should have read. The
 * text is fetched from the service on every read on purpose: the service owns the wording and its
 * own `version`, so a package released months ago still serves today's rules.
 */
describe("agent guidelines resource", () => {
  it("is listed as markdown, separate from the tools", async () => {
    const mcp = await connect(fake());

    const { resources } = await mcp.listResources();
    const guidelines = resources.find((r) => r.uri === "imagestep://agent-guidelines");

    expect(guidelines, "the contract must be discoverable as a resource").toBeTruthy();
    expect(guidelines.mimeType).toBe("text/markdown");
    expect(guidelines.description).toMatch(/report a missing capability/i);
    expect((await mcp.listTools()).tools.map((t) => t.name)).not.toContain("agent_guidelines");
  });

  it("serves what the service says today, stamped with the version it came from", async () => {
    const guidelines = vi.fn().mockResolvedValue({ version: 4, updated: "2030-01-02", markdown: "# Rules\n\nPrice first." });
    const mcp = await connect(fake({ agent: { guidelines } }));

    const { contents } = await mcp.readResource({ uri: "imagestep://agent-guidelines" });

    expect(guidelines).toHaveBeenCalled();
    expect(contents[0].mimeType).toBe("text/markdown");
    expect(contents[0].text).toContain("# Rules");
    expect(contents[0].text).toContain("version 4, updated 2030-01-02");
  });

  it("fails the read rather than inventing rules when the service cannot be reached", async () => {
    const mcp = await connect(fake({ agent: { guidelines: () => Promise.reject(new Error("service down")) } }));

    await expect(mcp.readResource({ uri: "imagestep://agent-guidelines" })).rejects.toThrow();
  });
});

describe("the op enum is the catalogue's, not this package's", () => {
  /** One catalogue entry, in the shape `GET /api/v1/ops` returns. */
  const op = (name, kind, requiresAssets = true) => ({ op: name, kind, requiresAssets, syncEndpoint: null });

  async function connectWithCatalogue(list, opts = {}) {
    clearCatalogueCache();
    const client = fake();
    client.ops.list = list;
    const server = await createServerWithCatalogue({ apiKey: "k", client, baseUrl: `https://t${Math.random()}`, ...opts });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientTransport);
    return mcp;
  }

  it("offers an op the API grew after this release, without a release", async () => {
    const mcp = await connectWithCatalogue(async () => [
      op("resize", "deterministic"),
      op("vignette", "deterministic"),
      op("generate", "ai", false),
      op("render_template", "deterministic", false)
    ]);
    const transform = (await mcp.listTools()).tools.find((t) => t.name === "transform");

    // Every op but `generate`, which has its own tool — `render_template` included, though it takes no image (#276).
    expect(transform.inputSchema.properties.op.enum).toEqual(["resize", "vignette", "render_template"]);
    expect(transform.inputSchema.properties.op.enum).not.toContain("generate");
    // The cost note names the deterministic ops the catalogue says are deterministic.
    expect(transform.description).toContain("resize/vignette");
  });

  it("prices each AI op from the catalogue's own pricing, and says 'see the estimate' without it (#224)", async () => {
    const removeBg = {
      ...op("remove_bg", "ai"),
      pricing: { basis: "per_item", defaultModel: { id: "fal-ai/bria/background/remove", priceFrom: "0.0233", priceRange: "$0.0233" } }
    };
    const generate = {
      ...op("generate", "ai", false),
      pricing: { basis: "per_item", defaultModel: { id: "google/gemini-3.1-flash-image", priceFrom: "0.0844" } }
    };
    const mcp = await connectWithCatalogue(async () => [op("resize", "deterministic"), removeBg, generate]);
    const { tools } = await mcp.listTools();

    expect(tools.find((t) => t.name === "transform").description).toContain("remove_bg $0.0233/item on fal-ai/bria/background/remove");
    // `generate` takes no image, so it is not a transform op — but its price still reaches the generate tool.
    expect(tools.find((t) => t.name === "generate").description).toContain("generate $0.0844/item on google/gemini-3.1-flash-image");
    expect(tools.find((t) => t.name === "transform").description).not.toContain("see the estimate");

    const bare = await connectWithCatalogue(async () => [op("resize", "deterministic"), op("remove_bg", "ai")]);
    expect((await bare.listTools()).tools.find((t) => t.name === "transform").description).toContain("see the estimate");
  });

  it("falls back to the built-in list and says so when the catalogue cannot be read", async () => {
    const mcp = await connectWithCatalogue(async () => {
      throw new Error("network down");
    });
    const transform = (await mcp.listTools()).tools.find((t) => t.name === "transform");

    expect(transform.inputSchema.properties.op.enum).toEqual(FALLBACK_TRANSFORM_OPS);
    expect(transform.inputSchema.properties.op.enum).toContain("render_template");
    expect(transform.description).toMatch(/built-in list/);
  });

  it("render_template runs on its parameters alone, and refuses images instead of ingesting them (#276)", async () => {
    const run = vi.fn(async () => ({ id: "job_r", status: "PENDING" }));
    const fromUrl = vi.fn();
    const catalogue = [op("resize", "deterministic"), op("render_template", "deterministic", false)];
    const mcp = await connect(fake({ ops: { run }, assets: { fromUrl } }), { catalogue });
    const parameters = { templateId: "builtin-template-og-image", items: [{ title: "Hi" }, { title: "There" }] };

    const res = await mcp.callTool({ name: "transform", arguments: { op: "render_template", parameters, wait: false } });

    expect(res.isError).toBeFalsy();
    expect(run).toHaveBeenCalledWith("render_template", expect.objectContaining({ parameters }));
    expect(run.mock.calls[0][1].assetIds).toBeUndefined();
    expect(res.structuredContent.jobId).toBe("job_r");

    const withImages = await mcp.callTool({
      name: "transform",
      arguments: { op: "render_template", parameters, urls: ["https://93.184.216.34/a.png"] }
    });
    expect(withImages.isError).toBe(true);
    expect(withImages.structuredContent.error).toMatchObject({ code: "invalid_param", param: "asset_ids" });
    expect(fromUrl).not.toHaveBeenCalled();
  });

  it("reads the catalogue once per base URL, not once per server", async () => {
    clearCatalogueCache();
    const list = vi.fn(async () => [{ op: "resize", kind: "deterministic", requiresAssets: true }]);
    const client = fake();
    client.ops.list = list;
    // The hosted transport builds a server per REQUEST; a round trip in front of every tool call is
    // the thing this cache exists to prevent.
    for (let i = 0; i < 3; i++) await createServerWithCatalogue({ apiKey: "k", client, baseUrl: "https://one.test" });
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("the parameter contract and catalogues an MCP-only client can read (#281)", () => {
  const catalogue = [
    {
      op: "resize",
      kind: "deterministic",
      requiresAssets: true,
      requiresPrompt: false,
      params: {
        width: { type: "integer", description: "px" },
        fit: { type: "string", default: "inside" },
        withoutEnlargement: { type: "boolean", default: true }
      }
    },
    { op: "edit", kind: "ai", requiresAssets: true, requiresPrompt: true, params: {} },
    {
      op: "upscale",
      kind: "ai",
      requiresAssets: true,
      requiresPrompt: false,
      params: { model: { type: "string", default: "fal-ai/x" }, parameters: { type: "object", description: 'e.g. {"scaleFactor": 2}.' } }
    },
    {
      op: "rotate",
      kind: "deterministic",
      requiresAssets: true,
      requiresPrompt: false,
      params: {
        angle: { type: "integer", description: "Degrees clockwise, -360 to 360 (required)." },
        format: { type: "string", description: "webp · jpeg · png (required)" },
        fit: { type: "string", default: "inside", description: "cover · contain" }
      }
    },
    {
      op: "analyze",
      kind: "ai",
      requiresAssets: true,
      requiresPrompt: false,
      defaultPrompt: "Describe it",
      params: { maxOutputTokens: { type: "integer", default: 1024 } }
    },
    { op: "generate", kind: "ai", requiresAssets: false, requiresPrompt: true, params: {} }
  ];

  it("describes every op's parameters from the catalogue, and which ops need a prompt", async () => {
    const mcp = await connect(fake(), { catalogue });
    const props = (await mcp.listTools()).tools.find((t) => t.name === "transform").inputSchema.properties;

    expect(props.parameters.description).toContain("resize: width(integer), fit(string=inside), withoutEnlargement(boolean=true)");
    expect(props.parameters.description).toContain("analyze: maxOutputTokens(integer=1024)");
    // #557: what a required parameter means, the values a description lists, and an AI op's own parameters object
    // — whose model is a field of the tool, not a key to put inside it.
    expect(props.parameters.description).toContain(
      "rotate: angle(integer, required: Degrees clockwise, -360 to 360), format(webp|jpeg|png, required), fit(cover|contain=inside)"
    );
    expect(props.parameters.description).toContain('upscale: e.g. {"scaleFactor": 2}.');
    expect(props.parameters.description).not.toContain("upscale: model");
    expect(props.parameters.description).toContain("imagestep://ops/{op}");
    expect(props.parameters.description).not.toMatch(/^generate:/m);
    expect(props.prompt.description).toMatch(/Required for op=edit/);
    expect(props.prompt.description).toMatch(/optional for analyze/);
    expect(props.model.description).toContain("imagestep://models/ai_image");
  });

  it("falls back to the built-in summary, and says so, without a catalogue", async () => {
    const mcp = await connect(fake());
    const props = (await mcp.listTools()).tools.find((t) => t.name === "transform").inputSchema.properties;
    expect(props.parameters.description).toMatch(/built-in summary/);
    expect(props.prompt.description).toBe("Required for op=edit.");
  });

  it("serves the op catalogue, one op, and the model catalogues as resources", async () => {
    clearCatalogueCache();
    const list = vi.fn(async () => catalogue);
    const get = vi.fn(async (name) => catalogue.find((o) => o.op === name));
    const models = vi.fn(async (mode) => [{ id: `${mode}-model`, priceFrom: "0.01" }]);
    const client = fake({ ops: { list, get } });
    client.models.list = models;
    const mcp = await connect(client, { catalogue });

    const uris = (await mcp.listResources()).resources.map((r) => r.uri);
    expect(uris).toEqual(
      expect.arrayContaining(["imagestep://ops", "imagestep://ops/resize", "imagestep://models/ai_image", "imagestep://models/analyze"])
    );
    const templates = (await mcp.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining(["imagestep://ops/{op}", "imagestep://models/{mode}"]));

    const all = await mcp.readResource({ uri: "imagestep://ops" });
    expect(JSON.parse(all.contents[0].text).map((o) => o.op)).toContain("resize");
    const one = await mcp.readResource({ uri: "imagestep://ops/resize" });
    expect(get).toHaveBeenCalledWith("resize");
    expect(JSON.parse(one.contents[0].text).params.fit.default).toBe("inside");
    const analyzeModels = await mcp.readResource({ uri: "imagestep://models/analyze" });
    expect(models).toHaveBeenCalledWith("analyze");
    expect(JSON.parse(analyzeModels.contents[0].text)[0].id).toBe("analyze-model");
    await expect(mcp.readResource({ uri: "imagestep://models/chat" })).rejects.toThrow();
  });

  it("a catalogue read that cannot reach the service fails rather than inventing one", async () => {
    clearCatalogueCache();
    const down = async () => {
      throw new Error("service down");
    };
    const mcp = await connect(fake({ ops: { list: down, get: down } }));
    await expect(mcp.readResource({ uri: "imagestep://ops" })).rejects.toThrow();
    await expect(mcp.readResource({ uri: "imagestep://ops/resize" })).rejects.toThrow();
  });
});

describe("transform", () => {
  it("runs the op, waits, publishes, and returns references only", async () => {
    const run = vi.fn(async () => ({ id: "job_1", status: "PENDING" }));
    const wait = vi.fn(async () => ({
      id: "job_1",
      status: "COMPLETED",
      items: [{ status: "COMPLETED", sourceAssetId: "a1", resultAssetId: "out1" }]
    }));
    const outputs = vi.fn(async () => [{ id: "out1", name: "x.png", status: "DONE", image: { width: 10, height: 20 } }]);
    const publish = vi.fn(async (ids) =>
      ids.map((id) => ({ id, published: true, publicUrl: `https://cdn.test/${id}`, image: { width: 10, height: 20 } }))
    );
    const mcp = await connect(fake({ ops: { run }, jobs: { wait, outputs }, assets: { publish } }));

    const res = await mcp.callTool({ name: "transform", arguments: { op: "remove_bg", asset_ids: ["a1"] } });
    expect(res.isError).toBeFalsy();
    expect(run).toHaveBeenCalledWith("remove_bg", expect.objectContaining({ assetIds: ["a1"] }));
    expect(res.structuredContent.status).toBe("COMPLETED");
    expect(res.structuredContent.outputs[0]).toMatchObject({ assetId: "out1", publicUrl: "https://cdn.test/out1", width: 10 });
    expect(JSON.stringify(res)).not.toMatch(/data:image/);
  });

  it("an analyze job returns each asset's answer and publishes nothing (imagestep#202)", async () => {
    const output = { tags: ["bicycle"], description: "a red bicycle" };
    const run = vi.fn(async () => ({ id: "job_2", status: "PENDING" }));
    const wait = vi.fn(async () => ({
      id: "job_2",
      type: "parse",
      status: "FAILED",
      items: [
        { status: "COMPLETED", sourceAssetId: "a1", output },
        { status: "FAILED", sourceAssetId: "a2", error: "the answer did not fit in maxOutputTokens=256", retryable: false }
      ]
    }));
    const outputs = vi.fn(async () => []);
    const publish = vi.fn();
    const get = vi.fn();
    const mcp = await connect(fake({ ops: { run }, jobs: { wait, outputs }, assets: { publish, get } }));

    const res = await mcp.callTool({ name: "transform", arguments: { op: "analyze", asset_ids: ["a1", "a2"] } });
    expect(res.isError).toBeFalsy();
    expect(run).toHaveBeenCalledWith("analyze", expect.objectContaining({ assetIds: ["a1", "a2"] }));
    // Only the item that completed has an answer — its own output (#338); the failed one reports itself in `items`.
    expect(res.structuredContent.analyses).toEqual([{ assetId: "a1", output }]);
    expect(get).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("returns a structured, non-retryable error when the API refuses a parameter — before any job exists", async () => {
    const run = vi.fn(async () => {
      throw new ImageStepError({
        status: 400,
        code: "invalid_param",
        message: "width must be between 1 and 16384",
        retryable: false,
        param: "width"
      });
    });
    const mcp = await connect(fake({ ops: { run } }));
    const res = await mcp.callTool({ name: "transform", arguments: { op: "resize", asset_ids: ["a1"], parameters: { width: 0 } } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", param: "width", retryable: false });
  });

  // #589: an agent cannot top up or subscribe, so the refusal it relays has to carry the page that clears it.
  it("hands the agent a refusal for credit with its figures and the top-up link, in both text and structure", async () => {
    const details = { requiredCredits: 26, requiredUsd: "0.0026", availableCredits: 0, topUpUrl: "https://imagestep.dev/usage/credits" };
    const run = vi.fn(async () => {
      throw new ImageStepError({ status: 402, code: "insufficient_credit", message: "Not enough credit", retryable: false, details });
    });
    const mcp = await connect(fake({ ops: { run } }));
    const res = await mcp.callTool({ name: "transform", arguments: { op: "resize", asset_ids: ["a1"], parameters: { width: 10 } } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "insufficient_credit", retryable: false, details });
    expect(res.content[0].text).toContain(details.topUpUrl);
  });

  it("idempotency_key reaches the submission on all three write tools (contract §3, #277)", async () => {
    const run = vi.fn(async () => ({ id: "job_k", status: "PENDING" }));
    const presetRun = vi.fn(async () => ({ id: "job_p", status: "PENDING" }));
    const get = vi.fn(async () => ({ id: "p1", slug: "s", version: 1, steps: [{}] }));
    const mcp = await connect(fake({ ops: { run }, presets: { run: presetRun, get } }));

    await mcp.callTool({ name: "transform", arguments: { op: "resize", asset_ids: ["a1"], idempotency_key: "k1", wait: false } });
    await mcp.callTool({ name: "generate", arguments: { prompt: "a cat", idempotency_key: "k2", wait: false } });
    await mcp.callTool({ name: "run_preset", arguments: { preset: "s", asset_ids: ["a1"], idempotency_key: "k3", wait: false } });

    expect(run.mock.calls[0][1]).toMatchObject({ idempotencyKey: "k1" });
    expect(run.mock.calls[1][1]).toMatchObject({ idempotencyKey: "k2" });
    expect(presetRun.mock.calls[0][2]).toMatchObject({ idempotencyKey: "k3" });
  });

  it("a failed call carries the service's requestId so it can be quoted (contract §11, #277)", async () => {
    const run = vi.fn(async () => {
      throw new ImageStepError({ status: 402, code: "insufficient_credit", message: "no", retryable: false, requestId: "req-42" });
    });
    const mcp = await connect(fake({ ops: { run } }));
    const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", asset_ids: ["a1"] } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "insufficient_credit", requestId: "req-42" });
  });

  it("dry_run returns the estimate and submits nothing", async () => {
    const estimate = vi.fn(async () => ({ totalItems: 1, estimatedCredits: 30, sufficientCredit: true }));
    const run = vi.fn();
    const mcp = await connect(fake({ ops: { estimate, run } }));
    const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", asset_ids: ["a1"], dry_run: true } });
    expect(res.structuredContent.estimate.estimatedCredits).toBe(30);
    expect(run).not.toHaveBeenCalled();
  });

  it("read_metadata is synchronous and needs no job", async () => {
    const readMetadata = vi.fn(async (id) => ({ id, image: { width: 1 }, metadata: { exif: {} } }));
    const run = vi.fn();
    const mcp = await connect(fake({ ops: { readMetadata, run } }));
    const res = await mcp.callTool({ name: "transform", arguments: { op: "read_metadata", asset_ids: ["a1"] } });
    expect(res.structuredContent.assets[0].metadata).toEqual({ exif: {} });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses file_paths unless the server runs locally, and refuses private URLs", async () => {
    const mcp = await connect(fake(), { allowLocalFiles: false });
    const res = await mcp.callTool({ name: "transform", arguments: { op: "grayscale", file_paths: ["/tmp/x.png"] } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.param).toBe("file_paths");
    const res2 = await mcp.callTool({
      name: "transform",
      arguments: { op: "grayscale", urls: ["http://169.254.169.254/latest/meta-data"] }
    });
    expect(res2.isError).toBe(true);
    expect(res2.structuredContent.error.message).toMatch(/private address/);
  });

  it("urls are handed to the service to fetch, and the created assets go into the job (#219)", async () => {
    const fromUrl = vi.fn(async (urls) => urls.map((url, i) => ({ url, asset: { id: `ast_u${i}`, status: "DONE" } })));
    const upload = vi.fn();
    const run = vi.fn(async () => ({ id: "job_u", status: "PENDING" }));
    const mcp = await connect(fake({ assets: { fromUrl, upload }, ops: { run } }));
    const res = await mcp.callTool({
      name: "transform",
      arguments: { op: "upscale", urls: ["https://93.184.216.34/shots/a.png"], collection: "shoot", wait: false }
    });
    expect(res.isError).toBeFalsy();
    expect(fromUrl).toHaveBeenCalledWith(["https://93.184.216.34/shots/a.png"], { collection: "shoot" });
    expect(upload).not.toHaveBeenCalled();
    expect(run.mock.calls[0][1].assetIds).toEqual(["ast_u0"]);
  });

  /**
   * #572 → #586 — a dry run over a file or a URL used to upload it to price it: "nothing is created" left an asset behind,
   * counted against the quota. The service now prices images it does not hold by count, so nothing is uploaded or fetched.
   */
  it("dry_run over file_paths or urls prices them by count and uploads nothing", async () => {
    const fromUrl = vi.fn();
    const uploadMany = vi.fn();
    const estimate = vi.fn(async () => ({ totalItems: 3 }));
    const run = vi.fn(async () => ({ totalItems: 1 }));
    const get = vi.fn(async () => ({ id: "p1", slug: "builtin-util-to-webp", version: 1, steps: [{ op: "convert" }] }));
    const mcp = await connect(fake({ assets: { fromUrl, uploadMany }, ops: { estimate }, presets: { run, get } }), {
      allowLocalFiles: true
    });

    const op = await mcp.callTool({
      name: "transform",
      arguments: {
        op: "remove_bg",
        asset_ids: ["a1"],
        file_paths: ["/tmp/x.png"],
        urls: ["https://93.184.216.34/shots/a.png"],
        dry_run: true
      }
    });
    expect(op.isError).toBeFalsy();
    expect(estimate).toHaveBeenCalledWith("remove_bg", expect.objectContaining({ assetIds: ["a1"], imageCount: 2 }));

    const preset = await mcp.callTool({
      name: "run_preset",
      arguments: { preset: "builtin-util-to-webp", urls: ["https://93.184.216.34/shots/a.png"], dry_run: true }
    });
    expect(preset.isError).toBeFalsy();
    expect(run).toHaveBeenCalledWith("builtin-util-to-webp", [], expect.objectContaining({ dryRun: true, imageCount: 1 }));
    for (const fn of [fromUrl, uploadMany]) expect(fn).not.toHaveBeenCalled();

    const { tools } = await mcp.listTools();
    for (const name of ["transform", "run_preset"]) {
      expect(tools.find((t) => t.name === name).inputSchema.properties.dry_run.description).toMatch(/file_paths and urls by how\s+many/);
    }
  });

  it("a dry run still refuses file_paths where the server cannot read them, as the run would", async () => {
    const estimate = vi.fn();
    const mcp = await connect(fake({ ops: { estimate } }), { allowLocalFiles: false });
    const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", file_paths: ["/tmp/x.png"], dry_run: true } });
    expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", param: "file_paths" });
    expect(estimate).not.toHaveBeenCalled();
  });

  it("a URL the service could not ingest is a tool error on urls, with the service's code", async () => {
    const fromUrl = vi.fn(async (urls) => [
      { url: urls[0], error: { code: "unsupported_format", message: "text/html is not an image", retryable: false } }
    ]);
    const mcp = await connect(fake({ assets: { fromUrl } }));
    const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", urls: ["https://93.184.216.34/"], wait: false } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "unsupported_format", param: "urls", retryable: false });
  });

  it("variants go into the one job and each item comes back labelled (#276)", async () => {
    const run = vi.fn(async () => ({ id: "job_v", status: "PENDING" }));
    const wait = vi.fn(async () => ({
      id: "job_v",
      status: "COMPLETED",
      items: [
        { status: "COMPLETED", sourceAssetId: "a1", resultAssetId: "o1", variant: "ig" },
        { status: "COMPLETED", sourceAssetId: "a1", resultAssetId: "o2", variant: "x" }
      ]
    }));
    const outputs = vi.fn(async () => [{ id: "o1" }, { id: "o2" }]);
    const publish = vi.fn(async (ids) => ids.map((id) => ({ id, published: true, publicUrl: `https://cdn.test/${id}` })));
    const mcp = await connect(fake({ ops: { run }, jobs: { wait, outputs }, assets: { publish } }));
    const variants = [
      { name: "ig", parameters: { width: 1080, height: 1350 } },
      { name: "x", parameters: { width: 1600, height: 900 } }
    ];

    const res = await mcp.callTool({
      name: "transform",
      arguments: { op: "resize", asset_ids: ["a1"], parameters: { fit: "cover" }, variants }
    });

    expect(run).toHaveBeenCalledWith("resize", expect.objectContaining({ assetIds: ["a1"], parameters: { fit: "cover" }, variants }));
    expect(res.structuredContent.items.map((i) => i.variant)).toEqual(["ig", "x"]);
  });

  it("render_template is callable from the built-in list when the catalogue cannot be read (#276)", async () => {
    const run = vi.fn(async () => ({ id: "job_b", status: "PENDING" }));
    const mcp = await connect(fake({ ops: { run } }));
    const res = await mcp.callTool({
      name: "transform",
      arguments: { op: "render_template", parameters: { templateId: "t", items: [{}] }, wait: false }
    });
    expect(res.isError).toBeFalsy();
    expect(run.mock.calls[0][0]).toBe("render_template");
  });

  it("rejects an op outside the enum at the schema layer", async () => {
    const mcp = await connect(fake());
    const res = await mcp.callTool({ name: "transform", arguments: { op: "teleport", asset_ids: ["a1"] } }).catch((e) => e);
    const text = res.isError ? JSON.stringify(res) : String(res.message);
    expect(text).toMatch(/op|invalid/i);
  });
});

describe("job_status / search_assets / run_preset", () => {
  it("job_status reports per-item progress and outputs", async () => {
    const get = vi.fn(async () => ({ id: "j", status: "PROCESSING", items: [{ status: "COMPLETED" }, { status: "PENDING" }] }));
    const mcp = await connect(fake({ jobs: { get } }));
    const res = await mcp.callTool({ name: "job_status", arguments: { job_id: "j" } });
    expect(res.structuredContent).toMatchObject({ jobId: "j", status: "PROCESSING", completedItems: 1, totalItems: 2 });
  });

  // #440 capped the items a job document inlines; #573: the note pointed an MCP-only agent at a REST call it cannot make.
  it("a job past the first page of items pages the rest through job_status itself (#440, #573)", async () => {
    const job = {
      id: "j",
      status: "PROCESSING",
      totalItems: 4000,
      completedItems: 120,
      itemsTruncated: true,
      items: [
        { index: 0, status: "COMPLETED" },
        { index: 1, status: "PENDING" }
      ]
    };
    const get = vi.fn(async () => job);
    const items = vi.fn(async (id, { status, cursor }) =>
      cursor === "c2"
        ? { items: [{ index: 3999, status: "FAILED", step: 1, failedStep: 1 }], meta: { hasMore: false } }
        : { items: [{ index: status ? 7 : 0, status: status || "COMPLETED" }], meta: { hasMore: true, nextCursor: status ? "f1" : "c1" } }
    );
    const mcp = await connect(fake({ jobs: { get, items } }));

    const first = (await mcp.callTool({ name: "job_status", arguments: { job_id: "j" } })).structuredContent;
    expect(first.totalItems).toBe(4000);
    expect(first.itemsCursor).toBe("c1");
    expect(first.itemsNote).toContain('job_status {"job_id": "j", "items_cursor": "c1"}');
    expect(first.itemsNote).toContain('job_status {"job_id": "j", "items_status": "FAILED"}');
    expect(first.itemsNote).not.toMatch(/GET \/api/);
    expect(first.items[0].index).toBe(0, "an item a filtered page returns has to say which it is");

    const failed = (await mcp.callTool({ name: "job_status", arguments: { job_id: "j", items_status: "FAILED" } })).structuredContent;
    expect(items).toHaveBeenLastCalledWith("j", { status: "FAILED", cursor: undefined });
    expect(failed.itemsNote).toContain('job_status {"job_id": "j", "items_status": "FAILED", "items_cursor": "f1"}');

    const last = (await mcp.callTool({ name: "job_status", arguments: { job_id: "j", items_cursor: "c2" } })).structuredContent;
    expect(last.items).toEqual([{ index: 3999, status: "FAILED", step: 1, failedStep: 1 }]);
    expect([last.itemsCursor, last.itemsNote]).toEqual([undefined, undefined]);

    // A write tool's answer reads no listing: it names the job_status call that knows the cursor.
    const wait = vi.fn(async () => {
      throw new JobFailedError(job, "Job j still PROCESSING after 5000 ms");
    });
    const run = vi.fn(async () => ({ id: "j", status: "PENDING" }));
    const write = await connect(fake({ ops: { run }, jobs: { wait } }));
    const handle = (await write.callTool({ name: "transform", arguments: { op: "upscale", asset_ids: ["a1"], wait_seconds: 5 } }))
      .structuredContent;
    expect(handle.itemsNote).toContain('job_status {"job_id": "j"} answers with the itemsCursor');
  });

  it("an analyze batch past the first page pages for the answers it did not get (#440)", async () => {
    const get = vi.fn(async () => ({
      id: "j",
      type: "parse",
      status: "COMPLETED",
      totalItems: 150,
      completedItems: 150,
      itemsTruncated: true,
      items: [{ index: 0, status: "COMPLETED", sourceAssetId: "ast_0", output: { tags: ["a"] } }]
    }));
    const iterateItems = vi.fn(async function* () {
      yield { index: 0, status: "COMPLETED", sourceAssetId: "ast_0", output: { tags: ["a"] } };
      yield { index: 140, status: "COMPLETED", sourceAssetId: "ast_140", output: { tags: ["z"] } };
    });
    // The first page of items shown, read from the listing for its cursor (#573); the analyses still walk every page.
    const items = vi.fn(async () => ({ items: [{ index: 0, status: "COMPLETED" }], meta: { hasMore: true, nextCursor: "c1" } }));
    const mcp = await connect(fake({ jobs: { get, iterateItems, items } }));

    const res = await mcp.callTool({ name: "job_status", arguments: { job_id: "j" } });

    expect(iterateItems).toHaveBeenCalledWith("j", { status: "COMPLETED" });
    expect(res.structuredContent.analyses.map((a) => a.assetId)).toEqual(["ast_0", "ast_140"]);
  });

  it("a wait that runs out is a job handle, not a failure — the job is still running (#274)", async () => {
    const run = vi.fn(async () => ({ id: "job_slow", status: "PENDING" }));
    const wait = vi.fn(async () => {
      const job = { id: "job_slow", status: "PROCESSING", items: [{ status: "COMPLETED" }, { status: "PROCESSING" }] };
      throw new JobFailedError(job, "Job job_slow still PROCESSING after 5000 ms");
    });
    const publish = vi.fn();
    const mcp = await connect(fake({ ops: { run }, jobs: { wait }, assets: { publish } }));

    const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", asset_ids: ["a1", "a2"], wait_seconds: 5 } });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ jobId: "job_slow", status: "PROCESSING", timedOut: true, completedItems: 1 });
    expect(res.structuredContent.note).toMatch(/job_status/);
    expect(res.structuredContent.error).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  });

  it("a job that ended FAILED is still the job — per-item errors, not a job_failed tool error (#274)", async () => {
    const run = vi.fn(async () => ({ id: "job_f", status: "PENDING" }));
    const wait = vi.fn(async () => ({
      id: "job_f",
      status: "FAILED",
      items: [
        { status: "COMPLETED", sourceAssetId: "a1", resultAssetId: "o1", variant: "ig" },
        { status: "FAILED", sourceAssetId: "a2", error: "provider timed out", retryable: true, variant: "x" }
      ]
    }));
    const outputs = vi.fn(async () => [{ id: "o1", published: true, publicUrl: "https://cdn.test/o1" }]);
    const publish = vi.fn(async (ids) => ids.map((id) => ({ id, published: true, publicUrl: `https://cdn.test/${id}` })));
    const mcp = await connect(fake({ ops: { run }, jobs: { wait, outputs }, assets: { publish } }));

    const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", asset_ids: ["a1", "a2"] } });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.status).toBe("FAILED");
    expect(res.structuredContent.timedOut).toBeUndefined();
    expect(res.structuredContent.items[1]).toMatchObject({ status: "FAILED", error: "provider timed out", retryable: true, variant: "x" });
    expect(res.structuredContent.items[0].variant).toBe("ig");
  });

  it("job_status on an analyze job returns the answers and publishes nothing (#274)", async () => {
    const get = vi.fn(async () => ({
      id: "jp",
      type: "parse",
      status: "COMPLETED",
      items: [
        { status: "COMPLETED", sourceAssetId: "a1", output: { tags: ["cat"] } },
        { status: "COMPLETED", sourceAssetId: "a1", output: { tags: ["dog"] } }
      ]
    }));
    const assetGet = vi.fn();
    const publish = vi.fn();
    const outputs = vi.fn(async () => []);
    const mcp = await connect(fake({ jobs: { get, outputs }, assets: { get: assetGet, publish } }));

    const res = await mcp.callTool({ name: "job_status", arguments: { job_id: "jp" } });

    // One answer per item, even for the same asset twice: nothing is read back from, or overwritten on, the asset.
    expect(res.structuredContent.analyses).toEqual([
      { assetId: "a1", output: { tags: ["cat"] } },
      { assetId: "a1", output: { tags: ["dog"] } }
    ]);
    expect(assetGet).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("search_assets maps filters and returns references", async () => {
    const list = vi.fn(async () => ({
      items: [
        { id: "a1", name: "n", published: true, publicUrl: "https://cdn.test/a1", mimeType: "image/png", width: 8, tags: ["hero"] },
        { id: "a2", name: "m", published: false, mimeType: "image/png", tags: [] }
      ],
      meta: { total: 1, page: 0, perPage: 20, hasMore: false }
    }));
    const mcp = await connect(fake({ assets: { list } }));
    const res = await mcp.callTool({
      name: "search_assets",
      arguments: { collection: "shoot", tag: "hero", mime: "image/png", per_page: 20 }
    });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ collection: "shoot", tag: "hero", mime: "image/png", perPage: 20 }));
    expect(res.structuredContent.assets[0]).toMatchObject({
      assetId: "a1",
      mimeType: "image/png",
      width: 8,
      tags: ["hero"],
      publicUrl: "https://cdn.test/a1"
    });
    // An untagged asset carries no tags: a reference names only what is there (#334).
    expect(res.structuredContent.assets[1].tags).toBeUndefined();
  });

  it("search_assets reads on by cursor: it passes the cursor through, never with a page, and hands back the next (#493)", async () => {
    const list = vi.fn(async () => ({ items: [{ id: "a3", name: "n" }], meta: { perPage: 1, hasMore: true, nextCursor: "c3" } }));
    const mcp = await connect(fake({ assets: { list } }));
    const res = await mcp.callTool({ name: "search_assets", arguments: { job_id: "j1", cursor: "c2", per_page: 1 } });
    expect(list.mock.calls[0][0]).toMatchObject({ jobId: "j1", cursor: "c2", perPage: 1 });
    expect(list.mock.calls[0][0].page).toBeUndefined();
    expect(res.structuredContent).toMatchObject({ hasMore: true, nextCursor: "c3" });
    expect(res.structuredContent.total).toBeUndefined();
  });

  it("search_assets group_by collection lists the collections, and refuses an asset filter rather than ignore it (#349)", async () => {
    const collections = vi.fn(async () => ({
      items: [{ collection: "shoot-01", count: 3, lastCreatedAt: Date.UTC(2026, 8, 17) }],
      meta: { total: 1, page: 0, perPage: 20, hasMore: false }
    }));
    const list = vi.fn();
    const mcp = await connect(fake({ assets: { collections, list } }));
    const res = await mcp.callTool({ name: "search_assets", arguments: { group_by: "collection", q: "shoot" } });
    expect(collections).toHaveBeenCalledWith({ q: "shoot", perPage: 20 });
    expect(list).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({
      collections: [{ collection: "shoot-01", count: 3, lastAddedAt: "2026-09-17T00:00:00.000Z" }],
      total: 1
    });

    const refused = await mcp.callTool({ name: "search_assets", arguments: { group_by: "collection", tag: "hero" } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent.error).toMatchObject({ code: "invalid_param", param: "group_by" });
    expect(collections).toHaveBeenCalledTimes(1);
  });

  it("run_preset resolves the slug then submits the preset as a job", async () => {
    const get = vi.fn(async () => ({ id: "builtin-preset-util-to-webp", slug: "builtin-util-to-webp", version: 1, steps: [{}] }));
    const run = vi.fn(async () => ({ id: "j2", status: "PENDING" }));
    const mcp = await connect(fake({ presets: { get, run } }));
    const res = await mcp.callTool({ name: "run_preset", arguments: { preset: "builtin-util-to-webp", asset_ids: ["a1"], wait: false } });
    // The reference as the agent gave it, so a slug@version stays pinned (#279) — not the id it resolved to.
    expect(run).toHaveBeenCalledWith("builtin-util-to-webp", ["a1"], { idempotencyKey: undefined, collection: undefined });
    expect(res.structuredContent.jobId).toBe("j2");
  });

  // imagestep#380 — save_preset tells an agent to save "generate + subjects" for a consistent batch; nothing could then run it.
  it("run_preset runs a preset that starts from a prompt with no image at all", async () => {
    const get = vi.fn(async () => ({ id: "p9", slug: "bottle-shots", version: 1, steps: [{ op: "generate", prompt: "a bottle" }] }));
    const run = vi.fn(async () => ({ id: "j9", status: "PENDING" }));
    const mcp = await connect(fake({ presets: { get, run } }));
    const res = await mcp.callTool({ name: "run_preset", arguments: { preset: "bottle-shots", wait: false } });
    expect(res.isError).toBeFalsy();
    expect(run).toHaveBeenCalledWith("bottle-shots", [], { idempotencyKey: undefined, collection: undefined });
    const dry = await mcp.callTool({ name: "run_preset", arguments: { preset: "bottle-shots", dry_run: true } });
    expect(dry.isError).toBeFalsy();
    expect(run).toHaveBeenLastCalledWith("bottle-shots", [], { dryRun: true, collection: undefined });
  });

  it("run_preset still refuses, by name, a preset whose first step works on an image", async () => {
    const get = vi.fn(async () => ({
      id: "p1",
      slug: "packshot",
      version: 1,
      steps: [{ op: "remove_bg" }, { op: "generate", prompt: "x" }]
    }));
    const run = vi.fn();
    const mcp = await connect(fake({ presets: { get, run } }));
    const res = await mcp.callTool({ name: "run_preset", arguments: { preset: "packshot", wait: false } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", param: "asset_ids" });
    expect(run).not.toHaveBeenCalled();
  });

  // imagestep#461 — "the same subject, a new scene each run" is a prompt per run; without one, MCP could only re-run the
  // preset's own scene, or save a version per scene.
  it("run_preset sends this run's prompt and count with the job, and prices the same call", async () => {
    const get = vi.fn(async () => ({ id: "p9", slug: "bottle-shots", version: 2, steps: [{ op: "generate", prompt: "a bottle" }] }));
    const run = vi.fn(async () => ({ id: "j9", status: "PENDING" }));
    const mcp = await connect(fake({ presets: { get, run } }));
    const prompt = "{{subject.bottle}} on a beach at dusk";
    const res = await mcp.callTool({ name: "run_preset", arguments: { preset: "bottle-shots@2", prompt, count: 3, wait: false } });
    expect(res.isError).toBeFalsy();
    expect(run).toHaveBeenCalledWith("bottle-shots@2", [], { idempotencyKey: undefined, collection: undefined, prompt, count: 3 });
    await mcp.callTool({ name: "run_preset", arguments: { preset: "bottle-shots@2", prompt, dry_run: true } });
    expect(run).toHaveBeenLastCalledWith("bottle-shots@2", [], { dryRun: true, collection: undefined, prompt, count: undefined });
  });

  it("run_preset hands the service's refusal of a prompt to the agent as it came", async () => {
    const get = vi.fn(async () => ({ id: "p1", slug: "packshot", version: 1, steps: [{ op: "remove_bg" }, { op: "upscale" }] }));
    const run = vi.fn(async () => {
      throw new ImageStepError({
        status: 400,
        code: "invalid_param",
        message: "preset 'packshot' runs 2 segments, so `prompt` has no one step to override — put it on the step",
        param: "prompt",
        retryable: false
      });
    });
    const mcp = await connect(fake({ presets: { get, run } }));
    const res = await mcp.callTool({
      name: "run_preset",
      arguments: { preset: "packshot", asset_ids: ["a1"], prompt: "brighter", wait: false }
    });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({
      code: "invalid_param",
      param: "prompt",
      retryable: false,
      status: 400,
      message: expect.stringContaining("no one step to override")
    });
  });

  it("run_preset answers a preset that does not exist with the ones that do (#557)", async () => {
    const missing = () =>
      new ImageStepError({
        status: 404,
        code: "preset_not_found",
        message: "Preset not found: thumbnail",
        param: "preset",
        retryable: false
      });
    const run = vi.fn(async () => {
      throw missing();
    });
    const list = vi.fn(async () => [
      { slug: "builtin-util-thumbnail", name: "Thumbnail 300×300" },
      { slug: "shop-thumbs", name: "Shop thumbnails" }
    ]);
    const mcp = await connect(fake({ presets: { run, list } }));
    const res = await mcp.callTool({ name: "run_preset", arguments: { preset: "thumbnail", asset_ids: ["a1"], wait: false } });
    expect(res.structuredContent.error).toMatchObject({ code: "preset_not_found", param: "preset", retryable: false });
    expect(res.structuredContent.error.message).toBe(
      "Preset not found: thumbnail. Presets on this account: builtin-util-thumbnail (Thumbnail 300×300), shop-thumbs (Shop thumbnails)"
    );

    // The list is best effort: when it cannot be read, the refusal is answered as it came.
    const bare = await connect(fake({ presets: { run, list: vi.fn().mockRejectedValue(new Error("down")) } }));
    const again = await bare.callTool({ name: "run_preset", arguments: { preset: "thumbnail", asset_ids: ["a1"], wait: false } });
    expect(again.structuredContent.error.message).toBe("Preset not found: thumbnail");
  });

  it("run_preset sends its collection with the job, not only with what it uploaded", async () => {
    const get = vi.fn(async () => ({ id: "p1", slug: "s", version: 1, steps: [{}] }));
    const run = vi.fn(async () => ({ id: "j3", status: "PENDING" }));
    const mcp = await connect(fake({ presets: { get, run } }));
    await mcp.callTool({ name: "run_preset", arguments: { preset: "s", asset_ids: ["a1"], collection: "shoot", wait: false } });
    expect(run).toHaveBeenCalledWith("s", ["a1"], { idempotencyKey: undefined, collection: "shoot" });
  });

  /**
   * #591 — an automation that posts its outputs at once need not keep them the plan's full retention. retention_days
   * reaches what the call stores: the images it ingests and the job that makes the new ones.
   */
  it("retention_days is sent with the upload and with the job", async () => {
    const fromUrl = vi.fn(async (urls) => urls.map((url, i) => ({ url, asset: { id: `ast_r${i}`, status: "DONE" } })));
    const run = vi.fn(async () => ({ id: "job_r", status: "PENDING" }));
    const presetRun = vi.fn(async () => ({ id: "job_p", status: "PENDING" }));
    const get = vi.fn(async () => ({ id: "p1", slug: "s", version: 1, steps: [{}] }));
    const mcp = await connect(fake({ assets: { fromUrl }, ops: { run }, presets: { get, run: presetRun } }));

    await mcp.callTool({
      name: "transform",
      arguments: { op: "upscale", urls: ["https://93.184.216.34/a.png"], retention_days: 7, wait: false }
    });
    expect(fromUrl).toHaveBeenCalledWith(["https://93.184.216.34/a.png"], { collection: undefined, retentionDays: 7 });
    expect(run.mock.calls[0][1].retentionDays).toBe(7);

    await mcp.callTool({ name: "generate", arguments: { prompt: "a bottle", retention_days: 3, wait: false } });
    expect(run.mock.calls[1][1].retentionDays).toBe(3);

    await mcp.callTool({ name: "run_preset", arguments: { preset: "s", asset_ids: ["a1"], retention_days: 1, wait: false } });
    expect(presetRun.mock.calls[0][2].retentionDays).toBe(1);

    const zero = await mcp
      .callTool({ name: "generate", arguments: { prompt: "x", retention_days: 0, wait: false } })
      .catch((e) => ({ isError: true, e }));
    expect(zero.isError).toBe(true);
  });
});

/**
 * imagestep#279 (decision B) — the two writes an MCP-only client was missing, and the budget it could not read. The
 * guidelines tell an agent to save a chain it has run twice and to report a gap instead of routing around it; with no
 * shell and no console it could do neither.
 */
describe("save_preset / send_feedback / imagestep://usage (#279)", () => {
  /** A schema refusal surfaces as an error result or a thrown McpError depending on the SDK; either is a refusal. */
  async function refused(call) {
    try {
      return (await call()).isError === true;
    } catch {
      return true;
    }
  }

  it("save_preset sends op steps and answers slug@version, which run_preset then runs pinned", async () => {
    const create = vi.fn(async (body) => ({ id: "pre_1", slug: "web-hero", version: 1, steps: body.steps }));
    const get = vi.fn(async () => ({ id: "pre_1", slug: "web-hero", version: 1, steps: [{}, {}] }));
    const run = vi.fn(async () => ({ id: "j9", status: "PENDING" }));
    const mcp = await connect(fake({ presets: { create, get, run } }));
    const steps = [
      { op: "resize", parameters: { width: 1600 } },
      { op: "convert", parameters: { format: "webp", quality: 82 } }
    ];

    const saved = await mcp.callTool({
      name: "save_preset",
      arguments: { name: "Web hero", slug: "web-hero", steps, idempotency_key: "k1" }
    });

    expect(saved.isError).toBeFalsy();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: "Web hero", slug: "web-hero", steps }), { idempotencyKey: "k1" });
    expect(saved.structuredContent).toMatchObject({ preset: "web-hero@1", slug: "web-hero", version: 1, steps: 2 });

    await mcp.callTool({ name: "run_preset", arguments: { preset: saved.structuredContent.preset, asset_ids: ["a1"], wait: false } });
    expect(run).toHaveBeenCalledWith("web-hero@1", ["a1"], { idempotencyKey: undefined });
  });

  it("generate runs through a consistency preset: the reference, version included, reaches the job as presetId (#250)", async () => {
    const run = vi.fn(async () => ({ id: "j1", status: "PENDING" }));
    const estimate = vi.fn(async () => ({ estimatedCredits: 2 }));
    const mcp = await connect(fake({ ops: { run, estimate } }));

    await mcp.callTool({ name: "generate", arguments: { prompt: "on a beach", preset: "hero-character@2", wait: false } });
    expect(run).toHaveBeenCalledWith("generate", expect.objectContaining({ prompt: "on a beach", presetId: "hero-character@2" }));

    await mcp.callTool({ name: "generate", arguments: { prompt: "on a beach", preset: "hero-character@2", dry_run: true } });
    expect(estimate).toHaveBeenCalledWith("generate", expect.objectContaining({ presetId: "hero-character@2" }));

    const { tools } = await mcp.listTools();
    const generate = tools.find((t) => t.name === "generate");
    expect(generate.inputSchema.properties.preset.description).toContain("slug@version");
    expect(generate.description).toContain("subjects");
  });

  it("a step is an L1 op: a registry step, or an op that is not a step, is refused by the schema before any request", async () => {
    const create = vi.fn();
    const mcp = await connect(fake({ presets: { create } }));
    for (const step of [{ operation: "sharpen", params: { sigma: 0.5 } }, { op: "read_metadata" }, { op: "render_template" }]) {
      expect(
        await refused(() => mcp.callTool({ name: "save_preset", arguments: { name: "x", steps: [step] } })),
        JSON.stringify(step)
      ).toBe(true);
    }
    expect(create).not.toHaveBeenCalled();

    const { tools } = await mcp.listTools();
    const stepOps = tools.find((t) => t.name === "save_preset").inputSchema.properties.steps.items.properties.op.enum;
    expect(stepOps).toEqual(expect.arrayContaining(["generate", "edit", "remove_bg", "resize"]));
    expect(stepOps).not.toContain("read_metadata");
    expect(stepOps).not.toContain("render_template");
  });

  it("a refusal from the service is the structured error, not a thrown one", async () => {
    const create = vi.fn(async () => {
      throw new ImageStepError({
        status: 400,
        code: "invalid_param",
        message: "steps[1].parameters.width out of range",
        retryable: false,
        param: "steps[1].parameters.width"
      });
    });
    const mcp = await connect(fake({ presets: { create } }));
    const res = await mcp.callTool({ name: "save_preset", arguments: { name: "x", steps: [{ op: "resize", parameters: { width: -1 } }] } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", retryable: false, param: "steps[1].parameters.width" });
  });

  it("send_feedback files the report through the agent face, with the key", async () => {
    const feedback = vi.fn(async () => ({ id: "fb_1", kind: "capability_gap" }));
    const mcp = await connect(fake({ agent: { feedback } }));
    const res = await mcp.callTool({
      name: "send_feedback",
      arguments: {
        kind: "capability_gap",
        op: "detect_faces",
        message: "No such op.",
        context: { tried: "analyze" },
        idempotency_key: "fb-1"
      }
    });
    expect(feedback).toHaveBeenCalledWith({
      kind: "capability_gap",
      message: "No such op.",
      op: "detect_faces",
      context: { tried: "analyze" },
      idempotencyKey: "fb-1"
    });
    expect(res.structuredContent).toMatchObject({ reported: true, id: "fb_1", kind: "capability_gap" });
  });

  it("imagestep://usage is spend by op over the API's default window, read live", async () => {
    const client = fake();
    const get = vi.fn(async () => ({ groupBy: "op", total: { credits: 10 }, groups: [{ key: "remove_bg", credits: 10, jobs: 2 }] }));
    client.usage.get = get;
    const mcp = await connect(client);

    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri)).toContain("imagestep://usage");
    const { contents } = await mcp.readResource({ uri: "imagestep://usage" });

    expect(get).toHaveBeenCalledWith({ groupBy: "op" });
    expect(JSON.parse(contents[0].text).groups[0]).toMatchObject({ key: "remove_bg", jobs: 2 });
  });
});

describe("hosted wait cap (#275)", () => {
  const slowWait = vi.fn(async (id, { timeoutMs }) => {
    throw new JobFailedError({ id, status: "PROCESSING", items: [] }, `Job ${id} still PROCESSING after ${timeoutMs} ms`);
  });

  it("clamps wait_seconds to the cap, says so in the schema, and names the cap in the timedOut note", async () => {
    slowWait.mockClear();
    const run = vi.fn(async () => ({ id: "job_h", status: "PENDING" }));
    const mcp = await connect(fake({ ops: { run }, jobs: { wait: slowWait } }), { maxWaitSeconds: 90 });
    const ws = (await mcp.listTools()).tools.find((t) => t.name === "transform").inputSchema.properties.wait_seconds;
    expect(ws.default).toBe(90);
    expect(ws.description).toMatch(/at most 90 s/);

    const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", asset_ids: ["a1"], wait_seconds: 300 } });

    expect(slowWait.mock.calls[0][1].timeoutMs).toBe(90_000);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ jobId: "job_h", status: "PROCESSING", timedOut: true });
    expect(res.structuredContent.note).toMatch(/at most 90 s per call/);
  });

  it("stdio keeps the wait it was asked for", async () => {
    slowWait.mockClear();
    const run = vi.fn(async () => ({ id: "job_s", status: "PENDING" }));
    const mcp = await connect(fake({ ops: { run }, jobs: { wait: slowWait } }));
    const ws = (await mcp.listTools()).tools.find((t) => t.name === "generate").inputSchema.properties.wait_seconds;
    expect(ws.default).toBe(180);

    const res = await mcp.callTool({ name: "generate", arguments: { prompt: "x", wait_seconds: 300 } });
    expect(slowWait.mock.calls[0][1].timeoutMs).toBe(300_000);
    expect(res.structuredContent.note).not.toMatch(/at most/);
  });

  it("serveHttp builds every per-request server with the cap", async () => {
    clearCatalogueCache();
    const fakeFetch = async () =>
      new Response(JSON.stringify({ success: true, data: [{ op: "resize", kind: "deterministic", requiresAssets: true }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const http = serveHttp({ port: 0, host: "127.0.0.1", baseUrl: `https://cap${Math.random()}.test`, fetch: fakeFetch });
    try {
      await new Promise((r) => (http.listening ? r() : http.once("listening", r)));
      const res = await fetch(`http://127.0.0.1:${http.address().port}/mcp`, {
        method: "POST",
        headers: { authorization: "Bearer is_sk_t", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      const { result } = await res.json();
      const ws = result.tools.find((t) => t.name === "transform").inputSchema.properties.wait_seconds;
      expect(ws.default).toBe(HOSTED_MAX_WAIT_SECONDS);
      expect(HOSTED_MAX_WAIT_SECONDS).toBeLessThan(100); // Cloudflare's edge gives up on the origin at 100 s
    } finally {
      await new Promise((r) => http.close(r));
    }
  });
});

/**
 * #632 — a hosted call waits up to 90 s for its job, and a shutdown gives the calls in flight 25 s. A call cut there
 * left the agent with no job id, and its retry was a second job and a second charge. When the server drains, a call
 * still waiting answers at once with the handle; and the submit — the one request it must not cut, because until it
 * answers there is no id — holds for no longer than the drain can wait.
 */
describe("draining the hosted server (#632)", () => {
  const RUNNING = { id: "job_d", status: "PROCESSING", items: [{ status: "COMPLETED" }, { status: "PROCESSING" }] };

  /** A real SDK whose job reads wait on the service until their request is aborted; the submit's leg is a fake. */
  function drainable() {
    const reads = [];
    const client = new ImageStep({
      apiKey: "is_sk_test",
      fetch: (url, init) => {
        reads.push(String(url));
        return new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      }
    });
    // What the SDK does when the submit's leg runs out with the job still going: JobFailedError carrying the job.
    client.ops.run = vi.fn(async () => {
      throw new JobFailedError(RUNNING, "Job job_d still PROCESSING after 15000 ms");
    });
    return { client, reads };
  }

  it("holds the submit for at most 15 s, then answers the moment the drain starts — the handle, timedOut", async () => {
    const { client, reads } = drainable();
    const draining = new AbortController();
    const mcp = await connect(client, { maxWaitSeconds: 90, drain: draining.signal });

    const call = mcp.callTool({ name: "transform", arguments: { op: "upscale", asset_ids: ["a1", "a2"], wait_seconds: 90 } });
    await vi.waitFor(() => expect(reads.some((u) => /\/api\/v1\/jobs\/job_d\?wait=\d+/.test(u))).toBe(true));
    const aborted = Date.now();
    draining.abort(new Error("SIGTERM"));
    const res = await call;

    expect(Date.now() - aborted).toBeLessThan(1_000);
    expect(client.ops.run.mock.calls[0][1].wait.timeoutMs).toBe(15_000);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ jobId: "job_d", status: "PROCESSING", timedOut: true, completedItems: 1 });
    expect(res.structuredContent.note).toMatch(/restarting/);
    expect(res.structuredContent.note).toMatch(/do not submit it again/);
  });

  it("already draining when the submit answers: the handle, and no read started that could not see the abort", async () => {
    const { client, reads } = drainable();
    const draining = new AbortController();
    draining.abort(new Error("SIGTERM"));
    const mcp = await connect(client, { maxWaitSeconds: 90, drain: draining.signal });

    const res = await mcp.callTool({ name: "generate", arguments: { prompt: "a red bicycle", wait_seconds: 60 } });

    expect(reads).toEqual([]);
    expect(res.structuredContent).toMatchObject({ jobId: "job_d", timedOut: true });
    expect(res.structuredContent.note).toMatch(/restarting/);
  });

  it("a wait no longer than the submit's hold is the submit's alone, as before", async () => {
    const { client, reads } = drainable();
    const mcp = await connect(client, { maxWaitSeconds: 90, drain: new AbortController().signal });

    const res = await mcp.callTool({ name: "generate", arguments: { prompt: "a red bicycle", wait_seconds: 10 } });

    expect(client.ops.run.mock.calls[0][1].wait.timeoutMs).toBe(10_000);
    expect(reads).toEqual([]);
    expect(res.structuredContent).toMatchObject({ jobId: "job_d", timedOut: true });
    expect(res.structuredContent.note).toMatch(/after 10 s of waiting/);
  });

  it("without a drain (stdio) the submit keeps the whole wait", async () => {
    const { client } = drainable();
    const mcp = await connect(client);

    await mcp.callTool({ name: "generate", arguments: { prompt: "a red bicycle", wait_seconds: 120 } });

    expect(client.ops.run.mock.calls[0][1].wait.timeoutMs).toBe(120_000);
  });
});

/**
 * #470 — `--http` on a laptop answered the whole LAN (it bound 0.0.0.0) and any Host, so a web page could point a
 * hostname it controls at the developer's machine (DNS rebinding) and drive the server from the browser.
 */
describe("serveHttp: loopback by default, and only its own Host names", () => {
  async function listening(options) {
    let upstream = 0;
    const http = serveHttp({
      port: 0,
      baseUrl: `https://host${Math.random()}.test`,
      fetch: async () => {
        upstream++;
        return Response.json({ success: true, data: [] });
      },
      ...options
    });
    await new Promise((r) => (http.listening ? r() : http.once("listening", r)));
    return { http, upstream: () => upstream };
  }

  function post(port, host) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            host,
            authorization: "Bearer is_sk_t",
            "content-type": "application/json",
            accept: "application/json, text/event-stream"
          }
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
  }

  it("binds 127.0.0.1 when no host is given", async () => {
    const { http } = await listening({});
    try {
      expect(http.address().address).toBe("127.0.0.1");
    } finally {
      await new Promise((r) => http.close(r));
    }
  });

  it("refuses a Host that is not one of its loopback names, before any upstream call", async () => {
    clearCatalogueCache();
    const { http, upstream } = await listening({});
    const { port } = http.address();
    try {
      const rebound = await post(port, `attacker.example:${port}`);
      expect(rebound.status).toBe(403);
      expect(JSON.parse(rebound.body).error.code).toBe("forbidden");
      expect(upstream()).toBe(0);

      for (const name of [`localhost:${port}`, `127.0.0.1:${port}`]) expect((await post(port, name)).status, name).toBe(200);
    } finally {
      await new Promise((r) => http.close(r));
    }
  });

  it("answers to the operator's list when it is given one", async () => {
    clearCatalogueCache();
    const { http } = await listening({ allowedHosts: ["mcp.example.com"] });
    const { port } = http.address();
    try {
      expect((await post(port, "mcp.example.com")).status).toBe(200);
      expect((await post(port, `localhost:${port}`)).status).toBe(403);
    } finally {
      await new Promise((r) => http.close(r));
    }
  });
});

describe("tool annotations and job_status's publish default (#278)", () => {
  it("no tool offers a mode: a job never overwrites its input (#331)", async () => {
    const mcp = await connect(fake());
    for (const tool of (await mcp.listTools()).tools)
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).not.toContain("mode");
  });

  it("every tool carries annotations a client can decide confirmation on", async () => {
    const mcp = await connect(fake());
    const by = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t.annotations]));

    expect(Object.keys(by)).toHaveLength(7);
    for (const [name, a] of Object.entries(by)) expect(a, name).toMatchObject({ openWorldHint: true });
    expect(by.job_status.readOnlyHint).toBe(true);
    expect(by.search_assets.readOnlyHint).toBe(true);
    for (const name of ["generate", "transform", "run_preset"])
      expect(by[name]).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(by.generate.destructiveHint).toBe(false);
    expect(by.transform.destructiveHint).toBe(false);
    // #331: every job writes new assets, so no tool overwrites anything — run_preset was destructive only through `mode`.
    expect(by.run_preset.destructiveHint).toBe(false);
    for (const name of ["save_preset", "send_feedback"])
      expect(by[name], name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
  });

  it("job_status publishes nothing unless asked", async () => {
    const get = vi.fn(async () => ({ id: "j", status: "COMPLETED", items: [{ status: "COMPLETED", resultAssetId: "o1" }] }));
    const outputs = vi.fn(async () => [{ id: "o1", published: false }]);
    const list = vi.fn(async () => ({ items: [{ id: "o1", published: false }], meta: { page: 0, total: 1, hasMore: false } }));
    const publish = vi.fn(async (ids) => ids.map((id) => ({ id, published: true, publicUrl: `https://cdn.test/${id}` })));
    const mcp = await connect(fake({ jobs: { get, outputs }, assets: { publish, list } }));

    const quiet = await mcp.callTool({ name: "job_status", arguments: { job_id: "j" } });
    expect(publish).not.toHaveBeenCalled();
    expect(quiet.structuredContent.outputs[0]).toMatchObject({ assetId: "o1" });

    const asked = await mcp.callTool({ name: "job_status", arguments: { job_id: "j", publish: true } });
    expect(publish).toHaveBeenCalledWith(["o1"]);
    expect(asked.structuredContent.outputs[0].publicUrl).toBe("https://cdn.test/o1");
  });
});

describe("http auth + url safety", () => {
  it("accepts ApiKey and Bearer schemes", () => {
    expect(apiKeyFrom({ headers: { authorization: "ApiKey is_sk_1" } })).toBe("is_sk_1");
    expect(apiKeyFrom({ headers: { authorization: "Bearer is_sk_2" } })).toBe("is_sk_2");
    expect(apiKeyFrom({ headers: {} })).toBeNull();
  });
  it("classifies private ranges and resolves hostnames before fetching", async () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "100.64.0.1", "::1", "fd00::1"])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "104.16.0.1", "2606:4700::1"]) expect(isPrivateAddress(ip)).toBe(false);
    const resolver = async () => [{ address: "10.43.0.1" }];
    await expect(assertPublicUrl("https://evil.example/x.png", resolver)).rejects.toThrow(/private/);
    await expect(assertPublicUrl("ftp://x/y", resolver)).rejects.toThrow(/http/);
    const url = await assertPublicUrl("https://cdn.example/x.png", async () => [{ address: "104.16.0.1" }]);
    expect(url.hostname).toBe("cdn.example");
  });

  // #479 (the service's twin is #475): an IPv4 address carried inside an IPv6 one was waved through — WHATWG turns
  // `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`, and only the dotted form was looked for.
  it.each([
    "http://[::ffff:127.0.0.1]/x.png",
    "http://[::ffff:7f00:1]/x.png",
    "http://[::ffff:a9fe:a9fe]/latest/meta-data",
    "http://[::ffff:10.0.0.1]/x.png",
    "http://[::127.0.0.1]/x.png",
    "http://[::ffff:0:7f00:1]/x.png",
    "http://[64:ff9b::a9fe:a9fe]/x.png",
    "http://[64:ff9b::10.1.2.3]/x.png",
    "http://[64:ff9b:1::1]/x.png",
    "http://[2002:7f00:1::]/x.png",
    "http://[2002:c0a8:101::1]/x.png",
    "http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/x.png",
    "http://[fe90::1]/x.png",
    "http://[fec0::1]/x.png",
    "http://[ff02::1]/x.png",
    "http://[2001:db8::1]/x.png",
    "http://[::]/x.png"
  ])("refuses %s", async (raw) => {
    await expect(assertPublicUrl(raw, async () => [])).rejects.toMatchObject({ code: "invalid_param", param: "urls" });
  });

  it("judges what a hostname RESOLVES to by the same rule, zone ids and all", async () => {
    for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:a00:1::", "fe80::1%en0"])
      await expect(
        assertPublicUrl("https://rebind.example/x.png", async () => [{ address }]),
        address
      ).rejects.toThrow(/private/);
  });

  it("classifies the shared address list the service's guard is held to (ledger C52)", () => {
    for (const ip of ADDRESSES.refused) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ADDRESSES.allowed) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

// #520: a job's outputs land in a context the way its items do — the first page, the total, and where the rest are.
describe("job outputs in an answer (#520)", () => {
  const done = (n) => ({
    id: "j500",
    type: "ai-upscale",
    status: "COMPLETED",
    totalItems: n,
    items: Array.from({ length: Math.min(n, 100) }, (_, i) => ({ status: "COMPLETED", resultAssetId: `o${i}` }))
  });
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, name: `o${i}.png`, status: "DONE" }));

  it("job_status carries the first OUTPUTS_INLINE outputs of 500, reads one page for them, and says how to page on", async () => {
    const get = vi.fn(async () => done(500));
    const outputs = vi.fn();
    const list = vi.fn(async ({ perPage, page }) => ({
      items: rows(500)
        .slice(page * perPage, (page + 1) * perPage)
        .reverse(),
      meta: { page, perPage, total: 500, hasMore: true, nextCursor: "c20" }
    }));
    const mcp = await connect(fake({ jobs: { get, outputs }, assets: { list } }));
    const res = await mcp.callTool({ name: "job_status", arguments: { job_id: "j500" } });
    const ref = res.structuredContent;
    expect(ref.outputs).toHaveLength(OUTPUTS_INLINE);
    expect(ref.outputs.map((o) => o.assetId)).toEqual(rows(OUTPUTS_INLINE).map((r) => r.id)); // item order within the page
    expect(ref.outputsTruncated).toBe(true);
    // Where the listing stopped (#493): the next call reads exactly the rest, uncounted.
    expect(ref.outputsNote).toMatch(/first 20 outputs of 500.*search_assets.*"job_id": "j500".*"cursor": "c20"/);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toMatchObject({ jobId: "j500", perPage: OUTPUTS_INLINE, page: 0 });
    expect(outputs).not.toHaveBeenCalled();
    // Compact JSON: the answer's text carries no indentation.
    expect(res.content[0].text).not.toMatch(/\n {2}/);
    expect(res.content[0].text.length).toBeLessThan(20_000);
  });

  it("with publish every output is published, and still only the first page comes back", async () => {
    const get = vi.fn(async () => done(45));
    const outputs = vi.fn(async () => rows(45));
    const publish = vi.fn(async (ids) => ids.map((id) => ({ id, published: true, publicUrl: `https://cdn.test/${id}` })));
    const mcp = await connect(fake({ jobs: { get, outputs }, assets: { publish } }));
    const res = await mcp.callTool({ name: "job_status", arguments: { job_id: "j500", publish: true } });
    expect(publish.mock.calls.flatMap(([ids]) => ids)).toHaveLength(45);
    expect(res.structuredContent.outputs).toHaveLength(OUTPUTS_INLINE);
    expect(res.structuredContent.outputs.every((o) => o.publicUrl)).toBe(true);
    expect(res.structuredContent.outputsNote).toMatch(/of 45/);
    // Read whole and reordered: there is no point in the listing to continue from, so the walk starts at the top.
    expect(res.structuredContent.outputsNote).toMatch(/search_assets \{"job_id": "j500"\} and follow its nextCursor/);
  });

  it("a job small enough to fit carries no note", async () => {
    const get = vi.fn(async () => done(3));
    const list = vi.fn(async () => ({ items: rows(3), meta: { page: 0, total: 3, hasMore: false } }));
    const mcp = await connect(fake({ jobs: { get }, assets: { list } }));
    const res = await mcp.callTool({ name: "job_status", arguments: { job_id: "j500" } });
    expect(res.structuredContent.outputs).toHaveLength(3);
    expect(res.structuredContent.outputsTruncated).toBeUndefined();
    expect(res.structuredContent.outputsNote).toBeUndefined();
  });

  it("the wait rides on the submit: a job that comes back finished costs no read (#355)", async () => {
    const run = vi.fn(async (_op, opts) => ({ ...done(1), id: "j1", waitAsked: opts.wait }));
    const wait = vi.fn();
    const list = vi.fn(async () => ({ items: rows(1), meta: { total: 1 } }));
    const mcp = await connect(fake({ ops: { run }, jobs: { wait }, assets: { list } }));
    const res = await mcp.callTool({
      name: "transform",
      arguments: { op: "upscale", asset_ids: ["a1"], wait_seconds: 30, publish: false }
    });
    expect(res.isError).toBeFalsy();
    expect(run.mock.calls[0][1].wait).toEqual({ timeoutMs: 30_000, throwOnFailure: false });
    expect(wait).not.toHaveBeenCalled();
  });

  it("run_preset over asset ids does not read the preset's export first", async () => {
    const get = vi.fn();
    const run = vi.fn(async () => ({ id: "jp", status: "PENDING", items: [] }));
    const mcp = await connect(fake({ presets: { get, run } }));
    const res = await mcp.callTool({ name: "run_preset", arguments: { preset: "web-optimize@1", asset_ids: ["a1"], wait: false } });
    expect(res.isError).toBeFalsy();
    expect(get).not.toHaveBeenCalled();
  });
});
