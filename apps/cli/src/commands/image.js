import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import { EXIT, batchExitCode, exitCodeFor, handleCommandError, readFileContent } from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import { extensionForMime } from "../utils/asset-utils.js";
import { executeConcurrently, getDetectedMimeType } from "../utils/file-utils.js";
import { BINARY_TIMEOUT_MS, client } from "../utils/service.js";

/**
 * `imagestep image …` — local file in, local file out, nothing touched in the account.
 *
 * This is the first command group that leaves no trace: no upload, no asset, no job, no publish.
 * It is also what finally makes the PRD's `imagestep run --preset web-optimize ./dir` shape real —
 * before it, that line could only be faked with upload + job + download.
 *
 * The subcommands are BUILT FROM `GET /api/v1/ops`: an op appears here when the API says it has a
 * `syncEndpoint`. Adding a deterministic op to the API therefore adds a subcommand without this
 * file changing, and there is no second list to drift.
 */
const imageCommand = new Command("image").description("Transform local files without storing anything in your account");

/**
 * What the bytes are, told to the service in Content-Type — the header the sync lane reads the
 * format from (contract §9: `application/octet-stream` on a CR2 is `400 unsupported_format`).
 * The same detection `asset upload` uses (magic bytes, then the extension table for RAW and SVG),
 * because this group used to carry a second, smaller table and sent octet-stream for every RAW
 * and SVG that upload accepted (#259). A file nothing can name is refused here: the service would
 * refuse it anyway, and saying so before the upload is the clearer failure.
 */
async function contentTypeFor(file) {
  const mimeType = await getDetectedMimeType(file);
  if (!mimeType) throw new Error(`Cannot tell what image format ${file} is (unknown signature and extension)`);
  return mimeType;
}

/**
 * `-o/--output` is the format flag everywhere else in this CLI, and here it would also be the
 * obvious name for "the output file". Rather than overload it — the one thing a flag must never do
 * — the file is `--out` and `-o` keeps meaning what it means in every other command.
 */
function addCommonOptions(command) {
  return command
    .option("--out <file>", "Write the result here (single input only)")
    .option("-d, --dir <directory>", "Write results into this directory (one file per input)")
    .option("--concurrency <n>", "How many files to process at once", "4")
    .option("--no-retry", "Do not retry retryable failures (429 / 503)");
}

/**
 * One call to the synchronous lane (contract §9) — no Idempotency-Key, because it stores nothing. Retry is what this CLI
 * has that a bare curl does not, and it is the SDK's: a `retryable` answer is sent twice more, after its `Retry-After`
 * when it has one (else 0.5 s, then 1 s). `--no-retry` makes it one attempt.
 */
function syncCall(path, request, options) {
  return client().requestBinary(path, {
    ...request,
    timeoutMs: BINARY_TIMEOUT_MS,
    ...(options.retry === false && { retries: 0 })
  });
}

/**
 * Whether two paths are one file — by device and inode, not by spelling, so `IMG_1.JPG` and the `IMG_1.jpg` a JPEG
 * result is named are caught on a case-insensitive disk, and so is a symlink. A target that does not exist is not.
 */
