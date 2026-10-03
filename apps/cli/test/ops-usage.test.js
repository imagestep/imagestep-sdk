import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#269 — `ops` (the discovery face) and `usage` (the budget face). Pinned per command: the
 * route it calls, and for `ops` that it goes out with no credential — the catalogue is public (#128),
 * so an agent can price an op before it holds a key.
 */
const config = vi.hoisted(() => ({ token: "" }));

vi.mock("../src/config.js", () => ({
  getToken: () => config.token,
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: opsCommand } = await import("../src/commands/ops.js");
const { default: usageCommand } = await import("../src/commands/usage.js");

let fetchMock;
let stdout;

function ok(data) {
  return new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
}

const REMOVE_BG = {
  op: "remove_bg",
  kind: "ai",
  jobType: "ai-edit",
  syncEndpoint: null,
  params: { model: { type: "string" } },
  pricing: { basis: "per_item", defaultModel: { id: "fal-ai/bria/background/remove", priceRange: "$0.0227" } },
  typicalSeconds: 5
};

beforeEach(() => {
  config.token = "";
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("imagestep ops", () => {
  it("list reads GET /api/v1/ops with no Authorization header and no login", async () => {
    fetchMock = vi.fn(async () => ok([REMOVE_BG]));
    vi.stubGlobal("fetch", fetchMock);

    await opsCommand.parseAsync(["list"], { from: "user" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/ops");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(stdout.join("\n")).toContain("remove_bg");
  });

  it("get <op> reads GET /api/v1/ops/{op} and prints the default model's price", async () => {
    fetchMock = vi.fn(async () => ok(REMOVE_BG));
    vi.stubGlobal("fetch", fetchMock);

    await opsCommand.parseAsync(["get", "remove_bg", "-o", "table"], { from: "user" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/ops/remove_bg");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(stdout.join("\n")).toContain("$0.0227");
    // How long one item usually takes (#357) is the catalogue's to say; the CLI only prints it.
    expect(stdout.join("\n")).toContain("~5 s for one item");
  });

  it("list shows the catalogue's typical time, and nothing for an op nobody measured", async () => {
    fetchMock = vi.fn(async () => ok([REMOVE_BG, { ...REMOVE_BG, op: "colorize", typicalSeconds: null }]));
    vi.stubGlobal("fetch", fetchMock);

    await opsCommand.parseAsync(["list"], { from: "user" });

    const table = stdout.join("\n");
    expect(table).toMatch(/remove_bg.*~5 s/);
    expect(table.split("\n").find((line) => line.includes("colorize"))).not.toContain("~");
  });
});

describe("imagestep usage", () => {
  it("reads GET /api/v1/usage with the window and grouping, and totals the table", async () => {
    config.token = "is_sk_test";
    const usage = {
      from: "2026-09-01T00:00:00Z",
      to: "2026-09-15T00:00:00Z",
      groupBy: "day",
      total: { key: null, credits: 12, jobs: 3, items: 7, sync: 5 },
      groups: [
        { key: "2026-09-02", credits: 10, jobs: 2, items: 5, sync: 1 },
        { key: "2026-09-03", credits: 2, jobs: 1, items: 2, sync: 4 }
      ]
    };
    fetchMock = vi.fn(async () => ok(usage));
    vi.stubGlobal("fetch", fetchMock);

    await usageCommand.parseAsync(["--from", "2026-09-01", "--to", "2026-09-15", "--group-by", "day"], { from: "user" });

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/api/v1/usage");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ groupBy: "day", from: "2026-09-01", to: "2026-09-15" });
    expect(init.headers.Authorization).toBe("ApiKey is_sk_test");
    const printed = stdout.join("\n");
    expect(printed).toContain("2026-09-02");
    expect(printed).toContain("TOTAL");
  });
});
