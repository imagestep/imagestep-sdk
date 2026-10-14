import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ImageStepError, JobFailedError } from "imagestep";
import { createServer } from "../src/server.js";

/**
 * imagestep#768 — every tool declares an `outputSchema`, and every answer it gives is one. Each case below calls a tool
 * through the SDK's own `Client`, which checks `structuredContent` against the JSON Schema `tools/list` published — there
 * `additionalProperties` is false, so a key the schema does not name is red, not just a wrong type — and then parses the
 * same content with the tool's zod schema. The documents the fake client returns carry every field the projections read,
 * nulls where the service may send them, so a mode's whole answer is exercised.
 */

const ITEM = {
  index: 0,
  status: "COMPLETED",
  sourceAssetId: "ast_src",
  resultAssetId: "ast_out",
  error: null,
  errorCode: null,
  retryable: null,
  variant: "ig",
  step: 1,
  failedStep: null,
  provider: "fal",
  model: "fal-ai/clarity-upscaler",
  durationMs: 8412,
  credits: 12,
  startedAt: "2026-10-14T10:00:00Z",
  finishedAt: "2026-10-14T10:00:08Z",
  output: { text: "a red bicycle" }
};

const JOB = {
  id: "job_1",
  type: "ai-edit",
  status: "COMPLETED",
  op: "upscale",
  presetId: "pre_1",
  presetVersion: 2,
  templateId: null,
  templateVersion: null,
  totalItems: 150,
  completedItems: 150,
  failedItems: 0,
  actualCredits: 1800,
  errorCode: null,
  retryable: null,
  expiresAt: "2026-11-14T10:00:00Z",
  itemsTruncated: true,
  itemsNextCursor: "items-2",
  items: [ITEM]
};

const ASSET = {
  id: "ast_out",
  name: "hero.png",
  status: "FAILED",
  mimeType: "image/png",
  width: 3200,
  height: 2400,
  size: 1834211,
  collection: "launch",
  tags: ["hero"],
  publicUrl: "https://cdn.example/ast_out",
  expiresAt: 1792000000000,
  error: { code: "unsupported_format", message: "not an image", retryable: false }
};

function fakeClient(overrides = {}) {
  return {
    images: {
      supports: vi.fn(async () => false),
      transformResult: vi.fn(async (op, input) =>
        input.response === "url"
          ? {
              json: {
                url: "https://sign.example/tmp/sync/r",
                contentType: "image/webp",
                bytes: 4,
                expiresInSeconds: 300,
                width: 40,
                height: 20
              },
              contentType: "application/json",
              width: null,
              height: null
            }
          : { bytes: new Uint8Array([1, 2, 3, 4]), contentType: "image/webp", width: 40, height: 20 }
      ),
      metadata: vi.fn(async () => ({
        durationMs: 12,
        image: { width: 10, height: 10, mimeType: "image/png" },
        metadata: { Make: "Canon" }
      }))
    },
    ops: {
      run: vi.fn(async (op, opts) =>
        opts.dryRun
          ? { estimatedCredits: 12, creditBalance: 500, sufficientCredit: true, totalItems: 1, costPerItem: 12, model: "m", warnings: [] }
          : JOB
      ),
      estimate: vi.fn(async () => ({ estimatedCredits: 12, creditBalance: 500, sufficientCredit: true, totalItems: 1, costPerItem: 12 })),
      readMetadata: vi.fn(async (id) => ({ id, name: "a.jpg", image: { width: 1 }, metadata: { Make: "Canon" }, expiresAt: null }))
    },
    jobs: {
      get: vi.fn(async () => JOB),
      wait: vi.fn(async () => JOB),
      items: vi.fn(async () => ({ items: [ITEM], meta: { hasMore: true, nextCursor: "items-3" } })),
      iterateItems: vi.fn(async function* () {
        yield ITEM;
      }),
      // A published run reads every output; more than an answer carries, so it says where the rest are.
      outputs: vi.fn(async () => Array.from({ length: 21 }, (_, n) => ({ ...ASSET, id: `ast_out${n}` })))
    },
    assets: {
      list: vi.fn(async () => ({ items: [ASSET], meta: { page: 0, perPage: 20, total: 25, hasMore: true, nextCursor: "assets-2" } })),
      collections: vi.fn(async () => ({
        items: [{ collection: "launch", count: 3, lastCreatedAt: 1792000000000 }],
        meta: { page: 0, perPage: 20, total: 1, hasMore: false, nextCursor: null }
      })),
      publish: vi.fn(async (ids) => ids.map((id) => ({ ...ASSET, id, publicUrl: `https://cdn.example/${id}` })))
    },
    presets: {
      get: vi.fn(async () => ({ id: "pre_1", slug: "web-hero", version: 2, steps: [{ op: "resize" }] })),
      run: vi.fn(async (ref, ids, opts) =>
        opts.dryRun ? { estimatedCredits: 0, creditBalance: 500, sufficientCredit: true, totalItems: 1, costPerItem: 0, steps: [] } : JOB
      ),
      create: vi.fn(async () => ({ id: "pre_2", slug: "web-hero", version: 1, steps: [{ op: "resize" }], warnings: ["step 1: lossy"] })),
      list: vi.fn(async () => [])
    },
    agent: { feedback: vi.fn(async () => ({ id: "fbk_1" })) },
    ...overrides
  };
}

