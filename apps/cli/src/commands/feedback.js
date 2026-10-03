import chalk from "chalk";
import { Command } from "commander";
import { handleCommandError, parseJsonInput, readFileContent } from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { client } from "../utils/service.js";
import { checkPagingOptions, printContinuation, readListing } from "../utils/paging.js";

const KINDS = ["capability_gap", "bug", "other"];

/**
 * `imagestep feedback …` and `imagestep guidelines` — contract §10, the channel for reporting a gap
 * (#270). An agent the CLI stops ("there is no detect_faces op") reports it with the same key it is
 * already holding, instead of routing around it; `guidelines` is the operating contract itself, and
 * it is public, so it reads before a login.
 */
const feedbackCommand = new Command("feedback").description("Report a capability gap or a bug, and read back what you reported");

feedbackCommand
  .command("send")
  .description("Report a gap (POST /api/v1/feedback)")
  .requiredOption("--kind <kind>", `What this is: ${KINDS.join(" | ")}`)
  .requiredOption("-m, --message <text>", "What you were trying to do and what stopped you (text, or @path to read a file)")
  .option("--op <name>", "The op this is about, when it is about one")
  .option("--context <json>", "Anything structured worth keeping (JSON string or file path)")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (options) => {
    try {
      const body = { kind: options.kind, message: readFileContent(options.message) };
      if (options.op) body.op = options.op;
      if (options.context) body.context = parseJsonInput(options.context, "context");
      const saved = await client().agent.feedback(body);
      console.error(chalk.green("Thanks — logged."));
      formatOutput(saved, options.output);
    } catch (error) {
      handleCommandError(error, "send feedback");
    }
  });

feedbackCommand
  .command("list")
  .description("What this account has reported, newest first (GET /api/v1/feedback)")
  .option("-p, --page <n>", "Page number (0-indexed)", "0")
  .option("-s, --per-page <n>", "Items per page (max 100; out of range is clamped)", "100")
  .option("-a, --all", "Every report, walking the pages for you — not with --page")
  .option("--cursor <cursor>", "Start after a page: the cursor it printed (More: --cursor …) — not with --page")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options, command) => {
    try {
      checkPagingOptions(options, command);
      const api = client();
      const { rows: reports, meta } = await readListing(
        { list: (p) => api.agent.reports(p), iterate: (p) => api.agent.iterateReports(p) },
        { perPage: options.perPage },
        options
      );
      if (options.output !== "table") {
        formatOutput(reports, options.output);
        printContinuation(meta, options);
        return;
      }
      console.error(chalk.green(`\nFeedback (${meta.total ?? reports.length} total):\n`));
      if (reports.length) formatOutput(reports, "table", { columns: ["id", "kind", "op", "message", "createdAt"] });
      printContinuation(meta, options);
    } catch (error) {
      handleCommandError(error, "list feedback");
    }
  });

const guidelinesCommand = new Command("guidelines")
  .description("Print the agent operating contract (GET /api/v1/agent-guidelines; no login needed)")
  .option("-o, --output <format>", "markdown (default) | json | yaml", "markdown")
  .action(async (options) => {
    try {
      const guidelines = await client({ auth: false }).agent.guidelines();
      if (options.output === "markdown") console.log(guidelines.markdown);
      else formatOutput(guidelines, options.output);
    } catch (error) {
      handleCommandError(error, "read the agent guidelines");
    }
  });

export { guidelinesCommand };
export default feedbackCommand;
