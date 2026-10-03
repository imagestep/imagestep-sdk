import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * imagestep#284 — with `-o json`, stdout is the JSON and nothing else. The acceptance run of the
 * agent skill found `jobs estimate -o json` printing "\nJob Estimate:\n" ahead of the document, so
 * `jq` failed on the one command the skill says to run before spending. Status lines ("Job
 * submitted successfully!", "Published 1 asset file(s)") are stderr, like the INFO log lines
 * already were: a person at a terminal still sees them, a program's parser never does.
 *
 * The CLI runs with FORCE_COLOR=1 on a pipe, the worst case: CI runners and `pnpm test:full` set it, and
 * json / yaml were highlighted whenever chalk said colour, so `template get -o json > t.json` wrote escape
 * codes into the file and the next `template create -f t.json` could not parse it. Only a TTY is highlighted.
 */
const run = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/imagestep.js", import.meta.url));
let base;
let server;

const asset = { id: "a1", name: "x.png", mimeType: "image/png", fileSize: 10, published: true, publicUrl: "https://cdn.example/a1" };
const job = { id: "j1", status: "COMPLETED", type: "ai-edit", items: [] };
const routes = {
  "POST /api/v1/jobs?dryRun=true": { data: { estimatedCredits: 227, sufficientCredit: true } },
  "POST /api/v1/jobs": { data: job },
  "GET /api/v1/jobs/j1": { data: job },
  "GET /api/v1/assets/a1": { data: asset },
  "POST /api/v1/assets/update": { data: [asset] },
  "GET /api/v1/presets/web": { data: { id: "p1", slug: "web", version: 1, steps: [] } },
  "GET /api/v1/ops": { data: [{ op: "resize", kind: "deterministic", params: {} }] },
  "GET /api/v1/templates/og": { data: { id: "og", version: 1, html: "<h1>{{title}}</h1>", css: "", width: 1200, height: 630 } },
  "GET /api/v1/assets/collections": { data: [{ collection: "shoot", assets: 2, lastAdded: "2026-09-17T00:00:00Z" }] },
  "POST /api/v1/images/metadata": { data: { width: 1, height: 1, format: "png" } },
  // The four listings whose count line used to be printed INSIDE the document (imagestep#444 found it on `preset
  // list`, whose `-o json` is what `preset import` takes back; `asset list` and `jobs list` were fixed in #284).
  // Declared after `/presets/web` and `/templates/og`, so the longer key still wins the prefix match.
  "GET /api/v1/presets": {
    data: [{ id: "p1", slug: "web", version: 2, versionCount: 2, versions: [{ version: 1, steps: [] }], steps: [] }]
  },
  "GET /api/v1/templates": { data: [{ id: "og", version: 1, html: "<h1/>", css: "", width: 1200, height: 630 }] },
  "GET /api/v1/ai-models": { data: [{ id: "m1", name: "a model" }] },
  "GET /api/v1/usage": { data: { from: "2026-09-01", to: "2026-09-22", groupBy: "op", rows: [] } }
};

// A 1×1 PNG, so `image metadata` detects a format and sends the file.
const png = join(mkdtempSync(join(tmpdir(), "imagestep-json-stdout-")), "one.png");
writeFileSync(
  png,
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64")
);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    const hit = routes[key] || Object.entries(routes).find(([k]) => key.startsWith(k))?.[1];
    res.writeHead(hit ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(hit || { error: { code: "not_found", message: key, retryable: false } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
});

function cli(args) {
  return run(process.execPath, [bin, ...args], {
    env: { ...process.env, IMAGESTEP_API_KEY: "is_sk_test", IMAGESTEP_BASE_URL: base, HOME: "/nonexistent", FORCE_COLOR: "1" }
  });
}

describe("-o json puts only the document on stdout", () => {
  it.each([
    ["jobs estimate", ["jobs", "estimate", "--op", "resize", "--asset-ids", "a1", "-o", "json"], (v) => v.estimatedCredits === 227],
    ["jobs submit", ["jobs", "submit", "--op", "resize", "--asset-ids", "a1", "-o", "json"], (v) => v.id === "j1"],
    ["jobs get", ["jobs", "get", "j1", "-o", "json"], (v) => v.id === "j1"],
    ["asset get", ["asset", "get", "a1", "-o", "json"], (v) => v.id === "a1"],
    ["asset publish", ["asset", "publish", "a1", "-o", "json"], (v) => v[0].publicUrl === "https://cdn.example/a1"],
    ["preset get", ["preset", "get", "web", "-o", "json"], (v) => v.slug === "web"],
    ["ops list", ["ops", "list", "-o", "json"], (v) => v[0].op === "resize"],
    ["template get", ["template", "get", "og", "-o", "json"], (v) => v.width === 1200],
    ["asset collections", ["asset", "collections", "-o", "json"], (v) => v[0].collection === "shoot"],
    ["image metadata", ["image", "metadata", png, "-o", "json"], (v) => v.format === "png"],
    ["preset list", ["preset", "list", "-o", "json"], (v) => v[0].slug === "web"],
    ["template list", ["template", "list", "-o", "json"], (v) => v[0].id === "og"],
    ["models list", ["models", "list", "-o", "json"], (v) => v[0].id === "m1"],
    ["usage", ["usage", "-o", "json"], (v) => v.groupBy === "op"]
  ])("%s", async (_name, args, check) => {
    const { stdout } = await cli(args);
    let parsed;
    expect(() => (parsed = JSON.parse(stdout)), `stdout is not one JSON document:\n${stdout}`).not.toThrow();
    expect(check(parsed)).toBe(true);
  });
});

it("-o yaml is plain YAML on a pipe too", async () => {
  const { stdout } = await cli(["jobs", "get", "j1", "-o", "yaml"]);
  expect(stdout).not.toContain("\u001b[");
  expect(stdout).toContain("id: j1");
});
