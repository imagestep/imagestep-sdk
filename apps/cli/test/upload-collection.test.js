import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * imagestep#348 — which collection `asset upload` puts each file in. A directory's own layout extends the name
 * (`shoot/raw/b.png` under `-c shoot-01` goes in `shoot-01/raw`); a file named on the command line goes in the name
 * as given — it used to take its path from the working directory along, so `upload ./shoot/*.jpg -c shoot-01` landed
 * in `shoot-01/shoot` and `asset list -c shoot-01` found nothing.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));

const { prepareFileList, prepareFileData, resolveCollection, collectionForFile } = await import("../src/utils/upload-helpers.js");

// The smallest valid PNG: the scanner checks magic bytes, not the extension alone.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b550000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex"
);

let root;
let cwd;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "imagestep-cli-collection-"));
  mkdirSync(join(root, "shoot", "raw"), { recursive: true });
  writeFileSync(join(root, "shoot", "a.png"), PNG);
  writeFileSync(join(root, "shoot", "raw", "b.png"), PNG);
  cwd = process.cwd();
  process.chdir(root);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function collectionsFor(paths, collection) {
  const { files } = await prepareFileList(paths);
  return (await prepareFileData(files, collection)).map((f) => [f.name, f.collection]);
}

describe("asset upload — the collection each file goes in", () => {
  it("files named on the command line go in the collection as given, wherever they are", async () => {
    expect(await collectionsFor(["./shoot/a.png", "shoot/raw/b.png"], "shoot-01")).toEqual([
      ["a.png", "shoot-01"],
      ["b.png", "shoot-01"]
    ]);
  });

  it("a directory keeps its own layout inside the name, relative to the directory itself", async () => {
    const got = await collectionsFor(["./shoot"], "shoot-01");
    expect(got.sort()).toEqual([
      ["a.png", "shoot-01"],
      ["b.png", "shoot-01/raw"]
    ]);
  });

  it("the name is used as given — a leading slash is part of it — and a missing one is generated", () => {
    expect(resolveCollection("/shoot-01")).toBe("/shoot-01");
    expect(resolveCollection(undefined)).toMatch(/^upload-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/);
    expect(collectionForFile({ relativePath: null }, "c")).toBe("c");
    expect(collectionForFile({ relativePath: "x.png" }, "c")).toBe("c");
  });
});

describe("asset set-collection", () => {
  it("sends the name as given, and an empty one takes the assets out of their collection", async () => {
    const bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        const collection = body.collection.trim() || undefined;
        return new Response(JSON.stringify({ success: true, data: body.ids.map((id) => ({ id, collection })) }), {
          headers: { "content-type": "application/json" }
        });
      })
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { default: assetCommand } = await import("../src/commands/asset.js");

    await assetCommand.parseAsync(["set-collection", "a1", "a2", "-c", "shoot-01"], { from: "user" });
    await assetCommand.parseAsync(["set-collection", "a1", "-c", ""], { from: "user" });

    expect(bodies).toEqual([
      { ids: ["a1", "a2"], collection: "shoot-01" },
      { ids: ["a1"], collection: "" }
    ]);
    vi.unstubAllGlobals();
  });
});

describe("asset collections / rename-collection", () => {
  it("lists through the collections endpoint with the filter, and renames with one POST", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init) => {
        calls.push([url, init?.method || "GET", init?.body ? JSON.parse(init.body) : undefined]);
        const data = url.includes("/rename")
          ? { from: "shoot-01", updated: 3 }
          : [{ collection: "shoot-01", count: 3, lastCreatedAt: 1_700_000_000_000 }];
        return new Response(JSON.stringify({ success: true, data, meta: { total: 1 } }), {
          headers: { "content-type": "application/json" }
        });
      })
    );
    let out = "";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const capture = (...args) => {
      out += args.join(" ") + "\n";
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(console, "log").mockImplementation(capture);
    const { default: assetCommand } = await import("../src/commands/asset.js");

    await assetCommand.parseAsync(["collections", "-q", "shoot", "-o", "json"], { from: "user" });
    expect(JSON.parse(out)).toEqual([{ collection: "shoot-01", count: 3, lastCreatedAt: 1_700_000_000_000 }]);
    await assetCommand.parseAsync(["rename-collection", "shoot-01", ""], { from: "user" });

    expect(calls[0][0]).toBe("https://api.test/api/v1/assets/collections?page=0&perPage=100&q=shoot");
    expect(calls[1]).toEqual(["https://api.test/api/v1/assets/collections/rename", "POST", { from: "shoot-01", to: "" }]);
    vi.unstubAllGlobals();
  });
});
