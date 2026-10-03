import chalk from "chalk";
import Table from "cli-table3";
import { Command } from "commander";
import { JobFailedError } from "imagestep";
import { EXIT, handleCommandError, parseJsonInput, readFileContent, retentionDaysOf } from "../utils/command-helpers.js";
import { formatDate, formatOutput, formatTime } from "../utils/formatter.js";
import { validateSteps } from "./preset.js";
import { logger } from "../utils/logger.js";
import { downloadAsset } from "../utils/download.js";
import { executeConcurrently } from "../utils/file-utils.js";
import { client } from "../utils/service.js";
import { checkPagingOptions, printContinuation, readListing } from "../utils/paging.js";

const jobsCommand = new Command("jobs").description("Submit and manage async AI / processing jobs");

const VALID_TYPES = ["ai-generate", "ai-edit", "parse", "process", "render", "chain"];
const VALID_STATUSES = ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED", "CANCELLING"];

const JOB_STATUS_COLOR = {
  COMPLETED: chalk.green,
  PROCESSING: chalk.cyan,
  PENDING: chalk.gray,
  CANCELLING: chalk.yellow,
  FAILED: chalk.red,
  CANCELLED: chalk.yellow,
  SKIPPED: chalk.gray
};

function colorizeStatus(status) {
  const fn = JOB_STATUS_COLOR[status] || chalk.white;
  return fn.bold(status);
}

