import { describe, expect, it, vi } from "vitest";

/**
 * imagestep#437 — `--all` is the four lines every script would otherwise write, one of them off by one.
 *
 * The CLI is the surface where it matters most: with `-o json` the stdout is the rows and nothing else (so
 * `| jq` works), which means `meta.hasMore` never reaches the pipe — a script could only guess at the end by
 * counting rows against the page size. `--all` answers the question instead of leaving it to the guess. The walk
 * itself is the SDK's `iterate…` (a `hasMore` with no cursor is an error there, `sdk/js/test/client.test.js`); what is
 * pinned here is that each command walks it, from page 0 or from `--cursor`, with its filters on every page.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

/** Answers each request from `pages`, in order, and records the URLs. */
function serve(...pages) {
  const urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      urls.push(url);
      const [data, meta] = pages[urls.length - 1];
      return new Response(JSON.stringify({ success: true, data, meta }), { headers: { "content-type": "application/json" } });
    })
  );
  return urls;
}

/** Runs one command with stdout captured; stderr is the commentary and is dropped. */
async function run(command, argv) {
  let out = "";
  const capture = (...args) => {
    out += args.join(" ") + "\n";
    return true;
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  await command.parseAsync(argv, { from: "user" });
  return out;
}

describe("--all walks the pages", () => {
  const param = (urls, name) => urls.map((u) => new URL(u).searchParams.get(name));

  it("asset list --all -o json is every row as one array, in one document", async () => {
    const urls = serve(
      [[{ id: "a1" }, { id: "a2" }], { total: 3, page: 0, perPage: 2, hasMore: true, nextCursor: "c2" }],
      [[{ id: "a3" }], { perPage: 2, hasMore: false, nextCursor: null }]
    );
    const { default: assetCommand } = await import("../src/commands/asset.js");

    const out = await run(assetCommand, ["list", "--all", "-s", "2", "-c", "shoot-01", "-o", "json"]);

    expect(JSON.parse(out).map((a) => a.id)).toEqual(["a1", "a2", "a3"]);
    // imagestep#493: the first request is page 0, every later one the cursor the answer carried — never page 1,
    // which would make the service re-read and re-count the rows before it.
    expect(param(urls, "page")).toEqual(["0", null]);
    expect(param(urls, "cursor")).toEqual([null, "c2"]);
    // The filters ride along on every page, or page 2 would be a different question.
    expect(urls.every((u) => new URL(u).searchParams.get("collection") === "shoot-01")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("--cursor reads the page after the one that printed it, and resumes a walk with --all", async () => {
    let urls = serve([[{ id: "a4" }], { perPage: 1, hasMore: true, nextCursor: "c5" }]);
    const { default: assetCommand } = await import("../src/commands/asset.js");

    await run(assetCommand, ["list", "--cursor", "c4", "-s", "1", "-o", "json"]);

    expect(param(urls, "cursor")).toEqual(["c4"]);
    expect(param(urls, "page")).toEqual([null]);
    vi.unstubAllGlobals();

    urls = serve(
      [[{ id: "a4" }], { perPage: 1, hasMore: true, nextCursor: "c5" }],
      [[{ id: "a5" }], { perPage: 1, hasMore: false, nextCursor: null }]
    );
    const out = await run(assetCommand, ["list", "--all", "--cursor", "c4", "-s", "1", "-o", "json"]);
    expect(JSON.parse(out).map((a) => a.id)).toEqual(["a4", "a5"]);
    expect(param(urls, "cursor")).toEqual(["c4", "c5"]);
    vi.unstubAllGlobals();
  });

  it("without --all it is one request, at the page asked for", async () => {
    const urls = serve([[{ id: "a1" }], { total: 9, page: 3, perPage: 1, hasMore: true, nextCursor: "c4" }]);
    const { default: assetCommand } = await import("../src/commands/asset.js");

    await run(assetCommand, ["list", "-p", "3", "-s", "1", "-o", "json"]);

    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get("page")).toBe("3");
    vi.unstubAllGlobals();
  });

  it("refuses --page beside --all or --cursor, because one of them is a mistake about what the other does", async () => {
    for (const argv of [
      ["list", "--all", "-p", "2", "-o", "json"],
      ["list", "--cursor", "c1", "-p", "2", "-o", "json"]
    ]) {
      serve([[], { total: 0, page: 0, perPage: 100, hasMore: false, nextCursor: null }]);
      const { default: assetCommand } = await import("../src/commands/asset.js");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {});

      await run(assetCommand, argv);

      // A usage error, exit 1 like the others (#566) — not 2, which is `jobs wait`'s timeout.
      expect(exit, argv.join(" ")).toHaveBeenCalledWith(1);
      exit.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("every listing that pages has it: collections, jobs, items, deliveries, feedback", async () => {
    const commands = [
      ["../src/commands/asset.js", ["collections", "--all", "-s", "1", "-o", "json"]],
      ["../src/commands/jobs.js", ["list", "--all", "-s", "1", "-o", "json"]],
      ["../src/commands/jobs.js", ["items", "job_1", "--all", "-s", "1", "-o", "json"]],
      ["../src/commands/webhook.js", ["deliveries", "whe_1", "--all", "-s", "1", "-o", "json"]],
      ["../src/commands/feedback.js", ["list", "--all", "-s", "1", "-o", "json"]]
    ];
    for (const [module, argv] of commands) {
      const urls = serve(
        [[{ id: "r1", collection: "a" }], { total: 2, page: 0, perPage: 1, hasMore: true, nextCursor: "c1" }],
        [[{ id: "r2", collection: "b" }], { perPage: 1, hasMore: false, nextCursor: null }]
      );
      const { default: command } = await import(module);

      const out = await run(command, argv);

      expect(urls, module).toHaveLength(2);
      expect(param(urls, "cursor"), module).toEqual([null, "c1"]);
      expect(JSON.parse(out), module).toHaveLength(2);
      vi.unstubAllGlobals();
    }
  });
});
