import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { isIP } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { clientFor, createServerWithCatalogue } from "./server.js";

const MAX_BODY = 1 << 20;

/**
 * How long a key check waits for the service (#872). The handshake never waits for it; a request that may call the API on
 * the key — a tool call, a resource read — waits for it before its server is built (#882).
 */
export const KEY_CHECK_TIMEOUT_MS = 3000;

/** The service's `KEY_SHAPE` (`ApiKeyService`): a string of any other shape is no key of ours, and is not asked about. */
const KEY_SHAPE = /^is_sk_[A-Za-z0-9_-]{32}$/;

/** How long the service's word on a key — valid, or invalid — stands before it is asked again (#882). */
export const KEY_VERDICT_TTL_MS = 5 * 60_000;

/** Entries per verdict table. Valid and invalid are two tables, so a flood of made-up keys can only push out made-up keys. */
export const KEY_VERDICT_MAX = 10_000;

/** Keys found invalid per visitor in a window, past which a key this server has not seen yet is refused unasked (#882). */
export const VISITOR_FAILURE_LIMIT = 20;
export const VISITOR_WINDOW_MS = 60_000;

/** Visitors counted in one window; past it the newcomers share one bucket. */
const VISITOR_MAX = 50_000;
const OVERFLOW = "overflow";

/** The service's own answer to a key it does not know (`UnifiedAuthenticationFilter`), so a tool's error reads as before. */
const INVALID_KEY_BODY = JSON.stringify({ success: false, error: { code: "unauthorized", message: "Invalid API key", retryable: false } });

/**
 * The reads that are public on the service (`auth.public-paths`): they answer whatever key is sent, and never 401 — the
 * catalogue `fetchCatalogue` builds every server from, an op of it, the agent guidelines. Short-circuiting them on a bad
 * key would turn an answer into an error, and protect nothing: a public path is never charged to the failure limiter.
 */
const PUBLIC_READ = /\/api\/v1\/(?:ops(?:\/.*)?|agent-guidelines)$/;

/** Longest client-supplied string (`clientInfo.*`, a tool name) a log line keeps. */
const LOG_TEXT_MAX = 100;