function formatTimeAgo(ts) {
  if (!ts) return "";
  const then = typeof ts === "number" ? ts * 1000 : new Date(ts).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return "in the future";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function truncateId(id, len = 10) {
  if (!id) return null;
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

function progressBar(statusCounts, total, width = 50) {
  if (!total) return chalk.gray("░".repeat(width));
  const segs = [
    { key: "COMPLETED", color: chalk.green },
    { key: "PROCESSING", color: chalk.yellow },
    { key: "FAILED", color: chalk.red },
    { key: "CANCELLED", color: chalk.cyan }
  ];
  const items = segs.map((s) => ({ ...s, count: statusCounts[s.key] || 0, w: 0 }));
  let assigned = 0;
  for (const item of items) {
    if (item.count === 0) continue;
    item.w = Math.max(1, Math.floor((item.count / total) * width));
    assigned += item.w;
  }
  while (assigned > width) {
    const largest = items.reduce((m, i) => (i.w > m.w ? i : m), { w: 0 });
    if (largest.w <= 1) break;
    largest.w -= 1;
    assigned -= 1;
  }
  let bar = "";
  for (const item of items) {
    if (item.w > 0) bar += item.color("█".repeat(item.w));
  }
  if (assigned < width) bar += chalk.gray("░".repeat(width - assigned));
  return bar;
}

function statusLegend(statusCounts) {
  const segs = [
    { key: "COMPLETED", color: chalk.green, label: "Completed" },
    { key: "PROCESSING", color: chalk.yellow, label: "Processing" },
    { key: "FAILED", color: chalk.red, label: "Failed" },
    { key: "CANCELLED", color: chalk.cyan, label: "Cancelled" },
    { key: "PENDING", color: chalk.gray, label: "Pending" }
  ];
  const active = segs.filter((s) => (statusCounts[s.key] || 0) > 0);
  if (active.length <= 1) return null;
  return active.map((s) => `${s.color("●")} ${chalk.gray(`${statusCounts[s.key]} ${s.label}`)}`).join("   ");
}

/** `1234` → `1.2s`; anything under a second keeps its milliseconds. */
function formatDuration(ms) {
  if (ms === undefined || ms === null) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One row per item, with the columns this job actually has something to say in (contract §11).
 * Every column is conditional on purpose: a `process` job has no provider and no credits, and an
 * empty column is a question the reader has to answer before they can ignore it.
 */
function buildItemsTable(items, jobType) {
  const showSource = items.some((i) => i.sourceAssetId);
  const showResult = items.some((i) => i.resultAssetId) || jobType === "ai-generate";
  const showError = items.some((i) => i.error);
  const showStarted = items.some((i) => i.startedAt);
  const showProvider = items.some((i) => i.provider);
  const showDuration = items.some((i) => i.durationMs !== undefined && i.durationMs !== null);
  const showCredits = items.some((i) => i.credits);

  const head = [chalk.cyan.bold("#"), chalk.cyan.bold("Status")];
  if (showSource) head.push(chalk.cyan.bold("Source"));
  if (showResult) head.push(chalk.cyan.bold("Result"));
  if (showProvider) head.push(chalk.cyan.bold("Provider"));
  if (showStarted) head.push(chalk.cyan.bold("Started"));
  if (showDuration) head.push(chalk.cyan.bold("Took"));
  if (showCredits) head.push(chalk.cyan.bold("Credits"));
  if (showError) head.push(chalk.cyan.bold("Error"));

  const table = new Table({
    head,
    style: { head: [], border: ["grey"] },
    wrapOnWordBoundary: false
  });

  items.forEach((item, idx) => {
    const row = [chalk.gray(String(idx + 1).padStart(2, "0")), colorizeStatus(item.status)];
    if (showSource) {
      const id = truncateId(item.sourceAssetId);
      row.push(id || chalk.gray("-"));
    }
    if (showResult) {
      row.push(truncateId(item.resultAssetId) || chalk.gray("-"));
    }
    if (showProvider) {
      row.push(item.provider ? chalk.gray(item.provider) : chalk.gray("-"));
    }
    if (showStarted) {
      row.push(item.startedAt ? chalk.gray(formatTimeAgo(item.startedAt)) : chalk.gray("-"));
    }
    if (showDuration) {
      row.push(chalk.gray(formatDuration(item.durationMs) || "-"));
    }
    if (showCredits) {
      // 0 is a figure — an item that failed or ran no AI step was charged nothing — so it prints; "-" means not reported.
      row.push(item.credits != null ? String(item.credits) : chalk.gray("-"));
    }
    if (showError) {
      const err = item.error;
      row.push(err ? chalk.red(err.length > 48 ? `${err.slice(0, 48)}…` : err) : chalk.gray("-"));
    }
    table.push(row);
  });

  return table.toString();
}

function printMetricsRows(rows) {
  if (rows.length === 0) return;
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    console.log(`  ${chalk.gray(r.label.toUpperCase().padEnd(labelWidth + 2))}${r.value}`);
  }
}

function printJobDetails(job) {
  const totalItems = job.totalItems || 0;
  const completedCount = job.completedItems || 0;
  const failedCount = job.failedItems || 0;
  const cancelledCount = job.cancelledItems || 0;
  const settledCount = completedCount + failedCount + cancelledCount;
  const durationMs = job.completedAt && job.createdAt ? new Date(job.completedAt) - new Date(job.createdAt) : null;

  // The job document carries only the first page of items now (imagestep#440), so a big job's bar is drawn from the
  // counts the row itself states — what is left over is still on its way, which the bar shows as pending.
  const statusCounts = {};
  if (job.itemsTruncated) {
    if (completedCount) statusCounts.COMPLETED = completedCount;
    if (failedCount) statusCounts.FAILED = failedCount;
    if (cancelledCount) statusCounts.CANCELLED = cancelledCount;
    if (totalItems - settledCount > 0) statusCounts.PENDING = totalItems - settledCount;
  } else if (job.items) {
    for (const item of job.items) {
      statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
    }
  }

  // ── Header ──
  console.log();
  console.log(`  ${chalk.bold(`Job ${job.id}`)}   ${colorizeStatus(job.status)}`);
  if (job.attemptNumber && job.attemptNumber > 1) {
    const parent = job.parentJobId ? chalk.gray(`  parent ${truncateId(job.parentJobId)}`) : "";
    console.log(`  ${chalk.gray(`Attempt #${job.attemptNumber}`)}${parent}`);
  }

  // ── Progress ──
  console.log();
  if (totalItems > 0) {
    const pct = Math.round((settledCount / totalItems) * 100);
    const right =
      durationMs !== null
        ? chalk.gray(`Duration ${chalk.bold(formatTime(durationMs))}`)
        : chalk.gray(`Created ${formatTimeAgo(job.createdAt)}`);
    console.log(`  ${chalk.bold(`${settledCount}/${totalItems}`)} done   ${chalk.gray(`${pct}%`)}     ${right}`);
    console.log(`  ${progressBar(statusCounts, totalItems)}`);
    const legend = statusLegend(statusCounts);
    if (legend) console.log(`  ${legend}`);
  } else {
    const right =
      durationMs !== null
        ? chalk.gray(`Duration ${chalk.bold(formatTime(durationMs))}`)
        : chalk.gray(`Created ${formatTimeAgo(job.createdAt)}`);
    console.log(`  ${chalk.gray("No items")}     ${right}`);
  }

  // ── Metrics ──
  console.log();
  const metrics = [{ label: "Type", value: chalk.bold(job.type) }];
  if (job.model) {
    metrics.push({ label: "Model", value: chalk.bold(job.model) });
  }
  if (job.op) {
    metrics.push({ label: "Op", value: chalk.bold(job.op) });
  }
  if (job.presetName || job.presetId) {
    const name = job.presetName || "Ad-hoc";
    const id = job.presetId && job.presetId !== job.presetName ? chalk.gray(` (${job.presetId})`) : "";
    // The version matters as much as the name: a preset edited after this job ran is a different
    // preset, and this is the one that actually produced these images (contract §11).
    const version = job.presetVersion ? chalk.gray(` v${job.presetVersion}`) : "";
    metrics.push({ label: "Preset", value: `${chalk.bold(name)}${version}${id}` });
  }
  if (job.templateId) {
    // A render names a template, in its own fields (#377) — the same name / version / id line a preset gets.
    const version = job.templateVersion ? chalk.gray(` v${job.templateVersion}`) : "";
    const id = job.templateName ? chalk.gray(` (${job.templateId})`) : "";
    metrics.push({ label: "Template", value: `${chalk.bold(job.templateName || job.templateId)}${version}${id}` });
  }
  if (job.actualCredits !== undefined && job.actualCredits !== null && job.type !== "process" && job.type !== "parse") {
    metrics.push({ label: "Credits", value: chalk.bold(String(job.actualCredits)) });
  }
  if (job.collection) {
    metrics.push({ label: "Collection", value: chalk.gray(job.collection) });
  }
  printMetricsRows(metrics);

  // ── Timeline ──
  const timeline = [];
  if (job.createdAt) timeline.push({ label: "Created", ts: job.createdAt, color: chalk.cyan });
  if (job.submittedAt && job.submittedAt !== job.createdAt) {
    timeline.push({ label: "Submitted", ts: job.submittedAt, color: chalk.cyan });
  }
  if (job.completedAt) {
    timeline.push({
      label: "Completed",
      ts: job.completedAt,
      color: job.status === "FAILED" ? chalk.red : chalk.green
    });
  }
  if (job.expiresAt) {
    // How long this record itself stays readable (imagestep#124) — the same window as the assets it
    // produced, so "the images are gone but the receipt is here" never has to be explained.
    timeline.push({ label: "Expires", ts: job.expiresAt, color: chalk.gray });
  }
  if (timeline.length > 0) {
    console.log();
    console.log(chalk.gray("  TIMELINE"));
    for (const step of timeline) {
      const dot = step.color("●");
      const label = chalk.gray(step.label.padEnd(10));
      const time = formatDate(step.ts);
      const ago = chalk.gray(`(${formatTimeAgo(step.ts)})`);
      console.log(`  ${dot} ${label} ${time}  ${ago}`);
    }
  }

  // ── Prompt ──
  if (job.prompt) {
    console.log();
    console.log(chalk.gray("  PROMPT"));
    const lines = job.prompt.split("\n");
    for (const line of lines) {
      console.log(`  ${chalk.cyan("┃")} ${line}`);
    }
  }

  // ── Parameters ──
  const params = job.parameters ? Object.fromEntries(Object.entries(job.parameters).filter(([k]) => k !== "schema")) : null;
  if (params && Object.keys(params).length > 0) {
    console.log();
    console.log(chalk.gray("  PARAMETERS"));
    const labelWidth = Math.max(...Object.keys(params).map((k) => k.length));
    for (const [k, v] of Object.entries(params)) {
      const value = typeof v === "object" ? JSON.stringify(v) : String(v);
      console.log(`  ${chalk.gray(k.padEnd(labelWidth + 2))}${chalk.bold(value)}`);
    }
  }

  // ── Response Schema ──
  if (job.parameters?.schema) {
    console.log();
    console.log(chalk.gray("  RESPONSE SCHEMA"));
    const schemaJson = JSON.stringify(job.parameters.schema, null, 2)
      .split("\n")
      .map((l) => `  ${chalk.gray(l)}`)
      .join("\n");
    console.log(schemaJson);
  }

  // ── Items ──
  if (job.items && job.items.length > 0) {
    console.log();
    console.log(chalk.gray(`  ITEMS (${job.items.length})`));
    const tableStr = buildItemsTable(job.items, job.type)
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n");
    console.log(tableStr);
  }

  // ── Error ──
  if (job.errorMessage) {
    console.log();
    const codeSuffix = job.errorCode ? chalk.gray(`  ${job.errorCode}`) : "";
    console.log(`  ${chalk.red.bold("✗ ERROR")}${codeSuffix}`);
    console.log(`  ${chalk.red(job.errorMessage)}`);
  }
  console.log();
}

const DEFAULT_WAIT_SECONDS = 600;

/** One line on stderr — overwritten in place at a terminal, one line per change otherwise. */
function progressReporter() {
  let last = "";
  return (job) => {
    const line = `${job.id}  ${job.status}  ${job.settledItems || 0}/${job.totalItems || 0}`;
    if (line === last) return;
    last = line;
    if (process.stderr.isTTY) process.stderr.write(`\r${line}   `);
    else process.stderr.write(`${line}\n`);
  };
}

/** `--timeout`, validated: how long this invocation is prepared to wait, in seconds. */
function waitSeconds(options) {
  const seconds = options.timeout === undefined ? DEFAULT_WAIT_SECONDS : Number(options.timeout);
  if (!(seconds > 0)) throw new Error("--timeout must be a positive number of seconds");
  return seconds;
}

/**
 * The terminal's answer to "tell me when it is done" (#265) — a webhook is the automation's answer, and this is not a
 * second event mechanism. The waiting is the SDK's `jobs.wait` (the service holds each read open, #355; a read turned
 * away with `rate_limited` is asked again after `Retry-After` until the deadline, #529), told not to throw on FAILED or
 * CANCELLED: the one `JobFailedError` it can raise then is the deadline, with the job as it last stood.
 *
 * Prints the final job in the `-o` format and sets the exit code: 0 COMPLETED, 1 FAILED / CANCELLED, 2 still running.
 * @param {(wait: object) => Promise<object>} waitWith runs the wait with these SDK wait options
 */
async function waitAndReport(options, waitWith) {
  const seconds = waitSeconds(options);
  let job;
  let timedOut = false;
  try {
    job = await waitWith({ timeoutMs: seconds * 1000, onProgress: progressReporter(), throwOnFailure: false });
  } catch (error) {
    if (!(error instanceof JobFailedError)) throw error;
    ({ job } = error);
    timedOut = true;
  }
  if (process.stderr.isTTY) process.stderr.write("\n");
  if (timedOut) {
    console.error(
      chalk.yellow(`Still ${job.status} after ${seconds} s — nothing was cancelled; wait again with: imagestep jobs wait ${job.id}`)
    );
  }
  if (options.output === "pretty") printJobDetails(job);
  else formatOutput(job, options.output);
  if (timedOut) process.exitCode = EXIT.TIMEOUT;
  else process.exitCode = job.status === "COMPLETED" ? EXIT.OK : EXIT.LOCAL;
}

function addWaitOptions(command) {
  return command.option("--timeout <seconds>", `How long to wait before giving up (exit 2), default ${DEFAULT_WAIT_SECONDS}`);
}

function validateEnum(value, allowed, label) {
  if (value && !allowed.includes(value)) {
    throw new Error(`Invalid ${label}: ${value}. Supported: ${allowed.join(", ")}`);
  }
}

/**
 * Build JobRequest body from CLI options.
 */
export function buildJobRequest(options) {
  const body = {};

  // `op` is the catalogue vocabulary (GET /api/v1/ops) and the service derives the job type from it,
  // so a type sent alongside would only be overwritten. A preset decides its own type as well, which is why
  // `--type` has no default here: without one the service picks ai-generate, or whatever the preset runs as.
  if (options.op) body.op = options.op;
  else if (options.type) body.type = options.type;
  if (options.assetIds) {
    body.assetIds = options.assetIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
  }
  if (options.count !== undefined) {
    const count = parseInt(options.count, 10);
    if (Number.isNaN(count) || count < 1) {
      throw new Error("count must be a positive integer");
    }
    body.count = count;
  }
  // `jobs estimate` only (imagestep#586): images not uploaded yet, priced by count. `submit` has no such flag — a submit
  // needs the images, and the service refuses the count without ?dryRun=true. The range is the service's to check.
  if (options.imageCount !== undefined) {
    const imageCount = Number(options.imageCount);
    if (!Number.isInteger(imageCount) || imageCount < 1) throw new Error("image-count must be a positive integer");
    body.imageCount = imageCount;
  }
  if (options.presetId) body.presetId = options.presetId;
  // Inline steps (imagestep#414): the array a preset would store, run once without saving one. The service refuses
  // anything sent beside it (an op, a preset, an override) by name; nothing to pre-check here but the shape.
  if (options.steps) {
    body.steps = parseJsonInput(options.steps, "steps");
    validateSteps(body.steps);
  }
  // …and the subjects a consistency preset stores, beside them (imagestep#466). The service checks them as a preset's
  // (your own DONE assets, a generate or edit step to read them) and refuses them without --steps.
  if (options.subjects) {
    body.subjects = parseJsonInput(options.subjects, "subjects");
    if (!Array.isArray(body.subjects)) throw new Error("subjects must be a JSON array of {name, referenceAssetIds, descriptor}");
  }
  if (options.model) body.model = options.model;
  if (options.prompt) body.prompt = readFileContent(options.prompt);
  if (options.params) body.parameters = parseJsonInput(options.params, "parameters");
  if (options.collection) body.collection = options.collection;
  if (options.retentionDays !== undefined) body.retentionDays = retentionDaysOf(options);
  if (options.preset) body.preset = parseJsonInput(options.preset, "preset");
  // Sent as given: the service checks unique names, ≤ 20 variants and ≤ 500 rows, and
  // answers 400 invalid_param naming the field — a second copy of those rules here would only drift.
  if (options.variants) body.variants = parseJsonInput(options.variants, "variants");
  if (options.templateId) body.templateId = options.templateId;
  if (options.items) body.items = parseJsonInput(options.items, "items");

  return body;
}

function addSubmitOptions(command) {
  return command
    .option("--op <op>", "Atomic op from GET /api/v1/ops (resize, remove_bg, generate, …); the job type follows from it")
    .option("--type <type>", `Job type when neither --op nor --preset-id decides it (${VALID_TYPES.join("|")}); default ai-generate`)
    .option("--asset-ids <ids>", "Comma-separated asset IDs")
    .option("--count <n>", "Number of images (text-to-image jobs)")
    .option("--preset-id <ref>", "A saved preset: slug, id, or slug@version to pin one version (it decides the job type)")
    .option(
      "--steps <json>",
      "An inline chain: the steps a preset would store, [{op, model?, prompt?, parameters?} | {operation, params}], run once without saving one (JSON string or file path)"
    )
    .option(
      "--subjects <json>",
      "With --steps: the subjects a preset stores, [{name, referenceAssetIds, descriptor}] — reference images and locked words for its generate / edit steps (JSON string or file path)"
    )
    .option("-m, --model <model>", "AI model ID (overrides preset)")
    .option("-p, --prompt <prompt>", "Prompt text (string, or @path to file) — overrides preset")
    .option("--params <json>", "Model parameters (JSON string or file path)")
    .option("-c, --collection <name>", "Collection to put the output assets in (default: the input's)")
    .option(
      "--retention-days <n>",
      "Keep the outputs (and the job's record) this many days instead of your plan's retention — shorter only"
    )
    .option("--preset <json>", "Inline processing pipeline {name, pipeline} (JSON string or file path, process jobs only)")
    .option(
      "--variants <json>",
      "One output per entry: [{name, parameters}] merged over --params — a whole set of sizes in one job (≤ 20, deterministic ops; JSON string or file path)"
    )
    .option("--template-id <ref>", "render_template: the template id, or id@version to pin one")
    .option("--items <json>", "render_template: one object of template variables per image (≤ 500; JSON string or file path)");
}

// List jobs
jobsCommand
  .command("list")
  .description("List jobs")
  .option("-p, --page <n>", "Page number (0-indexed)", "0")
  .option("-s, --per-page <n>", "Items per page (max 100; out of range is clamped)", "100")
  .option("--status <status>", "Filter by status")
  .option("--type <type>", "Filter by job type")
  .option("--preset <ref>", "Only jobs that ran this preset: a slug or id for every version, or slug@version")
  .option("--op <op>", "Only jobs submitted as this op (remove_bg, upscale, …)")
  .option("--root-job-id <id>", "Every attempt of one logical job")
  .option("--created-from <when>", "Submitted at or after this (epoch millis, or an ISO-8601 date read as UTC)")
  .option("--created-to <when>", "Submitted at or before this; a bare date covers the whole of that day")
  .option("-a, --all", "Every match, walking the pages for you — not with --page")
  .option("--cursor <cursor>", "Start after a page: the cursor it printed (More: --cursor …) — not with --page")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options, command) => {
    try {
      checkPagingOptions(options, command);
      if (options.status) {
        validateEnum(options.status.toUpperCase(), VALID_STATUSES, "status");
      }
      validateEnum(options.type, VALID_TYPES, "type");

      logger.info("Fetching jobs...");

      const params = {
        perPage: options.perPage,
        status: options.status?.toUpperCase(),
        type: options.type,
        preset: options.preset,
        op: options.op,
        rootJobId: options.rootJobId,
        createdFrom: options.createdFrom,
        createdTo: options.createdTo
      };
      for (const key of Object.keys(params)) if (!params[key]) delete params[key];

      const api = client();
      const { rows: jobs, meta } = await readListing(
        { list: (p) => api.jobs.list(p), iterate: (p) => api.jobs.iterate(p) },
        params,
        options
      );

      const totalLabel = meta.total === undefined ? `${jobs.length}` : `${jobs.length} of ${meta.total}`;
      // The count is commentary, so it goes to stderr: with -o json the stdout is the array and nothing else,
      // which is what makes `jobs list -o json | jq` work. It used to be a console.log, i.e. inside the document.
      console.error(chalk.green(`\nJobs (${totalLabel}):\n`));

      if (options.output === "table") {
        // Only surface the attempt column when at least one row has been resumed,
        // so the common case (no resumes) stays as narrow as before.
        const anyResumed = jobs.some((j) => (j.attemptNumber || 1) > 1);
        const rows = jobs.map((job) => {
          const row = {
            id: job.id,
            type: job.type,
            status: job.status,
            presetName: job.presetName || "N/A",
            model: job.model || "N/A",
            items: `${job.settledItems || 0}/${job.totalItems || 0}`,
            credits: job.actualCredits !== undefined && job.actualCredits !== null ? job.actualCredits : "N/A",
            createdAt: job.createdAt
          };
          if (anyResumed) row.attempt = job.attemptNumber || 1;
          return row;
        });

        const columns = ["id", "type", "status", "presetName", "model", "items", "credits"];
        if (anyResumed) columns.push("attempt");
        columns.push("createdAt");
        formatOutput(rows, options.output, { columns });

        if (meta.total !== undefined) {
          console.log(
            chalk.gray(
              options.all
                ? `\nEvery page • ${meta.total} total`
                : `\nPage ${meta.page} of ${Math.ceil(meta.total / meta.perPage)} • ${meta.total} total`
            )
          );
        }
      } else {
        formatOutput(jobs, options.output);
      }
      printContinuation(meta, options);
    } catch (error) {
      handleCommandError(error, "list jobs");
    }
  });

// Get job by id
jobsCommand
  .command("get")
  .description("Get job details (including per-item results)")
  .argument("<id>", "Job ID")
  .option("-o, --output <format>", "Output format (pretty|json|yaml)", "pretty")
  .action(async (id, options) => {
    try {
      logger.info(`Fetching job ${id}...`);

      const job = await client().jobs.get(id);

      if (options.output === "pretty") {
        printJobDetails(job);
      } else {
        console.error(chalk.green("\nJob Details:\n"));
        formatOutput(job, options.output);
      }
      if (job.itemsTruncated) {
        console.error(
          chalk.gray(`\nItems: first ${job.items?.length ?? 0} of ${job.totalItems} — the rest: imagestep jobs items ${id} --all`)
        );
      }
    } catch (error) {
      handleCommandError(error, "fetch job");
    }
  });

// Estimate job cost
addSubmitOptions(jobsCommand.command("estimate").description("Estimate credit cost for a job without submitting"))
  .option(
    "--image-count <n>",
    "Price this many images you have not uploaded yet, as that many more --asset-ids (the price never depends on the pixels)"
  )
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (options) => {
    try {
      validateEnum(options.type, VALID_TYPES, "type");

      const body = buildJobRequest(options);

      logger.info("Estimating job cost...");

      // The dry run is the submit endpoint itself (contract §5): same body, same validation, nothing
      // created. There has never been a /jobs/estimate route — this command 404'd until #210.
      const estimate = await client().jobs.estimate(body);

      console.error(chalk.green("\nJob Estimate:\n"));
      formatOutput(estimate, options.output);
    } catch (error) {
      handleCommandError(error, "estimate job");
    }
  });

