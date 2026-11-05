import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ImageStep } from "imagestep";
import { createServer } from "../src/server.js";

/**
 * imagestep#942 — over stdio `file_paths` names files on the user's machine, and the agent naming them may be following an
 * instruction injected into something it read. A path through a hidden file or folder is refused before anything is read,
 * the client's MCP roots (else IMAGESTEP_MCP_FILE_ROOTS) bound the rest, compared on real paths, and the outputs of a job
 * over local files stay private unless the agent asks.
 */

let dir; // real path: tmpdir() is a symlink on macOS
let pics;
let other;
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "imagestep-test-mcp-local-files-")));
  pics = join(dir, "pics");
  other = join(dir, "other");
  for (const d of [pics, other, join(dir, ".secret")]) mkdirSync(d);
  for (const f of [join(pics, "a.png"), join(other, "b.png"), join(dir, ".secret", "key.png"), join(pics, ".env")]) writeFileSync(f, "x");
  symlinkSync(join(dir, ".secret", "key.png"), join(pics, "innocent.png")); // inside a root, leads to a hidden file
  symlinkSync(join(other, "b.png"), join(pics, "escape.png")); // inside a root, leads out of it
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeClient() {
  const c = new ImageStep({
    apiKey: "is_sk_test",
    fetch: () => {
      throw new Error("no network in tests");
    }
  });
  const calls = {
    uploadMany: vi.fn(async (paths) => paths.map((name, i) => ({ name, asset: { id: `ast_${i}`, status: "READY" } }))),
    run: vi.fn(async () => ({ id: "job_1", status: "PENDING" })),
    wait: vi.fn(async () => ({
      id: "job_1",
      status: "COMPLETED",
      items: [{ status: "COMPLETED", sourceAssetId: "ast_0", resultAssetId: "out1" }]
    })),
    outputs: vi.fn(async () => [{ id: "out1", published: false }]),
    list: vi.fn(async () => ({ items: [{ id: "out1", published: false }], meta: { page: 0, total: 1, hasMore: false } })),
    publish: vi.fn(async (ids) => ids.map((id) => ({ id, published: true, publicUrl: `https://cdn.test/${id}` }))),
    estimate: vi.fn(async () => ({ totalItems: 1 })),
    metadata: vi.fn(async () => ({ format: "png" })),
    transformResult: vi.fn(async () => ({ bytes: Buffer.from("x"), contentType: "image/png", width: 1, height: 1 })),
    supports: vi.fn(async () => true),
    presetRun: vi.fn(async () => ({ id: "job_1", status: "PENDING" }))
  };
  Object.assign(c.assets, { uploadMany: calls.uploadMany, list: calls.list, publish: calls.publish });
  Object.assign(c.ops, { run: calls.run, estimate: calls.estimate });
  Object.assign(c.jobs, { wait: calls.wait, outputs: calls.outputs });
  Object.assign(c.images, { metadata: calls.metadata, transformResult: calls.transformResult, supports: calls.supports });
  Object.assign(c.presets, { run: calls.presetRun });
  return { client: c, calls };
}

/** A stdio server over `client`; `roots` makes the MCP client declare the capability and answer roots/list with them. */
async function connect(client, { roots, ...opts } = {}) {
  const server = createServer({ apiKey: "is_sk_test", client, allowLocalFiles: true, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: "test", version: "0" }, roots ? { capabilities: { roots: { listChanged: true } } } : {});
  const listed = vi.fn(async () => ({ roots: roots.current.map((p) => ({ uri: pathToFileURL(p).href })) }));
  if (roots) mcp.setRequestHandler(ListRootsRequestSchema, listed);
  await mcp.connect(clientTransport);
  await mcp.listTools();
  return { mcp, listed };
}

function transform(mcp, args) {
  return mcp.callTool({ name: "transform", arguments: { op: "upscale", wait: false, ...args } });
}

function nothingRead(calls) {
  for (const fn of ["uploadMany", "metadata", "transformResult", "estimate", "run", "presetRun"])
    expect(calls[fn], fn).not.toHaveBeenCalled();
}

