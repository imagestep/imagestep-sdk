// Loaded with `node --import`: this process looks as if it writes to a terminal, which is all chalk and cli-highlight
// check before they colour (test/no-color.test.js, imagestep#828).
import tty from "node:tty";

tty.isatty = function isatty() {
  return true;
};
process.stdout.isTTY = true;
process.stderr.isTTY = true;
