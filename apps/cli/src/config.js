import fs from "fs";
import os from "os";
import path from "path";
import * as yaml from "js-yaml";

// Two environments: `prod`, ImageStep's API and console, and `local`, a development stack on this machine — the API
// behind a `*.localhost` host, the console on port 4200 (the port its dev server uses, so both ways of running it share
// one origin).
const ENV_CONFIG = {
  prod: {
    serviceUrl: "https://api.imagestep.dev",
    authUrl: "https://imagestep.dev"
  },
  local: {
    serviceUrl: "http://imagestep-service.localhost",
    authUrl: "http://localhost:4200"
  }
};

// The same two variables, spelled the same way and with the same precedence (environment over file),
// as both SDKs (root README §3.2 / §3.3) — so a CI runner, a container or an agent without a browser
// uses the CLI exactly as it uses the SDK, without writing ~/.imagestep first (#264). The key is read
// from the environment on every call and never written to the config file.
const API_KEY_ENV = "IMAGESTEP_API_KEY";
const BASE_URL_ENV = "IMAGESTEP_BASE_URL";

const CONFIG_DIR = path.join(os.homedir(), ".imagestep");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.yml");

// The file holds API keys, so it is the owner's alone (#479): created 0700 / 0600, and one found wider — written by
// an older CLI under a 022 umask, 0755 / 0644, readable by every account on the machine — is narrowed on the next
// read, with one line on stderr saying so. Windows has no such bits to set.
const PRIVATE = { dir: 0o700, file: 0o600 };
let widened = false;

function narrow(target, mode) {
  if (process.platform === "win32" || !fs.existsSync(target)) return;
  const current = fs.statSync(target).mode & 0o777;
  if ((current & ~mode) === 0) return;
  fs.chmodSync(target, mode);
  if (!widened) {
    widened = true;
    console.error(`imagestep: ${target} was readable by other users (${current.toString(8)}) — now ${mode.toString(8)}`);
  }
}

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: PRIVATE.dir });
  }
  narrow(CONFIG_DIR, PRIVATE.dir);
  narrow(CONFIG_FILE, PRIVATE.file);
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { env: "prod", tokens: {} };
  }
  try {
    const config = yaml.load(fs.readFileSync(CONFIG_FILE, "utf8")) || {};
    return {
      env: config.env || "prod",
      tokens: config.tokens && typeof config.tokens === "object" ? { ...config.tokens } : {}
    };
  } catch {
    return { env: "prod", tokens: {} };
  }
}

function saveConfig(config) {
  ensureConfigDir();
  const yamlContent = yaml.dump({ env: config.env || "prod", tokens: config.tokens || {} }, { lineWidth: -1 });
  fs.writeFileSync(CONFIG_FILE, yamlContent, { encoding: "utf8", mode: PRIVATE.file });
}

function getEnv() {
  return loadConfig().env;
}

function setEnv(env) {
  if (!ENV_CONFIG[env]) {
    throw new Error("Invalid environment. Must be 'prod' or 'local'");
  }
  const config = loadConfig();
  config.env = env;
  saveConfig(config);
}

/**
 * `IMAGESTEP_BASE_URL`, or "". No key travels in clear text (#945): `http://` is accepted for this machine only —
 * `localhost`, `127.0.0.1`, `[::1]` and `*.localhost`, where the local preset lives — and anything else that is not
 * `https://` is refused before a request is built.
 */
function envBaseUrl() {
  const base = (process.env[BASE_URL_ENV] || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`${BASE_URL_ENV} is not a URL: ${base}`);
  }
  const host = url.hostname;
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${BASE_URL_ENV} must be https:// (http:// only for localhost, 127.0.0.1 or *.localhost): ${base}`);
  }
  return base;
}

/** The preset `IMAGESTEP_BASE_URL` names, or null — compared as URLs, so `HTTPS://API.imagestep.dev/` is `prod`. */
function presetFor(base) {
  const href = new URL(base).href;
  return Object.keys(ENV_CONFIG).find((env) => new URL(ENV_CONFIG[env].serviceUrl).href === href) || null;
}

/**
 * The environment a call without an explicit env goes to, or null. `IMAGESTEP_BASE_URL` naming one of
 * the two presets selects that preset — so `IMAGESTEP_BASE_URL=http://imagestep-service.localhost` is
 * `--local`, stored local key included. Any other URL is null: a key `login` stored goes only to the
 * server that issued it (#945), and a host this machine never signed in to — a staging box, a proxy, a
 * typo — gets `IMAGESTEP_API_KEY` or nothing.
 */
function currentEnv() {
  const base = envBaseUrl();
  return base ? presetFor(base) : getEnv();
}

/** `IMAGESTEP_BASE_URL` when it names neither preset, else "" — so "not logged in" can say why the stored key stayed home. */
function getForeignBaseUrl() {
  const base = envBaseUrl();
  return base && !presetFor(base) ? base : "";
}

/**
 * Without `env`: the key a request should carry — `IMAGESTEP_API_KEY` if set, else the stored one.
 * With `env`: the key STORED for that environment, and only that. `login` / `logout` ask this way,
 * because what they reuse or revoke is what this machine was issued, never a key someone exported.
 */
function getToken(env) {
  if (!env && process.env[API_KEY_ENV]) return process.env[API_KEY_ENV];
  const stored = env || currentEnv();
  if (!stored) return "";
  return loadConfig().tokens[stored] || "";
}

/** The key from the environment, or "" — lets `login` / `logout` say it is in use and leave it alone. */
function getEnvApiKey() {
  return process.env[API_KEY_ENV] || "";
}

function setToken(token, env) {
  const config = loadConfig();
  config.tokens[env || config.env] = token;
  saveConfig(config);
}

function clearToken(env) {
  const config = loadConfig();
  delete config.tokens[env || config.env];
  saveConfig(config);
}

function getServiceUrl(env) {
  if (!env && envBaseUrl()) return envBaseUrl();
  return ENV_CONFIG[env || getEnv()].serviceUrl;
}

function getAuthUrl(env) {
  return ENV_CONFIG[env || getEnv()].authUrl;
}

function getConfigFile() {
  return CONFIG_FILE;
}

export { setEnv, getToken, getEnvApiKey, getForeignBaseUrl, setToken, clearToken, getServiceUrl, getAuthUrl, getConfigFile };
