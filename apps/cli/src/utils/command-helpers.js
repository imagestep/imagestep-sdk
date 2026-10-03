import fs from "fs";
import path from "path";
import chalk from "chalk";
import { ImageStepError } from "imagestep";
import { getConfigFile } from "../config.js";
import { logger } from "./logger.js";
import { NetworkError } from "./service.js";

/**
 * Did the caller ask for JSON? Read from argv rather than threaded through every call site: the flag
 * is spelled the same on every command (`-o json`, `--output json`, `--output=json`), and an error
 * has to know the answer before commander has finished handing options to the action.
 */
function jsonOutputRequested(argv = process.argv.slice(2)) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === "-o" || arg === "--output") && argv[i + 1] === "json") return true;
    if (arg === "-ojson" || arg === "--output=json") return true;
  }
  return false;
}

/**
 * The exit codes a program branches on (imagestep#284), and the one place their numbers are spelled.
 * The CLI README §5, /docs/cli and SKILL.md restate this table for people and agents;
 * `test/exit-codes-copy.test.js` holds each of them to it (#306).
 *
 *   OK         done; for `jobs wait` / `--wait`, the job COMPLETED
 *   LOCAL      never reached the service (usage, a missing file, an unknown command) — or the job FAILED / was CANCELLED
 *   TIMEOUT    `jobs wait` / `--wait` ran out of time; the job is still running
 *   REFUSED    the service refused this request, `retryable: false` — resending the same body is pointless
 *   TRANSIENT  the service failed transiently, `retryable: true`, or never answered (a network failure or a timeout,
 *              once the retries are spent) — the same command may succeed
 *
 * TIMEOUT took 2 before the service codes existed, which is why they start at 3. REFUSED or TRANSIENT is the SDK's
 * `retryable`, which for an answer with no error envelope (a proxy's 502, a bare 429) is true for a 429 or a 5xx.
 */
const EXIT = Object.freeze({ OK: 0, LOCAL: 1, TIMEOUT: 2, REFUSED: 3, TRANSIENT: 4 });

/** The service's answer in `error`, if there was one: an `ImageStepError` with a status (0 = raised before a request). */
function answered(error) {
  return error instanceof ImageStepError && error.status > 0;
}

/** The exit code for a failed command: which of LOCAL / REFUSED / TRANSIENT the error is. */
function exitCodeFor(error) {
  // A request nothing answered was sent and may well get through next time (#566): it used to exit 1, as if the
  // command line were wrong, and an agent branching on the code never tried again.
  if (error instanceof NetworkError) return EXIT.TRANSIENT;
  if (!answered(error)) return EXIT.LOCAL;
  return error.retryable ? EXIT.TRANSIENT : EXIT.REFUSED;
}

/**
 * One exit code for a batch whose files fail on their own (#566): the lowest of the failures' codes. A rerun is the
 * answer only when every failure was transient, so 4 needs all of them to be 4; a refusal among them makes it 3, and a
 * failure that never reached the service 1.
 */
function batchExitCode(codes) {
  return codes.length ? Math.min(...codes) : EXIT.OK;
}

/**
 * Handle command errors consistently
 * @param {Error} error - The error object
 * @param {string} operation - Description of the operation that failed
 */
function handleCommandError(error, operation) {
  logger.error(`Failed to ${operation}`);
  const service = answered(error);
  const retryable = exitCodeFor(error) === EXIT.TRANSIENT;
  // A program that asked for JSON gets the contract's own shape (docs/api-contract.md §2) on
  // stdout, where its output goes, so one parser reads both the answer and the refusal. A local
  // failure has no code: `message` and `retryable: false` are all there is to say — and neither has an
  // answer that carried no error envelope (a proxy's 502), whose `status` and `retryable` say the rest,
  // nor a request nothing answered, which is `retryable: true` with no `status` (#566).
  if (jsonOutputRequested()) {
    const body = {
      code: (service && error.code) || null,
      message: error.message,
      retryable,
      param: (service && error.param) || null,
      requestId: (service && error.requestId) || null
    };
    if (service) body.status = error.status;
    if (service && error.details && typeof error.details === "object") body.details = error.details;
    console.log(JSON.stringify({ error: body }));
    process.exit(exitCodeFor(error));
  }
  // The service's answer (docs/api-contract.md §2) renders as a tighter bulleted form: status, code and
  // message, then the parameter to fix and whether trying again may help. Anything else is its message.
  if (service) {
    console.error(chalk.red(`Error: Cannot ${operation}`));
    console.error(chalk.red(`  - ${error.status}${error.code ? ` ${error.code}` : ""}: ${error.message}`));
    if (error.param) {
      console.error(chalk.red(`    parameter: ${error.param}`));
    }
    // Worth its own line: it is the difference between "fix your request" and "try again".
    if (error.retryable) {
      console.error(chalk.yellow("    this is a temporary failure — retrying may succeed"));
    }
    if (error.details && typeof error.details === "object") {
      for (const [k, v] of Object.entries(error.details)) {
        const display = Array.isArray(v) ? (v.length > 5 ? `${v.slice(0, 5).join(", ")}, …` : v.join(", ")) : v;
        console.error(chalk.red(`    ${k}: ${display}`));
      }
    }
    // A 404 nothing in the contract named is usually the wrong service, not a missing thing.
    if (error.status === 404 && !error.code) {
      console.error(
        chalk.yellow(`    Check that you are using the right environment (${error.requestUrl}); config file: ${getConfigFile()}`)
      );
    }
  } else {
    console.error(chalk.red(`Error: ${error.message}`));
    if (retryable) console.error(chalk.yellow("  this is a temporary failure — retrying may succeed"));
  }
  // Contract §11: the one handle that finds this failure in the service's logs. Last, so it is the
  // line a person copies into a bug report.
  if (service && error.requestId) {
    console.error(chalk.gray(`  request id: ${error.requestId}`));
  }
  process.exit(exitCodeFor(error));
}

