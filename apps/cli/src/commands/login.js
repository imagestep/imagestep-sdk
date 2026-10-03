import { createHash, randomBytes } from "crypto";
import http from "http";
import chalk from "chalk";
import { Command, Option } from "commander";
import { ImageStepError } from "imagestep";
import { clearToken, getAuthUrl, getEnvApiKey, getServiceUrl, getToken, setEnv, setToken } from "../config.js";
import { logger } from "../utils/logger.js";
import { client } from "../utils/service.js";

// The browser comes back to a listener on THIS machine, and the console will only redirect to one
// (`apps/console/src/lib/cli-auth.js`): loopback host, plain http, this path, and one of these ports —
// the first that is free here (#481). `127.0.0.1` rather than `localhost` on both lines, because the
// name can resolve to ::1 on a host whose stack then has nowhere to connect — and because the server
// below binds the address it is told to, so the two have to agree.
const CALLBACK_HOST = "127.0.0.1";
export const CALLBACK_PORTS = Array.from({ length: 10 }, (_, i) => 3456 + i);

function generateState() {
  return randomBytes(32).toString("hex");
}

/**
 * The PKCE pair of this login (RFC 7636, S256; #481). The browser carries back a one-time CODE, never the key: the
 * code is only worth a key together with the verifier, which never leaves this process. A code read out of the
 * browser's history, a synced tab or an extension is worth nothing — and it is dead after one exchange or 60 s.
 */
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(colour, title, lines) {
  const body = lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return `<html><body><h1 style="color: ${colour};">${escapeHtml(title)}</h1>${body}</body></html>`;
}

/**
 * What one request to the callback listener answers, and whether it ends the login (#479). Pure, so it is tested
 * without a port. A good answer carries a one-time `code`, which {@link exchangeCode} trades for the key (#481).
 *
 * **The state is checked before anything else is read.** Any web page can make the browser request
 * `http://127.0.0.1:3456/callback?error=…` while a login is waiting; that used to end the login and print the page's
 * text into this origin unescaped. A request without this login's state is now answered 400 and ignored — the
 * listener keeps waiting for the console's redirect — and every word it echoes is escaped.
 *
 * @returns {{ status: number, html: string, outcome: null | { key: string } | { error: string } }}
 */
export function answerCallback(url, expectedState) {
  if (url.searchParams.get("state") !== expectedState) {
    return {
      status: 400,
      html: page("red", "Not this login", ["This link does not belong to the login the CLI is waiting for. It is still waiting."]),
      outcome: null
    };
  }
  const error = url.searchParams.get("error");
  if (error) {
    return {
      status: 200,
      html: page("red", "Authentication Failed", [`Error: ${error}`, "You can close this window."]),
      outcome: { error }
    };
  }
  const code = url.searchParams.get("code");
  if (!code) {
    return {
      status: 200,
      html: page("red", "Authentication Failed", ["Error: No authorization code received", "You can close this window."]),
      outcome: { error: "No authorization code received" }
    };
  }
  return {
    status: 200,
    html: page("green", "Authorized", ["The CLI is finishing the login in your terminal.", "You can close this window."]),
    outcome: { code }
  };
}

/**
 * Trade the callback's one-time code for the key: `POST /api/v1/cli-auth/token` with the verifier only this process
 * holds (#481). Public — there is no credential yet — and the service answers a used, expired or mismatched code with
 * the same 400, so a failure says to run `login` again rather than which of the three it was.
 *
 * @returns {Promise<string>} the new API key
 */
export async function exchangeCode(serviceUrl, code, verifier) {
  // One attempt: the code is single-use, so a second send could only be told it was spent.
  const api = client({ auth: false, baseUrl: serviceUrl, timeoutMs: 15_000, maxRetries: 0 });
  const key = (await api.post("/api/v1/cli-auth/token", { code, codeVerifier: verifier })).data?.key;
  if (!key) throw new Error("the service answered without a key");
  return key;
}

/**
 * Probe whether a stored key is still accepted, before `login` reuses it: "ok", "invalid" (401 / 403), "unknown" (any
 * other answer) or "network-error" (none). One attempt, five seconds — a login waits on it.
 * @returns {Promise<"ok"|"invalid"|"unknown"|"network-error">}
 */
