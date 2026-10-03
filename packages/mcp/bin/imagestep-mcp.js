#!/usr/bin/env node
// stdio (default):  IMAGESTEP_API_KEY=is_sk_… imagestep-mcp
// remote (HTTP):    imagestep-mcp --http [--port 8787] [--host 127.0.0.1] [--allowed-hosts mcp.example.com,…]
//                   ← one server per request, API key from the Authorization header; loopback unless --host says otherwise
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServerWithCatalogue } from "../src/server.js";
import { serveHttp } from "../src/http.js";

const args = process.argv.slice(2);
const baseUrl = process.env.IMAGESTEP_BASE_URL || undefined;
function flag(name) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
}

// How long a SIGTERM waits for the tool calls in flight (#629): under the hosted pod's 30 s grace period,
// past which the kubelet SIGKILLs anyway.
const DRAIN_MS = 25_000;

if (args.includes("--http")) {
  const port = Number(flag("--port") || process.env.PORT || 8787);
  const allowedHosts = flag("--allowed-hosts")?.split(",").filter(Boolean);
  const draining = new AbortController();
  const httpServer = serveHttp({ port, host: flag("--host"), allowedHosts, baseUrl, drain: draining.signal });
  // A rollout's SIGTERM used to find no handler (#629): as the image's PID 1 node ignored it and sat out the grace
  // period; anywhere else it died with its calls in flight. Now: no new connections, the calls in flight finish, exit.
  // A call waiting for its job — up to 90 s, longer than the grace — stops waiting and answers with the handle (#632).
  function drain(signal) {
    console.error(`imagestep-mcp: ${signal} — no new connections, finishing the calls in flight`);
    draining.abort(new Error(`imagestep-mcp: ${signal}`));
    httpServer.close(() => process.exit(0));
    // close() drops the connections idle right now; a kept-alive one whose call is answered later stays open until its
    // client lets go, so it is closed as it goes idle.
    setInterval(() => httpServer.closeIdleConnections(), 100).unref();
    setTimeout(() => {
      console.error(`imagestep-mcp: calls still in flight after ${DRAIN_MS / 1000} s — exiting`);
      process.exit(1);
    }, DRAIN_MS).unref();
  }
  process.once("SIGTERM", drain);
  process.once("SIGINT", drain);
} else {
  const apiKey = process.env.IMAGESTEP_API_KEY;
  if (!apiKey) {
    console.error("imagestep-mcp: set IMAGESTEP_API_KEY (create one at https://imagestep.dev/keys)");
    process.exit(2);
  }
  // The op list in the tool schema is read from GET /api/v1/ops once, here (#94); if that fails the
  // built-in list stands in and the tool description says so.
  const server = await createServerWithCatalogue({ apiKey, baseUrl, allowLocalFiles: true });
  await server.connect(new StdioServerTransport());
}
