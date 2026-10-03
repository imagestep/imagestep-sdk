import { readFileSync } from "node:fs";
import chalk from "chalk";
import { ImageStep } from "imagestep";
import { getServiceUrl, getToken } from "../config.js";

/**
 * Every call this CLI makes to the service goes through the JS SDK (`sdk/js`, npm `imagestep`): its transport —
 * timeouts, retries of a `retryable` answer after its `Retry-After` under one Idempotency-Key, the error contract as an
 * `ImageStepError` — is the one both SDKs and the MCP server use, and the CLI adds only what a terminal needs: where the
 * key and the base URL come from (`config.js`), who is calling (`User-Agent`), how long a call may take, and a local
 * self-signed certificate.
 */

// A call that never answers must not hang a script forever (#272). JSON calls get 30 s; the binary lane uploads the
// image itself, so its budget covers the body too. Both are per attempt, and a call can override them.
const JSON_TIMEOUT_MS = 30_000;
export const BINARY_TIMEOUT_MS = 120_000;

let userAgent;
function cliUserAgent() {
  userAgent ??= `imagestep-cli/${JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version}`;
  return userAgent;
}

// The dispatcher that accepts a self-signed certificate — local development against https://…localhost only. undici is
// imported the first time one is needed (#526): it was ~50 ms of every start, for a case almost no run has. It is handed
// to Node's built-in fetch, which still speaks undici's v1 handler API; an undici 8 Agent speaks only v2 and refuses it
// ("invalid onRequestStart method", which cliFetch would report as an unreachable host), so it goes through
// Dispatcher1Wrapper — undici's v7→v8 migration guide, §6. The wrapper also keeps the request on HTTP/1.1.
let insecureAgent;
async function localDispatcher() {
  if (!insecureAgent) {
    const { Agent, Dispatcher1Wrapper } = await import("undici");
    insecureAgent = new Dispatcher1Wrapper(new Agent({ connect: { rejectUnauthorized: false } }));
  }
  return insecureAgent;
}

function isLocalhostHttps(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost"));
  } catch {
    return false;
  }
}

/**
 * A request that got no HTTP answer at all — the connection was refused or dropped, the name did not resolve, or the
 * attempt ran out of time (#566). The SDK tries such a request again and, when its retries are spent, throws what the
 * last attempt threw; this is that, so an exit code can say "transient" (4, `retryable: true`) instead of reading it as
 * a local mistake. Nothing answered, so there is no code, status or request id.
 */
export class NetworkError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "NetworkError";
  }
}

/**
 * `fetch`, except that an `https://…localhost` URL (a local bring-up's self-signed certificate) goes through a dispatcher
 * that accepts it, and a request that never got an answer throws a {@link NetworkError}. The SDK client takes it as its
 * `fetch`; the two requests the CLI makes itself — the presigned PUT and a download from storage — call it directly.
 * What `fetch` refuses before sending (a URL it cannot parse) is thrown as it is: that is this machine's mistake.
 */
export async function cliFetch(url, init) {
  try {
    if (!isLocalhostHttps(String(url))) return await fetch(url, init);
    return await fetch(url, { ...init, dispatcher: await localDispatcher() });
  } catch (error) {
    // An abort is the attempt's timeout: the SDK's reason already names the request that timed out.
    if (init?.signal?.aborted) throw new NetworkError(error?.message || String(error), { cause: error });
    if (!(error instanceof TypeError && error.message === "fetch failed")) throw error;
    const why = error.cause?.message || error.cause?.code || error.message;
    throw new NetworkError(`Could not reach ${new URL(String(url)).host}: ${why}`, { cause: error });
  }
}

/**
 * The key a request needs, or a "Not logged in" that names both ways to get one: `login` on a machine
 * with a browser, `IMAGESTEP_API_KEY` everywhere else (#264).
 */
export function requireApiKey() {
  const apiKey = getToken();
  if (!apiKey) {
    console.log(chalk.red("Error: Not logged in"));
    console.log(chalk.yellow("Run 'imagestep login', or set IMAGESTEP_API_KEY"));
    throw new Error("Not logged in (run 'imagestep login' or set IMAGESTEP_API_KEY)");
  }
  return apiKey;
}

/**
 * An SDK client for this invocation. Built per call, not once: the key and the base URL are read from the environment
 * or `~/.imagestep` at the moment of the call (#264), and it costs nothing.
 *
 * @param {{ auth?: boolean, apiKey?: string, baseUrl?: string, timeoutMs?: number, maxRetries?: number }} [options]
 *   `auth: false` is a public read (`/api/v1/ops`, `/api/v1/agent-guidelines`): no key is required and none is sent,
 *   so the catalogue is readable before a login (#260). `apiKey` / `baseUrl` name them outright — `login` and `logout`
 *   act on the key stored for one environment, never the one a call would pick.
 */
export function client({ auth = true, apiKey, baseUrl, ...options } = {}) {
  return new ImageStep({
    apiKey: apiKey ?? (auth ? requireApiKey() : undefined),
    baseUrl: baseUrl ?? getServiceUrl(),
    timeoutMs: JSON_TIMEOUT_MS,
    userAgent: cliUserAgent(),
    fetch: cliFetch,
    ...options
  });
}
