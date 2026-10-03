import chalk from "chalk";

// The npm level order winston used, so a LOG_LEVEL written for it still means what it did.
const LEVELS = { error: 0, warn: 1, info: 2, http: 3, verbose: 4, debug: 5, silly: 6 };
const COLOR = { error: chalk.red, warn: chalk.yellow, info: chalk.blue, debug: chalk.magenta };

// `level` is read at every call: LOG_LEVEL, default info, and a caller may set it.
const logger = { level: process.env.LOG_LEVEL || "info" };

/**
 * One line per call — `<local time> <LEVEL>: <message>` — and every level on stderr: these are progress and
 * diagnostics, and stdout belongs to the command's result, so `-o json` stays parseable by the program that asked for
 * it (#272). An Error passed after the message adds its own message, as winston's `meta` did.
 */
function write(level, message, detail) {
  if (LEVELS[level] > (LEVELS[logger.level] ?? LEVELS.info)) return;
  const text = detail?.message ? `${message} ${detail.message}` : message;
  process.stderr.write(`${chalk.gray(new Date().toLocaleTimeString())} ${COLOR[level](level.toUpperCase().padEnd(5))}: ${text}\n`);
}

for (const level of Object.keys(COLOR)) {
  logger[level] = function log(message, detail) {
    write(level, message, detail);
  };
}

export { logger };
