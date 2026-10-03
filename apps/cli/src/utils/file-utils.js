import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getMimeType, matchesMimeTypeFilter } from "./asset-utils.js";
import { cliFetch } from "./service.js";

/**
 * Get detected MIME type of a file using magic bytes, falling back to the
 * extension-based map for formats file-type can't detect (SVG, plus RAW
 * formats like 3fr, fff, iiq, srw, rwl).
 * @param {string} filePath - Path to the file
 * @returns {Promise<string|null>} Detected MIME type or null if unknown
 */
export async function getDetectedMimeType(filePath) {
  try {
    const { fileTypeFromFile } = await import("file-type"); // on first use, not at every start (#526)
    const fileType = await fileTypeFromFile(filePath);
    if (fileType) {
      return fileType.mime;
    }
  } catch {
    // fall through to extension-based detection
  }
  const mime = getMimeType(filePath);
  return mime !== "application/octet-stream" ? mime : null;
}

/**
 * Validate a file against the optional --mime-type user filter. Image-only
 * enforcement is handled server-side by stage-upload (per-item rejection) so
 * the CLI no longer needs its own allowlist.
 * @param {string} absolutePath - Absolute path to the file
 * @param {Array<string>|null} normalizedFilter - Optional normalized MIME type filter
 * @returns {Promise<{valid: boolean, mimeType: string|null, skipReason: string|null}>}
 */
export async function validateFileForUpload(absolutePath, normalizedFilter) {
  const detectedMimeType = await getDetectedMimeType(absolutePath);

  if (normalizedFilter && !matchesMimeTypeFilter(detectedMimeType, normalizedFilter)) {
    return { valid: false, mimeType: detectedMimeType, skipReason: "mime-filter" };
  }

  return { valid: true, mimeType: detectedMimeType, skipReason: null };
}

// The server-side upload limit, `UploadController.MAX_FILE_SIZE_BYTES` — `test/upload-limit-copy.test.js`
// reads the Java and fails when the two part (#310). Files above this would be rejected by
// stage-upload anyway, so skip the hash work and return null (server treats a
// missing hash as "no dedup possible"). Streaming makes memory bounded for any
// size, but there's no point burning CPU on files that can't be uploaded.
export const HASH_SIZE_LIMIT = 100 * 1024 * 1024;

/**
 * Calculate SHA1 hash of a file using a streaming read (memory bounded by the
 * stream chunk size, not the file size).
 * @param {string} filePath - Path to the file
 * @param {number} [knownSize] - Optional pre-fetched file size to avoid a redundant statSync
 * @returns {Promise<string|null>} SHA1 hash in hex format, or null if file is too large to upload
 */
export async function calculateSHA1(filePath, knownSize) {
  const size = knownSize ?? fs.statSync(filePath).size;
  if (size > HASH_SIZE_LIMIT) {
    return null;
  }
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);

    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** A path's bytes as a fetch body that opens the file only when fetch starts reading it (see `uploadFile`). */
async function* readLazily(filePath) {
  yield* fs.createReadStream(filePath);
}

/**
 * A presigned PUT gets three attempts, 2 s then 4 s apart, and only a failed connection is sent again — an answer is
 * never retried here (a 403 is re-staged by the caller, #524). The one retry the CLI still writes itself: the SDK's
 * transport retries calls to the API, and this PUT goes to storage.
 */
const UPLOAD_ATTEMPTS = 3;

/**
 * Upload file to pre-signed URL, streamed (memory bounded by the chunk size, not the file size)
 * @param {string} filePath - Path to the file to upload
 * @param {string} url - Pre-signed URL for upload
 * @param {string} mimeType - MIME type for the file
 * @param {string|null} signedContentType - The Content-Type stage-upload signed the URL for (#48).
 *   Present on every response from a service at or past #48; falls back to `mimeType` so an older
 *   deployment keeps working.
 * @returns {Promise<void>}
 */
export async function uploadFile(filePath, url, mimeType, signedContentType = null) {
  const fileSize = fs.statSync(filePath).size;
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await cliFetch(url, {
        method: "PUT",
        // A fresh body for each attempt (a stream is read once), opened on fetch's first read: a `createReadStream`
        // opens at once, so an attempt that failed before sending held a descriptor and, the file gone, threw an
        // ENOENT nothing could catch.
        body: readLazily(filePath),
        headers: {
          // Both are SIGNED into the presigned URL (#48): the service derives the Content-Type from
          // the file name, and the length is the fileSize we declared at stage-upload. Sending
          // anything else fails the signature at the object store, which is the point.
          "Content-Type": signedContentType || mimeType,
          "Content-Length": fileSize.toString()
        },
        duplex: "half" // Required for streaming body in Node.js fetch
      });
    } catch (error) {
      // No answer at all: the connection failed, not the storage.
      if (attempt >= UPLOAD_ATTEMPTS)
        throw new Error(`Network error after ${UPLOAD_ATTEMPTS} attempts: ${error.message}`, { cause: error });
      const waitMs = 2000 * 2 ** (attempt - 1);
      console.log(`  Retry ${attempt}/${UPLOAD_ATTEMPTS - 1}: Network error, waiting ${waitMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!response.ok) {
      // `status` lets a caller tell an expired signature (403) from the rest: that one is re-staged, not retried (#524).
      throw Object.assign(new Error(`Upload failed with status: ${response.status} ${response.statusText}`), { status: response.status });
    }
    return;
  }
}

/**
 * Recursively scan a directory and return all image files with their relative paths
 * @param {string} dirPath - The directory to scan
 * @param {string} basePath - The base path for calculating relative paths (defaults to dirPath)
 * @param {Array<string>|null} mimeTypeFilter - Optional normalized MIME type filter
 * @returns {Promise<{files: Array<{absolutePath: string, relativePath: string, mimeType: string}>, skipped: Array<{fileName: string, reason: string, mimeType: string|null}>}>} Files and skipped files info
 */
export async function scanDirectoryRecursive(dirPath, basePath = null, mimeTypeFilter = null) {
  if (basePath === null) {
    basePath = dirPath;
  }

  const results = [];
  const skipped = [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files and directories
    if (entry.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const subResult = await scanDirectoryRecursive(fullPath, basePath, mimeTypeFilter);
      results.push(...subResult.files);
      skipped.push(...subResult.skipped);
    } else if (entry.isFile()) {
      const validation = await validateFileForUpload(fullPath, mimeTypeFilter);

      if (!validation.valid) {
        skipped.push({ fileName: entry.name, reason: validation.skipReason, mimeType: validation.mimeType });
        continue;
      }

      const relativePath = path.relative(basePath, fullPath);
      results.push({ absolutePath: fullPath, relativePath, mimeType: validation.mimeType });
    }
  }

  return { files: results, skipped };
}

/**
 * Execute tasks with limited concurrency
 * @param {Array} items - Array of items to process
 * @param {Function} task - Async function to execute for each item
 * @param {number} concurrency - Maximum number of concurrent executions
 * @returns {Promise<Array>} Results from all tasks
 */
export async function executeConcurrently(items, task, concurrency) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex++;
      if (currentIndex >= items.length) break;

      const item = items[currentIndex];
      results[currentIndex] = await task(item, currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());

  await Promise.all(workers);
  return results;
}
