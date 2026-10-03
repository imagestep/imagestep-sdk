import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#267 — `imagestep webhook`: one route assertion per endpoint (8), and the secret rule —
 * create and rotate-secret are the only commands that print it.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: webhookCommand } = await import("../src/commands/webhook.js");

const SECRET = "whsec_the_one_time_secret";
const ENDPOINT = {
  id: "wh-1",
  url: "https://hooks.example.com/imagestep",
  enabled: true,
  events: ["job.completed"],
  secretHint: "whsec_…cret"
};

let fetchMock;
let stdout;

function answer(url, init) {
  const method = init?.method || "GET";
  if (method === "DELETE") return new Response(null, { status: 204 });
  let data = ENDPOINT;
  if (url.endsWith("/webhook-endpoints") && method === "GET") data = [ENDPOINT];
  if (method === "POST" && (url.endsWith("/webhook-endpoints") || url.endsWith("/rotate-secret"))) data = { ...ENDPOINT, secret: SECRET };
  if (url.endsWith("/test")) data = { id: "dl-1", status: "DELIVERED", responseStatus: 200, attempts: 1 };
  if (url.includes("/deliveries")) data = [{ id: "dl-1", eventType: "webhook.test", status: "FAILED", attempts: 3, responseStatus: 500 }];
  return new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.exitCode = undefined;
  stdout = [];
  fetchMock = vi.fn(async (url, init) => answer(url, init));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(...args) {
  await webhookCommand.parseAsync(args, { from: "user" });
  const [url, init] = fetchMock.mock.calls.at(-1);
  return { url, method: init?.method || "GET", body: init?.body ? JSON.parse(init.body) : undefined, printed: stdout.join("\n") };
}

describe("imagestep webhook — one route per endpoint", () => {
  it("list → GET /webhook-endpoints", async () => {
    const { url, method } = await run("list");
    expect([method, url]).toEqual(["GET", "https://api.test/api/v1/webhook-endpoints"]);
  });

  it("get → GET /webhook-endpoints/{id}", async () => {
    const { url, method } = await run("get", "wh-1");
    expect([method, url]).toEqual(["GET", "https://api.test/api/v1/webhook-endpoints/wh-1"]);
  });

  it("create → POST /webhook-endpoints with {url, events, description}", async () => {
    const { url, method, body } = await run(
      "create",
      "--url",
      "https://hooks.example.com/imagestep",
      "--events",
      "job.completed, job.failed",
      "--description",
      "ci"
    );
    expect([method, url]).toEqual(["POST", "https://api.test/api/v1/webhook-endpoints"]);
    expect(body).toEqual({ url: "https://hooks.example.com/imagestep", events: ["job.completed", "job.failed"], description: "ci" });
  });

  it("update → PUT /webhook-endpoints/{id} with only what was passed", async () => {
    const { url, method, body } = await run("update", "wh-1", "--enable");
    expect([method, url]).toEqual(["PUT", "https://api.test/api/v1/webhook-endpoints/wh-1"]);
    expect(body).toEqual({ enabled: true });
  });

  it("delete → DELETE /webhook-endpoints/{id}", async () => {
    const { url, method } = await run("delete", "wh-1", "-y");
    expect([method, url]).toEqual(["DELETE", "https://api.test/api/v1/webhook-endpoints/wh-1"]);
  });

  it("rotate-secret → POST /webhook-endpoints/{id}/rotate-secret", async () => {
    const { url, method } = await run("rotate-secret", "wh-1");
    expect([method, url]).toEqual(["POST", "https://api.test/api/v1/webhook-endpoints/wh-1/rotate-secret"]);
  });

  it("test → POST /webhook-endpoints/{id}/test, exit 0 when delivered", async () => {
    const { url, method, printed } = await run("test", "wh-1");
    expect([method, url]).toEqual(["POST", "https://api.test/api/v1/webhook-endpoints/wh-1/test"]);
    expect(printed).toContain("DELIVERED");
    expect(process.exitCode).toBeUndefined();
  });

  it("deliveries → GET /webhook-endpoints/{id}/deliveries with its page", async () => {
    const { url, method } = await run("deliveries", "wh-1", "-p", "1", "-s", "5");
    expect(method).toBe("GET");
    expect(url).toBe("https://api.test/api/v1/webhook-endpoints/wh-1/deliveries?page=1&perPage=5");
  });
});

describe("the signing secret", () => {
  it("is printed by create and rotate-secret", async () => {
    expect((await run("create", "--url", "https://hooks.example.com/x")).printed).toContain(SECRET);
    stdout.length = 0;
    expect((await run("rotate-secret", "wh-1")).printed).toContain(SECRET);
  });

  it("appears in no other command's output", async () => {
    for (const args of [["list"], ["get", "wh-1"], ["update", "wh-1", "--disable"], ["test", "wh-1"], ["deliveries", "wh-1"]]) {
      stdout.length = 0;
      expect((await run(...args)).printed).not.toContain(SECRET);
    }
  });
});
