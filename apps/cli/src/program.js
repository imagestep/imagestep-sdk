import { readFileSync } from "node:fs";
import { Command } from "commander";
import feedbackCommand, { guidelinesCommand } from "./commands/feedback.js";
import jobsCommand from "./commands/jobs.js";
import loginCommand, { logoutCommand } from "./commands/login.js";
import assetCommand from "./commands/asset.js";
import { imageCommand } from "./commands/image.js";
import modelsCommand from "./commands/models.js";
import opsCommand from "./commands/ops.js";
import presetCommand from "./commands/preset.js";
import skillCommand from "./commands/skill.js";
import templateCommand from "./commands/template.js";
import usageCommand from "./commands/usage.js";
import webhookCommand from "./commands/webhook.js";

// `-V` is what a script reports when it files a bug against this CLI, so it reads the one version
// that is actually published rather than a literal that drifts from package.json at every release.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/**
 * The command tree, built without parsing anything: `bin/imagestep.js` parses it, and
 * `test/skill.test.js` walks it to check that every command the SKILL.md names still exists.
 */
export function buildProgram() {
  const program = new Command();

  program
    .name("imagestep")
    .description("ImageStep CLI - image ops, presets, jobs, assets, templates and webhooks from the terminal")
    .version(version);

  program.addCommand(loginCommand);
  program.addCommand(logoutCommand);
  program.addCommand(assetCommand);
  program.addCommand(modelsCommand);
  program.addCommand(presetCommand);
  program.addCommand(templateCommand);
  program.addCommand(jobsCommand);
  program.addCommand(imageCommand);
  program.addCommand(opsCommand);
  program.addCommand(usageCommand);
  program.addCommand(webhookCommand);
  program.addCommand(feedbackCommand);
  program.addCommand(guidelinesCommand);
  program.addCommand(skillCommand);

  return program;
}
