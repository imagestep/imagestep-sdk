import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #629 — a rollout's SIGTERM found no handler. In the image node was PID 1, which the kernel does not give a signal's
 * default action, so each pod sat out the whole 30 s grace until the kubelet's SIGKILL cut its tool calls; run anywhere
 * else it died on the spot with its calls in flight. The hosted server now drains: no new connections, the calls in
 * flight finish, exit 0 — and tini is PID 1 in the image.
 */
const BIN = join(import.meta.dirname, "../bin/imagestep-mcp.js");
const children = [];
const servers = [];

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const server of servers.splice(0)) await new Promise((r) => server.close(r));
});

function listen(server) {
  servers.push(server);
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
}

async function freePort() {
  const probe = createServer();
  const port = await new Promise((r) => probe.listen(0, "127.0.0.1", () => r(probe.address().port)));
  await new Promise((r) => probe.close(r));
  return port;
}

/** The API the server reads its op catalogue from, answering after `delayMs` — long enough to be in flight. */
async function slowApi(delayMs) {
  const port = await listen(
    createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: true, data: [{ op: "resize", kind: "deterministic", requiresAssets: true }] }));
      }, delayMs);
    })
  );
  return `http://127.0.0.1:${port}`;
}

async function start(baseUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "--http", "--port", String(port)], {
    env: { ...process.env, IMAGESTEP_BASE_URL: baseUrl },
    stdio: ["ignore", "ignore", "pipe"]
  });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  await new Promise((resolve, reject) => {
    child.stderr.on("data", () => stderr.includes("Streamable HTTP on") && resolve());
    child.once("exit", () => reject(new Error(`exited before listening: ${stderr}`)));
  });
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal, at: Date.now() })));
  return { child, port, exited, stderr: () => stderr };
}

function toolsList(port) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer is_sk_t", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
}

describe("--http on SIGTERM", () => {
  it("exits 0 at once when nothing is in flight — not killed by the signal", async () => {
    const server = await start(await slowApi(0));
    const sent = Date.now();
    server.child.kill("SIGTERM");
    const { code, signal, at } = await server.exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(at - sent).toBeLessThan(2_000);
  });

  it("finishes the call in flight, refuses a new connection, then exits 0", async () => {
    const server = await start(await slowApi(1_000));
    const inFlight = toolsList(server.port);
    await new Promise((r) => setTimeout(r, 300)); // the request is waiting on the catalogue now
    server.child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    await expect(toolsList(server.port)).rejects.toThrow();

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect((await res.json()).result.tools.length).toBeGreaterThan(0);
    const answered = Date.now();
    const { code, signal, at } = await server.exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(at - answered, "a kept-alive idle socket must not hold the exit").toBeLessThan(2_000);
    expect(server.stderr()).toMatch(/SIGTERM — no new connections/);
  });
});

/**
 * #632 — a call waiting for its job (up to 90 s hosted) outlived the 25 s drain, so it was cut and the agent never saw
 * the job id. The service here holds a submit for as long as it is asked, and a job read until the reader goes away.
 */
async function slowJobApi() {
  const seen = { submits: [], reads: 0 };
  const port = await listen(
    createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const answer = (data) => {
          if (!res.writableEnded) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, data }));
        };
        const job = { id: "job_slow", status: "PROCESSING", type: "ai-generate", totalItems: 1, completedItems: 0, items: [] };
        if (req.method === "POST" && req.url.startsWith("/api/v1/jobs")) {
          const wait = JSON.parse(body).wait;
          seen.submits.push(wait);
          setTimeout(() => answer(job), wait * 1000);
        } else if (req.method === "GET" && req.url.startsWith("/api/v1/jobs/job_slow")) {
          seen.reads++; // held until the reader goes away: the job never finishes
        } else answer([]);
      });
    })
  );
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

describe("--http on SIGTERM, with a call waiting for its job (#632)", () => {
  it("answers that call with the job handle, timedOut, within a second — then exits 0", { timeout: 40_000 }, async () => {
    const api = await slowJobApi();
    const server = await start(api.baseUrl);
    const call = fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer is_sk_t", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "generate", arguments: { prompt: "a red bicycle", wait_seconds: 90 } }
      })
    });
    // Past the submit's hold, into the reads — the wait a drain used to cut.
    await vi.waitFor(() => expect(api.seen.reads).toBeGreaterThan(0), { timeout: 30_000, interval: 100 });
    const sent = Date.now();
    server.child.kill("SIGTERM");

    const res = await call;
    const answered = Date.now();
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ jobId: "job_slow", status: "PROCESSING", timedOut: true });
    expect(answered - sent).toBeLessThan(1_000);
    expect(api.seen.submits, "one submit, held no longer than the drain can wait").toEqual([15]);
    const { code, signal } = await server.exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  });
});

describe("the hosted image", () => {
  const dockerfile = readFileSync(join(import.meta.dirname, "../Dockerfile"), "utf8");

  it("runs node under tini, so node is never PID 1", () => {
    expect(dockerfile).toMatch(/apk add --no-cache tini/);
    expect(dockerfile).toContain("command -v tini");
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
    const entrypoint = runtime.search(/^ENTRYPOINT \["\/sbin\/tini", "--"\]$/m);
    expect(entrypoint, "ENTRYPOINT is tini, in the stage that ships").toBeGreaterThanOrEqual(0);
    expect(entrypoint).toBeLessThan(runtime.search(/^CMD \["node", "bin\/imagestep-mcp\.js", "--http"/m));
  });
});