// Submit job
addWaitOptions(
  addSubmitOptions(
    jobsCommand.command("submit").description("Submit a new async job (ai-generate | ai-edit | parse | process | render | chain)")
  )
)
  .option("--wait", "Wait for the job to finish: exit 0 COMPLETED, 1 FAILED / CANCELLED, 2 timeout")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (options) => {
    try {
      validateEnum(options.type, VALID_TYPES, "type");

      const body = buildJobRequest(options);
      logger.info(`Submitting ${body.op || body.type || "ai-generate"} job...`);

      // 429 / 503 are retried like the image group retries them (#98), with one Idempotency-Key across
      // the attempts: a submit that landed before the error replays instead of creating a second job.
      // `--wait` starts on the submit itself (#355): a job of one item that settles inside the window comes back
      // finished, in one round trip; the service ignores it on a batch, and whatever is left is the SDK's wait.
      if (options.wait) {
        await waitAndReport(options, (wait) => client().jobs.submit(body, { wait }));
        return;
      }
      const job = await client().jobs.submit(body);

      console.error(chalk.green("\nJob submitted successfully!\n"));
      formatOutput(job, options.output);
    } catch (error) {
      handleCommandError(error, "submit job");
    }
  });

// Wait for a job
addWaitOptions(jobsCommand.command("wait").description("Wait for a job to finish: exit 0 COMPLETED, 1 FAILED / CANCELLED, 2 timeout"))
  .argument("<id>", "Job ID")
  .option("-o, --output <format>", "Output format for the final job (pretty|json|yaml)", "pretty")
  .action(async (id, options) => {
    try {
      await waitAndReport(options, (wait) => client().jobs.wait(id, wait));
    } catch (error) {
      handleCommandError(error, "wait for job");
    }
  });

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// A job's items, a page at a time
jobsCommand
  .command("items")
  .description("List a job's items — what each one did, and the index the rest of the API names it by")
  .argument("<id>", "Job ID")
  .option("-p, --page <n>", "Page number (0-indexed)", "0")
  .option("-s, --per-page <n>", "Items per page (max 100; out of range is clamped)", "100")
  .option("--status <status>", "Only items in this status (PENDING · PROCESSING · COMPLETED · FAILED · CANCELLED)")
  .option("-a, --all", "Every item, walking the pages for you — not with --page")
  .option("--cursor <cursor>", "Start after a page: the cursor it printed (More: --cursor …) — not with --page")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (id, options, command) => {
    try {
      checkPagingOptions(options, command);
      if (options.status) validateEnum(options.status.toUpperCase(), VALID_STATUSES, "status");

      const api = client();
      const { rows: items, meta } = await readListing(
        { list: (p) => api.jobs.items(id, p), iterate: (p) => api.jobs.iterateItems(id, p) },
        { perPage: options.perPage, status: options.status?.toUpperCase() },
        options
      );

      console.error(chalk.green(`\nItems (${items.length}${meta.total === undefined ? "" : ` of ${meta.total}`}):\n`));
      if (options.output === "table") {
        formatOutput(
          items.map((item) => ({
            index: item.index,
            status: item.status,
            sourceAssetId: item.sourceAssetId || "N/A",
            resultAssetId: item.resultAssetId || "N/A",
            credits: item.credits ?? "N/A",
            error: item.error ? clip(item.error, 40) : ""
          })),
          "table",
          { columns: ["index", "status", "sourceAssetId", "resultAssetId", "credits", "error"] }
        );
      } else {
        formatOutput(items, options.output);
      }
      printContinuation(meta, options);
    } catch (error) {
      handleCommandError(error, "list job items");
    }
  });

