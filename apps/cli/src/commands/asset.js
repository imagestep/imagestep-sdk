import chalk from "chalk";
import { Command } from "commander";
import {
  handleCommandError,
  validateNonEmptyArray,
  confirmDeletion,
  retentionDaysOf,
  YES_FLAG_DESCRIPTION
} from "../utils/command-helpers.js";
import { formatOutput, formatBytes } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import { downloadAsset } from "../utils/download.js";
import { client } from "../utils/service.js";
import { checkPagingOptions, printContinuation, readListing } from "../utils/paging.js";
import {
  prepareFileList,
  resolveCollection,
  prepareFileData,
  parseTags,
  uploadInChunks,
  displayUploadSummary
} from "../utils/upload-helpers.js";

const assetCommand = new Command("asset").description("Manage your assets");

// ============================================================================
// Upload Command
// ============================================================================

assetCommand
  .command("upload")
  .description("Upload assets from local paths (wildcards ok; a directory's relative path becomes part of the collection name)")
  .argument("<file-paths...>", "Path to file(s) or directories to upload (supports wildcards like *.jpg)")
  .option("-c, --collection <name>", "Collection to put the new assets in (optional, defaults to upload-{timestamp})")
  .option("--tags <list>", "Comma-separated tags for every new asset (a file you already hold keeps its own)")
  .option("--retention-days <n>", "Keep the new assets this many days instead of your plan's retention — shorter only")
  .option("--concurrency <number>", "Number of concurrent uploads (default: 3)", "3")
  .option("-m, --mime-type <types...>", "Filter by MIME type(s), e.g., image/jpeg, jpg, PNG (case-insensitive)")
  .option("-o, --output <format>", "Output format (json|yaml|table); json/yaml print only the results on stdout", "table")
  .action(async (filePaths, options) => {
    // For json / yaml the progress lines move to stderr, so stdout is exactly the result a program
    // asked for (#272: the flag used to be declared and ignored — it always printed a table).
    const machine = options.output !== "table";
    const log = console.log;
    if (machine) console.log = console.error;
    try {
      // Step 1: Prepare file list with mime type filter
      const { files: fileInfoList, skipped: skippedFiles } = await prepareFileList(filePaths, options.mimeType);

      if (fileInfoList.length === 0) {
        if (skippedFiles.length > 0) {
          console.log(chalk.yellow(`\nSkipped ${skippedFiles.length} file(s) by mime filter`));
        }
        console.error(chalk.red(`Error: No valid files to upload`));
        process.exit(1);
      }

      console.log(chalk.cyan(`\nTotal ${fileInfoList.length} file(s) to upload`));
      if (skippedFiles.length > 0) {
        console.log(chalk.yellow(`Skipped ${skippedFiles.length} file(s) by mime filter`));
      }

      // Step 2: The collection. There is no folder entity server-side (CLAUDE.md «Collections, not
      // folders»): a collection is an opaque string on each asset, so nothing is created up front.
      const collection = resolveCollection(options.collection);

      // Step 3: Prepare file data (calculates hashes; a file found under a directory goes in
      // "<collection>/<relative dir>" so the local layout survives as collection names)
      const fileDataList = await prepareFileData(fileInfoList, collection, parseTags(options.tags), retentionDaysOf(options));

      // Step 5: Stage → upload → finish, one chunk of files at a time (#524)
      const concurrency = parseInt(options.concurrency, 10) || 3;
      const { results: uploadResults, elapsedTime } = await uploadInChunks(fileDataList, concurrency);

      // Step 7: Display results
      if (machine) {
        const rows = uploadResults.map((r) => ({
          fileName: r.fileName,
          status: r.status,
          assetId: r.assetId === "N/A" ? null : r.assetId,
          collection: r.collection,
          size: r.rawSize,
          ...(r.error && { error: r.error })
        }));
        displayUploadSummary(uploadResults, elapsedTime, collection, skippedFiles);
        console.log = log;
        formatOutput(rows, options.output);
      } else {
        console.log(chalk.green.bold(`\n${"=".repeat(80)}`));
        console.log(chalk.green.bold(`  Upload Results`));
        console.log(chalk.green.bold(`${"=".repeat(80)}\n`));

        formatOutput(uploadResults, "table", {
          columns: ["fileName", "fileSize", "status", "uploadTime", "finishTime", "totalTime", "assetId", "collection"]
        });

        displayUploadSummary(uploadResults, elapsedTime, collection, skippedFiles);
      }
      if (uploadResults.some((r) => r.status === "Failed")) process.exitCode = 1;
    } catch (error) {
      console.log = log;
      handleCommandError(error, "upload asset");
    } finally {
      console.log = log;
    }
  });

