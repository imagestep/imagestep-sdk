import chalk from "chalk";
import { createRequire } from "node:module";

// Required on first use (#526): cli-highlight is ~70 ms of every start, and only a terminal reading JSON / YAML needs it.
const require = createRequire(import.meta.url);
function highlight(text, options) {
  return require("cli-highlight").highlight(text, options);
}
import Table from "cli-table3";
import * as yaml from "js-yaml";

// ============================================================================
// Output Formatting (JSON, YAML, Table)
// ============================================================================

/**
 * Format and print output in different formats with syntax highlighting
 */
function formatOutput(data, format = "json", options = {}) {
  if (!data) {
    console.log(chalk.yellow("No data to display"));
    return;
  }

  switch (format.toLowerCase()) {
    case "json":
      printJson(data);
      break;
    case "yaml":
      printYaml(data);
      break;
    case "table":
      printTable(data, options);
      break;
    default:
      console.log(chalk.red(`Unknown format: ${format}`));
      printJson(data);
  }
}

// Highlight only on a terminal. A pipe is a program reading the document, and chalk's own detection
// is not enough: FORCE_COLOR=1 in the environment (CI runners, `pnpm test:full`) colours a pipe too,
// and `-o json | jq` then fails on the escape codes.
function printJson(data) {
  const jsonString = JSON.stringify(data, null, 2);
  console.log(process.stdout.isTTY ? highlight(jsonString, { language: "json", theme: "default" }) : jsonString);
}

function printYaml(data) {
  const yamlString = yaml.dump(data, { indent: 2 });
  console.log(process.stdout.isTTY ? highlight(yamlString, { language: "yaml", theme: "default" }) : yamlString);
}

function printTable(data, options = {}) {
  const items = Array.isArray(data) ? data : [data];

  if (items.length === 0) {
    console.log(chalk.yellow("No data to display"));
    return;
  }

  // Auto-detect columns from the first item if not provided
  const columns = options.columns || Object.keys(items[0]);

  const table = new Table({
    head: columns.map((col) => {
      const formatted = col.replace(/_/g, " ");
      return chalk.cyan.bold(formatted.charAt(0).toUpperCase() + formatted.slice(1));
    }),
    style: {
      head: [],
      border: ["grey"]
    },
    wrapOnWordBoundary: false
  });

  items.forEach((item) => {
    const row = columns.map((col) => {
      const value = item[col];
      if (value === null || value === undefined) {
        return chalk.gray("N/A");
      }
      if (typeof value === "object") {
        return JSON.stringify(value);
      }
      return String(value);
    });
    table.push(row);
  });

  console.log(table.toString());
}

// ============================================================================
// Data Formatting Utilities
// ============================================================================

/**
 * A date (Unix timestamp in seconds, or a date string) as "01/15/2025, 12:30:00", 24-hour; "N/A" when there is none.
 * @param {number|string} dateInput
 * @returns {string}
 */
function formatDate(dateInput) {
  if (!dateInput) return "N/A";
  const date = typeof dateInput === "number" ? new Date(dateInput * 1000) : new Date(dateInput);
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

/**
 * Format bytes to human-readable string
 * @param {number} bytes - Number of bytes
 * @returns {string} Formatted bytes string
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Format milliseconds to human-readable time string
 * @param {number} ms - Milliseconds
 * @returns {string} Formatted time string
 */
function formatTime(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(2)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }
}

export { formatOutput, formatDate, formatBytes, formatTime };
