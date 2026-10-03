import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * imagestep#48 — the presigned PUT is signed for a Content-Type the SERVICE derives from the file name, and for the
 * exact byte count. A client that sends its own guess fails the signature at the object store. The CLI echoes what
 * stage-upload returned rather than what it detected locally; the two agree today, and the day they do not, every
 * upload from the CLI breaks. Asserted on the wire: a real PUT to a local server, stage-upload answered by a stub.
 */
let base;
let server;
const puts = [];

vi.mock("../src/config.js", () => ({ getToken: () => "is_sk_test", getServiceUrl: () => "https://api.test" }));

const { uploadInChunks } = await import("../src/utils/upload-helpers.js");

/** stage-upload and finish-upload answered by a stub; the PUT goes on the wire, to the server below. */
const realFetch = globalThis.fetch;
async function stubbed(url, init) {
  if (!String(url).startsWith("https://api.test/")) return realFetch(url, init);
  const body = JSON.parse(init.body);
  return Response.json({
    data: String(url).endsWith("/stage-upload")
      ? body.map((file) => ({ objectId: `o/${file.fileName}`, url: `${base}/put/${file.fileName}`, contentType: "image/x-signed" }))
      : body.map((item) => ({ id: `ast_${item.objectId}` }))
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let bytes = 0;
    req.on("data", (chunk) => (bytes += chunk.length));
    req.on("end", () => {
      puts.push({ method: req.method, url: req.url, type: req.headers["content-type"], length: req.headers["content-length"], bytes });
      res.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

describe("the presigned PUT", () => {
  it("sends stage-upload's Content-Type, not the detected one, and the file's byte count", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", stubbed);
    const path = join(mkdtempSync(join(tmpdir(), "imagestep-put-")), "a.png");
    writeFileSync(path, Buffer.alloc(1234));

    const { results } = await uploadInChunks([{ path, name: "a.png", size: 1234, hash: "h", mimeType: "image/png" }], 1);

    expect(puts).toEqual([{ method: "PUT", url: "/put/a.png", type: "image/x-signed", length: "1234", bytes: 1234 }]);
    expect(results[0]).toMatchObject({ status: "Success", assetId: "ast_o/a.png" });
  });
});
