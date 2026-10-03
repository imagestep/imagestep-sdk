import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#270 — contract §10 from the terminal: `feedback send` / `feedback list` with the key the
 * caller already holds, and `guidelines` without one (the operating contract is public). One route
 * assertion per endpoint.
 */
const config = vi.hoisted(() => ({ token: "is_sk_test" }));

vi.mock("../src/config.js", () => ({
  getToken: () => config.token,
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: feedbackCommand, guidelinesCommand } = await import("../src/commands/feedback.js");

let fetchMock;
let stdout;

function ok(data, meta) {
  return new Response(JSON.stringify({ success: true, data, meta }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  config.token = "is_sk_test";
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("imagestep feedback", () => {
  it("send POSTs {kind, op, message, context} to /api/v1/feedback", async () => {
    fetchMock = vi.fn(async () => ok({ id: "fb-1", kind: "capability_gap" }));
    vi.stubGlobal("fetch", fetchMock);

    await feedbackCommand.parseAsync(
      ["send", "--kind", "capability_gap", "--op", "detect_faces", "-m", "no op finds faces", "--context", '{"tried":"blur_region"}'],
      { from: "user" }
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/feedback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      kind: "capability_gap",
      op: "detect_faces",
      message: "no op finds faces",
      context: { tried: "blur_region" }
    });
  });

  it("list GETs /api/v1/feedback with its page", async () => {
    fetchMock = vi.fn(async () => ok([{ id: "fb-1", kind: "bug", message: "x" }], { total: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    await feedbackCommand.parseAsync(["list", "-p", "2", "-s", "5"], { from: "user" });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/v1/feedback");
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: "2", perPage: "5" });
  });
});

describe("imagestep guidelines", () => {
  it("prints the markdown of GET /api/v1/agent-guidelines, with no login and no Authorization", async () => {
    config.token = "";
    fetchMock = vi.fn(async () => ok({ version: 4, markdown: "# ImageStep agent guidelines" }));
    vi.stubGlobal("fetch", fetchMock);

    await guidelinesCommand.parseAsync([], { from: "user" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/api/v1/agent-guidelines");
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(stdout).toContain("# ImageStep agent guidelines");
  });
});