async function sameFile(a, b) {
  try {
    const [x, y] = await Promise.all([stat(a), stat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

async function runOverFiles(files, options, transform) {
  if (!files.length) throw new Error("Give at least one file");
  if (options.out && files.length > 1) throw new Error("--out takes a single input; use --dir for several");
  if (options.out && options.dir) throw new Error("--out and --dir are mutually exclusive");
  if (options.dir) await mkdir(options.dir, { recursive: true });

  // Two failures end the run for the files not yet sent, because what fixes them is not in any one file. The balance is
  // the account's (#529, #592): past the plan's allowance a run is paid, and once one file hears `insufficient_credit`,
  // every file after it would upload itself to hear it too. And a result that would land on its own input (#565) says the
  // output needs a name or another directory; each file after it would be transformed, counted and thrown away the same
  // way. The fan-out is bounded: files are independent, but a laptop is not, and neither is the API's per-account cap.
  let stopped = null;
  const results = await executeConcurrently(
    files,
    async (file) => {
      if (stopped) return { file, ok: false, notSent: true, exit: stopped.exit };
      try {
        const { bytes, contentType } = await transform(file);
        const target =
          options.out || join(options.dir || ".", basename(file, extname(file)) + (extensionForMime(contentType) || extname(file)));
        // The input is written over only when `--out` names it (#565). Without it the result takes the input's name in
        // the current directory (or `-d`), so a same-type result run beside its input used to replace it, silently.
        if (!options.out && (await sameFile(target, file))) {
          stopped ??= { why: "input", exit: EXIT.LOCAL };
          return {
            file,
            ok: false,
            exit: EXIT.LOCAL,
            error: "not written: the result would replace the input — name the output with --out, or pick another -d"
          };
        }
        await writeFile(target, bytes);
        return { file, ok: true, target, bytes: bytes.length };
      } catch (error) {
        if (error.code === "insufficient_credit") stopped ??= { why: "credit", exit: exitCodeFor(error), error };
        // One bad file must not take the other nineteen with it.
        return {
          file,
          ok: false,
          exit: exitCodeFor(error),
          error: error.requestId ? `${error.message} (request id ${error.requestId})` : error.message
        };
      }
    },
    Number(options.concurrency) || 4
  );

  const failed = results.filter((r) => !r.ok);
  const notSent = results.filter((r) => r.notSent);
  for (const r of results) {
    if (r.ok) console.log(chalk.green(`${r.file} → ${r.target} (${r.bytes} bytes)`));
    else if (!r.notSent) logger.error(`${r.file}: ${r.error}`);
  }
  if (stopped?.why === "credit") {
    // The link the refusal carries (#589): where the balance is topped up, since this CLI cannot do it.
    const topUp = stopped.error.details?.topUpUrl;
    logger.error(
      `Not enough credit for the runs past the plan's allowance (insufficient_credit)${notSent.length ? ` — ${notSent.length} more file(s) were not sent` : ""}.${topUp ? ` Top up at ${topUp}, then run again.` : " Top up in the console, then run again."}`
    );
  } else if (notSent.length) {
    logger.error(`${notSent.length} more file(s) were not sent — name the output with --out, or pick another -d, and run again.`);
  }
  if (failed.length) {
    console.log(chalk.yellow(`\n${results.length - failed.length} succeeded, ${failed.length} failed`));
    // The code a single call would have exited with, for the batch (#566): 4 when running it again may be all it
    // takes, 3 when the service refused a file — it was 1 whatever the reason, and a script could not tell the two.
    process.exitCode = batchExitCode(failed.map((r) => r.exit));
  }
  return results;
}

/** How long the `image` group waits for the catalogue before it parses without it. */
const CATALOGUE_TIMEOUT_MS = 3000;

/** The fixed subcommands of the group: none of them is built from the catalogue, so none waits for it. */
const FIXED = new Set(["metadata", "run", "render"]);

/**
 * Whether this command line needs the op subcommands attached before it is parsed (#526): only the `image` group itself —
 * running an op (`image resize …`), or its help (`image`, `image --help` / `-h`, `image <op> --help`). Any other command's
 * help does not list ops; `--help` on it used to fetch the catalogue anyway, 30 s against an unreachable API.
 */
function needsCatalogue(argv) {
  return argv[0] === "image" && !FIXED.has(argv[1]);
}

async function syncCapableOps() {
  // A public read (#128 put `/api/v1/ops` on `public-paths`): the catalogue is how a caller discovers
  // what it can do, so it is fetched without a key and `image --help` is complete before `login`.
  // Running a subcommand still needs one — the call says "Not logged in" (#260).
  // 3 s and one attempt, not the 30 s every other call gets (#526): this runs before the command does, and the answer
  // is optional.
  const ops = await client({ auth: false, timeoutMs: CATALOGUE_TIMEOUT_MS, maxRetries: 0 }).ops.list();
  return syncCapable(ops || []);
}

function syncCapable(ops) {
  return ops.filter((op) => op.syncEndpoint === "POST /api/v1/images/transform");
}

/** Turn an op's parameter contract into real CLI options, so `--width 1200` exists because the API says so. */
function optionsFromContract(command, def) {
  for (const [name, spec] of Object.entries(def.params || {})) {
    if (name === "model" || name === "parameters") continue; // AI-only; no sync op takes them
    const flag = `--${name.replace(/_/g, "-")} <value>`;
    command.option(flag, spec.description || `${name} (${spec.type})`);
  }
  return command;
}

function parametersFrom(def, options) {
  const params = {};
  for (const name of Object.keys(def.params || {})) {
    const value = options[name];
    if (value !== undefined) params[name] = value;
  }
  return params;
}

async function transformOnce(file, query, options) {
  const body = await readFile(file);
  return syncCall(`/api/v1/images/transform?${new URLSearchParams(query)}`, { body, contentType: await contentTypeFor(file) }, options);
}

imageCommand
  .command("metadata <files...>")
  .description("Read EXIF, GPS, dimensions and SHA-1 — free, and nothing is stored")
  .option("-o, --output <format>", "json | yaml | table", "json")
  .option("--concurrency <n>", "How many files to read at once", "4")
  .option("--no-retry", "Do not retry retryable failures (429 / 503)")
  .action(async (files, options) => {
    try {
      // Like every other command in this group (#527): four at a time, retried like them, and one unreadable file
      // does not stop the rest — it used to be one after another and the first failure ended the run.
      const results = await executeConcurrently(
        files,
        async (file) => {
          try {
            const { json } = await syncCall(
              "/api/v1/images/metadata",
              { body: await readFile(file), contentType: await contentTypeFor(file), accept: "application/json" },
              options
            );
            return { file, json };
          } catch (error) {
            return {
              file,
              exit: exitCodeFor(error),
              error: error.requestId ? `${error.message} (request id ${error.requestId})` : error.message
            };
          }
        },
        Number(options.concurrency) || 4
      );
      for (const r of results) {
        if (r.error) {
          logger.error(`${r.file}: ${r.error}`);
          continue;
        }
        console.error(chalk.bold(r.file));
        formatOutput(r.json, options.output);
      }
      const failed = results.filter((r) => r.error);
      if (failed.length) process.exitCode = batchExitCode(failed.map((r) => r.exit));
    } catch (error) {
      handleCommandError(error, "read metadata");
    }
  });

imageCommand
  .command("run <files...>")
  .description("Run a saved deterministic preset over local files")
  .requiredOption("--preset <idOrSlug>", "A deterministic preset id or slug")
  .action(async (files, options) => {
    try {
      await runOverFiles(files, options, (file) => transformOnce(file, { preset: options.preset }, options));
    } catch (error) {
      handleCommandError(error, "run preset");
    }
  });
addCommonOptions(imageCommand.commands.find((c) => c.name() === "run"));

imageCommand
  .command("render")
  .description(
    "Render one row of data through a template into a PNG — nothing is stored (many rows: jobs submit --op render_template --items)"
  )
  .requiredOption("--template <id>", "Template id, or id@version to pin one")
  .requiredOption("--data <json>", "The template variables for this one image (JSON string, or @path to a JSON file)")
  .requiredOption("--out <file>", "Where to write the PNG")
  .option("--no-retry", "Do not retry retryable failures (429 / 503)")
  .action(async (options) => {
    try {
      const data = JSON.parse(readFileContent(options.data));
      if (Array.isArray(data)) {
        throw new Error(
          "--data is one row; for many rows use: imagestep jobs submit --op render_template --template-id <id> --items <file>"
        );
      }
      const { bytes } = await syncCall(
        "/api/v1/images/render",
        { body: JSON.stringify({ templateId: options.template, data }), contentType: "application/json", accept: "image/png" },
        options
      );
      await writeFile(options.out, bytes);
      console.log(chalk.green(`${options.template} → ${options.out} (${bytes.length} bytes)`));
    } catch (error) {
      handleCommandError(error, "render template");
    }
  });

/**
 * Attaches one subcommand per synchronous op in the catalogue. Called at startup, so `--help`
 * lists what this API version actually supports rather than what this release was built against.
 * `catalogue` is a `GET /api/v1/ops` answer already in hand — the console's docs tests pass the
 * committed `ops.json`, so `imagestep image resize …` on a docs page is parsed by this same code
 * (imagestep#389). An op already attached is left as it is.
 */
async function attachOpCommands(catalogue) {
  let ops;
  try {
    ops = catalogue ? syncCapable(catalogue) : await syncCapableOps();
  } catch {
    return; // the API is unreachable — `image metadata`/`run` still parse
  }
  for (const def of ops) {
    if (imageCommand.commands.some((c) => c.name() === def.op)) continue;
    const command = imageCommand
      .command(`${def.op} <files...>`)
      .description(def.description || `Run ${def.op}`)
      .action(async (files, options) => {
        try {
          await runOverFiles(files, options, (file) => transformOnce(file, { op: def.op, ...parametersFrom(def, options) }, options));
        } catch (error) {
          handleCommandError(error, def.op);
        }
      });
    optionsFromContract(command, def);
    addCommonOptions(command);
  }
}

export { imageCommand, attachOpCommands, needsCatalogue };