/**
 * Parse JSON from a string or file path
 * @param {string} input - JSON string or file path
 * @param {string} label - Label for error messages (e.g., "pipeline", "config")
 * @returns {any} Parsed JSON data
 */
function parseJsonInput(input, label = "JSON") {
  // Check if input is a file path
  if (fs.existsSync(input)) {
    logger.info(`Reading ${label} from file: ${input}`);
    const fileContent = fs.readFileSync(input, "utf-8");
    return JSON.parse(fileContent);
  }

  // Parse as JSON string
  return JSON.parse(input);
}

/** What every destructive command says about `-y, --yes`: it is the confirmation, and there is no prompt. */
const YES_FLAG_DESCRIPTION = "Confirm the deletion; without it nothing is deleted and the command exits 1";

/**
 * Without `--yes`, say what would have been deleted and exit 1 — at a terminal too (#566). There is no prompt: a
 * program in a pseudo-terminal would sit on it, and doing nothing then exiting 0 told the caller the delete succeeded
 * (#272 fixed that for scripts; the terminal branch still did it).
 * @param {boolean} confirmed - Whether the caller passed --yes
 * @param {string} itemType - Type of item being deleted (e.g., "preset", "asset file")
 * @param {number} count - Number of items being deleted (optional, for batch operations)
 * @param {string} extraWarning - Additional warning message (optional)
 */
function confirmDeletion(confirmed, itemType, count = 1, extraWarning = null) {
  if (confirmed) return;
  const what = count > 1 ? `${count} ${itemType}s` : `the ${itemType}`;
  console.error(chalk.red(`Error: refusing to delete without --yes — nothing was deleted`));
  console.error(chalk.yellow(`This would permanently delete ${what}; it cannot be undone.`));
  if (extraWarning) console.error(chalk.yellow(extraWarning));
  console.error(chalk.cyan("Run the same command with -y / --yes to delete."));
  process.exit(EXIT.LOCAL);
}

/**
 * Read file content, supporting @ prefix for file paths
 * @param {string} content - Content string or file path (prefixed with @)
 * @returns {string} The content string or file contents
 */
function readFileContent(content) {
  if (!content.startsWith("@")) {
    return content;
  }

  const filePath = content.substring(1);
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    console.error(chalk.red(`Error: File not found: ${absolutePath}`));
    process.exit(1);
  }

  logger.info(`Reading content from file: ${absolutePath}`);
  return fs.readFileSync(absolutePath, "utf-8");
}

/**
 * Validate that an array has at least one item
 * @param {Array} items - Array to validate
 * @param {string} itemType - Type of items (e.g., "prompt ID", "preset ID")
 */
function validateNonEmptyArray(items, itemType) {
  if (!items || items.length === 0) {
    console.error(chalk.red(`Error: Provide at least one ${itemType}`));
    process.exit(1);
  }
}

/**
 * Parse comma-separated string into trimmed array
 * @param {string} input - Comma-separated string
 * @returns {Array<string>} Array of trimmed values
 */
function parseCommaSeparated(input) {
  return input.split(",").map((item) => item.trim());
}

export {
  handleCommandError,
  EXIT,
  exitCodeFor,
  batchExitCode,
  YES_FLAG_DESCRIPTION,
  jsonOutputRequested,
  parseJsonInput,
  confirmDeletion,
  readFileContent,
  validateNonEmptyArray,
  parseCommaSeparated
};

/**
 * `--retention-days` (imagestep#591): keep what a command makes this many days instead of the plan's retention — the
 * service keeps it shorter, never longer. Undefined when the flag is absent; a whole number of days, at least 1.
 */
export function retentionDaysOf(options) {
  if (options.retentionDays === undefined) return undefined;
  const days = Number(options.retentionDays);
  if (!Number.isInteger(days) || days < 1) throw new Error("--retention-days must be a whole number of days, at least 1");
  return days;
}
