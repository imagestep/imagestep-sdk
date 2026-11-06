import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

/**
 * imagestep#264 — `IMAGESTEP_API_KEY` / `IMAGESTEP_BASE_URL`, the names and the precedence the SDKs
 * already use (environment over file). What is pinned: the variables win over ~/.imagestep, a base
 * URL naming a preset selects that preset's stored key — and any other base URL gets no stored key at
 * all, nor does any key travel over http:// to a host that is not this machine (#945) — and the two commands that manage THIS
 * machine's key — login and logout — leave an exported key alone: login does not open a browser for
 * a key nothing would use, and logout never revokes a key it was not issued.
 */
const saved = { HOME: process.env.HOME, key: process.env.IMAGESTEP_API_KEY, base: process.env.IMAGESTEP_BASE_URL };
let out;

function home(tokens) {
  const dir = mkdtempSync(join(tmpdir(), "imagestep-test-cli-env-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true })); // #880
  if (tokens) {
    mkdirSync(join(dir, ".imagestep"));
    const lines = Object.entries(tokens).map(([env, token]) => `  ${env}: ${token}`);
    writeFileSync(join(dir, ".imagestep", "config.yml"), `env: prod\ntokens:\n${lines.join("\n")}\n`);
  }
  process.env.HOME = dir;
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  vi.resetModules();
  delete process.env.IMAGESTEP_API_KEY;
  delete process.env.IMAGESTEP_BASE_URL;
  out = [];
  vi.spyOn(console, "log").mockImplementation((line) => out.push(String(line)));
});

afterEach(() => {
  restore("HOME", saved.HOME);
  restore("IMAGESTEP_API_KEY", saved.key);
  restore("IMAGESTEP_BASE_URL", saved.base);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("credentials from the environment", () => {
  it("IMAGESTEP_API_KEY wins over the stored key; an explicit env still reads the file", async () => {
    home({ prod: "is_sk_file_prod" });
    process.env.IMAGESTEP_API_KEY = "is_sk_from_env";
    const config = await import("../src/config.js");

    expect(config.getToken()).toBe("is_sk_from_env");
    expect(config.getToken("prod")).toBe("is_sk_file_prod");
    delete process.env.IMAGESTEP_API_KEY;
    expect(config.getToken()).toBe("is_sk_file_prod");
  });

  it("works on a machine that has no ~/.imagestep at all", async () => {
    home(null);
    process.env.IMAGESTEP_API_KEY = "is_sk_from_env";
    const config = await import("../src/config.js");

    expect(config.getToken()).toBe("is_sk_from_env");
    expect(config.getServiceUrl()).toBe("https://api.imagestep.dev");
  });

  it("IMAGESTEP_BASE_URL naming the local preset is --local, stored local key included", async () => {
    home({ prod: "is_sk_file_prod", local: "is_sk_file_local" });
    process.env.IMAGESTEP_BASE_URL = "http://imagestep-service.localhost/";
    const config = await import("../src/config.js");

    expect(config.getServiceUrl()).toBe("http://imagestep-service.localhost");
    expect(config.getToken()).toBe("is_sk_file_local");
    // login / logout name their environment, and that stays the preset's own URL.
    expect(config.getServiceUrl("prod")).toBe("https://api.imagestep.dev");
  });

  it("any other base URL gets no stored key, only IMAGESTEP_API_KEY (#945)", async () => {
    home({ prod: "is_sk_file_prod", local: "is_sk_file_local" });
    process.env.IMAGESTEP_BASE_URL = "https://staging.example.test";
    const config = await import("../src/config.js");

    expect(config.getServiceUrl()).toBe("https://staging.example.test");
    expect(config.getToken()).toBe("");
    expect(config.getForeignBaseUrl()).toBe("https://staging.example.test");
    process.env.IMAGESTEP_API_KEY = "is_sk_from_env";
    expect(config.getToken()).toBe("is_sk_from_env");
    // login / logout name their environment, and still reach the key stored for it.
    expect(config.getToken("prod")).toBe("is_sk_file_prod");
  });

  it("a preset spelled another way is still that preset", async () => {
    home({ prod: "is_sk_file_prod" });
    process.env.IMAGESTEP_BASE_URL = "HTTPS://API.imagestep.dev/";
    const config = await import("../src/config.js");

    expect(config.getToken()).toBe("is_sk_file_prod");
    expect(config.getForeignBaseUrl()).toBe("");
  });

  it("a command pointed at another server says why the stored key stays home, and sends nothing", async () => {
    home({ prod: "is_sk_file_prod" });
    process.env.IMAGESTEP_BASE_URL = "https://staging.example.test";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { requireApiKey } = await import("../src/utils/service.js");

    expect(() => requireApiKey()).toThrow(/sent only to the server that issued it \(set IMAGESTEP_API_KEY\)/);
    expect(out.join("\n")).toMatch(/no key for https:\/\/staging\.example\.test/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses http:// to anything but this machine, key or no key (#945)", async () => {
    home({ prod: "is_sk_file_prod" });
    process.env.IMAGESTEP_API_KEY = "is_sk_from_env";
    const config = await import("../src/config.js");

    for (const base of ["http://api.imagestep.dev", "http://staging.example.test", "http://localhost.example.test", "ftp://x.test"]) {
      process.env.IMAGESTEP_BASE_URL = base;
      expect(() => config.getServiceUrl(), base).toThrow(/must be https:\/\//);
    }
    for (const base of ["http://localhost:8443", "http://127.0.0.1:9", "http://[::1]:8443", "http://imagestep-service.localhost"]) {
      process.env.IMAGESTEP_BASE_URL = base;
      expect(config.getServiceUrl(), base).toBe(base);
    }
    process.env.IMAGESTEP_BASE_URL = "api.imagestep.dev";
    expect(() => config.getServiceUrl()).toThrow(/is not a URL/);
  });
});

describe("login and logout with a key in the environment", () => {
  it("logout makes no network call when the only key is the exported one, and says it is still valid", async () => {
    home(null);
    process.env.IMAGESTEP_API_KEY = "is_sk_from_env";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { logoutCommand } = await import("../src/commands/login.js");

    await logoutCommand.parseAsync([], { from: "user" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/IMAGESTEP_API_KEY is still set/);
  });

  it("logout still revokes the key this machine stored — and only that one", async () => {
    home({ prod: "is_sk_file_prod" });
    process.env.IMAGESTEP_API_KEY = "is_sk_from_env";
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { logoutCommand } = await import("../src/commands/login.js");

    await logoutCommand.parseAsync([], { from: "user" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("ApiKey is_sk_file_prod");
  });

  it("login does not start a browser round trip for a key nothing would use", async () => {
    home(null);
    process.env.IMAGESTEP_API_KEY = "is_sk_from_env";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    const { default: loginCommand } = await import("../src/commands/login.js");

    await loginCommand.parseAsync([], { from: "user" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(out.join("\n")).toMatch(/login would not override it/);
  });
});