// Outputs of a job
jobsCommand
  .command("outputs")
  .description("List what a job produced, in item order: its assets (optionally downloaded) and analyze answers")
  .argument("<id>", "Job ID")
  .option("--download <dir>", "Save each result's bytes into this directory (the API key never reaches storage)")
  .option("--concurrency <n>", "How many downloads at once, with --download", "4")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (id, options) => {
    try {
      const api = client();
      const job = await api.jobs.get(id);
      // Items that produced something: an asset, or an analyze answer (imagestep#338), which is the item's own
      // `output` — analyze creates no asset. A failed item has neither.
      // Past the first page the job document does not carry them (imagestep#440) — walk the items endpoint, or the
      // outputs of a 500-item render would stop at 100.
      let all = job.items || [];
      if (job.itemsTruncated) {
        all = [];
        for await (const item of api.jobs.iterateItems(id)) all.push(item);
      }
      const produced = all
        .map((item, position) => ({ item, index: item.index ?? position }))
        .filter(({ item }) => item.resultAssetId || item.output);
      // One paged listing of the run, not one GET per item (imagestep#441) — the SDK's `jobs.outputs`: `?jobId=` is the
      // same set (#430) and a 500-item render costs five requests instead of five hundred, in a row. An output since
      // deleted is simply missing from it, where a per-id GET took the whole command down with a 404.
      const byId = new Map();
      if (produced.some(({ item }) => item.resultAssetId)) {
        for (const asset of await api.jobs.outputs(id)) byId.set(asset.id, asset);
      }
      const rows = [];
      for (const { item, index } of produced) {
        const row = { item: index + 1, ...(item.variant && { variant: item.variant }) };
        if (item.resultAssetId) {
          const asset = byId.get(item.resultAssetId);
          Object.assign(row, {
            assetId: item.resultAssetId,
            name: asset?.name ?? null,
            status: asset?.status ?? "GONE",
            dimension: asset?.width && asset?.height ? `${asset.width}x${asset.height}` : null,
            publicUrl: asset?.publicUrl || null
          });
        }
        if (item.output) Object.assign(row, { sourceAssetId: item.sourceAssetId, output: item.output });
        rows.push(row);
      }
      // `--concurrency` at a time (#527): one after another, a 10 000-output job was over an hour of downloads.
      if (options.download) {
        const wanted = rows.filter((row) => row.assetId && row.status !== "GONE");
        await executeConcurrently(
          wanted,
          async (row) => {
            try {
              row.file = (await downloadAsset(row.assetId, { dir: options.download })).target;
            } catch (error) {
              // One output that will not come down does not cost the rest; the exit code says something is missing.
              row.downloadError = error.message;
              process.exitCode = 1;
            }
          },
          Math.max(1, Number(options.concurrency) || 4)
        );
      }
      if (rows.length === 0) console.error(chalk.yellow(`Job ${id} (${job.status}) has no outputs`));
      if (options.output === "table") {
        const assets = rows.some((r) => r.assetId);
        const answers = rows.some((r) => r.output);
        const columns = [
          "item",
          ...(rows.some((r) => r.variant) ? ["variant"] : []),
          ...(assets ? ["assetId", "name", "status", "dimension", "publicUrl"] : []),
          ...(answers ? ["sourceAssetId", "output"] : [])
        ];
        if (options.download) columns.push("file");
        // The answer is JSON; a table cell gets it on one line, cut short — `-o json` has it whole.
        const shown = rows.map((r) => (r.output ? { ...r, output: clip(JSON.stringify(r.output), 80) } : r));
        if (rows.length) formatOutput(shown, "table", { columns });
      } else {
        formatOutput(rows, options.output);
      }
    } catch (error) {
      handleCommandError(error, "list job outputs");
    }
  });

// Resume job
jobsCommand
  .command("resume")
  .description("Resume incomplete items from a failed/cancelled job (creates a new attempt linked via rootJobId)")
  .argument("<id>", "Job ID to resume")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (id, options) => {
    try {
      logger.info(`Resuming job ${id}...`);

      const job = await client().jobs.resume(id);

      console.error(chalk.green(`\nJob resumed (attempt ${job.attemptNumber})!\n`));
      formatOutput(job, options.output);
    } catch (error) {
      handleCommandError(error, "resume job");
    }
  });

// Cancel job
jobsCommand
  .command("cancel")
  .description("Cancel a pending or running job")
  .argument("<id>", "Job ID to cancel")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (id, options) => {
    try {
      logger.info(`Cancelling job ${id}...`);

      const job = await client().jobs.cancel(id);

      console.error(chalk.green("\nJob cancelled!\n"));
      formatOutput(job, options.output);
    } catch (error) {
      handleCommandError(error, "cancel job");
    }
  });

export default jobsCommand;
