import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#133 — `imagestep logout` revokes the key before it forgets it.
 *
 * The command used to list the account's keys to find its own id, which an API key may not do
 * (`/api/v1/api-keys` is session-only): the list 400'd, the helper returned without a word, and the
 * command printed "Logged out" over a credential that was still live. Three things are pinned here,
 * and the middle one is the whole lesson:
 *
 *   1. it calls the one endpoint a key is allowed to reach — `DELETE /api/v1/api-keys/self`, which
 *      takes no id;
 *   2. when that call fails the key is still cleared locally, **and the command says out loud that
 *      the key is still valid**. A swallowed failure here is how someone believes a lost laptop's
 *      key is dead;
 *   3. a 401 is a success, not a failure — the key was already revoked elsewhere, which is the
 *      state the command was asking for.
 */
const config = vi.hoisted(() => ({
  tokens: { local: "is_sk_abcdefghijklmnopqrstuvwxyz012345" },
  cleared: [],
  env: null
}));

vi.mock("../src/config.js", () => ({
  getToken: (env) => config.tokens[env] || "",
  getEnvApiKey: () => "",
  clearToken: (env) => config.cleared.push(env),
  setToken: () => {},
  setEnv: (env) => (config.env = env),
  getServiceUrl: (env) => (env === "local" ? "http://imagestep-service.localhost" : "https://api.imagestep.dev"),
  getAuthUrl: (env) => (env === "local" ? "http://localhost:4200" : "https://imagestep.dev"),
  getConfigFile: () => "/tmp/config.yml"
}));

const { logoutCommand } = await import("../src/commands/login.js");

let out;

async function logout() {
  await logoutCommand.parseAsync(["--local"], { from: "user" });
  return out.join("\n");
}

beforeEach(() => {
  config.tokens = { local: "is_sk_abcdefghijklmnopqrstuvwxyz012345" };
  config.cleared = [];
  out = [];
  vi.spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("imagestep logout", () => {
  it("revokes through /api/v1/api-keys/self — the endpoint that takes no id", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const printed = await logout();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://imagestep-service.localhost/api/v1/api-keys/self");
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("ApiKey is_sk_abcdefghijklmnopqrstuvwxyz012345");
    // No listing beforehand: that call is what could never work, and one round trip is the fix.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(config.cleared).toEqual(["local"]);
    expect(printed).toContain("Logged out from local.");
    expect(printed).not.toMatch(/STILL VALID/);

    vi.unstubAllGlobals();
  });

  it("says STILL VALID when the revoke fails, and still clears the machine", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 403 }))
    );

    const printed = await logout();

    expect(printed).toContain("Logged out from local.");
    expect(printed).toMatch(/STILL VALID/);
    expect(printed).toContain("http://localhost:4200/keys");
    // The person asked to be signed out HERE; refusing to clear would leave them signed in and
    // unable to say so. What must not happen is clearing quietly.
    expect(config.cleared).toEqual(["local"]);

    vi.unstubAllGlobals();
  });

  it("says the same thing when the service is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    expect(await logout()).toMatch(/STILL VALID/);

    vi.unstubAllGlobals();
  });

  it("treats 401 as already revoked, not as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 }))
    );

    expect(await logout()).not.toMatch(/STILL VALID/);

    vi.unstubAllGlobals();
  });

  it("reaches the network only when there is a key to revoke", async () => {
    config.tokens = {};
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const printed = await logout();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(printed).toContain("Not logged in to local.");

    vi.unstubAllGlobals();
  });
});