export async function pingAuth(serviceUrl, token, timeoutMs = 5000) {
  try {
    // `ai_image` because the service answers only `ai_image` / `analyze` (#202); anything else is a 400,
    // and a 400 here reads as "could not verify" on every login with a perfectly good key (#258).
    // The catalogue is cached, key-scoped and writes nothing.
    await client({ apiKey: token, baseUrl: serviceUrl, timeoutMs, maxRetries: 0 }).models.list("ai_image");
    return "ok";
  } catch (error) {
    if (!(error instanceof ImageStepError)) return "network-error";
    return error.status === 401 || error.status === 403 ? "invalid" : "unknown";
  }
}

/**
 * Listen on the first free port of {@link CALLBACK_PORTS}. Resolves once bound, with the callback URL to hand the
 * console and a promise for the code; a port in use moves on to the next one instead of failing the login.
 */
export function startCallbackServer(expectedState, candidatePorts = CALLBACK_PORTS) {
  let settle;
  const code = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${CALLBACK_HOST}`);
    if (url.pathname !== "/callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const { status, html, outcome } = answerCallback(url, expectedState);
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    if (!outcome) return;
    // Wait a bit to ensure the response is sent before closing
    setTimeout(() => {
      server.close();
      if (outcome.code) settle.resolve(outcome.code);
      else settle.reject(new Error(outcome.error));
    }, 100);
  });

  return new Promise((resolve, reject) => {
    const ports = [...candidatePorts];
    const tryNext = () => {
      const port = ports.shift();
      if (port === undefined) {
        reject(new Error(`ports ${candidatePorts[0]}–${candidatePorts.at(-1)} are all in use on this machine`));
        return;
      }
      // Each attempt removes the other's listener: a `listen(port, host, cb)` that fails leaves `cb` on the server's
      // 'listening' event, and the next port's success would then fire it too — reporting the port that was taken.
      const onListening = () => {
        server.removeAllListeners("error");
        server.on("error", (err) => settle.reject(err));
        logger.debug(`Callback server listening on ${CALLBACK_HOST}:${port}`);
        resolve({ callbackUrl: `http://${CALLBACK_HOST}:${port}/callback`, code });
      };
      server.once("listening", onListening);
      server.once("error", (err) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE") tryNext();
        else reject(err);
      });
      // Bound to the loopback interface, not to every one of them: `listen(port)` alone answers on
      // the LAN address too, which puts a window into this login on any network the machine is on.
      server.listen(port, CALLBACK_HOST);
    };
    tryNext();
  });
}

async function loginAction(options) {
  try {
    // Determine environment based on --local flag (there is no dev environment, imagestep#38)
    const env = options.local ? "local" : "prod";

    // A key in the environment wins over anything login could store (#264), so a browser round trip
    // here would issue a key nothing uses. Say which credential is live and stop, successfully.
    if (getEnvApiKey()) {
      console.log(chalk.green("IMAGESTEP_API_KEY is set — the CLI uses it, and login would not override it."));
      console.log(chalk.gray("Unset it to sign in with the browser instead."));
      return;
    }

    if (!options.force) {
      const existingToken = getToken(env);
      if (existingToken) {
        const status = await pingAuth(getServiceUrl(env), existingToken);

        if (status !== "invalid") {
          setEnv(env);
          setToken(existingToken, env);

          if (status === "ok") {
            console.log(chalk.green(`Already logged in to ${env}.`));
          } else {
            console.log(chalk.green(`Reusing stored API key for ${env}.`));
            console.log(chalk.gray("The key could not be verified right now, but the service did not reject it."));
          }
          console.log(chalk.gray("Use `imagestep login --force` to create a new key."));
          return;
        }

        console.log(chalk.yellow("Stored token is invalid or revoked - re-authenticating..."));
      }
    }

    console.log(chalk.cyan(`\nLogging in to ${env} environment\n`));

    const authUrl = getAuthUrl(env);
    console.log(chalk.gray(`Auth URL: ${authUrl}`));

    const state = generateState();
    const { verifier, challenge } = pkcePair();
    console.log(chalk.yellow("Starting authentication flow...\n"));

    const { callbackUrl, code } = await startCallbackServer(state);
    const browserAuthUrl = `${authUrl}/cli-auth?${new URLSearchParams({
      callback: callbackUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    })}`;

    console.log(chalk.yellow("Opening browser for authentication..."));
    console.log(chalk.gray(`URL: ${browserAuthUrl}\n`));

    // Open browser
    try {
      const { default: open } = await import("open"); // only `login` opens a browser (#526)
      await open(browserAuthUrl);
    } catch {
      console.log(chalk.yellow("Could not automatically open browser. Please open the URL manually:"));
      console.log(chalk.cyan(browserAuthUrl));
      console.log("");
    }

    console.log(chalk.yellow("Waiting for authentication...\n"));

    // Wait for callback with timeout
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Authentication timeout (5 minutes)")), 300000);
    });

    const authorizationCode = await Promise.race([code, timeoutPromise]);
    const apiKey = await exchangeCode(getServiceUrl(env), authorizationCode, verifier);

    // Save environment and token
    setEnv(env);
    setToken(apiKey, env);

    console.log(chalk.green("Login successful!"));
    console.log(chalk.green(`Environment: ${env}`));
    console.log(chalk.green(`API key saved!\n`));

    process.exit(0);
  } catch (error) {
    logger.error("Login failed", error);
    console.error(chalk.red(`\nLogin failed: ${error.message}\n`));
    process.exit(1);
  }
}