/** One JSON line on stdout — the hosted pod's log, `imagestep-mcp-logs-*` (#872). Never stdio's: stdout is its protocol. */
function writeLogLine(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * What the service makes of the caller's key, asked once per `initialize` (#872): `GET /api/v1/ops` with the key. The path
 * is public, so a valid key there gets the service's usage line — userId, `client: mcp`, `imagestep-mcp/<ver> (hosted)` —
 * without being counted as a use (#857: `request_count` / `last_used_at` stay what the key ran), and no failure is
 * charged to this pod's shared address in the auth limiter, which a keyed path would do for every mistyped key. The
 * answer's `X-ImageStep-Key-Valid` (sent to in-cluster callers only) says valid or not; no header, a timeout or an error
 * is "unknown" (null). Asked through {@link keyGate}, which asks about a key of our shape only, and once per key.
 */
async function keyValidity(apiKey, { baseUrl, fetch }) {
  try {
    const { headers } = await clientFor({ apiKey, baseUrl, fetch, transport: "hosted" }).request("GET", "/api/v1/ops", {
      retries: 0,
      timeoutMs: KEY_CHECK_TIMEOUT_MS
    });
    const said = headers?.get("x-imagestep-key-valid");
    return said === "true" ? true : said === "false" ? false : null;
  } catch {
    return null;
  }
}

/**
 * The bucket a visitor's failures count in (#882), as the service's `ClientIp.bucket` makes it: an IPv6 address by its
 * /64, since one host can take a fresh address per request inside it, and an IPv4-mapped one as the IPv4 address it is.
 */
export function visitorBucket(address) {
  const literal = String(address ?? "")
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");
  if (isIP(literal) !== 6) return literal;
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(literal);
  const text = v4 ? `${literal.slice(0, v4.index)}${((v4[1] << 8) | v4[2]).toString(16)}:${((v4[3] << 8) | v4[4]).toString(16)}` : literal;
  const [head, tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = [...front, ...Array(8 - front.length - back.length).fill("0"), ...back].map((g) => parseInt(g, 16));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/**
 * What the hosted server knows about keys, so that a bad one stops here instead of at the service (#882).
 *
 * The service counts failed authentications per source address, before it looks at the credential (#495), and every
 * hosted call reaches it from this pod's one address: a tool call with a made-up key, sent 60 times a minute, used to
 * lock every hosted user out with a 429, good keys included. Now a request asks for the key's verdict first:
 *
 *   1. not our key's shape → invalid, nothing asked;
 *   2. said valid in the last five minutes → valid, whatever the visitor has done — a limit is for what has to be asked;
 *   3. said invalid in the last five minutes → invalid;
 *   4. unknown, and this visitor's keys were found invalid {@link VISITOR_FAILURE_LIMIT} times this window → limited;
 *   5. else the public-path check of {@link keyValidity}, one per key however many requests wait on it.
 *
 * Only an answer is remembered: a check that failed, timed out or came back without the header is "unknown" and lets the
 * call through, as before. The tables hold the key's SHA-256, never the key, and no 12-character prefix: the console
 * lists those. A visitor is charged once per HTTP request (a batch is one request), when the check it started found the
 * key invalid or the service answered one of its calls 401 — not for a key already known bad, which costs the service
 * nothing, and which one looping client behind a shared address would otherwise turn into a lock on its neighbours.
 */
export function keyGate({ baseUrl, fetch, now = Date.now }) {
  const valid = new Map();
  const invalid = new Map();
  const checks = new Map();
  let failures = new Map();
  let windowStart = now();

  function hashOf(apiKey) {
    return createHash("sha256").update(apiKey).digest("hex");
  }

  function knows(table, hash) {
    const until = table.get(hash);
    if (until === undefined) return false;
    if (until > now()) return true;
    table.delete(hash);
    return false;
  }

  function remember(table, hash) {
    table.delete(hash);
    if (table.size >= KEY_VERDICT_MAX) table.delete(table.keys().next().value);
    table.set(hash, now() + KEY_VERDICT_TTL_MS);
  }

  function bucketOf(visitor) {
    if (now() - windowStart >= VISITOR_WINDOW_MS) {
      failures = new Map();
      windowStart = now();
    }
    return failures.has(visitor) || failures.size < VISITOR_MAX ? visitor : OVERFLOW;
  }

  function charge(call) {
    if (call.charged) return;
    call.charged = true;
    const bucket = bucketOf(call.visitor);
    failures.set(bucket, (failures.get(bucket) ?? 0) + 1);
  }

  return {
    /** "valid" · "invalid" · "unknown" · "limited", for one request's `call` ({ visitor }). */
    async verdict(apiKey, call) {
      if (!KEY_SHAPE.test(apiKey)) return "invalid";
      const hash = hashOf(apiKey);
      if (knows(valid, hash)) return "valid";
      if (knows(invalid, hash)) return "invalid";
      let check = checks.get(hash);
      if (!check) {
        if ((failures.get(bucketOf(call.visitor)) ?? 0) >= VISITOR_FAILURE_LIMIT) return "limited";
        check = keyValidity(apiKey, { baseUrl, fetch })
          .then((said) => {
            if (said === true) remember(valid, hash);
            if (said === false) {
              remember(invalid, hash);
              charge(call);
            }
            return said;
          })
          .finally(() => checks.delete(hash));
        checks.set(hash, check);
      }
      const said = await check;
      return said === true ? "valid" : said === false ? "invalid" : "unknown";
    },

    /** The service answered one of `call`'s keyed requests 401: the key was revoked since, or was never checked. */
    refused(apiKey, call) {
      if (KEY_SHAPE.test(apiKey)) {
        const hash = hashOf(apiKey);
        valid.delete(hash);
        remember(invalid, hash);
      }
      charge(call);
    },

    /** Seconds until the window — and every visitor's count — starts over. */
    retryAfterSeconds() {
      return Math.max(1, Math.ceil((windowStart + VISITOR_WINDOW_MS - now()) / 1000));
    }
  };
}

/** A JSON-RPC message that never calls the API on the caller's key: the handshake, a listing, a ping, a notification. */
function keyless(message) {
  const method = message.method;
  return (
    typeof method !== "string" ||
    method === "initialize" ||
    method === "ping" ||
    method.endsWith("/list") ||
    method.startsWith("notifications/")
  );
}

function logText(value) {
  return typeof value === "string" ? value.slice(0, LOG_TEXT_MAX) : undefined;
}

/**
 * The log line of one JSON-RPC message (#872): which method, the tool of a `tools/call`, the client a `initialize` names —
 * never `params` beyond those, so no tool argument and no prompt reaches the log.
 */
function requestLine(message, { keyPrefix, keyValid, statusCode, durationMs }) {
  const method = logText(message?.method) ?? null;
  const line = { level: "info", msg: "mcp_request", method };
  if (method === "tools/call") line.tool = logText(message.params?.name) ?? null;
  if (method === "initialize") {
    line.clientInfo = {
      name: logText(message.params?.clientInfo?.name) ?? null,
      version: logText(message.params?.clientInfo?.version) ?? null
    };
    line.keyValid = keyValid;
  }
  return { ...line, keyPrefix, statusCode, durationMs };
}

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
 * API key and tears it down after the response. No sessions, and no state beyond what {@link keyGate} remembers about
 * keys, each process for itself — so it scales horizontally behind the tunnel and a leaked session id is not a thing.
 * `file_paths` is disabled here; callers pass asset ids or public URLs.
 *
 * It binds 127.0.0.1 unless told otherwise (#470): `--http` on a laptop used to answer the whole LAN. The hosted image
 * passes `--host 0.0.0.0` (packages/mcp/Dockerfile). `drain` aborts when the process starts shutting down: every call
 * still waiting for its job then answers with the handle (#632).
 */
export function serveHttp({ port = 8787, host = "127.0.0.1", allowedHosts, baseUrl, fetch: fetchImpl, drain, log = writeLogLine } = {}) {
  let hosts;
  const gate = keyGate({ baseUrl, fetch: fetchImpl });
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
    // One line per JSON-RPC message once the response is out (#872): a handshake and a tools/list left nothing anywhere,
    // so "connected, looked, left" and "never connected" were the same. `keyPrefix` is what the console shows and
    // api_keys.prefix stores (the first 12 characters) — never the key, and nothing of a string that is not our key.
    const started = Date.now();
    let messages = [];
    let keyCheck = null;
    res.once("close", async () => {
      const facts = {
        keyPrefix: apiKey?.startsWith("is_sk_") ? apiKey.slice(0, 12) : null,
        keyValid: await keyCheck,
        statusCode: res.statusCode,
        durationMs: Date.now() - started
      };
      for (const message of messages.length ? messages : [undefined]) log(requestLine(message, facts));
    });
    if (!apiKey) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="imagestep", error="invalid_token"' }).end(
        JSON.stringify({
          error: { code: "unauthorized", message: "Send your ImageStep API key as `Authorization: Bearer is_sk_…`", retryable: false }
        })
      );
      return;
    }
    // The visitor is the address Cloudflare's edge writes, which nothing in front of this pod can forge (#882; prod has no
    // other way in): the socket's peer is the tunnel. Never passed on to the service — see `publicPathKey` there.
    const call = { visitor: visitorBucket(req.headers["cf-connecting-ip"] || req.socket.remoteAddress), charged: false };
    let pendingVerdict = null;
    function verdict() {
      pendingVerdict ??= gate.verdict(apiKey, call);
      return pendingVerdict;
    }
    // The fetch this request's server calls the API with (#882): a keyed call on a key known invalid is answered here with
    // the service's own 401 — the tool's error reads as it did, and the service never sees the key — and a 401 the
    // service gives is remembered. A public read goes through: it answers whatever key is sent.
    async function gatedFetch(url, init) {
      const keyed = new Headers(init?.headers).has("authorization");
      const publicRead = (init?.method ?? "GET") === "GET" && PUBLIC_READ.test(new URL(url).pathname);
      if (keyed && !publicRead && (await verdict()) === "invalid") {
        return new Response(INVALID_KEY_BODY, { status: 401, headers: { "content-type": "application/json" } });
      }
      const answer = await (fetchImpl ?? globalThis.fetch)(url, init);
      if (keyed && answer.status === 401) gate.refused(apiKey, call);
      return answer;
    }
    try {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      messages = (Array.isArray(body) ? body : [body]).filter((m) => m && typeof m === "object");
      // The handshake's key check is started and not awaited: the handshake answers as fast as it did (#872).
      if (messages.some((m) => m.method === "initialize")) {
        keyCheck = verdict().then((v) => (v === "valid" ? true : v === "invalid" ? false : null));
      }
      // A request that may call the API on the key waits for its verdict before a server is built (#882). An unknown key
      // from a visitor over the limit is refused here, in HTTP: through the SDK, a 429 would be slept on for its
      // Retry-After, twice, holding the connection.
      if (messages.some((m) => !keyless(m)) && (await verdict()) === "limited") {
        const retryAfter = gate.retryAfterSeconds();
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(retryAfter) }).end(
          JSON.stringify({
            error: {
              code: "rate_limited",
              message: `Too many invalid API keys from this address; retry in ${retryAfter}s`,
              retryable: true
            }
          })
        );
        return;
      }
      // Per request, but the catalogue behind it is cached for five minutes (`fetchCatalogue`), so
      // this does not put a GET /api/v1/ops in front of every tool call.
      const server = await createServerWithCatalogue({
        apiKey,
        baseUrl,
        fetch: gatedFetch,
        allowLocalFiles: false,
        transport: "hosted",
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
