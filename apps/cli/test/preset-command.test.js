import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#248 — `imagestep preset`: one route assertion per endpoint, and the two behaviours the ticket is
 * actually about. `slug@version` has to survive the path (it is how a run is pinned to the version it was
 * written against), and `create -f` has to swallow a /docs/recipes block as it is printed — that page is where a
 * caller gets their first preset, and retyping it into `-n` and `-s` is the step that loses the slug.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: presetCommand } = await import("../src/commands/preset.js");

/** A /docs/recipes block, copied verbatim: four keys, mixed op and registry steps. */
const RECIPE = {
  name: "Instagram square",
  slug: "instagram-square",
  description: "1080×1080, cropped to the busiest region, a little more colour, JPEG 90.",
  steps: [
    { op: "resize", parameters: { width: 1080, height: 1080, fit: "cover", gravity: "attention" } },
    { operation: "sharpen", params: { sigma: 0.5 } },
    { op: "convert", parameters: { format: "jpeg", quality: 90 } }
  ]
};

/** What a GET answers with: the recipe plus everything the service assigns. */
const SAVED = { ...RECIPE, id: "pre_1", version: 2, versions: [], builtIn: false, subjects: [], createdAt: "t", updatedAt: "t" };

let fetchMock;

function ok(data) {
  return new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock = vi.fn(async (url, init) => {
    const method = init?.method || "GET";
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/import")) return ok({ importedCount: 1 });
    if (method === "GET" && new URL(url).pathname.endsWith("/presets")) return ok([SAVED]);
    return ok({ ...SAVED, ...(init?.body ? JSON.parse(init.body) : {}), version: method === "PUT" ? 3 : 1 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(...args) {
  await presetCommand.parseAsync(args, { from: "user" });
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method || "GET",
    body: init?.body ? JSON.parse(init.body) : undefined
  }));
}

describe("imagestep preset — one route per endpoint", () => {
  // imagestep#444 — `GET /api/v1/presets` leaves `versions` off, so the output that is an import document (json / yaml)
  // asks for them, beside a filter rather than instead of it; the table is a summary and does not.
  it.each([
    ["json", "https://api.test/api/v1/presets?filter=builtin&includeVersions=true"],
    ["yaml", "https://api.test/api/v1/presets?filter=builtin&includeVersions=true"],
    ["table", "https://api.test/api/v1/presets?filter=builtin"]
  ])("list -o %s → GET %s", async (output, url) => {
    const calls = await run("list", "-f", "builtin", "-o", output);
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", url]]);
  });

  it("get → GET /presets/{slug@version}, encoded", async () => {
    const [bare] = await run("get", "instagram-square");
    expect([bare.method, bare.url]).toEqual(["GET", "https://api.test/api/v1/presets/instagram-square"]);
  });

  it("delete → DELETE /presets/{slug}", async () => {
    const [call] = await run("delete", "instagram-square", "-y");
    expect([call.method, call.url]).toEqual(["DELETE", "https://api.test/api/v1/presets/instagram-square"]);
  });

  it("delete-version → DELETE /presets/{slug}/versions/{n}, and says what it costs before --yes", async () => {
    const [call] = await run("delete-version", "instagram-square", "2", "-y");
    expect([call.method, call.url]).toEqual(["DELETE", "https://api.test/api/v1/presets/instagram-square/versions/2"]);
    // imagestep#445 — the one call here that makes a reference somebody may be holding stop resolving, so the warning
    // names it rather than saying "this cannot be undone" and leaving the reader to work out what "this" is.
    const source = readFileSync(new URL("../src/commands/preset.js", import.meta.url), "utf8");
    expect(source).toContain("gets a 404 from then on");
    expect(source).toContain("never reissued");
  });

  it("import → POST /presets/import with the file's list", async () => {
    const [call] = await run("import", JSON.stringify([RECIPE]));
    expect([call.method, call.url]).toEqual(["POST", "https://api.test/api/v1/presets/import"]);
    expect(call.body).toHaveLength(1);
  });
});

describe("a version is pinned on the path, not re-parsed here", () => {
  it("passes slug@version through to the service, percent-encoded", async () => {
    const [call] = await run("get", "instagram-square@1");
    expect(call.url).toBe("https://api.test/api/v1/presets/instagram-square%401");
  });

  it("does the same for an id@version", async () => {
    const [call] = await run("get", "pre_1@3");
    expect(call.url).toBe("https://api.test/api/v1/presets/pre_1%403");
  });
});

describe("create -f takes a document as it is printed", () => {
  it("posts a /docs/recipes block unchanged, slug and all", async () => {
    const [call] = await run("create", "-f", JSON.stringify(RECIPE));
    expect([call.method, call.url]).toEqual(["POST", "https://api.test/api/v1/presets"]);
    expect(call.body).toEqual(RECIPE);
  });

  it("drops what the service assigns, so `get -o json` round-trips into `create -f`", async () => {
    const [call] = await run("create", "-f", JSON.stringify(SAVED));
    expect(call.body).toEqual({ ...RECIPE, subjects: [] });
  });

  it("drops a built-in's slug, because `builtin-` is reserved and copying one is the point", async () => {
    const [call] = await run("create", "-f", JSON.stringify({ ...SAVED, slug: "builtin-util-web-optimize", builtIn: true }));
    expect(call.body).not.toHaveProperty("slug");
    expect(call.body.steps).toEqual(RECIPE.steps);
  });

  it("lets flags override the document", async () => {
    const [call] = await run("create", "-f", JSON.stringify(RECIPE), "-n", "Mine", "--slug", "mine");
    expect(call.body).toMatchObject({ name: "Mine", slug: "mine", steps: RECIPE.steps });
  });

  it("still takes -n and -s with no file", async () => {
    const [call] = await run("create", "-n", "Square", "-s", JSON.stringify(RECIPE.steps));
    expect(call.body).toEqual({ name: "Square", steps: RECIPE.steps });
  });
});

describe("update sends only what changes (#376: the service merges a PUT over the current preset)", () => {
  it("a rename is one PUT with the name and nothing else", async () => {
    const calls = await run("update", "instagram-square", "-n", "Renamed");
    expect(calls.map((c) => [c.method, c.url])).toEqual([["PUT", "https://api.test/api/v1/presets/instagram-square"]]);
    expect(calls[0].body).toEqual({ name: "Renamed" });
  });

  it("-f sends the file's fields without the server's", async () => {
    const calls = await run("update", "instagram-square", "-f", JSON.stringify(SAVED));
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    expect(calls[0].body).not.toHaveProperty("version");
    expect(calls[0].body).not.toHaveProperty("versions");
    expect(calls[0].body.steps).toEqual(RECIPE.steps);
  });
});
