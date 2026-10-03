import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { ImageStep, ImageStepError } from "../src/index.js";

// Every read of a local path the SDK makes goes through this one function (`toBody`); counting its calls is how a test
// proves a path was not read.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

/**
 * The synchronous face of the SDK (#81).
 *
 * The cases that matter are the ones about the SDK not inventing its own rules: whether an op may
 * run synchronously is the catalogue's answer, not a list in this file, and the synchronous
 * endpoints must not carry an Idempotency-Key.
 */
describe("client.images", () => {
  function stubFetch(handler) {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return handler(url, init, calls.length);
    };
    return { fetch, calls };
  }

  function opsResponse(ops) {
    return new Response(
      JSON.stringify({
        success: true,
        data: ops || [
          { op: "resize", kind: "deterministic", syncEndpoint: "POST /api/v1/images/transform" },
          { op: "generate", kind: "ai", syncEndpoint: null }
        ]
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  function pngResponse() {
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/webp", "x-imagestep-width": "40" }
    });
  }

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  }

  it("runs a deterministic op and hands back bytes", async () => {
    const { fetch, calls } = stubFetch((url) => (url.includes("/ops") ? opsResponse() : pngResponse()));
    const client = new ImageStep({ apiKey: "k", fetch });

    const out = await client.images.transform("resize", { file: new Uint8Array([9]), parameters: { width: 40 } });

    expect(out).toBeInstanceOf(Uint8Array);
    const call = calls.at(-1);
    expect(call.url).toContain("op=resize");
    expect(call.url).toContain("width=40");
    // Contract §9: no Idempotency-Key on the synchronous endpoints.
    expect(Object.keys(call.init.headers)).not.toContain("Idempotency-Key");
  });

  it("transformResult keeps the content type and the size the service measured", async () => {
    // `transform` answers "give me the bytes" and drops the rest, which left anyone who has to NAME
    // the result — a file extension, a reported size — deriving it from the bytes again (#95).
    const { fetch } = stubFetch((url) => (url.includes("/ops") ? opsResponse() : pngResponse()));
    const client = new ImageStep({ apiKey: "k", fetch });

    const res = await client.images.transformResult("resize", { file: new Uint8Array([9]), parameters: { width: 40 } });

    expect(res.bytes).toBeInstanceOf(Uint8Array);
    expect(res.contentType).toBe("image/webp");
    expect(res.width).toBe(40);
    // The service measures what it produced; a header it did not send is null, never NaN.
    expect(res.height).toBeNull();
  });

  it("keeps the op's parameters out of the input's own names — a `file` among them is never read (#470)", async () => {
    // One flat bag let the hosted MCP server spread an agent's `parameters` over the input it built, and a `file` in
    // there was a path on the MCP host this method then read. A parameter is only ever a query value now.
    const { fetch, calls } = stubFetch((url) => (url.includes("/ops") ? opsResponse() : pngResponse()));
    const client = new ImageStep({ apiKey: "k", fetch });

    await client.images.transform("resize", { url: "https://e.dev/a.jpg", parameters: { file: "/etc/hostname", width: 4 } });

    expect(readFile).not.toHaveBeenCalled();
    const call = calls.at(-1);
    expect(JSON.parse(call.init.body)).toEqual({ url: "https://e.dev/a.jpg" });
    expect(new URL(call.url).searchParams.get("file")).toBe("/etc/hostname");

    // The seam: the same spy does see a path given as the input.
    await client.images.transform("resize", { file: new URL(import.meta.url).pathname, parameters: { width: 4 } });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("refuses op parameters beside the input, before any request", async () => {
    const { fetch, calls } = stubFetch(() => pngResponse());
    const client = new ImageStep({ apiKey: "k", fetch });

    const err = await client.images.transform("resize", { file: new Uint8Array([9]), width: 40 }).catch((e) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toContain("`parameters`");
    expect(calls).toHaveLength(0);
  });

  it("refuses a parameter named after one of the endpoint's own query keys", async () => {
    // `parameters: { response: "url" }` would have replaced the caller's answer shape in the query string.
    const { fetch, calls } = stubFetch(() => pngResponse());
    const client = new ImageStep({ apiKey: "k", fetch });

    const err = await client.images.transform("resize", { file: new Uint8Array([9]), parameters: { response: "url" } }).catch((e) => e);

    expect(err).toBeInstanceOf(ImageStepError);
    expect(err.code).toBe("invalid_param");
    expect(err.param).toBe("parameters.response");
    expect(calls).toHaveLength(0);
  });

  it("asks the catalogue rather than carrying its own list", async () => {
    // `resize` reported WITHOUT a syncEndpoint: the SDK must refuse, not send it anyway.
    const { fetch } = stubFetch((url) =>
      url.includes("/ops") ? opsResponse([{ op: "resize", kind: "deterministic", syncEndpoint: null }]) : pngResponse()
    );
    const client = new ImageStep({ apiKey: "k", fetch });

    const err = await client.images.transform("resize", { file: new Uint8Array([1]) }).catch((e) => e);

    expect(err).toBeInstanceOf(ImageStepError);
    expect(err.code).toBe("invalid_param");
    expect(err.message).toContain("client.ops.run");
  });

  it("refuses an AI op with a pointer to the job form", async () => {
    const { fetch } = stubFetch((url) => (url.includes("/ops") ? opsResponse() : pngResponse()));
    const client = new ImageStep({ apiKey: "k", fetch });

    const err = await client.images.transform("generate", { file: new Uint8Array([1]) }).catch((e) => e);
    expect(err.code).toBe("invalid_param");
  });

  it("sends a reference as a JSON body", async () => {
    const { fetch, calls } = stubFetch((url) => (url.includes("/ops") ? opsResponse() : pngResponse()));
    const client = new ImageStep({ apiKey: "k", fetch });

    await client.images.transform("resize", { assetId: "ast_1", parameters: { width: 10 } });

    const call = calls.at(-1);
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(call.init.body).assetId).toBe("ast_1");
  });

  it("returns the JSON object for response:url instead of bytes", async () => {
    const { fetch } = stubFetch((url) =>
      url.includes("/ops") ? opsResponse() : jsonResponse({ success: true, data: { url: "https://signed", bytes: 12 } })
    );
    const client = new ImageStep({ apiKey: "k", fetch });

    const out = await client.images.transform("resize", { file: new Uint8Array([1]), response: "url" });
    expect(out.url).toBe("https://signed");
  });

  it("turns an error envelope into an ImageStepError carrying code and retryable", async () => {
    const { fetch } = stubFetch((url) =>
      url.includes("/ops")
        ? opsResponse()
        : jsonResponse(
            {
              success: false,
              error: { code: "payload_too_large", message: "too big", retryable: false, details: { limit: 100 } }
            },
            413
          )
    );
    const client = new ImageStep({ apiKey: "k", fetch });

    const err = await client.images.transform("resize", { file: new Uint8Array([1]) }).catch((e) => e);

    expect(err.status).toBe(413);
    expect(err.code).toBe("payload_too_large");
    expect(err.retryable).toBe(false);
    expect(err.details.limit).toBe(100);
  });

  // #592: past the allowance a sync call is paid; a balance that cannot pay is refused once — the body is the whole image.
  it("sends a refusal for credit once", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.includes("/ops")
        ? opsResponse()
        : jsonResponse({ success: false, error: { code: "insufficient_credit", message: "Not enough credit", retryable: false } }, 402)
    );
    const client = new ImageStep({ apiKey: "k", fetch, maxRetries: 3 });
    const err = await client.images.transform("resize", { file: new Uint8Array([9]), parameters: { width: 4 } }).catch((e) => e);
    expect(err.code).toBe("insufficient_credit");
    expect(calls.filter((c) => c.url.includes("/images/transform"))).toHaveLength(1);
  });

  it("retries a retryable refusal and waits the Retry-After it was given", async () => {
    // Contract §9's premise — the input is still in your hand, re-sending costs nothing — is
    // exactly what makes this path the one that SHOULD retry; it was the only one that did not
    // (#98). `rate_limited` and the three `provider_unavailable` reasons are all retryable and all
    // carry a delay now (#93).
    vi.useFakeTimers();
    try {
      const { fetch, calls } = stubFetch((url, init, n) => {
        if (url.includes("/ops")) return opsResponse();
        if (n === 2)
          return new Response(JSON.stringify({ success: false, error: { code: "rate_limited", message: "slow down", retryable: true } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "3" }
          });
        return pngResponse();
      });
      const client = new ImageStep({ apiKey: "k", fetch });
      const transforms = () => calls.filter((c) => c.url.includes("/images/transform"));

      const pending = client.images.transform("resize", { file: new Uint8Array([9]) });
      await vi.advanceTimersByTimeAsync(2999);
      expect(transforms()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toBeInstanceOf(Uint8Array);
      expect(transforms()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxRetries and throws the last error — `Retry-After: 0` retrying at once, as HTTP says", async () => {
    vi.useFakeTimers();
    try {
      const { fetch, calls } = stubFetch((url) =>
        url.includes("/ops")
          ? opsResponse()
          : new Response(
              JSON.stringify({ success: false, error: { code: "provider_unavailable", retryable: true, details: { reason: "capacity" } } }),
              {
                status: 503,
                headers: { "content-type": "application/json", "retry-after": "0" }
              }
            )
      );
      const client = new ImageStep({ apiKey: "k", fetch, maxRetries: 1 });

      const pending = client.images.transform("resize", { file: new Uint8Array([9]) }).catch((e) => e);
      await vi.advanceTimersByTimeAsync(0);
      const err = await pending;

      expect(err.code).toBe("provider_unavailable");
      expect(err.retryAfter).toBe(0);
      expect(calls.filter((c) => c.url.includes("/images/transform"))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retries a stream body — the second attempt would send nothing", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.includes("/ops")
        ? opsResponse()
        : new Response(JSON.stringify({ success: false, error: { code: "rate_limited", retryable: true } }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "0" }
          })
    );
    const client = new ImageStep({ apiKey: "k", fetch });
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1]));
        c.close();
      }
    });

    const err = await client.images.transform("resize", { file: stream }).catch((e) => e);

    expect(err.code).toBe("rate_limited");
    expect(calls.filter((c) => c.url.includes("/images/transform"))).toHaveLength(1);
  });

  it("metadata asks for JSON and returns the object", async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ success: true, data: { image: { width: 5 } } }));
    const client = new ImageStep({ apiKey: "k", fetch });

    const meta = await client.images.metadata(new Uint8Array([1]));

    expect(meta.image.width).toBe(5);
    expect(calls.at(-1).init.headers.Accept).toBe("application/json");
  });

  it("render posts the template reference and one row", async () => {
    const { fetch, calls } = stubFetch(() => pngResponse());
    const client = new ImageStep({ apiKey: "k", fetch });

    await client.images.render("builtin-template-og-image", { title: "hi" });

    expect(JSON.parse(calls.at(-1).init.body)).toEqual({
      templateId: "builtin-template-og-image",
      data: { title: "hi" }
    });
  });
});