async function call(client, name, args, opts = {}) {
  const server = createServer({ apiKey: "is_sk_test", client, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "0" });
  await mcp.connect(clientTransport);
  // The client checks an answer only against a schema it has listed: list first, as a client does.
  await mcp.listTools();
  // The client validates the answer against the published outputSchema; a mismatch throws here.
  const result = await mcp.callTool({ name, arguments: args });
  await mcp.close();
  server._registeredTools[name].outputSchema.parse(result.structuredContent);
  return result;
}

function pending() {
  return { ...JOB, status: "PROCESSING", completedItems: 0 };
}

const CASES = [
  ["generate", "job", () => call(fakeClient(), "generate", { prompt: "a fox" })],
  ["generate", "estimate", () => call(fakeClient(), "generate", { prompt: "a fox", dry_run: true })],
  [
    "generate",
    "timedOut",
    () =>
      call(
        fakeClient({
          ops: {
            run: vi.fn(async () => {
              throw new JobFailedError(pending(), "timed out");
            })
          }
        }),
        "generate",
        { prompt: "a fox", wait_seconds: 5 }
      )
  ],
  ["generate", "no wait", () => call(fakeClient(), "generate", { prompt: "a fox", wait: false })],
  ["transform", "job", () => call(fakeClient(), "transform", { op: "upscale", asset_ids: ["ast_src"] })],
  ["transform", "job, published", () => call(fakeClient(), "transform", { op: "upscale", asset_ids: ["ast_src"], publish: true })],
  ["transform", "estimate", () => call(fakeClient(), "transform", { op: "upscale", asset_ids: ["ast_src"], dry_run: true })],
  [
    "transform",
    "sync, a file",
    () => {
      const client = fakeClient();
      client.images.supports = vi.fn(async () => true);
      return call(client, "transform", { op: "resize", file_paths: ["/tmp/a.png"], parameters: { width: 40 } }, { allowLocalFiles: true });
    }
  ],
  [
    "transform",
    "sync, a signed link",
    () => {
      const client = fakeClient();
      client.images.supports = vi.fn(async () => true);
      return call(
        client,
        "transform",
        { op: "resize", urls: ["https://93.184.216.34/a.jpg"], parameters: { width: 40 } },
        { allowLocalFiles: false }
      );
    }
  ],
  [
    "transform",
    "read_metadata, a file",
    () => call(fakeClient(), "transform", { op: "read_metadata", file_paths: ["/tmp/a.jpg"] }, { allowLocalFiles: true })
  ],
  ["transform", "read_metadata, assets", () => call(fakeClient(), "transform", { op: "read_metadata", asset_ids: ["ast_1", "ast_2"] })],
  [
    "transform",
    "analyze",
    () => {
      const client = fakeClient();
      client.ops.run = vi.fn(async () => ({ ...JOB, type: "parse", itemsTruncated: false }));
      return call(client, "transform", { op: "analyze", asset_ids: ["ast_src"], prompt: "what is it?" });
    }
  ],
  ["run_preset", "job", () => call(fakeClient(), "run_preset", { preset: "web-hero@2", asset_ids: ["ast_src"] })],
  ["run_preset", "estimate", () => call(fakeClient(), "run_preset", { preset: "web-hero@2", asset_ids: ["ast_src"], dry_run: true })],
  [
    "save_preset",
    "saved",
    () => call(fakeClient(), "save_preset", { name: "Web hero", steps: [{ op: "resize", parameters: { width: 1600 } }] })
  ],
  [
    "job_status",
    "running",
    () => {
      const client = fakeClient();
      client.jobs.get = vi.fn(async () => pending());
      return call(client, "job_status", { job_id: "job_1" });
    }
  ],
  ["job_status", "completed", () => call(fakeClient(), "job_status", { job_id: "job_1", publish: true })],
  ["job_status", "a page of items", () => call(fakeClient(), "job_status", { job_id: "job_1", items_status: "FAILED" })],
  [
    "job_status",
    "analyze",
    () => {
      const client = fakeClient();
      client.jobs.get = vi.fn(async () => ({ ...JOB, type: "parse" }));
      return call(client, "job_status", { job_id: "job_1" });
    }
  ],
  ["search_assets", "assets", () => call(fakeClient(), "search_assets", { collection: "launch" })],
  ["search_assets", "collections", () => call(fakeClient(), "search_assets", { group_by: "collection" })],
  ["send_feedback", "reported", () => call(fakeClient(), "send_feedback", { kind: "capability_gap", message: "no vectorize" })],
  [
    "search_assets",
    "error",
    () => {
      const client = fakeClient();
      client.assets.list = vi.fn(async () => {
        throw new ImageStepError({
          status: 400,
          code: "invalid_param",
          message: "width must be between 1 and 16384",
          retryable: false,
          param: "width",
          details: { allowed: [1, 16384] },
          requestId: "3c9e1f40-7b2d-4a8e-9f61-0d5a2b7c8e14"
        });
      });
      return call(client, "search_assets", { min_width: 0 });
    }
  ]
];