/**
 * Revoke the stored key on the server — `DELETE /api/v1/api-keys/self` (imagestep#133).
 *
 * The endpoint takes **no id**: it revokes the key the request authenticated with, which is why an
 * API key is allowed to reach it at all. Everything else under `/api/v1/api-keys` refuses API keys,
 * because a credential that can mint and delete credentials can escalate itself.
 *
 * This used to list the account's keys and match on the prefix. That call could never succeed —
 * the list is session-only — so it 400'd, this helper returned without a word, and `logout` printed
 * "Logged out" over a key that was still live. The failure path below is the other half of that
 * lesson: a revocation that did not happen has to be SAID, never swallowed.
 *
 * @returns {Promise<void>} resolves when the key is revoked; throws otherwise
 */
async function revokeTokenOnServer(serviceUrl, token) {
  try {
    await client({ apiKey: token, baseUrl: serviceUrl, timeoutMs: 5000, maxRetries: 0 }).del("/api/v1/api-keys/self");
  } catch (error) {
    // 401 means the key is already dead — revoked from the console, or expired. That is the state
    // this command was asking for, so it is a success and not something to alarm anyone about.
    if (error instanceof ImageStepError && error.status === 401) return;
    throw error;
  }
}

/**
 * Sign out of this machine: revoke the key, then forget it.
 *
 * In that order, and the order is the point — clearing first and failing to revoke would leave a
 * live credential with nothing left on the machine that can name it. When the revoke fails the key
 * is still cleared locally (the person asked to be signed out here), but the command says so and
 * says where to finish the job; "Logged out" over a key that still works is the sentence someone
 * reads after losing a laptop.
 */
async function logoutAction(options) {
  const specificEnv = options.local ? "local" : null;
  const envsToCheck = specificEnv ? [specificEnv] : ["prod", "local"];

  const cleared = [];
  const notRevoked = [];

  for (const env of envsToCheck) {
    const token = getToken(env);
    if (!token) continue;

    try {
      await revokeTokenOnServer(getServiceUrl(env), token);
    } catch {
      notRevoked.push(env);
    }

    clearToken(env);
    cleared.push(env);
  }

  // Never revoked: a key from the environment was not issued to this machine, and revoking it would
  // break every other runner that holds it (#264). Only the stored keys above are this command's to end.
  const envKeyNote = getEnvApiKey()
    ? "IMAGESTEP_API_KEY is still set in your environment and still valid — logout does not revoke it."
    : null;

  if (cleared.length === 0) {
    console.log(chalk.yellow(specificEnv ? `Not logged in to ${specificEnv}.` : "Not logged in to any environment."));
    if (envKeyNote) console.log(chalk.yellow(envKeyNote));
    return;
  }

  console.log(chalk.green(`Logged out from ${cleared.join(", ")}.`));

  for (const env of notRevoked) {
    console.log(chalk.yellow(`Could not revoke the ${env} key — it is off this machine but STILL VALID.`));
    console.log(chalk.gray(`Revoke it at ${getAuthUrl(env)}/keys.`));
  }
  if (envKeyNote) console.log(chalk.yellow(envKeyNote));
}

const logoutCommand = new Command("logout")
  .description("Revoke this machine's API key and clear it from the config")
  .addOption(new Option("--local", "Logout from local environment").hideHelp())
  .action(logoutAction);

const loginCommand = new Command("login")
  .description("Authenticate with ImageStep via browser")
  .addOption(new Option("--local", "Login to local environment").hideHelp())
  .addOption(new Option("-f, --force", "Create a new API key even if a valid one is cached"))
  .action(loginAction);

export { logoutCommand };
export default loginCommand;
