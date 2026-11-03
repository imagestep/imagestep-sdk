import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

/**
 * A directory of a few hundred thousand files is a camera card's worth of a shoot, not an edge case.
 * The scan used to merge each subtree with `push(...files)`, and a spread passes every element as a call argument:
 * past ~150k that is `RangeError: Maximum call stack size exceeded`, and `asset upload <dir>` died before it staged a
 * file. The tree here is virtual — `readdirSync` / `existsSync` / `statSync` answer for /virtual-shoot and file-type
 * says PNG — so 200,000 entries cost no disk and no file opens.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_test",
  getServiceUrl: () => "https://api.test",
  getConfigFile: () => "/tmp/config.yml"
}));
vi.mock("file-type", () => ({ fileTypeFromFile: async () => ({ mime: "image/png", ext: "png" }) }));

const { scanDirectoryRecursive } = await import("../src/utils/file-utils.js");
const { prepareFileList } = await import("../src/utils/upload-helpers.js");

const COUNT = 200_000;
const ROOT = "/virtual-shoot";
const DIR = { isDirectory: () => true, isFile: () => false };
const FILE = { isDirectory: () => false, isFile: () => true };
const BIG = Array.from({ length: COUNT }, (_, i) => ({ ...FILE, name: `IMG_${i}.png` }));

beforeAll(() => {
  const { readdirSync, existsSync, statSync } = fs;
  vi.spyOn(fs, "readdirSync").mockImplementation((dir, options) => {
    if (dir === ROOT) return [{ ...DIR, name: "card" }];
    if (dir === `${ROOT}/card`) return BIG;
    return readdirSync(dir, options);
  });
  vi.spyOn(fs, "existsSync").mockImplementation((p) => p === ROOT || existsSync(p));
  vi.spyOn(fs, "statSync").mockImplementation((p, options) => (p === ROOT ? DIR : statSync(p, options)));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("a directory of 200,000 files", () => {
  it("scans every file of a subtree that large", async () => {
    const { files, skipped } = await scanDirectoryRecursive(ROOT);
    expect(files).toHaveLength(COUNT);
    expect(skipped).toHaveLength(0);
    expect(files.at(-1).relativePath).toBe(`card/IMG_${COUNT - 1}.png`);
  });

  it("collects them all into the upload list — and all into the skipped list when the filter refuses them", async () => {
    expect((await prepareFileList([ROOT])).files).toHaveLength(COUNT);
    const refused = await prepareFileList([ROOT], ["image/jpeg"]);
    expect(refused.files).toHaveLength(0);
    expect(refused.skipped).toHaveLength(COUNT);
  });
});
