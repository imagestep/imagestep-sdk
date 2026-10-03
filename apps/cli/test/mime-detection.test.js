import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getMimeType, matchesMimeTypeFilter, normalizeMimeTypeFilter } from "../src/utils/asset-utils.js";
import { getDetectedMimeType, validateFileForUpload } from "../src/utils/file-utils.js";

/**
 * imagestep#57 — `apps/cli` had no `test` script at all, so `pnpm -r --if-present test` skipped it:
 * nothing in CI could go red for this package, and it is one of the four things #27 publishes.
 *
 * What is worth testing here is the seam between magic-byte detection and the extension map: RAW
 * formats and SVG have no detectable signature `file-type` recognises, so `getMimeType` is the only
 * thing standing between them and `application/octet-stream` — i.e. between a customer's .3fr being
 * uploaded and being silently filtered out by their own `--mime-type` flag.
 */
const dir = mkdtempSync(join(tmpdir(), "imagestep-cli-test-"));

function file(name, bytes) {
  const path = join(dir, name);
  writeFileSync(path, Buffer.from(bytes));
  return path;
}

describe("mime type from the extension map", () => {
  it("names the formats magic bytes cannot reach", () => {
    // Every one of these is in the service's ALLOWED_IMAGE_EXTENSIONS, and none has a signature
    // file-type recognises — the extension map is the whole answer for them.
    expect(getMimeType("/x/photo.3fr")).toBe("image/x-hasselblad-3fr");
    expect(getMimeType("/x/photo.iiq")).toBe("image/x-phaseone-iiq");
    expect(getMimeType("/x/photo.srw")).toBe("image/x-samsung-srw");
    expect(getMimeType("/x/photo.rwl")).toBe("image/x-leica-rwl");
    expect(getMimeType("/x/logo.svg")).toBe("image/svg+xml");
  });

  it("is case-insensitive, because cameras write .CR2 and .NEF", () => {
    expect(getMimeType("/x/IMG_0001.CR2")).toBe(getMimeType("/x/img_0001.cr2"));
    expect(getMimeType("/x/IMG_0001.CR2")).not.toBe("application/octet-stream");
  });

  it("says octet-stream rather than guessing for an extension it does not know", () => {
    expect(getMimeType("/x/archive.tar.zst")).toBe("application/octet-stream");
    expect(getMimeType("/x/noextension")).toBe("application/octet-stream");
  });
});

describe("detection prefers magic bytes over the extension", () => {
  // A real image, not a hand-made header: file-type reads structure, not just the first 8 bytes,
  // and a synthetic signature quietly falls through to the extension map — which would make this
  // assertion pass for the wrong reason. A 2×2 lossless WebP sharp wrote (38 bytes), kept in this package so the
  // test runs wherever the package does (#653).
  const REAL_WEBP = fileURLToPath(new URL("./fixtures/sample.webp", import.meta.url));

  it("reads the real signature regardless of what the name claims", async () => {
    const mislabelled = join(dir, "mislabelled.jpg");
    copyFileSync(REAL_WEBP, mislabelled);
    expect(await getDetectedMimeType(mislabelled)).toBe("image/webp");
    // Positive control: the extension map would have said something else entirely.
    expect(getMimeType(mislabelled)).toBe("image/jpeg");
  });

  it("falls back to the extension when there is no signature to read", async () => {
    const svg = file("logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
    expect(await getDetectedMimeType(svg)).toBe("image/svg+xml");
  });

  it("returns null — not octet-stream — when nothing can name the file", async () => {
    // `null` is what upload-helpers treats as "no dedup / let the server decide"; collapsing it to
    // octet-stream would make an unknown file look like a known one.
    const unknown = file("mystery.tar.zst", Buffer.from("hello"));
    expect(await getDetectedMimeType(unknown)).toBeNull();
  });
});

describe("the --mime-type filter", () => {
  it("expands a bare extension into the full type", () => {
    expect(normalizeMimeTypeFilter(["png"])).toContain("image/png");
    expect(normalizeMimeTypeFilter(["image/png"])).toEqual(["image/png"]);
  });

  it("no filter means everything passes", () => {
    expect(normalizeMimeTypeFilter([])).toBeNull();
    expect(matchesMimeTypeFilter("image/png", null)).toBe(true);
  });

  it("skips a file the filter excludes, and says why", async () => {
    const png = file("shot.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
    const filter = normalizeMimeTypeFilter(["jpeg"]);
    const result = await validateFileForUpload(png, filter);
    expect(result.valid).toBe(false);
    expect(result.skipReason).toBe("mime-filter");
    expect(result.mimeType).toBe("image/png");
  });

  it("accepts the file when the filter matches — the positive control", async () => {
    const png = file("shot2.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
    const result = await validateFileForUpload(png, normalizeMimeTypeFilter(["png"]));
    expect(result.valid).toBe(true);
    expect(result.skipReason).toBeNull();
  });
});
