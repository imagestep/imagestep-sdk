import chalk from "chalk";
import { Command } from "commander";
import { handleCommandError } from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { client } from "../utils/service.js";

const GROUP_BY = ["op", "key", "day"];

/**
 * `imagestep usage` — the budget face (#269): what this account's keys spent (`GET /api/v1/usage`,
 * contract §11), grouped by op, by key or by day. The window and its limits are the service's; the
 * command only passes them through.
 */
const usageCommand = new Command("usage")
  .description("What your keys spent: credits, jobs, items and sync calls, grouped by op, key or day")
  .option("--from <date>", "Window start, inclusive: YYYY-MM-DD or an ISO-8601 instant (default: 30 days ago)")
  .option("--to <date>", "Window end, exclusive: same formats (default: now)")
  .option("-g, --group-by <dimension>", `Group by ${GROUP_BY.join("|")}`, "op")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options) => {
    try {
      if (!GROUP_BY.includes(options.groupBy)) {
        throw new Error(`Invalid --group-by: ${options.groupBy}. Supported: ${GROUP_BY.join(", ")}`);
      }
      const usage = await client().usage.get({ groupBy: options.groupBy, from: options.from, to: options.to });
      if (options.output !== "table") {
        formatOutput(usage, options.output);
        return;
      }
      // Commentary to stderr, so `usage -o json | jq` reads the document and nothing else.
      console.error(chalk.green(`\nUsage ${usage.from} → ${usage.to}, by ${usage.groupBy}:\n`));
      function row(label, bucket) {
        return { [usage.groupBy]: label, credits: bucket.credits, jobs: bucket.jobs, items: bucket.items, sync: bucket.sync };
      }
      // A bucket's `key` is the op name, the API key id (`console` for the web app) or the UTC date.
      const rows = (usage.groups || []).map((group) => row(group.key ?? "-", group));
      rows.push(row(chalk.bold("TOTAL"), usage.total));
      formatOutput(rows, "table", { columns: [usage.groupBy, "credits", "jobs", "items", "sync"] });
    } catch (error) {
      handleCommandError(error, "read usage");
    }
  });

export default usageCommand;
