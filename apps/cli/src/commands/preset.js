import chalk from "chalk";
import { Command } from "commander";
import { handleCommandError, parseJsonInput, confirmDeletion, YES_FLAG_DESCRIPTION } from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { logger } from "../utils/logger.js";
import { client } from "../utils/service.js";

const presetCommand = new Command("preset").description("Manage presets: saved, versioned lists of steps");

/**
 * Steps are an array, each `{op, model?, prompt?, parameters?}` or `{operation, params}`; the service checks the rest.
 * `jobs submit --steps` sends the same array inline (imagestep#414), so it is exported for that.
 * @param {any} steps - Steps to validate
 */
export function validateSteps(steps) {
  if (!Array.isArray(steps)) {
    console.error(chalk.red("Error: Steps must be an array of {op, parameters} or {operation, params} objects"));
    process.exit(1);
  }
}

// What a GET carries that a create must not send back: the service assigns every one of them. The slug goes
// only when it is a built-in's — `builtin-…` is reserved and refused outright, and copying a built-in into your
// own account is exactly what presets.md §8 says to do with one. Stripping these is what lets
// `preset get <slug> -o json > p.json` then `preset create -f p.json` work, and lets a /docs/recipes block —
// `{name, slug, description, steps}` and nothing else — be fed in as it is printed.
const SERVER_FIELDS = ["id", "version", "versions", "builtIn", "createdAt", "updatedAt"];

function withoutServerFields(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    console.error(
      chalk.red("Error: -f takes one preset object {name, slug?, description?, subjects?, steps}; a list of them is `preset import`")
    );
    process.exit(1);
  }
  const body = Object.fromEntries(Object.entries(doc).filter(([key]) => !SERVER_FIELDS.includes(key)));
  if (typeof body.slug === "string" && body.slug.startsWith("builtin-")) delete body.slug;
  return body;
}

/**
 * The document the flags name, over `base` — a flag not given leaves the base's value. Exported because it is the
 * body this command sends, which is what the console's own save is held to (`call-forms.test.jsx`, imagestep#411),
 * the way `buildJobRequest` is.
 */
export function buildPresetBody(options, base = {}) {
  const doc = { ...base };
  if (options.name !== undefined) doc.name = options.name;
  if (options.slug !== undefined) doc.slug = options.slug;
  if (options.description !== undefined) doc.description = options.description;
  if (options.steps !== undefined) doc.steps = parseJsonInput(options.steps, "steps");
  if (doc.steps !== undefined) validateSteps(doc.steps);
  return doc;
}

// List all presets
presetCommand
  .command("list")
  .description("List all presets — `-o json` and `-o yaml` print the export shape, history included")
  .option("-f, --filter <filter>", "Filter by ownership (user|builtin)")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options) => {
    try {
      if (options.filter && !["user", "builtin"].includes(options.filter)) {
        throw new Error(`Invalid filter: ${options.filter}. Supported: user, builtin`);
      }

      logger.info("Fetching presets...");

      // The output format decides the request (imagestep#444). `GET /api/v1/presets` leaves `versions` off now,
      // because a list row is read to choose a preset; but `preset list -o json` is the document `preset import`
      // takes back (see `import`'s own description), so the export shapes ask for the history and the table — which
      // prints the current version and its step count — does not.
      const includeVersions = options.output !== "table" || undefined;
      const presets = (await client().presets.list(options.filter, { includeVersions })) || [];

      // The count is commentary, so it goes to stderr: with -o json the stdout is the document and nothing else,
      // which is what makes `preset list -o json > p.json` an import file (`asset list` / `jobs list` were fixed
      // the same way; it was a console.log here, i.e. inside the document).
      console.error(chalk.green(`\nPresets (${presets.length} total):\n`));

      if (options.output === "table") {
        // `runs` / `lastRun` are the service's `usage` (imagestep#423) — the jobs still on record that ran this
        // preset. A preset nothing has run answers with no `usage` at all, which is a 0 and a blank here.
        const transformedPresets = presets.map((preset) => ({
          slug: preset.slug,
          name: preset.name,
          builtIn: preset.builtIn === true ? "yes" : "no",
          version: preset.version,
          versions: preset.versionCount ?? 1,
          steps: (preset.steps || []).length,
          runs: preset.usage?.runs ?? 0,
          lastRun: preset.usage?.lastRunAt ?? "",
          createdAt: preset.createdAt,
          updatedAt: preset.updatedAt
        }));

        formatOutput(transformedPresets, options.output, {
          columns: ["slug", "name", "builtIn", "version", "versions", "steps", "runs", "lastRun", "createdAt", "updatedAt"]
        });
      } else {
        formatOutput(presets, options.output);
      }
    } catch (error) {
      handleCommandError(error, "fetch presets");
    }
  });

// Get preset by slug
presetCommand
  .command("get")
  .description("Get a preset by slug, or one earlier version of it as slug@version")
  .argument("<preset-slug>", "Preset slug or id, or slug@version")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (presetSlug, options) => {
    try {
      logger.info(`Fetching preset ${presetSlug}...`);

      const preset = await client().presets.get(presetSlug);

      console.error(chalk.green("\nPreset Details:\n"));
      formatOutput(preset, options.output);
    } catch (error) {
      handleCommandError(error, "fetch preset");
    }
  });