// ============================================================================
// From-URL Command
// ============================================================================

assetCommand
  .command("from-url")
  .description("Create assets from public image URLs, fetched by the service (batches of 20; any failed URL exits 1)")
  .argument("<urls...>", "Public http(s) image URLs")
  .option("-c, --collection <name>", "Collection to put every new asset in")
  .option("--tags <list>", "Comma-separated tags for every new asset")
  .option("--retention-days <n>", "Keep the new assets this many days instead of your plan's retention — shorter only")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (urls, options) => {
    try {
      // Each URL succeeds or fails on its own (a refused host, a redirect, > 25 MB): the service says
      // why per URL, with `code` and `retryable`, and this prints it as given rather than re-checking. The SDK sends
      // them twenty to a request, the most the service takes (#525), and nothing here waits for the ingest.
      const tags = parseTags(options.tags);
      const results = (
        await client().assets.fromUrl(urls, {
          collection: options.collection || undefined,
          tags: tags?.length ? tags : undefined,
          retentionDays: retentionDaysOf(options),
          wait: false
        })
      ).map((r) => r.asset ?? r);
      if (options.output === "table") {
        const rows = results.map((r) => ({
          url: r.url,
          id: r.id || null,
          status: r.status || null,
          error: r.error ? `${r.error.code}: ${r.error.message}${r.error.retryable ? " (retryable)" : ""}` : null
        }));
        formatOutput(rows, "table", { columns: ["url", "id", "status", "error"] });
      } else {
        formatOutput(results, options.output);
      }
      if (results.some((r) => r.error)) process.exitCode = 1;
    } catch (error) {
      handleCommandError(error, "create assets from URLs");
    }
  });

// ============================================================================
// List Command
// ============================================================================

assetCommand
  .command("list")
  .description("List and search assets — every filter is optional and they compose")
  .option("-v, --view <view>", "Which slice to read (all|published)", "all")
  .option("-c, --collection <name>", "Only assets in this collection (exact match)")
  .option("--tag <tag>", "One of your tags, matched exactly")
  .option("--mime <type>", "Exact MIME type, e.g. image/jpeg")
  .option("--source <op>", "Originating operation (upload|process|ai-generate|ai-edit|render)")
  .option("--min-width <px>", "Pixel width lower bound")
  .option("--max-width <px>", "Pixel width upper bound")
  .option("--min-height <px>", "Pixel height lower bound")
  .option("--max-height <px>", "Pixel height upper bound")
  .option("--taken-from <when>", "Capture date lower bound (EXIF DateTimeOriginal): 2026-09-14 or epoch millis")
  .option("--taken-to <when>", "Capture date upper bound; a bare date covers the whole of that day")
  .option("--created-from <when>", "Only assets made or ingested since: 2026-09-14 or epoch millis")
  .option("--created-to <when>", "Only assets made or ingested before; a bare date covers the whole of that day")
  .option("--status <state>", "Ingest state (PROCESSING|DONE|FAILED) — FAILED is an upload whose ingest never finished")
  .option("--has-collection <bool>", "true for filed assets, false for everything you have not filed; not with --collection")
  .option("--job-id <id>", "Everything one run produced (an upload has no job and never matches)")
  .option("--op <op>", "Only what this op produced, as `imagestep models` / GET /api/v1/ops names it")
  .option("-q, --query <text>", "Free text over the name and camera make/model")
  .option("-p, --page <page>", "Page number (0-based)", "0")
  .option("-s, --per-page <perPage>", "Page size (max 100; out of range is clamped)", "100")
  .option("-a, --all", "Every match, walking the pages for you — not with --page")
  .option("--cursor <cursor>", "Start after a page: the cursor it printed (More: --cursor …) — not with --page")
  .option("-o, --output <format>", "Output format (json|yaml|table); json/yaml print only the assets on stdout", "table")
  .action(async (options, command) => {
    try {
      checkPagingOptions(options, command);
      const params = { view: options.view.toUpperCase(), perPage: options.perPage };
      // Only the filters the caller actually named: an empty string is a filter that matches
      // nothing, not "no filter", so a blank option must never reach the query string.
      const optional = {
        collection: options.collection,
        tag: options.tag,
        mime: options.mime,
        source: options.source,
        minWidth: options.minWidth,
        maxWidth: options.maxWidth,
        minHeight: options.minHeight,
        maxHeight: options.maxHeight,
        takenFrom: options.takenFrom,
        takenTo: options.takenTo,
        createdFrom: options.createdFrom,
        createdTo: options.createdTo,
        status: options.status,
        hasCollection: options.hasCollection,
        jobId: options.jobId,
        op: options.op,
        q: options.query
      };
      for (const [key, value] of Object.entries(optional)) {
        if (value !== undefined && value !== "") params[key] = value;
      }

      logger.info(`Fetching assets (view: ${options.view})...`);

      const api = client();
      const { rows: assetItems, meta } = await readListing(
        { list: (p) => api.assets.list(p), iterate: (p) => api.assets.iterate(p) },
        params,
        options
      );

      // The count is commentary, so it goes to stderr: with -o json the stdout is the array and nothing
      // else, which is what makes `asset list -o json | jq` work (the docs' examples pipe it).
      // A page read by --cursor counts nothing, so there is no total to print then (imagestep#493).
      const counted = meta.total === undefined ? "" : `${meta.total} total, `;
      console.error(chalk.green(`\nAssets (${counted}showing ${assetItems.length}):\n`));

      if (options.output === "table") {
        // The collection is printed as stored. There is no folder tree to resolve it against —
        // a collection is an opaque string a caller attaches, and none means "in no collection", not "root".
        const transformedItems = assetItems.map((asset) => ({
          assetId: asset.id,
          name: asset.name,
          // A list row carries the measured facts flat (imagestep#339).
          mimeType: asset.mimeType || "N/A",
          dimension: asset.width && asset.height ? `${asset.width}x${asset.height}` : "N/A",
          fileSize: asset.size ? formatBytes(asset.size) : "N/A",
          source: asset.source || "N/A",
          collection: asset.collection || "-",
          tags: asset.tags?.length ? asset.tags.join(", ") : "-",
          status: asset.status,
          published: asset.published,
          createdAt: asset.createdAt
        }));

        formatOutput(transformedItems, options.output, {
          columns: [
            "assetId",
            "name",
            "mimeType",
            "dimension",
            "fileSize",
            "source",
            "collection",
            "tags",
            "status",
            "published",
            "createdAt"
          ]
        });
      } else {
        // The assets themselves, not the response envelope: `.[]` is the shape a pipe expects.
        formatOutput(assetItems, options.output);
      }
      printContinuation(meta, options);
    } catch (error) {
      handleCommandError(error, "fetch assets");
    }
  });

