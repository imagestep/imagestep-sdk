import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServerWithCatalogue } from "./server.js";

const MAX_BODY = 1 << 20;

/**
 * The longest a hosted tool call waits for its job (#275).
 *
 * Hosted mode answers a `tools/call` as ONE JSON body (`enableJsonResponse`), so no byte reaches the client until the
 * handler returns — and Cloudflare's edge answers 524 for an origin (a Tunnel included) that has not started answering
 * after 100 s on non-Enterprise plans: an HTML page with no contract error and no job id, while the job keeps running.
 * 90 s leaves room for the submit and the last poll; past it the agent gets the job handle with `timedOut: true` and
 * polls `job_status`.
 */
export const HOSTED_MAX_WAIT_SECONDS = 90;

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(Object.assign(new Error("body too large"), { status: 413 }));
      else chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/** `Authorization: ApiKey is_sk_…` (the API's own scheme) or `Bearer is_sk_…` (what most MCP clients can send). */
export function apiKeyFrom(req) {
  const h = req.headers.authorization || "";
  const m = /^(?:ApiKey|Bearer)\s+(\S+)$/i.exec(h);
  return m ? m[1] : null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The `Host` values `/mcp` answers to (#470). Bound to loopback — the default — only its own loopback names: a web page
 * the developer opens can point a hostname it controls at 127.0.0.1 (DNS rebinding) and drive this server, and what it
 * sends then carries that hostname. Bound elsewhere (the hosted pod, `--host 0.0.0.0`), the operator's list, or none:
 * the hosted server is a public endpoint that checks a key on every request, reached by the tunnel under its own name
 * and by kubelet probes under the pod IP.
 */
function allowedHostsFor(host, port, allowedHosts) {
  if (allowedHosts?.length) return new Set(allowedHosts.map((h) => h.toLowerCase()));
  if (!LOOPBACK.has(host)) return null;
  return new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
}

/**
 * Remote MCP over Streamable HTTP, stateless: every request builds a server bound to the caller's
 * API key and tears it down after the response. No sessions, no shared state — so it scales
 * horizontally behind the tunnel and a leaked session id is not a thing. `file_paths` is disabled
 * here; callers pass asset ids or public URLs.
 *
 * It binds 127.0.0.1 unless told otherwise (#470): `--http` on a laptop used to answer the whole LAN. The hosted image
 * passes `--host 0.0.0.0` (packages/mcp/Dockerfile). `drain` aborts when the process starts shutting down: every call
 * still waiting for its job then answers with the handle (#632).
 */
export function serveHttp({ port = 8787, host = "127.0.0.1", allowedHosts, baseUrl, fetch: fetchImpl, drain } = {}) {
  let hosts;
  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "UP", name: "imagestep-mcp" }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res
        .writeHead(404, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { code: "not_found", message: "POST /mcp" } }));
      return;
    }
    hosts ??= allowedHostsFor(host, httpServer.address().port, allowedHosts);
    if (hosts && !hosts.has(String(req.headers.host || "").toLowerCase())) {
      res.writeHead(403, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: { code: "forbidden", message: `this server does not answer to Host ${req.headers.host || "(none)"}`, retryable: false }
        })
      );
      return;
    }
    const apiKey = apiKeyFrom(req);
    if (!apiKey) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="imagestep", error="invalid_token"' }).end(
        JSON.stringify({
          error: { code: "unauthorized", message: "Send your ImageStep API key as `Authorization: Bearer is_sk_…`", retryable: false }
        })
      );
      return;
    }
    try {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      // Per request, but the catalogue behind it is cached for five minutes (`fetchCatalogue`), so
      // this does not put a GET /api/v1/ops in front of every tool call.
      const server = await createServerWithCatalogue({
        apiKey,
        baseUrl,
        fetch: fetchImpl,
        allowLocalFiles: false,
        maxWaitSeconds: HOSTED_MAX_WAIT_SECONDS,
        drain
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(err.status || 500, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { code: err.status ? "invalid_param" : "internal_error", message: err.message, retryable: !err.status }
          })
        );
      }
    }
  });
  httpServer.listen(port, host, () => {
    console.error(`imagestep-mcp: Streamable HTTP on http://${host}:${port}/mcp (stateless; API key per request)`);
  });
  return httpServer;
}
