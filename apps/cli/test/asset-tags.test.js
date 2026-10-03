import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#334 — tags are the caller's own labels: `asset tag` replaces them through the one batch update,
 * `upload` / `from-url` attach them to new assets, and `asset list` shows them in its table.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: assetCommand } = await import("../src/commands/asset.js");
const { parseTags } = await import("../src/utils/upload-helpers.js");

let fetchMock;
let printed;

function ok(data, meta) {
  return new Response(JSON.stringify({ success: true, data, ...(meta && { meta }) }), {
    headers: { "content-type": "application/json" }
  });
}

beforeEach(() => {
  printed = "";
  vi.spyOn(console, "log").mockImplementation((...args) => {
    printed += args.join(" ") + "\n";
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    printed += String(chunk);
    return true;
  });
  fetchMock = vi.fn(async (url, init) => {
    if (url.includes("/api/v1/assets/update")) {
      const { ids, tags } = JSON.parse(init.body);
      return ok(ids.map((id) => ({ id, tags })));
    }
    if (url.includes("/api/v1/assets/from-url")) {
      return ok(JSON.parse(init.body).urls.map((u, i) => ({ url: u, id: `as-${i}`, status: "PROCESSING" })));
    }
    return ok([{ id: "as-1", name: "a", status: "DONE", tags: ["hero", "sale"], image: {} }], { total: 1 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseTags", () => {
  it("splits on commas, trims, drops blanks; an empty string clears and an absent option leaves them", () => {
    expect(parseTags(" hero, spring sale ,,")).toEqual(["hero", "spring sale"]);
    expect(parseTags("")).toEqual([]);
    expect(parseTags(undefined)).toBeUndefined();
  });
});

describe("imagestep asset tag", () => {
  it("replaces the tags through POST /api/v1/assets/update", async () => {
    await assetCommand.parseAsync(["tag", "as-1", "as-2", "--tags", "hero,sale"], { from: "user" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/assets/update");
    expect(JSON.parse(init.body)).toEqual({ ids: ["as-1", "as-2"], tags: ["hero", "sale"] });
  });

  it("clears them with an empty list", async () => {
    await assetCommand.parseAsync(["tag", "as-1", "--tags", ""], { from: "user" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ ids: ["as-1"], tags: [] });
  });
});

describe("imagestep asset list", () => {
  it("prints the tags column", async () => {
    await assetCommand.parseAsync(["list"], { from: "user" });

    // eslint-disable-next-line no-control-regex
    const plain = printed.replace(/\u001b\[[0-9;]*m/g, "");
    expect(plain).toContain("Tags");
    expect(plain).toContain("hero, sale");
  });
});

describe("imagestep asset from-url --tags", () => {
  it("sends the tags with the URLs", async () => {
    await assetCommand.parseAsync(["from-url", "https://x.test/a.png", "--tags", "hero"], { from: "user" });

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ urls: ["https://x.test/a.png"], tags: ["hero"] });
  });
});
