#!/usr/bin/env node

import chalk from "chalk";
import { attachOpCommands, needsCatalogue } from "./commands/image.js";
import { buildProgram } from "./program.js";

const program = buildProgram();

// Handle unknown commands
program.on("command:*", function () {
  console.error(chalk.red(`\nInvalid command: ${program.args.join(" ")}`));
  console.log(chalk.yellow("\nRun 'imagestep --help' to see available commands\n"));
  process.exit(1);
});

// A bare `imagestep` is a question, not a mistake: the command list goes to stdout and the process
// exits 0. Commander's own no-subcommand path prints the same help to stderr and exits 1, which
// every wrapper reports as a failed run (`pnpm cli` turns it into ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL).
// It also returns before the fetch below, because the root help lists groups, never ops.
if (process.argv.slice(2).length === 0) {
  program.outputHelp();
} else {
  // The `image` group's subcommands come from `GET /api/v1/ops` (an op with a `syncEndpoint`), so
  // its help lists what this API version supports rather than what this release was built against.
  // Awaited before parse because commander needs the tree complete; it fails soft (within 3 s) when the
  // API is unreachable or nobody is logged in, and the rest of the CLI parses either way. Only the
  // `image` group asks (#526): `jobs --help` used to fetch the catalogue too, and `-h` did not.
  if (needsCatalogue(process.argv.slice(2))) {
    await attachOpCommands();
  }

  program.parse(process.argv);
}
