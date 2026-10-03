import chalk from "chalk";
import { Command } from "commander";
import { handleCommandError } from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import { client } from "../utils/service.js";

const modelsCommand = new Command("models").description("List available AI models");

const SUPPORTED_MODES = new Set(["ai_image", "analyze"]);

function validateMode(mode) {
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`Invalid mode: ${mode}. Supported modes: ai_image, analyze`);
  }

  return mode;
}

function formatList(values, color = chalk.cyan, maxItems = 3) {
  if (!Array.isArray(values) || values.length === 0) {
    return chalk.gray("N/A");
  }

  const visible = values
    .slice(0, maxItems)
    .map((value) => color(value))
    .join(", ");

  const remaining = values.length - maxItems;
  return remaining > 0 ? `${visible} ${chalk.yellow(`+${remaining}`)}` : visible;
}

function formatBoolean(value) {
  if (value === true) {
    return chalk.green("yes");
  }

  if (value === false) {
    return chalk.gray("no");
  }

  return chalk.gray("N/A");
}

function formatModalities(model) {
  if (model.modality) {
    return chalk.yellow(model.modality);
  }

  const inputModalities = Array.isArray(model.input_modalities) ? model.input_modalities.join(",") : null;
  const outputModalities = Array.isArray(model.output_modalities) ? model.output_modalities.join(",") : null;

  if (inputModalities && outputModalities) {
    return chalk.yellow(`${inputModalities} -> ${outputModalities}`);
  }

  return chalk.gray("N/A");
}

// ============================================================================
// List Models Command
// ============================================================================

modelsCommand
  .command("list")
  .description("List available AI models")
  .option("-m, --mode <mode>", "Model mode: ai_image (the image ops) or analyze (the analyze op)", "ai_image")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options) => {
    try {
      const mode = validateMode(options.mode);
      logger.info("Fetching available models...");

      const models = (await client().models.list(mode)) || [];

      // Commentary to stderr, so `models list -o json | jq` reads an array and nothing else.
      console.error(chalk.green(`\nAvailable ${mode} models (${models.length} total):\n`));

      if (options.output === "table") {
        const transformedModels = models.map((model) => {
          const baseModel = {
            series: model.series ? chalk.magenta(model.series) : chalk.gray("N/A"),
            id: chalk.cyan(model.id),
            name: model.name || chalk.gray("N/A"),
            categories: formatList(model.categories, chalk.yellow),
            modality: formatModalities(model),
            contextLength: model.context_length || model.contextLength || chalk.gray("N/A"),
            structuredOutput: formatBoolean(model.support_structured_output),
            imageRequired: formatBoolean(model.image_required),
            maxInputImages: model.max_input_images || chalk.gray("N/A"),
            supportedParams: formatList(model.supported_parameters),
            promptPrice: model.prompt_price ? chalk.green(`$${model.prompt_price}/M`) : chalk.gray("N/A"),
            completionPrice: model.completion_price ? chalk.green(`$${model.completion_price}/M`) : chalk.gray("N/A")
          };

          // Both modes are priced per image: an image op per output, analyze per analyzed image (imagestep#202).
          const imagePrice = model.image_price || model.image_price_range;
          baseModel.imagePrice = imagePrice ? chalk.green(imagePrice) : chalk.gray("N/A");

          return baseModel;
        });

        // Define columns based on mode
        const columns =
          mode === "ai_image"
            ? [
                "series",
                "id",
                "name",
                "categories",
                "modality",
                "imageRequired",
                "maxInputImages",
                "contextLength",
                "supportedParams",
                "promptPrice",
                "completionPrice",
                "imagePrice"
              ]
            : ["series", "id", "name", "modality", "contextLength", "structuredOutput", "imagePrice"];

        formatOutput(transformedModels, options.output, {
          columns
        });
      } else {
        formatOutput(models, options.output);
      }
    } catch (error) {
      handleCommandError(error, "list models");
    }
  });

export default modelsCommand;
