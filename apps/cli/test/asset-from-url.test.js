import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#271 — `asset from-url`: the route, the 20-URL batching, and the exit code a script
 * branches on — one refused URL fails only itself, the rest are created, and the command exits 1.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: assetCommand } = await import("../src/commands/asset.js");

let fetchMock;

function ok(data) {
  return new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = vi.fn(async (url, init) => {
    const { urls } = JSON.parse(init.body);
    return ok(
      urls.map((u, i) =>
        u.includes("bad")
          ? { url: u, error: { code: "invalid_param", message: "not a public host", retryable: false, param: "urls" } }
          : { url: u, id: `as-${i}`, status: "PROCESSING", name: "a" }
      )
    );
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("imagestep asset from-url", () => {
  it("POSTs {urls, collection} to /api/v1/assets/from-url", async () => {
    await assetCommand.parseAsync(["from-url", "https://x.test/a.png", "https://x.test/b.png", "-c", "shoot-02"], { from: "user" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/assets/from-url");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ urls: ["https://x.test/a.png", "https://x.test/b.png"], collection: "shoot-02" });
    expect(process.exitCode).toBeUndefined();
  });

  it("sends more than 20 URLs as consecutive batches of 20", async () => {
    const urls = Array.from({ length: 45 }, (_, i) => `https://x.test/${i}.png`);

    await assetCommand.parseAsync(["from-url", ...urls], { from: "user" });

    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).urls.length)).toEqual([20, 20, 5]);
  });

  it("exits 1 when any URL failed, without failing the others", async () => {
    await assetCommand.parseAsync(["from-url", "https://x.test/good.png", "https://bad.test/b.png"], { from: "user" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });
});
