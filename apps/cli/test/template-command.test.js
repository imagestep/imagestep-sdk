import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#268 — `imagestep template`: one route assertion per template endpoint (7), plus the two
 * behaviours that make the export round-trip work: `create -f` drops what the service assigns (a
 * copied `builtin-…` slug is refused), and `update` sends only what the flags change — the service
 * merges a PUT over the current version (#376).
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: templateCommand } = await import("../src/commands/template.js");

const OG = {
  id: "builtin-template-og-image",
  slug: "builtin-template-og-image",
  name: "OG image",
  html: "<h1>{{title}}</h1>",
  css: "h1{}",
  width: 1200,
  height: 630,
  variables: ["title", "site"],
  version: 1,
  builtIn: true,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z"
};

let fetchMock;

function ok(data) {
  return new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock = vi.fn(async (url, init) => {
    const method = init?.method || "GET";
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/import")) return ok({ importedCount: 1, data: [OG] });
    if (url.endsWith("/versions")) return ok([OG]);
    if (method === "GET" && new URL(url).pathname.endsWith("/templates")) return ok([{ id: OG.id, name: OG.name }]);
    return ok({ ...OG, ...(init?.body ? JSON.parse(init.body) : {}), id: "tpl-1", version: method === "PUT" ? 2 : 1, builtIn: false });
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
  await templateCommand.parseAsync(args, { from: "user" });
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    method: init?.method || "GET",
    body: init?.body ? JSON.parse(init.body) : undefined
  }));
}

describe("imagestep template — one route per endpoint", () => {
  it("list → GET /templates?filter=, every page", async () => {
    const [call] = await run("list", "-f", "builtin");
    expect([call.method, call.url]).toEqual(["GET", "https://api.test/api/v1/templates?filter=builtin"]);
  });

  it("list -o json prints full documents: the listing's rows carry no html / css (imagestep#497)", async () => {
    let listed = 0;
    fetchMock.mockImplementation(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/templates")) {
        listed++;
        const first = !new URL(url).searchParams.get("cursor");
        const rows = first ? [{ id: "tpl-1", name: "OG" }] : [{ id: "tpl-2", name: "Card" }];
        const meta = { perPage: 1, hasMore: first, nextCursor: first ? "c1" : null };
        return new Response(JSON.stringify({ success: true, data: rows, meta }), {
          headers: { "content-type": "application/json" }
        });
      }
      return ok({ ...OG, id: path.split("/").pop() });
    });
    const printed = [];
    console.log.mockImplementation((line) => printed.push(line));

    const calls = await run("list", "-f", "user", "-o", "json");

    expect(listed).toBe(2);
    expect(calls.map((c) => new URL(c.url).pathname).slice(2)).toEqual(["/api/v1/templates/tpl-1", "/api/v1/templates/tpl-2"]);
    const docs = JSON.parse(printed.join("\n"));
    expect(docs.map((d) => d.id)).toEqual(["tpl-1", "tpl-2"]);
    expect(docs[0].html).toBe(OG.html);
  });

  it("get → GET /templates/{id@version}, encoded", async () => {
    const [call] = await run("get", "tpl-1@1");
    expect([call.method, call.url]).toEqual(["GET", "https://api.test/api/v1/templates/tpl-1%401"]);
  });

  it("versions → GET /templates/{id}/versions", async () => {
    const [call] = await run("versions", "tpl-1");
    expect([call.method, call.url]).toEqual(["GET", "https://api.test/api/v1/templates/tpl-1/versions"]);
  });

  it("create → POST /templates, from an exported document with the server's fields dropped and flags on top", async () => {
    const [call] = await run("create", "-f", JSON.stringify(OG), "--name", "My OG");
    expect([call.method, call.url]).toEqual(["POST", "https://api.test/api/v1/templates"]);
    expect(call.body).toEqual({ name: "My OG", html: OG.html, css: OG.css, width: 1200, height: 630, variables: ["title", "site"] });
  });

  it("update → one PUT /templates/{id} carrying only the flag changed (#376: the service merges)", async () => {
    const calls = await run("update", "tpl-1", "--css", "h1{color:red}");
    expect(calls.map((c) => [c.method, c.url])).toEqual([["PUT", "https://api.test/api/v1/templates/tpl-1"]]);
    expect(calls[0].body).toEqual({ css: "h1{color:red}" });
  });

  it("update -f → the document's own fields, the server's dropped, flags on top", async () => {
    const calls = await run("update", "tpl-1", "-f", JSON.stringify(OG), "--width", "1080");
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
    expect(calls[0].body).toEqual({ name: OG.name, html: OG.html, css: OG.css, width: 1080, height: 630, variables: ["title", "site"] });
  });

  it("delete → DELETE /templates/{id}", async () => {
    const [call] = await run("delete", "tpl-1", "-y");
    expect([call.method, call.url]).toEqual(["DELETE", "https://api.test/api/v1/templates/tpl-1"]);
  });

  it("import → POST /templates/import with the file's list", async () => {
    const [call] = await run("import", JSON.stringify([OG]));
    expect([call.method, call.url]).toEqual(["POST", "https://api.test/api/v1/templates/import"]);
    expect(call.body).toHaveLength(1);
  });
});
