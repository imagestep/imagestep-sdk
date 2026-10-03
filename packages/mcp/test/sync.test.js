import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { createServer } from "../src/server.js";

// The SDK reads a local path through this one function; counting its calls is how a test proves no path was read.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

/**
 * The synchronous fast path (#85).
 *
 * What is worth pinning is the SHAPE of the decision, not the speed: which inputs take it, that
 * the catalogue decides which ops may, and that an agent is never handed image bytes either way.
 */
describe("transform: the synchronous fast path", () => {
  function fakeClient({ syncSupports = true, onTransform, contentType = "image/webp" } = {}) {
    return {
      images: {
        supports: vi.fn(async () => syncSupports),
        // Answers the way the service does: bytes by default, and a JSON body for `?response=url`
        // (contract §9 — `{ url, contentType, bytes, expiresInSeconds, width, height }`).
        transformResult: vi.fn(async (op, input) => {
          onTransform?.(op, input);
          if (input.response === "url") {
            return {
              json: { url: "https://sign.example/tmp/sync/u1/req-1", contentType, bytes: 4, expiresInSeconds: 300, width: 40, height: 20 },
              contentType: "application/json",
              width: null,
              height: null
            };
          }
          return { bytes: new Uint8Array([1, 2, 3, 4]), contentType, width: 40, height: 20 };
        }),
        metadata: vi.fn(async () => ({ image: { width: 10 } }))
      },
      ops: { run: vi.fn(async () => ({ id: "job-1", status: "PROCESSING", items: [] })), readMetadata: vi.fn() },
      jobs: {
        wait: vi.fn(async () => ({ id: "job-1", status: "COMPLETED", items: [] })),
        outputs: vi.fn(async () => [])
      },
      assets: {
        upload: vi.fn(async () => ({ id: "ast-1" })),
        uploadMany: vi.fn(async (paths) => paths.map((name, n) => ({ name, asset: { id: `ast-${n + 1}` } }))),
        publish: vi.fn(async () => [])
      }
    };
  }

  async function callTransform(client, args, { allowLocalFiles = true } = {}) {
    const server = createServer({ apiKey: "k", client, allowLocalFiles });
    const tool = server._registeredTools ? server._registeredTools.transform : null;
    // The SDK's registerTool keeps the callback on the server; reach it the same way the MCP
    // runtime does.
    const handler = tool?.callback || tool?.handler;
    return handler(args, {});
  }

  it("runs one local file through the sync path and stores nothing", async () => {
    const client = fakeClient();
    const res = await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png"], wait: true, parameters: { width: 40 } });

    expect(client.images.transformResult).toHaveBeenCalled();
    expect(client.ops.run).not.toHaveBeenCalled();
    expect(res.structuredContent.mode).toBe("sync");
    expect(res.structuredContent.stored).toBe(false);
    // A path, never the bytes: an image in the context window is tokens the agent cannot read.
    expect(res.structuredContent.path).toBeTruthy();
    expect(JSON.stringify(res)).not.toContain("base64");
  });

  it("falls back to the job path when the catalogue says the op has no sync form", async () => {
    const client = fakeClient({ syncSupports: false });
    await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png"], wait: true });

    expect(client.images.transformResult).not.toHaveBeenCalled();
    expect(client.ops.run).toHaveBeenCalled();
  });

  it("keeps asset ids on the job path — an already-stored image gains nothing from sync", async () => {
    const client = fakeClient();
    await callTransform(client, { op: "resize", asset_ids: ["ast-9"], wait: true });

    expect(client.images.transformResult).not.toHaveBeenCalled();
    expect(client.ops.run).toHaveBeenCalled();
  });

  it("keeps wait:false on the job path — a handle is the only thing that answer means", async () => {
    const client = fakeClient();
    await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png"], wait: false });

    expect(client.images.transformResult).not.toHaveBeenCalled();
    expect(client.ops.run).toHaveBeenCalled();
  });

  it("keeps several images on the job path", async () => {
    const client = fakeClient();
    await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png", "/tmp/b.png"], wait: true });

    expect(client.images.transformResult).not.toHaveBeenCalled();
    expect(client.ops.run).toHaveBeenCalled();
    // #525: the files go up together — one uploadMany, not upload() per file — and the job gets their ids in order.
    expect(client.assets.uploadMany).toHaveBeenCalledTimes(1);
    expect(client.assets.uploadMany.mock.calls[0][0]).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(client.assets.upload).not.toHaveBeenCalled();
    expect(client.ops.run.mock.calls[0][1].assetIds).toEqual(["ast-1", "ast-2"]);
  });

  it("a file the service refused is a tool error on file_paths, with the service's code", async () => {
    const client = fakeClient();
    client.assets.uploadMany = vi.fn(async () => [
      { name: "a.png", asset: { id: "ast-1" } },
      { name: "b.png", error: { code: "invalid_param", message: "File exceeds the 100 MB limit", retryable: false, param: "file" } }
    ]);
    const res = await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png", "/tmp/b.png"], wait: true });
    expect(res.isError).toBe(true);
    expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", param: "file_paths", retryable: false });
    expect(client.ops.run).not.toHaveBeenCalled();
  });

  it("refuses a private URL on the sync path too, before any call leaves the process", async () => {
    // The job path's `ingest` has always run every url through assertPublicUrl; the sync path did
    // not look at urls at all (#96). The service would have refused it as well, one round trip
    // later and with different wording — one input, two answers.
    const client = fakeClient();
    const res = await callTransform(client, { op: "resize", urls: ["http://169.254.169.254/latest/meta-data"], wait: true });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.error.param).toBe("urls");
    expect(res.structuredContent.error.message).toMatch(/private address/);
    expect(client.images.transformResult).not.toHaveBeenCalled();
    expect(client.ops.run).not.toHaveBeenCalled();
  });

  it("names the result file for what it is, and says so in the answer", async () => {
    // `<op>-<ts>.bin` made the agent guess the format of a file we had just been told the type of
    // (#95); the same answer now carries the mime type and the dimensions the service measured.
    const client = fakeClient({ contentType: "image/avif" });
    const res = await callTransform(client, { op: "convert", file_paths: ["/tmp/a.png"], wait: true, parameters: { format: "avif" } });

    expect(res.structuredContent.path).toMatch(/convert-\d+\.avif$/);
    expect(res.structuredContent.mimeType).toBe("image/avif");
    expect(res.structuredContent.width).toBe(40);
    expect(res.structuredContent.height).toBe(20);
  });

  it("keeps every result in ONE temp directory, not one per call", async () => {
    const { dirname } = await import("node:path");
    const client = fakeClient();
    const first = await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png"], wait: true });
    const second = await callTransform(client, { op: "resize", file_paths: ["/tmp/b.png"], wait: true });

    // It used to be a fresh mkdtemp per call, and nothing ever removed any of them.
    expect(dirname(second.structuredContent.path)).toBe(dirname(first.structuredContent.path));
  });

  it("reads metadata of a local file for free, with no asset", async () => {
    const client = fakeClient();
    const res = await callTransform(client, { op: "read_metadata", file_paths: ["/tmp/a.png"], wait: true });

    expect(client.images.metadata).toHaveBeenCalled();
    expect(client.assets.upload).not.toHaveBeenCalled();
    expect(res.structuredContent.stored).toBe(false);
  });

  /**
   * #118 — the same fast path, answered for an agent that is NOT on this machine.
   *
   * Hosted mode had only ever been reasoned about, never tested: `canRunSync` only refused
   * `file_paths`, so one `urls` input took the sync path, wrote the result into the server
   * container's own `/tmp` and handed back `{ path: "/tmp/imagestep-xxx/resize-….webp" }` — a
   * filesystem the caller cannot read. The answer is now a signed URL (`?response=url`, contract
   * §9), which the service already supports for callers that would rather fetch than stream.
   */
  describe("hosted mode (allowLocalFiles: false)", () => {
    const hosted = { allowLocalFiles: false };

    it("answers a URL input with a signed link and no server-local path", async () => {
      const client = fakeClient();
      const res = await callTransform(client, { op: "resize", urls: ["https://example.com/a.png"], wait: true }, hosted);

      const out = res.structuredContent;
      expect(out.mode).toBe("sync");
      expect(out.url).toBe("https://sign.example/tmp/sync/u1/req-1");
      expect(out.expiresInSeconds).toBe(300);
      expect(out.mimeType).toBe("image/webp");
      expect(out.width).toBe(40);
      expect(out.height).toBe(20);
      expect(out.stored).toBe(false);
      // The defect itself: no path anywhere in the answer, in any field.
      expect(out.path).toBeUndefined();
      expect(JSON.stringify(res)).not.toMatch(/\/tmp\/imagestep-|"path"/);
      // And the note has to tell the agent the link is perishable, or it will hand it to a human
      // an hour later.
      expect(out.note).toMatch(/expires/i);
    });

    it("asks the service for a URL rather than streaming the bytes", async () => {
      const seen = [];
      const client = fakeClient({ onTransform: (op, input) => seen.push(input) });
      await callTransform(client, { op: "resize", urls: ["https://example.com/a.png"], wait: true, parameters: { width: 40 } }, hosted);

      expect(seen).toHaveLength(1);
      expect(seen[0].response).toBe("url");
      expect(seen[0].url).toBe("https://example.com/a.png");
      expect(seen[0].parameters).toEqual({ width: 40 });
      expect(seen[0].width).toBeUndefined();
    });

    it("still refuses local files outright — a path in is as meaningless as a path out", async () => {
      const client = fakeClient();
      const res = await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png"], wait: true }, hosted);

      expect(res.structuredContent.error.param).toBe("file_paths");
      expect(client.images.transformResult).not.toHaveBeenCalled();
    });

    /**
     * #470 — `parameters` is the agent's, and it used to be spread over the input this server built: `{"file": …}` was
     * a path on the MCP host the SDK then read (before any key was checked), `{"url": null}` cleared the URL so that it
     * would. Driven through the REAL SDK with a fake network, so the only thing standing in is the wire.
     */
    describe("an agent's parameters cannot name a file on this host (#470)", () => {
      function realClientServer() {
        const requests = [];
        const fetch = async (url, init) => {
          requests.push({ url: String(url), init });
          if (String(url).includes("/api/v1/ops"))
            return Response.json({
              success: true,
              data: [{ op: "resize", kind: "deterministic", syncEndpoint: "POST /api/v1/images/transform" }]
            });
          return Response.json({ success: true, data: { url: "https://sign.example/x", contentType: "image/webp", bytes: 4 } });
        };
        const server = createServer({ apiKey: "is_sk_nobody", fetch, allowLocalFiles: false, baseUrl: "https://api.test" });
        const tool = server._registeredTools.transform;
        return { call: (args) => (tool.callback || tool.handler)(args, {}), requests };
      }

      it.each([
        ["a file among them", { file: "/etc/hostname", width: 4 }, "parameters.file"],
        ["the URL cleared", { url: null, file: "/etc/hostname" }, "parameters.url"],
        ["the answer shape changed", { response: "bytes" }, "parameters.response"]
      ])("refuses %s by name, reading nothing and sending nothing", async (_, parameters, param) => {
        readFile.mockClear();
        const { call, requests } = realClientServer();

        const res = await call({ op: "resize", urls: ["https://93.184.215.14/a.png"], wait: true, parameters });

        expect(res.isError).toBe(true);
        expect(res.structuredContent.error).toMatchObject({ code: "invalid_param", param });
        expect(readFile).not.toHaveBeenCalled();
        expect(requests).toHaveLength(0);
      });

      it("refuses the same inside a variant", async () => {
        const { call } = realClientServer();
        const res = await call({
          op: "resize",
          asset_ids: ["ast_1"],
          variants: [{ parameters: { width: 4 } }, { parameters: { file: "/x" } }]
        });
        expect(res.structuredContent.error.param).toBe("variants[1].parameters.file");
      });

      it("sends the op's own parameters as query values beside the caller's URL", async () => {
        readFile.mockClear();
        const { call, requests } = realClientServer();

        const res = await call({ op: "resize", urls: ["https://93.184.215.14/a.png"], wait: true, parameters: { width: 4 } });

        expect(res.structuredContent.url).toBe("https://sign.example/x");
        const sent = requests.find((r) => r.url.includes("/images/transform"));
        expect(new URL(sent.url).searchParams.get("width")).toBe("4");
        expect(JSON.parse(sent.init.body)).toEqual({ url: "https://93.184.215.14/a.png" });
        expect(readFile).not.toHaveBeenCalled();
      });
    });

    it("keeps asking for the bytes in stdio mode — a local agent wants the file, not a download", async () => {
      const seen = [];
      const client = fakeClient({ onTransform: (op, input) => seen.push(input) });
      const res = await callTransform(client, { op: "resize", file_paths: ["/tmp/a.png"], wait: true });

      expect(seen[0].response).toBeUndefined();
      expect(res.structuredContent.path).toBeTruthy();
      expect(res.structuredContent.url).toBeUndefined();
    });
  });
});
