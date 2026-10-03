import chalk from "chalk";
import { Command } from "commander";
import { handleCommandError } from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { client } from "../utils/service.js";

/**
 * `imagestep ops …` — the discovery face (#269). The catalogue (`GET /api/v1/ops`) is how a caller
 * learns what it can ask for, what each op takes and what it costs, before it holds a key: the path
 * is public (#128), so neither command needs a login.
 */
const opsCommand = new Command("ops").description("Discover the op catalogue: what each op takes and what it costs (no login needed)");

/** The price a person reads first: the default model's price for an AI op, the Free quota for a deterministic one. */
function priceOf(op) {
  const pricing = op.pricing || {};
  if (pricing.defaultModel) {
    const model = pricing.defaultModel;
    return `${model.priceRange || (model.priceFrom ? `$${model.priceFrom}` : "?")} (${model.id})`;
  }
  if (pricing.processLimit) {
    const free = pricing.processLimit.FREE;
    return free === -1 ? "free" : `free on paid plans; Free: ${free}/month`;
  }
  return pricing.basis || "";
}

opsCommand
  .command("list")
  .description("List every op in the catalogue")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options) => {
    try {
      const ops = (await client({ auth: false }).ops.list()) || [];
      if (options.output !== "table") {
        formatOutput(ops, options.output);
        return;
      }
      const rows = ops.map((op) => ({
        op: op.op,
        kind: op.kind,
        jobType: op.jobType,
        // ✓ = also runs on the synchronous lane (`imagestep image <op>`), bytes in, bytes out.
        sync: op.syncEndpoint ? "✓" : "",
        // How long one item usually takes as a job (#357) — the catalogue's hint for sizing --timeout; blank = not measured.
        time: op.typicalSeconds ? `~${op.typicalSeconds} s` : "",
        basis: op.pricing?.basis || "",
        price: priceOf(op)
      }));
      console.error(chalk.green(`\nOps (${ops.length}):\n`));
      formatOutput(rows, "table", { columns: ["op", "kind", "jobType", "sync", "time", "basis", "price"] });
      console.log(chalk.gray("\nimagestep ops get <op> — parameters and pricing in full"));
    } catch (error) {
      handleCommandError(error, "list ops");
    }
  });

opsCommand
  .command("get")
  .description("One op's full entry: its parameter contract and its pricing")
  .argument("<op>", "Op name, e.g. resize or remove_bg")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (name, options) => {
    try {
      const op = await client({ auth: false }).ops.get(name);
      if (options.output !== "table") {
        formatOutput(op, options.output);
        return;
      }
      console.log(`\n  ${chalk.bold(op.op)}  ${chalk.gray(`${op.kind} · ${op.jobType}${op.syncEndpoint ? ` · ${op.syncEndpoint}` : ""}`)}`);
      if (op.description) console.log(`  ${op.description}\n`);
      const params = Object.entries(op.params || {}).map(([param, spec]) => ({
        param,
        type: spec.type,
        default: spec.default,
        description: spec.description
      }));
      if (params.length) formatOutput(params, "table", { columns: ["param", "type", "default", "description"] });
      console.log(`\n  ${chalk.gray("PRICING")}  ${priceOf(op)}`);
      if (op.pricing?.summary) console.log(`  ${chalk.gray(op.pricing.summary)}`);
      if (op.typicalSeconds) {
        console.log(
          `\n  ${chalk.gray("TIME")}     ~${op.typicalSeconds} s for one item as a job, on the default model — a hint, not a promise`
        );
      }
      const example = exampleCommand(op.example);
      if (example) console.log(`\n  ${chalk.gray("EXAMPLE")}  ${example}`);
      console.log();
    } catch (error) {
      handleCommandError(error, "get op");
    }
  });

/** A shell argument, single-quoted when it has to be. */
function shellArg(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * The catalogue's `example` for an op (imagestep#358) — one complete, validated `POST /api/v1/jobs` body — as the
 * `jobs submit` line that posts it. Nothing is added: every flag is a field of the example, so the line is as right as
 * the example is, and `test/ops-example.test.js` parses it back through `jobs submit` for every op to prove it.
 * Null when the entry has none (a sync op, or a service older than the field).
 */
export function exampleCommand(example) {
  if (!example?.op) return null;
  return [
    `imagestep jobs submit --op ${example.op}`,
    example.assetIds ? `--asset-ids ${example.assetIds.join(",")}` : null,
    example.prompt ? `-p ${shellArg(example.prompt)}` : null,
    example.count ? `--count ${example.count}` : null,
    example.parameters ? `--params ${shellArg(example.parameters)}` : null,
    example.templateId ? `--template-id ${example.templateId}` : null,
    example.items ? `--items ${shellArg(example.items)}` : null,
    "--wait"
  ]
    .filter(Boolean)
    .join(" ");
}

export default opsCommand;
