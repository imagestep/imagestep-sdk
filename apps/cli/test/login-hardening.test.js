import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CALLBACK_PORTS, answerCallback, exchangeCode, pkcePair, startCallbackServer } from "../src/commands/login.js";

/**
 * imagestep#479 — two things on the machine running `imagestep login` that belong to its owner alone.
 *
 * - `~/.imagestep` holds API keys and was created 0755 / 0644 under the usual umask: any account on the machine read
 *   them. New ones are 0700 / 0600, and one found wider is narrowed on the next read.
 * - The callback listener on 127.0.0.1 answered a request's `error` before looking at its `state`, ending the login
 *   and printing the text unescaped: any web page could interrupt a login, or write into that origin.
 */
const HOME = process.env.HOME;
const onPosix = process.platform === "win32" ? it.skip : it;

describe("~/.imagestep is private (#479)", () => {
  let home;
  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "imagestep-cli-perm-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = HOME;
    vi.restoreAllMocks();
  });

  const mode = (path) => statSync(path).mode & 0o777;

  onPosix("creates the directory 0700 and the file 0600", async () => {
    const { setToken } = await import("../src/config.js");
    setToken("is_sk_secret", "prod");
    expect(mode(join(home, ".imagestep"))).toBe(0o700);
    expect(mode(join(home, ".imagestep", "config.yml"))).toBe(0o600);
  });

  onPosix("narrows one an older CLI left readable, once, and says so on stderr", async () => {
    const dir = join(home, ".imagestep");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.yml"), "env: prod\ntokens:\n  prod: is_sk_old\n");
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "config.yml"), 0o644);
    const said = [];
    vi.spyOn(console, "error").mockImplementation((line) => said.push(String(line)));

    const { getToken } = await import("../src/config.js");
    expect(getToken("prod")).toBe("is_sk_old");
    getToken("prod");

    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "config.yml"))).toBe(0o600);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/readable by other users/);
  });
});

describe("the login callback checks its state before anything else (#479)", () => {
  const STATE = "a".repeat(64);
  const at = (query) => new URL(`http://127.0.0.1:3456/callback?${new URLSearchParams(query)}`);

  it("ignores an error from a request without this login's state — the login keeps waiting", () => {
    for (const state of [undefined, "", "b".repeat(64)]) {
      const answer = answerCallback(at({ error: "<script>alert(1)</script>", ...(state === undefined ? {} : { state }) }), STATE);
      expect(answer.status).toBe(400);
      expect(answer.outcome).toBeNull();
      expect(answer.html).not.toContain("<script>");
    }
  });

  it("ignores a code from a request without this login's state", () => {
    expect(answerCallback(at({ code: "planted", state: "x" }), STATE).outcome).toBeNull();
  });

  it("escapes what it echoes, even from the console's own redirect", () => {
    const answer = answerCallback(at({ error: `"><img src=x onerror=alert(1)>`, state: STATE }), STATE);
    expect(answer.outcome).toEqual({ error: `"><img src=x onerror=alert(1)>` });
    expect(answer.html).not.toMatch(/<img/);
    expect(answer.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("takes the code when the state matches", () => {
    expect(answerCallback(at({ code: "one-time", state: STATE }), STATE).outcome).toEqual({ code: "one-time" });
    expect(answerCallback(at({ state: STATE }), STATE).outcome).toEqual({ error: "No authorization code received" });
  });

  it("does not take a key from the URL at all — the old shape is not a way in (#481)", () => {
    expect(answerCallback(at({ key: "is_sk_in_the_url", state: STATE }), STATE).outcome).toEqual({
      error: "No authorization code received"
    });
  });
});

/**
 * imagestep#481 — the key never travels in a URL. The browser carries back a one-time code; the key is minted when the
 * CLI trades that code, with a verifier that never left this process, at `POST /api/v1/cli-auth/token`.
 */
describe("the login is a PKCE code exchange (#481)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("pairs a fresh verifier with its S256 challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkcePair().verifier, "a new pair per login").not.toBe(verifier);
  });

  it("trades the code and the verifier for the key, and sends nothing else", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true, data: { key: "is_sk_fresh" } }), { status: 200 });
    });
    await expect(exchangeCode("https://api.imagestep.dev", "the-code", "the-verifier")).resolves.toBe("is_sk_fresh");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.imagestep.dev/api/v1/cli-auth/token");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body)).toEqual({ code: "the-code", codeVerifier: "the-verifier" });
    expect(calls[0].init.headers.Authorization, "there is no credential yet").toBeUndefined();
  });

  it("says what the service said when the code is refused", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { code: "invalid_param", message: "The code is not valid.", retryable: false } }), {
          status: 400
        })
    );
    await expect(exchangeCode("https://api.imagestep.dev", "used", "v")).rejects.toThrow("The code is not valid.");
  });

  it("listens on the first free port of its range", () => {
    // That the console redirects to exactly these ports is test/console-ports-copy.test.js (ledger C128).
    expect(CALLBACK_PORTS[0]).toBe(3456);
    expect(CALLBACK_PORTS).toHaveLength(10);
  });

  it("moves past a port in use, and hands back the code the console's redirect carries", async () => {
    const taken = createServer();
    await new Promise((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const busy = taken.address().port;
    try {
      const { callbackUrl, code } = await startCallbackServer("s".repeat(64), [busy, busy + 1, busy + 2]);
      const url = new URL(callbackUrl);
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).not.toBe(busy);
      expect(url.pathname).toBe("/callback");

      const res = await fetch(`${callbackUrl}?${new URLSearchParams({ code: "one-time", state: "s".repeat(64) })}`);
      expect(res.status).toBe(200);
      await expect(code).resolves.toBe("one-time");
    } finally {
      taken.close();
    }
  });
});
