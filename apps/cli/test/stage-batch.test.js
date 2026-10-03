import { beforeEach, describe, expect, it, vi } from "vitest";

// Every call in order: ["stage", n] · ["put", url] · ["finish", n].
const log = [];
const finishKeys = [];
let stages = 0;
let failStage = null;
vi.mock("../src/config.js", () => ({ getToken: () => "is_sk_test", getServiceUrl: () => "https://api.test" }));

/** stage-upload and finish-upload, answered where they leave the SDK. */
async function service(url, init) {
  const body = JSON.parse(init.body);
  if (url.endsWith("/finish-upload")) {
    log.push(["finish", body.length]);
    finishKeys.push(init.headers["Idempotency-Key"]);
    return Response.json({ data: body.map((item) => ({ id: `ast_${item.objectId}` })) });
  }
  stages++;
  log.push(["stage", body.length]);
  if (failStage === stages)
    return Response.json({ error: { code: "invalid_param", message: "refused", retryable: false } }, { status: 400 });
  return Response.json({
    data: body.map((file) => ({
      fileName: file.fileName,
      objectId: `s${stages}/${file.fileName}`,
      url: `https://r2.test/s${stages}/${file.fileName}`
    }))
  });
}
let putAnswer = () => {};
vi.mock("../src/utils/file-utils.js", async (original) => ({
  ...(await original()),
  uploadFile: vi.fn(async (_path, url) => {
    log.push(["put", url]);
    return putAnswer(url);
  })
}));

const { STAGE_BATCH_SIZE, uploadInChunks } = await import("../src/utils/upload-helpers.js");

const files = (n) => Array.from({ length: n }, (_, i) => ({ name: `f${i}.jpg`, path: `/tmp/f${i}.jpg`, size: 1, hash: `h${i}` }));

/**
 * imagestep#524 — `asset upload` stages, uploads and finishes one chunk of STAGE_BATCH_SIZE files before it stages the
 * next. It used to stage everything, PUT everything, then finish: past the 60-minute life of a presigned URL the second
 * half of a big directory met 403s, and an interrupted run had created no asset at all. A chunk is also the most one
 * stage-upload / finish-upload call may carry (#329 · #476; the number is held to the Java by the repo-root
 * `test/stage-upload-batch.test.js`): at 1000 a 501–1000 file upload had its first call refused whole with a 400.
 */
describe("uploadInChunks", () => {
  beforeEach(() => {
    log.length = 0;
    finishKeys.length = 0;
    stages = 0;
    failStage = null;
    putAnswer = () => {};
    vi.stubGlobal("fetch", vi.fn(service));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("finishes chunk 1 before staging chunk 2, and finishes a chunk in one call", async () => {
    const { results } = await uploadInChunks(files(STAGE_BATCH_SIZE + 1), 3);
    const kinds = log.map(([kind]) => kind);
    const firstFinish = kinds.indexOf("finish");
    expect(log[0]).toEqual(["stage", STAGE_BATCH_SIZE]);
    expect(log[firstFinish]).toEqual(["finish", STAGE_BATCH_SIZE]);
    expect(kinds.lastIndexOf("stage")).toBeGreaterThan(firstFinish);
    expect(log.filter(([kind]) => kind === "finish").map(([, n]) => n)).toEqual([STAGE_BATCH_SIZE, 1]);
    // Each chunk's finish is its own request: a shared key would replay chunk 1's answer for chunk 2 (#476).
    expect(new Set(finishKeys).size).toBe(2);
    // Chunk 2's PUT goes to a URL chunk 2's own stage minted, however long chunk 1 took.
    expect(log.at(-2)).toEqual(["put", `https://r2.test/s2/f${STAGE_BATCH_SIZE}.jpg`]);
    expect(results.every((r) => r.status === "Success")).toBe(true);
  });

  it("an interrupted run keeps the assets of the chunks it finished", async () => {
    failStage = 2;
    await expect(uploadInChunks(files(STAGE_BATCH_SIZE + 5), 3)).rejects.toThrow(/refused/);
    expect(log.filter(([kind]) => kind === "finish")).toEqual([["finish", STAGE_BATCH_SIZE]]);
  });

  it("re-stages a file whose upload URL expired (403) and uploads it to the new URL", async () => {
    putAnswer = (url) => {
      if (url === "https://r2.test/s1/f1.jpg") throw Object.assign(new Error("Upload failed with status: 403 Forbidden"), { status: 403 });
    };
    const { results } = await uploadInChunks(files(3), 1);
    expect(log.filter(([kind]) => kind === "stage")).toEqual([
      ["stage", 3],
      ["stage", 1]
    ]);
    expect(log.map(([, v]) => v)).toContain("https://r2.test/s2/f1.jpg");
    expect(results.map((r) => r.status)).toEqual(["Success", "Success", "Success"]);
    expect(results[1].assetId).toBe("ast_s2/f1.jpg");
  });
});