describe("a hidden file or folder is refused before anything is read", () => {
  it("on every path a file takes: upload, the synchronous lane, read_metadata, a dry run, run_preset", async () => {
    const { client, calls } = fakeClient();
    const { mcp } = await connect(client);
    const key = join(dir, ".secret", "key.png");
    for (const [name, args] of [
      ["transform", { op: "upscale", file_paths: [join(pics, "a.png"), key], wait: false }],
      ["transform", { op: "resize", file_paths: [key], parameters: { width: 10 } }],
      ["transform", { op: "read_metadata", file_paths: [key] }],
      ["transform", { op: "upscale", file_paths: [key], dry_run: true }],
      ["run_preset", { preset: "p", file_paths: [key], wait: false }],
      ["run_preset", { preset: "p", file_paths: [key], dry_run: true }]
    ]) {
      const res = await mcp.callTool({ name, arguments: args });
      expect(res.isError, JSON.stringify(args)).toBe(true);
      expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", param: "file_paths", retryable: false });
      expect(res.structuredContent.error.message).toMatch(/hidden file or folder/);
      expect(res.structuredContent.error.message).not.toContain(dir); // names the input, never echoes a path or a byte
    }
    nothingRead(calls);
  });

  it("whichever way the path gets there: a dotfile, `..` into a hidden folder, a symlink that leads to one", async () => {
    const { client, calls } = fakeClient();
    const { mcp } = await connect(client);
    for (const p of [join(pics, ".env"), join(pics, "..", ".secret", "key.png"), join(pics, "innocent.png")]) {
      const res = await transform(mcp, { file_paths: [p] });
      expect(res.structuredContent.error, p).toMatchObject({ code: "invalid_param", param: "file_paths" });
    }
    nothingRead(calls);
  });

  it("`./` and `../` are navigation, not names: a visible file reached through them is uploaded by its real path", async () => {
    const { client, calls } = fakeClient();
    const { mcp } = await connect(client);
    const res = await transform(mcp, { file_paths: [join(other, "..", "pics", ".", "a.png")] });
    expect(res.isError).toBeFalsy();
    expect(calls.uploadMany.mock.calls[0][0]).toEqual([join(pics, "a.png")]);
  });
});

