import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliFetch } from "../src/utils/service.js";

/**
 * `cliFetch` against a real https://localhost server with a self-signed certificate: the one path that hands Node's
 * built-in fetch a dispatcher of our own. undici 8's Agent refuses the v1 handler that fetch still sends, and cliFetch
 * reports that as "Could not reach localhost" — so a bare undici bump passed every other test while local development
 * was broken. The certificate is made per run and deleted with the server.
 */
let dir;
let server;
let base;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "imagestep-cli-tls-"));
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1"].concat([
      "-subj",
      "/CN=localhost",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem")
    ]),
    { stdio: "ignore" }
  );
  server = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, httpVersion: req.httpVersion }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `https://localhost:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

describe("cliFetch on https://…localhost", () => {
  it("accepts the self-signed certificate through its own dispatcher", async () => {
    const res = await cliFetch(`${base}/api/v1/ops`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "/api/v1/ops", httpVersion: "1.1" });
  });

  it("leaves every other host on fetch's own certificate check", async () => {
    await expect(cliFetch(`https://127.0.0.1:${server.address().port}/`)).rejects.toThrow(/certificate/i);
  });
});