// ============================================================================
// Collections Commands (list · rename)
// ============================================================================

assetCommand
  .command("collections")
  .description("List your collections, most recently added to first, with how many assets each holds")
  .option("-q, --query <text>", "Only names containing this text (case-insensitive)")
  .option("-p, --page <page>", "Page number (0-based)", "0")
  .option("-s, --per-page <perPage>", "Page size (max 100; out of range is clamped)", "100")
  .option("-a, --all", "Every collection, walking the pages for you — not with --page")
  .option("--cursor <cursor>", "Start after a page: the cursor it printed (More: --cursor …) — not with --page")
  .option("-o, --output <format>", "Output format (json|yaml|table); json/yaml print only the collections on stdout", "table")
  .action(async (options, command) => {
    try {
      checkPagingOptions(options, command);
      const api = client();
      const { rows: items, meta } = await readListing(
        { list: (p) => api.assets.collections(p), iterate: (p) => api.assets.iterateCollections(p) },
        { perPage: options.perPage, q: options.query || undefined },
        options
      );
      const counted = meta.total === undefined ? "" : `${meta.total} total, `;
      console.error(chalk.green(`\nCollections (${counted}showing ${items.length}):\n`));
      if (options.output === "table") {
        const rows = items.map((c) => ({
          collection: c.collection,
          assets: c.count,
          lastAdded: c.lastCreatedAt ? new Date(c.lastCreatedAt).toISOString() : "-"
        }));
        formatOutput(rows, "table", { columns: ["collection", "assets", "lastAdded"] });
      } else {
        formatOutput(items, options.output);
      }
      printContinuation(meta, options);
    } catch (error) {
      handleCommandError(error, "list collections");
    }
  });

assetCommand
  .command("rename-collection")
  .description('Move every asset in one collection to another name (a rename or a merge; "" takes them out of any collection)')
  .argument("<from>", "The collection as it is named now")
  .argument("<to>", 'Its new name, or "" to take the assets out')
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (from, to, options) => {
    try {
      const result = (await client().assets.renameCollection(from, to)) || {};
      const where = result.to ? `'${result.to}'` : "no collection";
      console.error(chalk.green(`\n${result.updated ?? 0} asset(s) moved from '${result.from ?? from}' to ${where}\n`));
      formatOutput(result, options.output);
    } catch (error) {
      handleCommandError(error, "rename the collection");
    }
  });

// ============================================================================
// Get Command
// ============================================================================