describe("IMAGESTEP_MCP_FILE_ROOTS, when the client declares no roots", () => {
  it("takes a file under a listed folder and refuses one outside, naming the folders", async () => {
    const { client, calls } = fakeClient();
    // As bin/ hands the variable over: one string, separated like PATH; a folder that does not exist is no root.
    const { mcp } = await connect(client, { fileRoots: ["/nowhere-imagestep-test", pics].join(delimiter) });
    expect((await transform(mcp, { file_paths: [join(pics, "a.png")] })).isError).toBeFalsy();
    const res = await transform(mcp, { file_paths: [join(other, "b.png")] });
    expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", param: "file_paths", retryable: false });
    expect(res.structuredContent.error.message).toMatch(/outside the folders this server may read \(IMAGESTEP_MCP_FILE_ROOTS: /);
    expect(calls.uploadMany).toHaveBeenCalledTimes(1);
  });

  it("compares real paths: a symlink inside a root that leads out of it is refused", async () => {
    const { client, calls } = fakeClient();
    const { mcp } = await connect(client, { fileRoots: [pics] });
    const res = await transform(mcp, { file_paths: [join(pics, "escape.png")] });
    expect(res.structuredContent.error.message).toMatch(/outside the folders/);
    nothingRead(calls);
  });

  it("a root given through a symlink still holds the files under its real path", async () => {
    const link = join(dir, "pics-link");
    symlinkSync(pics, link);
    const { client } = fakeClient();
    const { mcp } = await connect(client, { fileRoots: [link] });
    expect((await transform(mcp, { file_paths: [join(link, "a.png")] })).isError).toBeFalsy();
    expect((await transform(mcp, { file_paths: [join(pics, "a.png")] })).isError).toBeFalsy();
    rmSync(link);
  });

  it("unset, any visible folder is readable, as before", async () => {
    const { client } = fakeClient();
    const { mcp } = await connect(client);
    expect((await transform(mcp, { file_paths: [join(other, "b.png")] })).isError).toBeFalsy();
  });
});

describe("the client's MCP roots", () => {
  it("bound file_paths when declared, ahead of IMAGESTEP_MCP_FILE_ROOTS", async () => {
    const { client } = fakeClient();
    // IMAGESTEP_MCP_FILE_ROOTS would allow b.png; the client's roots decide.
    const { mcp, listed } = await connect(client, { roots: { current: [pics] }, fileRoots: other });
    expect((await transform(mcp, { file_paths: [join(pics, "a.png")] })).isError).toBeFalsy();
    const res = await transform(mcp, { file_paths: [join(other, "b.png")] });
    expect(res.structuredContent.error.message).toMatch(/outside the folders this server may read \(the client's MCP roots: /);
    expect(listed).toHaveBeenCalledTimes(1); // asked once, then cached
  });

  it("are asked again after notifications/roots/list_changed", async () => {
    const roots = { current: [pics] };
    const { client } = fakeClient();
    const { mcp, listed } = await connect(client, { roots });
    expect((await transform(mcp, { file_paths: [join(other, "b.png")] })).isError).toBe(true);
    roots.current = [other];
    await mcp.sendRootsListChanged();
    await vi.waitFor(async () => expect((await transform(mcp, { file_paths: [join(other, "b.png")] })).isError).toBeFalsy());
    expect(listed.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("declared but empty share no folder: every file is refused", async () => {
    const { client, calls } = fakeClient();
    const { mcp } = await connect(client, { roots: { current: [] } });
    const res = await transform(mcp, { file_paths: [join(pics, "a.png")] });
    expect(res.structuredContent.error.message).toMatch(/the client's MCP roots name none/);
    nothingRead(calls);
  });
});

describe("publish defaults by where the input came from", () => {
  it("off when file_paths are among the inputs, on for asset ids, and an explicit value always wins", async () => {
    const { client, calls } = fakeClient();
    calls.supports.mockResolvedValue(false); // a job, not the synchronous lane, which stores nothing to publish
    const { mcp } = await connect(client);
    const file = join(pics, "a.png");
    for (const [args, published] of [
      [{ file_paths: [file] }, false],
      [{ file_paths: [file], asset_ids: ["a1"] }, false],
      [{ file_paths: [file], publish: true }, true],
      [{ asset_ids: ["a1"] }, true],
      [{ asset_ids: ["a1"], publish: false }, false]
    ]) {
      calls.publish.mockClear();
      const res = await mcp.callTool({ name: "transform", arguments: { op: "upscale", ...args } });
      expect(res.isError, JSON.stringify(args)).toBeFalsy();
      expect(calls.publish.mock.calls.length > 0, JSON.stringify(args)).toBe(published);
    }
    expect(calls.transformResult).not.toHaveBeenCalled();

    calls.publish.mockClear();
    await mcp.callTool({ name: "run_preset", arguments: { preset: "p", file_paths: [file] } });
    expect(calls.presetRun).toHaveBeenCalled();
    expect(calls.publish).not.toHaveBeenCalled();
  });

  it("tools/list carries no default for transform's and run_preset's publish, and says what it is; generate keeps true", async () => {
    const { client } = fakeClient();
    const { mcp } = await connect(client);
    const { tools } = await mcp.listTools();
    for (const name of ["transform", "run_preset"]) {
      const publish = tools.find((t) => t.name === name).inputSchema.properties.publish;
      expect(publish.default, name).toBeUndefined();
      expect(publish.description).toMatch(/file_paths are among the inputs: outputs made from a local file stay private/);
    }
    expect(tools.find((t) => t.name === "generate").inputSchema.properties.publish.default).toBe(true);
  });
});

it("the hosted server keeps refusing file_paths outright, without looking at the path", async () => {
  const { client, calls } = fakeClient();
  const { mcp } = await connect(client, { allowLocalFiles: false });
  const res = await transform(mcp, { file_paths: [join(dir, ".secret", "key.png")] });
  expect(res.structuredContent.error.message).toMatch(/only available when the server runs locally over stdio/);
  nothingRead(calls);
});
