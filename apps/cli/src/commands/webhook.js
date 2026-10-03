import chalk from "chalk";
import { Command } from "commander";
import { YES_FLAG_DESCRIPTION, confirmDeletion, handleCommandError, parseCommaSeparated } from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { client } from "../utils/service.js";
import { checkPagingOptions, printContinuation, readListing } from "../utils/paging.js";

/**
 * `imagestep webhook …` — contract §6 from the terminal (#267): register a URL and stop polling, and
 * when an event did not arrive, read the deliveries instead of reaching for curl.
 *
 * The signing secret is readable exactly twice in an endpoint's life — the create and the
 * rotate-secret responses — and the service masks it everywhere else (`secretHint`). This file keeps
 * the same rule: only those two commands ever print it.
 */
const webhookCommand = new Command("webhook").description("Register URLs for job events, and inspect what was delivered");

/** The two responses that carry the secret in the clear: say so, and say it once. */
function printWithSecret(endpoint, output, verb) {
  if (output !== "table") {
    formatOutput(endpoint, output);
    return;
  }
  console.log(chalk.green(`\nWebhook endpoint ${verb}: ${endpoint.id}`));
  console.log(`  url     ${endpoint.url}`);
  console.log(`  events  ${(endpoint.events || []).join(", ") || "(all)"}`);
  console.log(`\n  ${chalk.bold.yellow("secret")}  ${chalk.bold(endpoint.secret)}`);
  console.log(chalk.yellow("  Store it now — it is not shown again. A lost secret is rotated, not recovered.\n"));
}

webhookCommand
  .command("list")
  .description("List this account's webhook endpoints (the secret is masked)")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options) => {
    try {
      const endpoints = (await client().webhooks.list()) || [];
      if (options.output !== "table") {
        formatOutput(endpoints, options.output);
        return;
      }
      console.log(chalk.green(`\nWebhook endpoints (${endpoints.length}):\n`));
      const rows = endpoints.map((e) => ({
        id: e.id,
        url: e.url,
        enabled: e.enabled,
        events: (e.events || []).join(",") || "(all)",
        secretHint: e.secretHint,
        disabledReason: e.disabledReason
      }));
      if (rows.length) formatOutput(rows, "table", { columns: ["id", "url", "enabled", "events", "secretHint", "disabledReason"] });
    } catch (error) {
      handleCommandError(error, "list webhook endpoints");
    }
  });

webhookCommand
  .command("get")
  .description("Get one webhook endpoint (the secret is masked)")
  .argument("<id>", "Endpoint ID")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (id, options) => {
    try {
      formatOutput(await client().webhooks.get(id), options.output);
    } catch (error) {
      handleCommandError(error, "get webhook endpoint");
    }
  });

webhookCommand
  .command("create")
  .description("Register an https:// URL for job events — prints the signing secret, once")
  .requiredOption("--url <url>", "The https:// URL to POST events to (loopback and private addresses are refused)")
  .option("--events <types>", "Comma-separated event types to receive (contract §6; per-item events must be named); omit for all")
  .option("--description <text>", "A note for yourself")
  .option("-o, --output <format>", "table (default: the secret, highlighted) | json | yaml", "table")
  .action(async (options) => {
    try {
      const body = { url: options.url };
      if (options.events) body.events = parseCommaSeparated(options.events).filter(Boolean);
      if (options.description) body.description = options.description;
      const created = await client().webhooks.create(body);
      printWithSecret(created, options.output, "created");
    } catch (error) {
      handleCommandError(error, "create webhook endpoint");
    }
  });