// Create preset
presetCommand
  .command("create")
  .description(
    "Create a preset (version 1) from a JSON document — a /docs/recipes block, or what `preset get -o json` prints — and/or flags"
  )
  .option(
    "-f, --file <json>",
    "A whole preset {name, slug?, description?, subjects?, steps} (JSON string or file path); flags override its fields"
  )
  .option("-n, --name <name>", "Preset name")
  .option("-s, --steps <json>", "Steps: a JSON array of {op, parameters} or {operation, params} (JSON string or file path)")
  .option("--slug <slug>", "Your own slug for it (default: from the name)")
  .option("--description <text>", "Description")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (options) => {
    try {
      const base = options.file ? withoutServerFields(parseJsonInput(options.file, "preset")) : {};
      const body = buildPresetBody(options, base);
      if (!body.name || !body.steps) {
        console.error(chalk.red("Error: a preset needs a name and steps — give -f <file>, or -n and -s"));
        process.exit(1);
      }

      logger.info("Creating preset...");

      const preset = await client().presets.create(body);

      console.error(chalk.green(`\nPreset created: ${preset.slug} (version ${preset.version})\n`));
      formatOutput(preset, options.output);
    } catch (error) {
      handleCommandError(error, "create preset");
    }
  });

// Update preset
presetCommand
  .command("update")
  .description("Update a preset — changing its steps makes a new version; what the flags (or -f) leave out is carried over")
  .argument("<preset-slug>", "Preset slug or id")
  .option("-f, --file <json>", "A whole preset (JSON string or file path); flags override its fields")
  .option("-n, --name <name>", "New preset name")
  .option("-s, --steps <json>", "New steps: a JSON array of {op, parameters} or {operation, params} (JSON string or file path)")
  .option("--slug <slug>", "New slug")
  .option("--description <text>", "New description")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (presetSlug, options) => {
    try {
      logger.info(`Updating preset ${presetSlug}...`);

      // The service merges a PUT over the current preset (#376): a rename sends the name and nothing else, and
      // what the flags leave out is carried over there.
      const base = options.file ? withoutServerFields(parseJsonInput(options.file, "preset")) : {};
      const preset = await client().presets.update(presetSlug, buildPresetBody(options, base));

      console.error(chalk.green(`\nPreset ${preset.slug} is now version ${preset.version}\n`));
      formatOutput(preset, options.output);
    } catch (error) {
      handleCommandError(error, "update preset");
    }
  });

// Delete preset
presetCommand
  .command("delete")
  .description("Delete a preset")
  .argument("<preset-slug>", "Preset slug")
  .option("-y, --yes", YES_FLAG_DESCRIPTION)
  .action(async (presetSlug, options) => {
    try {
      confirmDeletion(options.yes, "preset");

      logger.info(`Deleting preset ${presetSlug}...`);

      await client().presets.delete(presetSlug);

      console.log(chalk.green("\nPreset deleted successfully!\n"));
    } catch (error) {
      handleCommandError(error, "delete preset");
    }
  });

// Delete one superseded version (imagestep#445)
presetCommand
  .command("delete-version")
  .description("Delete one superseded version — slug@version stops resolving for good; the way past the version ceiling")
  .argument("<preset-slug>", "Preset slug or id (without an @)")
  .argument("<version>", "The superseded version to delete")
  .option("-y, --yes", YES_FLAG_DESCRIPTION)
  .action(async (presetSlug, version, options) => {
    try {
      // The cost is said before it is paid, because this is the one call that makes a reference a caller may be
      // holding stop resolving — the preset itself, and every other version, is untouched.
      confirmDeletion(
        options.yes,
        `version ${version} of ${presetSlug}`,
        1,
        `Anything calling ${presetSlug}@${version} gets a 404 from then on, and the number is never reissued. ` +
          `The preset and its other versions are untouched.`
      );

      logger.info(`Deleting version ${version} of ${presetSlug}...`);

      await client().presets.deleteVersion(presetSlug, version);

      console.log(chalk.green(`\nDeleted ${presetSlug}@${version}\n`));
    } catch (error) {
      handleCommandError(error, "delete preset version");
    }
  });

// Import presets
presetCommand
  .command("import")
  .description("Import a list of presets — the export shape, which is what `preset list -o json` prints")
  .argument("<json>", "A JSON array of presets (file path, or a JSON string)")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (filePath, options) => {
    try {
      // A path or the JSON itself, like every other JSON input in this CLI (`create -f`, `jobs submit --params`).
      // It used to be path.resolve()'d first, which turned a piped document into a filename that does not exist.
      const presets = parseJsonInput(filePath, "presets");

      // Validate presets is an array
      if (!Array.isArray(presets)) {
        console.error(chalk.red("Error: File must contain an array of preset objects"));
        process.exit(1);
      }

      logger.info(`Importing ${presets.length} presets...`);

      const result = await client().presets.import(presets);

      console.error(chalk.green(`\nSuccessfully imported ${result.importedCount} of ${presets.length} presets!\n`));
      formatOutput(result, options.output);
    } catch (error) {
      handleCommandError(error, "import presets");
    }
  });

export default presetCommand;
