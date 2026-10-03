import chalk from "chalk";
import { Command } from "commander";
import {
  YES_FLAG_DESCRIPTION,
  confirmDeletion,
  handleCommandError,
  parseCommaSeparated,
  parseJsonInput,
  readFileContent
} from "../utils/command-helpers.js";
import { formatOutput } from "../utils/formatter.js";
import { client } from "../utils/service.js";

/**
 * `imagestep template …` — the input of `render_template` (#268): list, read (any version), create,
 * version, delete and import HTML/CSS templates through `/api/v1/templates`.
 *
 * A template is never edited in place: every update is `version + 1`, and `id@version` reads exactly
 * the bytes a job rendered with. Built-ins (`builtin-template-*`) are read-only — the 403 on PUT or
 * DELETE is printed as the service words it.
 */
const templateCommand = new Command("template").description("Manage render templates: HTML/CSS + variables, versioned");

// What a GET carries that a create must not send back: the service assigns these, and a copied
// `builtin-…` slug is refused outright. Stripping them is what lets `get -o json > t.json` then
// `create -f t.json` work.
const SERVER_FIELDS = ["id", "slug", "version", "builtIn", "createdAt", "updatedAt"];

function addFieldOptions(command) {
  return command
    .option("--name <name>", "Template name")
    .option("--description <text>", "Description")
    .option("--html <html>", "HTML (a string, or @path to read a file)")
    .option("--css <css>", "CSS (a string, or @path to read a file)")
    .option("--width <px>", "Output width in pixels (1–4096)")
    .option("--height <px>", "Output height in pixels (1–4096)")
    .option("--variables <names>", "Comma-separated variable names (default: the {{ … }} names found in html and css)")
    .option("--slug <slug>", "Your own slug for it");
}

/** The document fields the flags name, over `base` — a flag not given leaves the base's value. */
function fieldsFrom(options, base = {}) {
  const doc = { ...base };
  if (options.name !== undefined) doc.name = options.name;
  if (options.description !== undefined) doc.description = options.description;
  if (options.html !== undefined) doc.html = readFileContent(options.html);
  if (options.css !== undefined) doc.css = readFileContent(options.css);
  if (options.width !== undefined) doc.width = Number(options.width);
  if (options.height !== undefined) doc.height = Number(options.height);
  if (options.variables !== undefined) doc.variables = parseCommaSeparated(options.variables).filter(Boolean);
  if (options.slug !== undefined) doc.slug = options.slug;
  return doc;
}

function withoutServerFields(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !SERVER_FIELDS.includes(key)));
}

templateCommand
  .command("list")
  .description("List templates: built-ins first, then your own (-o json|yaml prints full documents, the import format)")
  .option("-f, --filter <filter>", "builtin | user; omit for both")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (options) => {
    try {
      if (options.filter && !["builtin", "user"].includes(options.filter)) {
        throw new Error(`Invalid filter: ${options.filter}. Supported: builtin, user`);
      }
      // Every page: an account holds at most 200 templates, and a listing that stopped at 100 would be a quiet export
      // of half of them. The rows are summaries without html / css (imagestep#497).
      const api = client();
      const templates = [];
      for await (const t of api.templates.iterate(options.filter)) templates.push(t);
      if (options.output !== "table") {
        // The export document is the whole template, which the listing no longer carries: read each one.
        const docs = [];
        for (const t of templates) docs.push(await api.templates.get(t.id));
        formatOutput(docs, options.output);
        return;
      }
      // Commentary to stderr, so `template list -f user -o json` prints an import document and nothing else.
      console.error(chalk.green(`\nTemplates (${templates.length}):\n`));
      const rows = templates.map((t) => ({
        id: t.id,
        name: t.name,
        version: t.version,
        size: `${t.width}x${t.height}`,
        variables: (t.variables || []).join(","),
        builtIn: t.builtIn === true ? "yes" : "no"
      }));
      if (rows.length) formatOutput(rows, "table", { columns: ["id", "name", "version", "size", "variables", "builtIn"] });
    } catch (error) {
      handleCommandError(error, "list templates");
    }
  });

templateCommand
  .command("get")
  .description("Get a template, or one version of it as id@version")
  .argument("<id>", "Template id or slug, or id@version")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (id, options) => {
    try {
      formatOutput(await client().templates.get(id), options.output);
    } catch (error) {
      handleCommandError(error, "get template");
    }
  });

templateCommand
  .command("versions")
  .description("Every saved version of a template, newest first")
  .argument("<id>", "Template id or slug")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "table")
  .action(async (id, options) => {
    try {
      const versions = (await client().templates.versions(id)) || [];
      if (options.output !== "table") formatOutput(versions, options.output);
      else if (versions.length) formatOutput(versions, "table", { columns: ["id", "name", "version", "width", "height", "updatedAt"] });
    } catch (error) {
      handleCommandError(error, "list template versions");
    }
  });

addFieldOptions(
  templateCommand
    .command("create")
    .description("Create a template (version 1) from a JSON document — the shape `template get -o json` prints — and/or flags")
    .option("-f, --file <json>", "A template document (JSON string or file path); flags override its fields")
)
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (options) => {
    try {
      const base = options.file ? withoutServerFields(parseJsonInput(options.file, "template")) : {};
      const created = await client().templates.create(fieldsFrom(options, base));
      console.error(chalk.green(`Template created: ${created.id} (version ${created.version})`));
      formatOutput(created, options.output);
    } catch (error) {
      handleCommandError(error, "create template");
    }
  });

addFieldOptions(
  templateCommand
    .command("update")
    .description("Save a new version — what the flags (or -f) leave out is carried over from the current version")
    .argument("<id>", "Template id or slug")
    .option("-f, --file <json>", "A template document (JSON string or file path)")
)
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (id, options) => {
    try {
      // The service merges a PUT over the current version (#376), so the body is only what changes.
      const base = options.file ? withoutServerFields(parseJsonInput(options.file, "template")) : {};
      const updated = await client().templates.update(id, fieldsFrom(options, base));
      console.error(chalk.green(`Template ${updated.id} is now version ${updated.version}`));
      formatOutput(updated, options.output);
    } catch (error) {
      handleCommandError(error, "update template");
    }
  });

templateCommand
  .command("delete")
  .description("Delete a template and every version of it (built-ins are 403)")
  .argument("<id>", "Template id or slug")
  .option("-y, --yes", YES_FLAG_DESCRIPTION)
  .action(async (id, options) => {
    try {
      confirmDeletion(options.yes, "template");
      await client().templates.delete(id);
      console.log(chalk.green(`\nDeleted template ${id}\n`));
    } catch (error) {
      handleCommandError(error, "delete template");
    }
  });

templateCommand
  .command("import")
  .description("Import templates from a JSON file (the list `template list -f user -o json` prints); each becomes version 1")
  .argument("<file>", "Path to a JSON array of template documents")
  .option("-o, --output <format>", "Output format (json|yaml|table)", "json")
  .action(async (file, options) => {
    try {
      const list = parseJsonInput(file, "templates");
      if (!Array.isArray(list)) throw new Error("The file must contain an array of template documents");
      const result = await client().templates.import(list);
      console.error(chalk.green(`Imported ${result.importedCount} of ${list.length} template(s)`));
      formatOutput(result, options.output);
    } catch (error) {
      handleCommandError(error, "import templates");
    }
  });

export default templateCommand;
