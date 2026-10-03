import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#265 — `jobs submit --wait` / `jobs wait` / `jobs outputs`: one command that ends when the
 * job does. A program branches on the exit code, so the three codes are the contract: 0 COMPLETED,
 * 1 FAILED or CANCELLED, 2 still running when the wait ran out. `outputs` reads only the items that
 * produced something: an asset, or an analyze answer (#338).
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { default: jobsCommand } = await import("../src/commands/jobs.js");

let fetchMock;
let stdout;

function ok(body, meta) {
  return new Response(JSON.stringify({ success: true, data: body, ...(meta ? { meta } : {}) }), {
    headers: { "content-type": "application/json" }
  });
}

function job(status, extra = {}) {
  return { id: "job-1", status, totalItems: 2, settledItems: status === "PROCESSING" ? 1 : 2, ...extra };
}

beforeEach(() => {
  process.exitCode = undefined;
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((line) => stdout.push(String(line)));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  process.exitCode = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A command run on a fake clock: the wait's one-second floor between reads (a stub answers every `?wait=` at once) and
 * its deadline pass without the test sleeping through them.
 */
async function onFakeClock(args) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    const done = jobsCommand.parseAsync(args, { from: "user" });
    await vi.runAllTimersAsync();
    await done;
  } finally {
    vi.useRealTimers();
  }
  return process.exitCode;
}

function wait(...args) {
  return onFakeClock(["wait", "job-1", "-o", "json", ...args]);
}

describe("imagestep jobs wait", () => {
  it("polls until the job is terminal, then stops and exits 0 on COMPLETED", async () => {
    const answers = [job("PENDING"), job("PROCESSING"), job("COMPLETED")];
    fetchMock = vi.fn(async () => ok(answers.shift()));
    vi.stubGlobal("fetch", fetchMock);

    expect(await wait()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // The service does the waiting (#355): every read is a long-poll, at its 60 s ceiling while the deadline is far off.
    expect(fetchMock.mock.calls.every(([url]) => url === "https://api.test/api/v1/jobs/job-1?wait=60")).toBe(true);
  });

  it("exits 1 on FAILED and on CANCELLED", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(job("FAILED")))
    );
    expect(await wait()).toBe(1);

    process.exitCode = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok(job("CANCELLED")))
    );
    expect(await wait()).toBe(1);
  });

  it("exits 2 when the job is still running at the deadline, and cancels nothing", async () => {
    fetchMock = vi.fn(async () => ok(job("PROCESSING")));
    vi.stubGlobal("fetch", fetchMock);

    expect(await wait("--timeout", "0.02")).toBe(2);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });

  it("submit --wait submits once and then waits on the job it got back", async () => {
    const answers = [job("PENDING"), job("COMPLETED")];
    fetchMock = vi.fn(async () => ok(answers.shift()));
    vi.stubGlobal("fetch", fetchMock);

    await onFakeClock(["submit", "--op", "resize", "--asset-ids", "a1", "--wait"]);

    expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    // The wait starts on the submit itself, and what is left of it goes to the read.
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ op: "resize", assetIds: ["a1"], wait: 60 });
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.test/api/v1/jobs/job-1?wait=60");
    expect(process.exitCode).toBe(0);
  });

  it("submit --wait on a job that came back finished reads nothing more; without --wait the body carries no wait", async () => {
    fetchMock = vi.fn(async () => ok(job("COMPLETED")));
    vi.stubGlobal("fetch", fetchMock);
    await jobsCommand.parseAsync(["submit", "--op", "resize", "--asset-ids", "a1", "--wait", "--timeout", "20"], { from: "user" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).wait).toBe(20);
    expect(process.exitCode).toBe(0);

    fetchMock = vi.fn(async () => ok(job("PENDING")));
    vi.stubGlobal("fetch", fetchMock);
    await jobsCommand.parseAsync(["submit", "--op", "resize", "--asset-ids", "a1"], { from: "user" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ op: "resize", assetIds: ["a1"] });
  });

  // #529: over the account's share of open waits the read is `429 rate_limited` + `Retry-After` (contract §5.1) — the
  // SDKs ask again; the CLI used to exit 4 on it.
  it("asks again after Retry-After when a waited read is turned away, and still exits 0", async () => {
    const turnedAway = () =>
      new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "rate_limited",
            message: "You already have 8 job waits open",
            retryable: true,
            details: { reason: "account_concurrency" }
          }
        }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "0.01" } }
      );
    const answers = [turnedAway, () => ok(job("COMPLETED"))];
    fetchMock = vi.fn(async () => answers.shift()());
    vi.stubGlobal("fetch", fetchMock);

    expect(await wait()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // #591: how long to keep the outputs is the caller's to shorten; a value that is not a whole day is refused here, unsent.
  it("submit --retention-days sends a whole number of days and refuses anything else before sending", async () => {
    fetchMock = vi.fn(async () => ok(job("PENDING")));
    vi.stubGlobal("fetch", fetchMock);
    await jobsCommand.parseAsync(["submit", "--op", "resize", "--asset-ids", "a1", "--retention-days", "7"], { from: "user" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).retentionDays).toBe(7);

    fetchMock = vi.fn(async () => ok(job("PENDING")));
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    await jobsCommand.parseAsync(["submit", "--op", "resize", "--asset-ids", "a1", "--retention-days", "0.5"], { from: "user" });
    expect(fetchMock).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("submits once on insufficient_credit: a refusal is not retried", async () => {
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ success: false, error: { code: "insufficient_credit", message: "Not enough credit", retryable: false } }),
          { status: 402, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined);
    await jobsCommand.parseAsync(["submit", "--op", "resize", "--asset-ids", "a1"], { from: "user" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    exit.mockRestore();
  });
});

describe("imagestep jobs outputs", () => {
  it("reads the run as ONE listing, not one GET per item, and prints it in item order (#441)", async () => {
    const detail = job("COMPLETED", {
      items: [
        { status: "COMPLETED", resultAssetId: "as-1", variant: "ig" },
        { status: "FAILED", error: "boom" },
        { status: "COMPLETED", resultAssetId: "as-3", variant: "og" }
      ]
    });
    fetchMock = vi.fn(async (url) => {
      if (url.includes("/jobs/job-1")) return ok(detail);
      // The listing is newest-first, i.e. NOT item order, and it is a list row (no `image` wrapper).
      return ok(
        ["as-3", "as-1"].map((id) => ({ id, name: `name-${id}`, status: "DONE", width: 10, height: 20, publicUrl: null })),
        { total: 2, page: 0, perPage: 100, hasMore: false }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await jobsCommand.parseAsync(["outputs", "job-1", "-o", "yaml"], { from: "user" });

    const assetCalls = fetchMock.mock.calls.map(([url]) => url).filter((url) => url.includes("/assets"));
    expect(assetCalls).toEqual(["https://api.test/api/v1/assets?jobId=job-1"]);
    const printed = stdout.join("\n");
    expect(printed.indexOf("as-1")).toBeLessThan(printed.indexOf("as-3"));
    expect(printed).toContain("variant");
    expect(printed).toContain("10x20");
  });

  it("past the first page it walks the items endpoint, not the truncated job document (#440)", async () => {
    const detail = job("COMPLETED", {
      totalItems: 150,
      itemsTruncated: true,
      items: [{ status: "COMPLETED", resultAssetId: "as-1", index: 0 }]
    });
    fetchMock = vi.fn(async (url) => {
      if (url.includes("/jobs/job-1/items"))
        return ok(
          [
            { index: 0, status: "COMPLETED", resultAssetId: "as-1" },
            { index: 149, status: "COMPLETED", resultAssetId: "as-150" }
          ],
          {
            total: 2,
            page: 0,
            perPage: 100,
            hasMore: false
          }
        );
      if (url.includes("/jobs/job-1")) return ok(detail);
      return ok([{ id: "as-1" }, { id: "as-150" }], { total: 2, page: 0, perPage: 100, hasMore: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    await jobsCommand.parseAsync(["outputs", "job-1", "-o", "json"], { from: "user" });

    const rows = JSON.parse(stdout.join("\n"));
    expect(rows.map((r) => r.item)).toEqual([1, 150], "the last item of a 150-item job is not in the job document");
    expect(fetchMock.mock.calls.some(([url]) => url.includes("/jobs/job-1/items"))).toBe(true);
  });

  it("an output deleted since the run does not take the whole command down (#441)", async () => {
    const detail = job("COMPLETED", { items: [{ status: "COMPLETED", resultAssetId: "as-gone" }] });
    fetchMock = vi.fn(async (url) => {
      if (url.includes("/jobs/job-1")) return ok(detail);
      return ok([], { total: 0, page: 0, perPage: 100, hasMore: false });
    });
    vi.stubGlobal("fetch", fetchMock);

    await jobsCommand.parseAsync(["outputs", "job-1", "-o", "json"], { from: "user" });

    expect(JSON.parse(stdout.join("\n"))).toEqual([
      { item: 1, assetId: "as-gone", name: null, status: "GONE", dimension: null, publicUrl: null }
    ]);
    expect(process.exitCode ?? 0).toBe(0, "a 404 on one output used to fail the command");
  });

  it("lists an analyze job's answers from its items, without reading any asset (#338)", async () => {
    const detail = job("COMPLETED", {
      type: "parse",
      items: [
        { status: "COMPLETED", sourceAssetId: "as-1", output: { tags: ["bicycle"], description: "a red bicycle" } },
        { status: "FAILED", sourceAssetId: "as-2", error: "boom" }
      ]
    });
    fetchMock = vi.fn(async () => ok(detail));
    vi.stubGlobal("fetch", fetchMock);

    await jobsCommand.parseAsync(["outputs", "job-1", "-o", "json"], { from: "user" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.join("\n"))).toEqual([
      { item: 1, sourceAssetId: "as-1", output: { tags: ["bicycle"], description: "a red bicycle" } }
    ]);
  });
});

describe("imagestep jobs items (#440)", () => {
  it("pages a job's items and prints the index each row is named by", async () => {
    fetchMock = vi.fn(async () =>
      ok([{ index: 100, status: "FAILED", sourceAssetId: "as-a", error: "boom" }], { total: 1, page: 1, perPage: 100, hasMore: false })
    );
    vi.stubGlobal("fetch", fetchMock);

    await jobsCommand.parseAsync(["items", "job-1", "--page", "1", "--status", "failed", "-o", "json"], { from: "user" });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe("/api/v1/jobs/job-1/items");
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: "1", perPage: "100", status: "FAILED" });
    expect(JSON.parse(stdout.join("\n"))[0].index).toBe(100);
  });

  it("--all walks every page, and refuses to be given a page of its own", async () => {
    fetchMock = vi.fn(async (url) =>
      new URL(url).searchParams.get("page") === "0"
        ? ok([{ index: 0, status: "COMPLETED" }], { total: 2, page: 0, perPage: 1, hasMore: true, nextCursor: "c0" })
        : ok([{ index: 1, status: "COMPLETED" }], { perPage: 1, hasMore: false, nextCursor: null })
    );
    vi.stubGlobal("fetch", fetchMock);

    await jobsCommand.parseAsync(["items", "job-1", "--all", "-s", "1", "-o", "json"], { from: "user" });

    expect(JSON.parse(stdout.join("\n")).map((i) => i.index)).toEqual([0, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const exit = vi.spyOn(process, "exit").mockImplementation(() => {});
    await jobsCommand.parseAsync(["items", "job-1", "--all", "--page", "2"], { from: "user" });
    expect(exit).toHaveBeenCalled();
    exit.mockRestore();
  });
});