webhookCommand
  .command("update")
  .description("Change an endpoint — only what you pass changes; --enable also clears an automatic disable")
  .argument("<id>", "Endpoint ID")
  .option("--url <url>", "New https:// URL")
  .option("--events <types>", "Comma-separated event types (replaces the list)")
  .option("--description <text>", "New note")
  .option("--enable", "Enable it (the way back after an automatic disable)")
  .option("--disable", "Stop deliveries without deleting it")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (id, options) => {
    try {
      if (options.enable && options.disable) throw new Error("--enable and --disable are mutually exclusive");
      const body = {};
      if (options.url) body.url = options.url;
      if (options.events) body.events = parseCommaSeparated(options.events).filter(Boolean);
      if (options.description !== undefined) body.description = options.description;
      if (options.enable) body.enabled = true;
      if (options.disable) body.enabled = false;
      if (Object.keys(body).length === 0) throw new Error("Nothing to change: pass --url, --events, --description, --enable or --disable");
      formatOutput(await client().webhooks.update(id, body), options.output);
    } catch (error) {
      handleCommandError(error, "update webhook endpoint");
    }
  });

webhookCommand
  .command("delete")
  .description(
    "Delete an endpoint — queued events are closed as FAILED and its delivery history is no longer readable (records are purged after 14 days)"
  )
  .argument("<id>", "Endpoint ID")
  .option("-y, --yes", YES_FLAG_DESCRIPTION)
  .action(async (id, options) => {
    try {
      confirmDeletion(options.yes, "webhook endpoint");
      await client().webhooks.delete(id);
      console.log(chalk.green(`\nDeleted webhook endpoint ${id}\n`));
    } catch (error) {
      handleCommandError(error, "delete webhook endpoint");
    }
  });

webhookCommand
  .command("rotate-secret")
  .description("Issue a new signing secret — printed once; the old one stops verifying immediately")
  .argument("<id>", "Endpoint ID")
  .option("-o, --output <format>", "table (default: the secret, highlighted) | json | yaml", "table")
  .action(async (id, options) => {
    try {
      const rotated = await client().webhooks.rotateSecret(id);
      printWithSecret(rotated, options.output, "secret rotated");
    } catch (error) {
      handleCommandError(error, "rotate webhook secret");
    }
  });

webhookCommand
  .command("test")
  .description("Send a synthetic webhook.test event now and show what the receiver answered")
  .argument("<id>", "Endpoint ID")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (id, options) => {
    try {
      const delivery = await client().webhooks.test(id);
      if (options.output !== "table") {
        formatOutput(delivery, options.output);
      } else {
        const color = delivery.status === "DELIVERED" ? chalk.green : chalk.red;
        console.log(`\n  ${color.bold(delivery.status)}  receiver answered ${delivery.responseStatus ?? "nothing"}`);
        if (delivery.error) console.log(`  ${chalk.red(delivery.error)}`);
        console.log(chalk.gray(`  delivery ${delivery.id} · imagestep webhook deliveries ${id}\n`));
      }
      if (delivery.status !== "DELIVERED") process.exitCode = 1;
    } catch (error) {
      handleCommandError(error, "test webhook endpoint");
    }
  });

webhookCommand
  .command("deliveries")
  .description("Recent deliveries to an endpoint, newest first — where to look when an event did not arrive")
  .argument("<id>", "Endpoint ID")
  .option("-p, --page <n>", "Page number (0-indexed)", "0")
  .option("-s, --per-page <n>", "Items per page (max 100; out of range is clamped)", "100")
  .option("-a, --all", "Every delivery, walking the pages for you — not with --page")
  .option("--cursor <cursor>", "Start after a page: the cursor it printed (More: --cursor …) — not with --page")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (id, options, command) => {
    try {
      checkPagingOptions(options, command);
      const api = client();
      const { rows: deliveries, meta } = await readListing(
        { list: (p) => api.webhooks.deliveries(id, p), iterate: (p) => api.webhooks.iterateDeliveries(id, p) },
        { perPage: options.perPage },
        options
      );
      if (options.output !== "table") {
        formatOutput(deliveries, options.output);
        printContinuation(meta, options);
        return;
      }
      console.log(chalk.green(`\nDeliveries (${meta.total ?? deliveries.length} total):\n`));
      if (deliveries.length) {
        formatOutput(deliveries, "table", {
          columns: ["eventType", "status", "attempts", "responseStatus", "error", "nextAttemptAt", "createdAt"]
        });
      }
      printContinuation(meta, options);
    } catch (error) {
      handleCommandError(error, "list webhook deliveries");
    }
  });

export default webhookCommand;