describe("every tool's answer is its outputSchema (#768)", () => {
  it("tools/list gives every tool an object outputSchema that names no required key", async () => {
    const server = createServer({ apiKey: "is_sk_test", client: fakeClient() });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientTransport);
    const { tools } = await mcp.listTools();
    await mcp.close();
    expect(tools.length).toBe(7);
    for (const tool of tools) {
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      expect(tool.outputSchema.additionalProperties, tool.name).toBe(false);
      expect(tool.outputSchema.required ?? [], tool.name).toEqual([]);
    }
  });

  it("has a case for every tool", () => {
    expect(new Set(CASES.map(([tool]) => tool)).size).toBe(7);
  });

  it.each(CASES)("%s (%s): the client accepts the answer and the schema parses it", async (tool, mode, run) => {
    const result = await run();
    expect(result.structuredContent).toBeTruthy();
    expect(Boolean(result.isError), mode).toBe(mode === "error");
  });

  it("covers the modes: a timed-out handle, a truncated job, a dry run, both sync answers, both read_metadata answers", async () => {
    const answers = Object.fromEntries(
      await Promise.all(CASES.map(async ([tool, mode, run]) => [`${tool} ${mode}`, (await run()).structuredContent]))
    );
    expect(answers["generate timedOut"].timedOut).toBe(true);
    expect(answers["transform job"]).toMatchObject({ outputsTruncated: true, itemsNote: expect.any(String) });
    expect(answers["transform estimate"].estimate.sufficientCredit).toBe(true);
    expect(answers["transform sync, a file"]).toMatchObject({ mode: "sync", path: expect.any(String) });
    expect(answers["transform sync, a signed link"]).toMatchObject({ mode: "sync", url: expect.any(String), expiresInSeconds: 300 });
    expect(answers["transform read_metadata, a file"]).toMatchObject({ mode: "sync", metadata: { Make: "Canon" } });
    expect(answers["transform read_metadata, assets"].assets).toHaveLength(2);
    expect(answers["transform analyze"].analyses).toHaveLength(1);
    expect(answers["run_preset estimate"].preset).toMatchObject({ slug: "web-hero" });
    expect(answers["save_preset saved"].warnings).toHaveLength(1);
    expect(answers["job_status a page of items"].itemsCursor).toBe("items-3");
    expect(answers["search_assets collections"].collections).toHaveLength(1);
    expect(answers["search_assets error"].error.code).toBe("invalid_param");
  });
});
