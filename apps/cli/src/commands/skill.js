import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";

/**
 * `imagestep skill` — the agent skill this CLI ships with (imagestep#284).
 *
 * The file is the repo-root `skills/imagestep/SKILL.md`, copied into this package by
 * `scripts/sync-skill.mjs` and served byte for byte at `/.well-known/agent-skills/imagestep/SKILL.md`,
 * so a coding agent can get the operating procedure from whichever of the three it reached first.
 * Printing is the default; `--install claude-code` writes it where Claude Code loads skills from and
 * nowhere else — one install target, and a directory this CLI owns by name.
 */
export const SKILL_NAME = "imagestep";
const SKILL_FILE = new URL(`../../skills/${SKILL_NAME}/SKILL.md`, import.meta.url);
const INSTALL_TARGETS = {
  "claude-code": () => join(homedir(), ".claude", "skills", SKILL_NAME)
};

export function skillText() {
  return readFileSync(SKILL_FILE, "utf8");
}

const skillCommand = new Command("skill")
  .description("Print the agent skill for this CLI (a SKILL.md), or install it for a coding agent")
  .option("--install <target>", `Write it where the agent loads skills from (${Object.keys(INSTALL_TARGETS).join("|")})`)
  .action((options) => {
    if (!options.install) {
      process.stdout.write(skillText());
      return;
    }
    const target = INSTALL_TARGETS[options.install];
    if (!target) {
      console.error(chalk.red(`Error: unknown install target ${options.install}; supported: ${Object.keys(INSTALL_TARGETS).join(", ")}`));
      process.exit(1);
    }
    const dir = target();
    const file = join(dir, "SKILL.md");
    const existed = existsSync(file);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, skillText());
    console.error(chalk.green(`${existed ? "Updated" : "Installed"} ${file}`));
  });

export default skillCommand;
