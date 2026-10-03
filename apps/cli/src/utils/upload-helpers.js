import fs from "fs";
import path from "path";
import chalk from "chalk";
import { calculateSHA1, executeConcurrently, scanDirectoryRecursive, uploadFile, validateFileForUpload } from "./file-utils.js";
import { formatBytes, formatTime } from "./formatter.js";
import { logger } from "./logger.js";
import { getMimeType, normalizeMimeTypeFilter } from "./asset-utils.js";
import { client } from "./service.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Files per stage-upload call AND per finish-upload call: the service's one ceiling on both
 * (`UploadController.MAX_STAGE_UPLOAD_ITEMS`, #329 · #476) — and the size of one chunk of the upload pipeline (#524).
 */
export const STAGE_BATCH_SIZE = 500;
const DEFAULT_CONCURRENCY = 3;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a standardized upload result object
 */
function createUploadResult(baseInfo, { status, assetId = "N/A", uploadTimeMs = 0, finishRequest = null, error = null }) {
  return {
    ...baseInfo,
    status,
    assetId,
    uploadTime: formatTime(uploadTimeMs),
    finishTime: formatTime(0),
    totalTime: formatTime(uploadTimeMs),
    rawUploadTime: uploadTimeMs,
    rawFinishTime: 0,
    rawTotalTime: uploadTimeMs,
    finishRequest,
    error
  };
}

// ============================================================================
// File Preparation
// ============================================================================

/**
 * Log skipped file with appropriate message
 * @param {string} fileName - Name of the file
 * @param {string} skipReason - Reason for skipping
 * @param {string|null} mimeType - Detected MIME type
 */
function logSkippedFile(fileName, skipReason, mimeType) {
  if (skipReason === "mime-filter") {
    console.log(chalk.yellow(`Skipping file (mime type filter): ${fileName} (${mimeType})`));
  }
}

/**
 * Prepare file list from input paths (handles files and directories)
 * @param {Array<string>} filePaths - Array of file/directory paths
 * @param {Array<string>|undefined} mimeTypeFilter - Optional MIME type filter (e.g., ['image/jpeg', 'png'])
 * @returns {Promise<{files: Array<{absolutePath: string, relativePath: string|null, mimeType: string}>, skipped: Array<{fileName: string, reason: string, mimeType: string|null}>}>} File info list and skipped files
 */
export async function prepareFileList(filePaths, mimeTypeFilter) {
  const fileInfoList = [];
  const skippedFiles = [];
  const normalizedFilter = normalizeMimeTypeFilter(mimeTypeFilter);

  for (const filePath of filePaths) {
    const absolutePath = path.resolve(filePath);

    if (!fs.existsSync(absolutePath)) {
      console.error(chalk.red(`Warning: Path not found: ${absolutePath}`));
      continue;
    }

    const stats = fs.statSync(absolutePath);
    if (stats.isFile()) {
      const fileName = path.basename(absolutePath);

      // Skip hidden files
      if (fileName.startsWith(".")) {
        console.log(chalk.yellow(`Skipping hidden file: ${fileName}`));
        continue;
      }

      // Validate file using consolidated validation function
      const validation = await validateFileForUpload(absolutePath, normalizedFilter);
      if (validation.valid) {
        // A file named on the command line goes in the collection as given: only a directory's own layout
        // extends the name (imagestep#348 — `./shoot/a.png -c shoot-01` used to land in "shoot-01/shoot").
        fileInfoList.push({ absolutePath, relativePath: null, mimeType: validation.mimeType });
      } else {
        logSkippedFile(fileName, validation.skipReason, validation.mimeType);
        skippedFiles.push({ fileName, reason: validation.skipReason, mimeType: validation.mimeType });
      }
    } else if (stats.isDirectory()) {
      console.log(chalk.cyan(`Scanning directory: ${absolutePath}`));
      const { files: dirFiles, skipped: dirSkipped } = await scanDirectoryRecursive(absolutePath, null, normalizedFilter);
      fileInfoList.push(...dirFiles);
      skippedFiles.push(...dirSkipped);
      console.log(chalk.green(`  Found ${dirFiles.length} file(s) in directory`));
      if (dirSkipped.length > 0) {
        console.log(chalk.yellow(`  Skipped ${dirSkipped.length} file(s) by mime filter`));
      }
    }
  }

  return { files: fileInfoList, skipped: skippedFiles };
}

/**
 * The collection every uploaded asset goes in (`collection` on finish-upload). Opaque, no tree,
 * nothing created server-side — `imagestep asset list --collection <name>` filters on it, exactly as
 * given (a leading `/` is part of the name, not a root).
 * @param {string|undefined} option - `--collection` as given
 * @returns {string} the collection (auto-generated `upload-<timestamp>` when omitted)
 */
export function resolveCollection(option) {
  if (option) return option;
  const timeStr = new Date().toISOString().replace(/T/, "-").replace(/\..+/, "").replace(/:/g, "-");
  const collection = `upload-${timeStr}`;
  logger.info(`No collection specified, using auto-generated: ${collection}`);
  return collection;
}

/** A file found under a directory keeps its relative directory as part of the collection name. */
export function collectionForFile(fileInfo, base) {
  if (!fileInfo.relativePath) return base;
  const dirPath = path.dirname(fileInfo.relativePath);
  return dirPath === "." ? base : path.posix.join(base, dirPath.replace(/\\/g, "/"));
}

/**
 * `--tags a,b` as the list the service takes (imagestep#334): split on commas, trimmed, blanks dropped. `""` is `[]`
 * (the service's "clear them"); an absent option stays `undefined` (leave them).
 * @param {string|undefined} option
 * @returns {string[]|undefined}
 */
export function parseTags(option) {
  if (option === undefined) return undefined;
  return String(option)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Prepare file data for staging (calculates hashes in parallel)
 * @param {Array<{absolutePath: string, relativePath: string|null, mimeType: string}>} fileInfoList - File info list
 * @param {string} collection - Collection for the batch
 * @param {string[]} [tags] - Tags every new asset gets
 * @param {number} [retentionDays] - Keep every new asset this many days instead of the plan's retention — shorter only (#591)
 * @returns {Promise<Array<Object>>} File data list
 */
export async function prepareFileData(fileInfoList, collection, tags, retentionDays) {
  logger.info("Calculating file hashes...");

  const processFile = async function (fileInfo) {
    const stats = fs.statSync(fileInfo.absolutePath);
    const sha1Hash = await calculateSHA1(fileInfo.absolutePath, stats.size);
    const fileCollection = collectionForFile(fileInfo, collection);

    logger.info(`  ${path.basename(fileInfo.absolutePath)} - ${formatBytes(stats.size)}`);

    return {
      path: fileInfo.absolutePath,
      size: stats.size,
      hash: sha1Hash,
      name: path.basename(fileInfo.absolutePath),
      collection: fileCollection,
      tags,
      retentionDays,
      relativePath: fileInfo.relativePath,
      mimeType: fileInfo.mimeType
    };
  };

  return executeConcurrently(fileInfoList, processFile, 5);
}

// ============================================================================
// Single File Upload
// ============================================================================

/**
 * Upload a single file (upload to storage only, does not call finish-upload API)
 * @param {Object} fileData - File data with cached mimeType
 * @param {Object} stageData - Stage data from API
 * @param {number} index - File index
 * @param {number} total - Total number of files
 * @returns {Promise<Object>} Upload result with finishRequest for batch processing
 */
async function uploadSingleFile(fileData, stageData, index, total) {
  const fileName = path.basename(fileData.path);
  const mimeType = fileData.mimeType || getMimeType(fileData.path);
  const baseInfo = {
    fileName,
    fileSize: formatBytes(fileData.size),
    rawSize: fileData.size,
    collection: fileData.collection,
    mimeType
  };

  console.log(chalk.cyan(`\nProcessing (${index + 1}/${total}): ${fileName}`));

  // Stage rejected this file (e.g., size limit exceeded)
  if (stageData.error) {
    console.log(chalk.red(`  Rejected by server: ${stageData.error}`));
    return createUploadResult(baseInfo, { status: "Failed", error: stageData.error });
  }

  // The account already holds these bytes (same SHA-1): nothing to PUT, and the row names the asset the
  // caller wanted anyway — the SDKs return the existing asset here, and `-o json | jq '.[0].assetId'`
  // (the docs' example) must work whether or not the file was new.
  if (stageData.exists) {
    console.log(chalk.yellow(`  File already exists in storage (duplicate detected): ${stageData.existingAssetId}`));
    return createUploadResult(baseInfo, { status: "Existing", assetId: stageData.existingAssetId });
  }

  try {
    logger.info("  Uploading file to storage...");
    const uploadStartMs = Date.now();
    try {
      await uploadFile(fileData.path, stageData.url, mimeType, stageData.contentType);
    } catch (error) {
      if (error.status !== 403) throw error;
      // The presigned PUT is good for 60 minutes (service README §5); a slow upload reaches a URL past that. It is
      // staged again — a fresh URL for a fresh object — and sent once more (#524).
      logger.warn(`  ${fileName}: upload URL expired (403) — staging it again`);
      const [again] = await stageUploads([fileData]);
      if (!again || again.error) throw new Error(again?.error || "stage-upload answered nothing", { cause: error });
      if (again.exists) return createUploadResult(baseInfo, { status: "Existing", assetId: again.existingAssetId });
      stageData = again;
      await uploadFile(fileData.path, stageData.url, mimeType, stageData.contentType);
    }
    const uploadTimeMs = Date.now() - uploadStartMs;
    console.log(chalk.green(`  File uploaded successfully! (${formatTime(uploadTimeMs)})`));

    // Which staged object, its name, the collection, the tags (#232, #334) and how long to keep it (#591): the service
    // knows the rest.
    const finishRequest = {
      objectId: stageData.objectId,
      name: fileData.name,
      ...(fileData.collection && { collection: fileData.collection }),
      ...(fileData.tags?.length && { tags: fileData.tags }),
      ...(fileData.retentionDays && { retentionDays: fileData.retentionDays })
    };

    return createUploadResult(baseInfo, { status: "Uploaded", uploadTimeMs, finishRequest });
  } catch (error) {
    const errorMessage = error.message || "Unknown error";
    console.log(chalk.red(`  Failed to upload: ${errorMessage}`));
    logger.error(`Failed to upload ${fileName}: ${errorMessage}`);

    return createUploadResult(baseInfo, { status: "Failed", error: errorMessage });
  }
}

// ============================================================================
// Batch Processing
// ============================================================================

/**
 * Finish one chunk of uploads (≤ {@link STAGE_BATCH_SIZE} — `uploadInChunks` cuts them) in one finish-upload call.
 *
 * The SDK retries a failed call (a 5xx, a connection that dropped) under the one Idempotency-Key it gave that call
 * (contract §3), so a call that landed before the connection dropped replays its answer: with a fresh key per attempt
 * the retry names objects that are already assets, which finish-upload refuses (#476) — it used to make a second asset
 * of each. Each chunk's call is a call of its own, with a key of its own.
 * @param {Array<Object>} finishRequests - Array of finish-upload request bodies
 * @returns {Promise<Array<Object>>} Array of created asset objects, in request order
 */
async function batchFinishUpload(finishRequests) {
  if (finishRequests.length === 0) return [];
  const response = await client().post("/api/v1/assets/finish-upload", finishRequests);
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Display upload summary
 * @param {Array<Object>} uploadResults - Upload results
 * @param {number} totalElapsedTime - Total elapsed time in ms
 * @param {string} collection - The collection given on the command line
 * @param {Array<{fileName: string, reason: string, mimeType: string|null}>} skippedFiles - Skipped files during file scanning
 */
export function displayUploadSummary(uploadResults, totalElapsedTime, collection, skippedFiles = []) {
  const successCount = uploadResults.filter((r) => r.status === "Success").length;
  // Bytes the account already held (same SHA-1): nothing was sent, and the row names the asset that has them.
  const existingCount = uploadResults.filter((r) => r.status === "Existing").length;
  const failedResults = uploadResults.filter((r) => r.status === "Failed");
  const failedCount = failedResults.length;
  const totalSize = uploadResults.reduce((sum, r) => sum + r.rawSize, 0);
  const totalUploadTime = uploadResults.reduce((sum, r) => sum + r.rawUploadTime, 0);
  const totalFinishTime = uploadResults.reduce((sum, r) => sum + r.rawFinishTime, 0);

  const skippedMimeFilter = skippedFiles.filter((f) => f.reason === "mime-filter");

  // Determine header color based on results
  const headerColor = failedCount > 0 ? chalk.yellow.bold : chalk.green.bold;

  console.log(headerColor(`\n${"=".repeat(80)}`));
  console.log(headerColor(`  Upload Summary`));
  console.log(headerColor(`${"=".repeat(80)}\n`));
  console.log(chalk.cyan(`  Total files processed:  ${uploadResults.length}`));
  console.log(chalk.green(`  Successfully uploaded:  ${successCount}`));
  if (existingCount > 0) {
    console.log(chalk.yellow(`  Already stored:         ${existingCount}`));
  }
  if (failedCount > 0) {
    console.log(chalk.red(`  Failed:                 ${failedCount}`));
  }
  console.log(chalk.cyan(`  Total file size:        ${formatBytes(totalSize)}`));
  console.log(chalk.cyan(`  Total upload time:      ${formatTime(totalUploadTime)}`));
  console.log(chalk.cyan(`  Total API time:         ${formatTime(totalFinishTime)}`));
  console.log(chalk.cyan(`  Total elapsed time:     ${formatTime(totalElapsedTime)}`));
  console.log(chalk.cyan(`  Collection:             ${collection}`));

  // Display skipped files summary
  if (skippedMimeFilter.length > 0) {
    console.log(chalk.yellow.bold(`\n${"=".repeat(80)}`));
    console.log(chalk.yellow.bold(`  Filtered by MIME type (${skippedMimeFilter.length} total)`));
    console.log(chalk.yellow.bold(`${"=".repeat(80)}\n`));

    skippedMimeFilter.forEach((file) => {
      console.log(chalk.yellow(`    - ${file.fileName} (${file.mimeType})`));
    });
  }

  // Display failed files with error reasons
  if (failedCount > 0) {
    console.log(chalk.red.bold(`\n${"=".repeat(80)}`));
    console.log(chalk.red.bold(`  Failed Files (${failedCount})`));
    console.log(chalk.red.bold(`${"=".repeat(80)}\n`));

    failedResults.forEach((result, index) => {
      console.log(chalk.red(`  ${index + 1}. ${result.fileName}`));
      console.log(chalk.red(`     Error: ${result.error || "Unknown error"}`));
    });
  }

  console.log();
}

// ============================================================================
// Upload Orchestration
// ============================================================================

/**
 * Stage one chunk of uploads (≤ {@link STAGE_BATCH_SIZE}) in one stage-upload call.
 * @param {Array<Object>} fileDataList - Prepared file data list
 * @returns {Promise<Array<Object>>} One stage answer per file, in order
 */
async function stageUploads(fileDataList) {
  logger.info("Staging uploads...");
  const response = await client().post(
    "/api/v1/assets/stage-upload",
    fileDataList.map((file) => ({ fileName: file.name, fileSize: file.size, sha1Hash: file.hash }))
  );
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * Update upload results with finish API results
 * @param {Array<Object>} uploadResults - Upload results to update in place
 * @param {Array<Object>} finishResults - Finish results from API
 * @param {number} finishTimeMs - Total finish time in ms
 */
function processFinishResults(uploadResults, finishResults, finishTimeMs) {
  const pendingResults = uploadResults.filter((r) => r.finishRequest);
  const perFileFinishTime = pendingResults.length > 0 ? finishTimeMs / pendingResults.length : 0;

  // finish-upload answers `{id, name, status}` per item, in request order (#232), and the batches go
  // out in this same order — so the i-th created asset is the i-th pending upload. This used to look
  // each one up by `finishRequest.basicInfo.sha1Hash`, a field #232 removed from the request: every
  // upload crashed on a TypeError after its assets had already been created.
  for (const [index, result] of pendingResults.entries()) {
    const asset = finishResults[index];
    if (asset) {
      result.assetId = asset.id || "N/A";
      result.status = "Success";
    }
    result.rawFinishTime = perFileFinishTime;
    result.finishTime = formatTime(perFileFinishTime);
    result.rawTotalTime = result.rawUploadTime + perFileFinishTime;
    result.totalTime = formatTime(result.rawTotalTime);
    delete result.finishRequest;
  }
}

/**
 * The whole upload, one chunk of {@link STAGE_BATCH_SIZE} files at a time: stage the chunk → PUT it (bounded
 * concurrency) → finish it, then the next (#524). Staging every file first and finishing only after the last PUT meant
 * a directory that took longer than the 60-minute URL lifetime met 403s in its second half, and an interrupted run had
 * created not one asset. Now each chunk's assets exist before the next chunk starts, and a rerun skips them (sha1).
 * @returns {Promise<{results: Array<Object>, elapsedTime: number}>}
 */
export async function uploadInChunks(fileDataList, concurrency = DEFAULT_CONCURRENCY) {
  const startTime = Date.now();
  const results = [];
  const chunks = Math.ceil(fileDataList.length / STAGE_BATCH_SIZE);
  for (let i = 0; i < fileDataList.length; i += STAGE_BATCH_SIZE) {
    const chunk = fileDataList.slice(i, i + STAGE_BATCH_SIZE);
    if (chunks > 1) console.log(chalk.cyan(`\nChunk ${i / STAGE_BATCH_SIZE + 1}/${chunks} (${chunk.length} files)`));
    const stageResponse = await stageUploads(chunk);
    if (stageResponse.length !== chunk.length) throw new Error("stage-upload did not answer for every file");
    results.push(...(await executeUploadsWithFinish(chunk, stageResponse, concurrency)));
  }
  return { results, elapsedTime: Date.now() - startTime };
}

/**
 * One staged chunk: PUT its files with bounded concurrency, then finish the ones that went up in one call.
 * @returns {Promise<Array<Object>>} Upload results, in file order
 */
async function executeUploadsWithFinish(fileDataList, stageResponse, concurrency) {
  const totalFiles = fileDataList.length;

  console.log(chalk.cyan(`\nUploading with concurrency limit: ${concurrency}\n`));

  // Pair each file with its stage data and upload
  const uploadItems = fileDataList.map((fileData, i) => ({ fileData, stageData: stageResponse[i] }));
  const uploadResults = await executeConcurrently(
    uploadItems,
    (item, i) => uploadSingleFile(item.fileData, item.stageData, i, totalFiles),
    concurrency
  );

  // Batch finish all successfully uploaded files
  const finishRequests = uploadResults.filter((r) => r.finishRequest).map((r) => r.finishRequest);
  if (finishRequests.length > 0) {
    console.log(chalk.cyan(`\nFinalizing ${finishRequests.length} uploads in batch...`));
    const finishStartMs = Date.now();
    const finishResults = await batchFinishUpload(finishRequests);
    const finishTimeMs = Date.now() - finishStartMs;
    console.log(chalk.green(`Batch finalization completed! (${formatTime(finishTimeMs)})`));
    processFinishResults(uploadResults, finishResults, finishTimeMs);
  }

  return uploadResults;
}
