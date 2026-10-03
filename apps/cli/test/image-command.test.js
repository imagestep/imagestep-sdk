import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `imagestep image …` (#84): local file in, local file out, nothing touched in the account.
 *
 * The two properties worth pinning are the ones a future change could quietly break: the
 * subcommands come from the API's catalogue rather than a list in the source, and a bad file in a
 * batch must not take the good ones with it. The requests are read where they leave the SDK — a stubbed `fetch`;
 * that a `retryable` answer is sent again after its `Retry-After` is the SDK's (`sdk/js/test/images.test.js`).
 */
const config = vi.hoisted(() => ({ token: "is_sk_test" }));

describe("imagestep image", () => {
  let calls;

  const catalogue = {
    data: [
      {
        op: "resize",
        kind: "deterministic",
        description: "Scale to a box",
        syncEndpoint: "POST /api/v1/images/transform",
        params: { width: { type: "integer", description: "Target width" }, fit: { type: "string" } }
      },
      { op: "upscale", kind: "ai", syncEndpoint: null, params: {} },
      { op: "render_template", kind: "deterministic", syncEndpoint: "POST /api/v1/images/render", params: {} }
    ]
  };

  /** Stubs `fetch`: the catalogue for `GET /api/v1/ops`, `answer(url, init)` for everything else. */
  function serve(answer = () => new Response(Buffer.from("out"), { headers: { "content-type": "image/png" } })) {
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/api/v1/ops")) return Response.json(catalogue);
        return answer(String(url), init);
      })
    );
  }

  beforeEach(async () => {
    vi.resetModules();
    config.token = "is_sk_test";
    vi.doMock("../src/config.js", () => ({
      getToken: () => config.token,
      getServiceUrl: () => "https://api.test",
      getConfigFile: () => "/tmp/x"
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock("../src/config.js");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it("builds a subcommand for each op the catalogue says can run synchronously, its contract as flags", async () => {
    serve();
    const { imageCommand, attachOpCommands } = await import("../src/commands/image.js");

    await attachOpCommands();
    const names = imageCommand.commands.map((c) => c.name());

    expect(names).toContain("resize");
    // AI ops have no synchronous form; render_template is answered by a different endpoint.
    expect(names).not.toContain("upscale");
    expect(names).not.toContain("render_template");

    const resize = imageCommand.commands.find((c) => c.name() === "resize");
    const flags = resize.options.map((o) => o.long);
    // `--width` exists because the API says the op takes it, not because it was typed here.
    expect(flags).toEqual(expect.arrayContaining(["--width", "--fit", "--out"]));
    // `-o` still means output FORMAT everywhere in this CLI, so the file flag is `--out`.
    expect(resize.options.find((o) => o.short === "-o")).toBeUndefined();
  });

  it("lists the catalogue without a token, and the call carries no Authorization header (#260)", async () => {
    config.token = "";
    serve();
    const { imageCommand, attachOpCommands } = await import("../src/commands/image.js");

    await attachOpCommands();

    expect(calls[0].url).toBe("https://api.test/api/v1/ops");
    expect(calls[0].init.headers).not.toHaveProperty("Authorization");
    expect(imageCommand.commands.map((c) => c.name())).toContain("resize");
  });

  // #526: 3 s and one attempt, not the 30 s (and three attempts) every other call gets — this runs before the command does.
  it("gives an unreachable catalogue 3 s, once, and `metadata` and `run` still parse", async () => {
    const hang = vi.fn((_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
    vi.stubGlobal("fetch", hang);
    const { imageCommand, attachOpCommands } = await import("../src/commands/image.js");

    vi.useFakeTimers();
    try {
      let settled = false;
      const attached = attachOpCommands().then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await attached;
    } finally {
      vi.useRealTimers();
    }
    expect(hang).toHaveBeenCalledTimes(1);
    expect(imageCommand.commands.map((c) => c.name())).toEqual(expect.arrayContaining(["metadata", "run"]));
  });

  // #268: one row of data through a template, bytes back, nothing stored.
  it("render POSTs {templateId, data} as JSON to /api/v1/images/render and writes the PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagestep-render-"));
    serve();
    const { imageCommand } = await import("../src/commands/image.js");

    await imageCommand.parseAsync(
      [
        "render",
        "--template",
        "builtin-template-og-image@1",
        "--data",
        '{"title":"Hi","site":"imagestep.dev"}',
        "--out",
        join(dir, "og.png")
      ],
      { from: "user" }
    );

    const [render] = calls;
    expect(render.url).toBe("https://api.test/api/v1/images/render");
    expect(render.init.headers["Content-Type"]).toBe("application/json");
    // The synchronous lane stores nothing, so there is nothing for an Idempotency-Key to replay (contract §9).
    expect(render.init.headers).not.toHaveProperty("Idempotency-Key");
    expect(JSON.parse(render.init.body)).toEqual({
      templateId: "builtin-template-og-image@1",
      data: { title: "Hi", site: "imagestep.dev" }
    });
  });

  // #259: the group sent `application/octet-stream` for every RAW and SVG, because it carried its own
  // 17-entry table; the sync lane reads the format from that header and answers 400. It now asks the
  // detector `asset upload` asks, so the two can never disagree about the same file.
  it("sends the Content-Type `asset upload` would, for RAW and SVG alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagestep-image-mime-"));
    const cr2 = join(dir, "IMG_0001.CR2");
    const svg = join(dir, "logo.svg");
    writeFileSync(cr2, Buffer.from("not a real frame, so detection falls back to the extension"));
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    serve((url) =>
      url.includes("metadata") ? Response.json({ data: {} }) : new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })
    );
    const { imageCommand, attachOpCommands } = await import("../src/commands/image.js");
    const { validateFileForUpload } = await import("../src/utils/file-utils.js");
    await attachOpCommands();

    await imageCommand.parseAsync(["metadata", cr2], { from: "user" });
    await imageCommand.parseAsync(["resize", svg, "--width", "100", "--out", join(dir, "out.svg")], { from: "user" });

    const [metadataCall, resizeCall] = calls.filter((c) => c.init?.method === "POST");
    expect(metadataCall.url).toBe("https://api.test/api/v1/images/metadata");
    expect(metadataCall.init.headers["Content-Type"]).toBe((await validateFileForUpload(cr2, null)).mimeType);
    expect(metadataCall.init.headers["Content-Type"]).toBe("image/x-canon-cr2");
    expect(resizeCall.url).toBe("https://api.test/api/v1/images/transform?op=resize&width=100");
    expect(resizeCall.init.headers["Content-Type"]).toBe((await validateFileForUpload(svg, null)).mimeType);
    expect(resizeCall.init.headers["Content-Type"]).toBe("image/svg+xml");
  });

  // #565: without --out a result takes its input's name, so a same-type result written beside its input replaced it.
  // It is not written, the files after it are not sent (each would be transformed and thrown away), and only an --out
  // that names the input writes over it.
  it("never writes a result over its own input unless --out names it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagestep-image-inplace-"));
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const files = ["a.png", "b.png", "c.png"].map((name) => {
      const path = join(dir, name);
      writeFileSync(path, png);
      return path;
    });
    const errors = [];
    const { logger } = await import("../src/utils/logger.js");
    vi.spyOn(logger, "error").mockImplementation((line) => errors.push(String(line)));
    serve();
    const { imageCommand, attachOpCommands } = await import("../src/commands/image.js");
    await attachOpCommands();

    await imageCommand.parseAsync(["resize", ...files, "--width", "10", "--dir", dir, "--concurrency", "1"], { from: "user" });

    expect(files.map((f) => readFileSync(f).equals(png))).toEqual([true, true, true]);
    expect(calls.filter((c) => c.url.includes("/images/transform"))).toHaveLength(1);
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/a\.png: not written: the result would replace the input — name the output with --out/);
    expect(errors.join("\n")).toMatch(/2 more file\(s\) were not sent/);

    process.exitCode = 0;
    await imageCommand.parseAsync(["resize", files[0], "--width", "10", "--out", files[0]], { from: "user" });
    expect(readFileSync(files[0], "utf8")).toBe("out");
    expect(process.exitCode).toBe(0);
  });

  // #529 · #592: past the plan's allowance a run is paid, and a balance that cannot pay refuses it — so would every file
  // after it, each uploading itself to hear so. It is sent once, the files after it are not sent, and the run says where
  // the balance is topped up (#589: the link the refusal carries).
  it("sends a file that hears insufficient_credit once, does not send the files after it, and names the top-up page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagestep-image-quota-"));
    const files = ["a.png", "b.png", "c.png"].map((name) => {
      const path = join(dir, name);
      writeFileSync(path, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
      return path;
    });
    const errors = [];
    const { logger } = await import("../src/utils/logger.js");
    vi.spyOn(logger, "error").mockImplementation((line) => errors.push(String(line)));
    serve(() =>
      Response.json(
        {
          error: {
            code: "insufficient_credit",
            message: "Not enough credit",
            retryable: false,
            details: { topUpUrl: "https://imagestep.dev/usage/credits" }
          }
        },
        { status: 402 }
      )
    );
    const { imageCommand, attachOpCommands } = await import("../src/commands/image.js");
    await attachOpCommands();

    await imageCommand.parseAsync(["resize", ...files, "--width", "10", "--dir", join(dir, "out"), "--concurrency", "1"], {
      from: "user"
    });

    expect(calls.filter((c) => c.url.includes("/images/transform"))).toHaveLength(1);
    // A refusal, so the batch exits as the one call would: 3 (#566).
    expect(process.exitCode).toBe(3);
    expect(errors.join("\n")).toMatch(
      /\(insufficient_credit\) — 2 more file\(s\) were not sent\. Top up at https:\/\/imagestep\.dev\/usage\/credits/
    );
  });

  // #566: a failed file made the run exit 1 whatever the reason, so a script could not tell a refusal from a blip.
  // The batch exits with the lowest of its failures' codes: 4 only when every failure was transient.
  it("exits 4 when every failed file failed transiently, 3 when the service refused one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imagestep-image-exit-"));
    const files = ["a.png", "b.png"].map((name) => {
      const path = join(dir, name);
      writeFileSync(path, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
      return path;
    });
    const { logger } = await import("../src/utils/logger.js");
    vi.spyOn(logger, "error").mockImplementation(() => {});
    const busy = () => Response.json({ error: { code: "internal_error", message: "busy", retryable: true } }, { status: 503 });
    const refused = () => Response.json({ error: { code: "unsupported_format", message: "no", retryable: false } }, { status: 400 });
    const { imageCommand, attachOpCommands } = await import("../src/commands/image.js");
    const argv = ["resize", ...files, "--width", "10", "--dir", join(dir, "out"), "--no-retry"];

    serve(busy);
    await attachOpCommands();
    await imageCommand.parseAsync(argv, { from: "user" });
    expect(process.exitCode).toBe(4);

    let sent = 0;
    serve(() => (++sent === 1 ? refused() : busy()));
    await imageCommand.parseAsync(argv, { from: "user" });
    expect(process.exitCode).toBe(3);
  });
});