assetCommand
  .command("get")
  .description("Get asset file details by ID")
  .argument("<asset-id>", "Asset ID")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (assetId, options) => {
    try {
      logger.info(`Fetching asset ${assetId}...`);

      const asset = await client().assets.get(assetId);

      console.error(chalk.green("\nAsset details:\n"));
      formatOutput(asset, options.output);
    } catch (error) {
      handleCommandError(error, "fetch asset");
    }
  });

// ============================================================================
// Download Command
// ============================================================================

assetCommand
  .command("download")
  .description("Download an asset's private bytes (follows the signed redirect; the API key never reaches storage)")
  .argument("<asset-id>", "Asset ID")
  .option("--variant <variant>", "readable | original | preview", "readable")
  .option("-f, --file <path>", "Where to write it (default: the asset id plus the type's extension, here)")
  .action(async (assetId, options) => {
    try {
      const { target, bytes } = await downloadAsset(assetId, { variant: options.variant, file: options.file });
      console.log(chalk.green(`\nSaved ${formatBytes(bytes)} to ${target}\n`));
    } catch (error) {
      handleCommandError(error, "download asset");
    }
  });

// ============================================================================
// Delete Command (permanent — there is no trash)
// ============================================================================

assetCommand
  .command("delete")
  .description("Delete assets permanently (irreversible: there is no trash and no restore)")
  .argument("<asset-ids...>", "Asset IDs to delete")
  .option("-y, --yes", YES_FLAG_DESCRIPTION)
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (assetIds, options) => {
    try {
      validateNonEmptyArray(assetIds, "asset ID");
      confirmDeletion(options.yes, "asset file", assetIds.length);

      logger.info(`Deleting ${assetIds.length} asset file(s)...`);

      const deleted = await client().assets.delete(assetIds);

      console.error(chalk.green(`\nDeleted ${assetIds.length} asset file(s)\n`));
      formatOutput(deleted, options.output);
    } catch (error) {
      handleCommandError(error, "delete asset");
    }
  });

// ============================================================================
// Set-Collection Command (put assets in a collection)
// ============================================================================

assetCommand
  .command("set-collection")
  .description("Put assets in a collection (one batch request)")
  .argument("<asset-ids...>", "Asset IDs")
  .requiredOption("-c, --collection <name>", "The collection (e.g. shoot-01); an empty string takes the assets out of theirs")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (assetIds, options) => {
    try {
      validateNonEmptyArray(assetIds, "asset ID");

      // Sent as given: "" is the service's "in no collection", and the service owns the rules for a name.
      const updated = (await client().assets.setCollection(assetIds, options.collection)) || [];

      const where = options.collection.trim() ? `now in '${options.collection.trim()}'` : "now in no collection";
      console.error(chalk.green(`\n${updated.length} asset(s) ${where}\n`));
      formatOutput(updated, options.output);
    } catch (error) {
      handleCommandError(error, "set the collection");
    }
  });

// ============================================================================
// Tag Command (replace the tags on assets)
// ============================================================================

assetCommand
  .command("tag")
  .description("Replace the tags on assets (one batch request; `asset list --tag` finds them again)")
  .argument("<asset-ids...>", "Asset IDs to tag")
  .requiredOption("--tags <list>", "Comma-separated tags that replace the current ones; an empty string clears them")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (assetIds, options) => {
    try {
      validateNonEmptyArray(assetIds, "asset ID");
      const tags = parseTags(options.tags);

      logger.info(`Tagging ${assetIds.length} asset(s) with [${tags.join(", ")}]...`);

      const updated = (await client().assets.tag(assetIds, tags)) || [];

      console.error(chalk.green(`\nTagged ${updated.length} asset(s)${tags.length ? `: ${tags.join(", ")}` : " (tags cleared)"}\n`));
      formatOutput(updated, options.output);
    } catch (error) {
      handleCommandError(error, "tag assets");
    }
  });

// ============================================================================
// Publish Command (publish/unpublish)
// ============================================================================

assetCommand
  .command("publish")
  .description("Publish assets (use --off to unpublish)")
  .argument("<asset-ids...>", "Asset IDs to update")
  .option("--off", "Unpublish")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (assetIds, options) => {
    try {
      validateNonEmptyArray(assetIds, "asset ID");
      const published = !options.off;

      logger.info(`${published ? "Publishing" : "Unpublishing"} ${assetIds.length} asset file(s)...`);

      const updated = (await client().assets.publish(assetIds, published)) || [];

      console.error(chalk.green(`\n${published ? "Published" : "Unpublished"} ${updated.length} asset file(s)\n`));
      formatOutput(updated, options.output);
    } catch (error) {
      handleCommandError(error, "update publish status");
    }
  });

export default assetCommand;
