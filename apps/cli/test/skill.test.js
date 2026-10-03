import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SKILL_NAME, skillText } from "../src/commands/skill.js";
import { buildProgram } from "../src/program.js";

/**
 * imagestep#284 — the agent skill this CLI ships.
 *
 * Three things can drift apart quietly: the copy in this package and the repo-root source it is
 * generated from (that one is `node scripts/sync-skill.mjs --check`, in `pnpm check`); the name in the file's frontmatter and the directory / URL it is published under;
 * and the commands the skill tells an agent to run and the commands this CLI actually has. The last
 * one is the one that costs money — an agent that follows a stale skill gets a usage error, guesses,
 * and the guess is charged — so every `imagestep …` line in the file is resolved against the real
 * commander tree: group, subcommand, and every flag.
 */
const run = promisify(execFile);
const bin = fileURLToPath(new URL("../bin/imagestep.js", import.meta.url));

describe("the shipped copy", () => {
  it("is named once: frontmatter, directory and install target agree", () => {
    const name = skillText().match(/^---\n[\s\S]*?^name:\s*(\S+)\s*$/m)?.[1];
    expect(name).toBe(SKILL_NAME);
    expect(SKILL_NAME).toMatch(/^[a-z0-9-]+$/);
  });

  it("is in the npm tarball", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.files).toContain("skills");
  });
});

/** Every `imagestep …` invocation in the skill: inside code fences and in inline code. */
function invocations(text) {
  const found = [];
  for (const line of text.split("\n")) {
    const fence = line.match(/^\s*(?:[A-Z_]+=\S+\s+)*(?:\w+=\$\()?imagestep\s+(.*)$/);
    if (fence) found.push(fence[1]);
    for (const inline of line.matchAll(/`imagestep\s+([^`]+)`/g)) found.push(inline[1]);
  }
  return found.map((rest) => rest.replace(/\s*\|.*$/, "").replace(/\)\s*$/, ""));
}

/** Split on whitespace, keeping quoted arguments whole, and drop the `…` placeholders the prose uses. */
function tokens(invocation) {
  return (invocation.match(/"[^"]*"|'[^']*'|\S+/g) || []).filter((t) => t !== "…" && t !== "...");
}

function optionNames(command) {
  const names = new Set(["--help", "-h"]);
  for (const option of command.options) {
    if (option.long) names.add(option.long);
    if (option.short) names.add(option.short);
  }
  return names;
}

describe("every command the skill names exists", () => {
  const program = buildProgram();
  const lines = invocations(skillText());

  it("finds the invocations it is about to check", () => {
    expect(lines.length).toBeGreaterThan(10);
  });

  it.each(lines)("imagestep %s", (invocation) => {
    const argv = tokens(invocation);
    let command = program;
    // Walk the tree while the next token names a subcommand; flags and positionals follow.
    while (argv.length && !argv[0].startsWith("-")) {
      const next = command.commands.find((c) => c.name() === argv[0] || c.aliases().includes(argv[0]));
      if (!next) break;
      command = next;
      argv.shift();
    }
    // Only a root flag (`--version`, `--help`) may stop at the root; anything else is a command that
    // does not exist.
    if (command === program) {
      expect(
        argv.every((t) => t.startsWith("-")),
        `no such command: imagestep ${invocation}`
      ).toBe(true);
    }

    // `image <op>` subcommands are built from GET /api/v1/ops at run time, so the op name is a
    // positional here; its flags are the op's parameters plus the group's common options, which
    // this test cannot see offline. What it can check is that the op line is under `image`.
    const dynamicOp = command.name() === "image" && argv.length && /^[a-z_]+$/.test(argv[0]);
    if (dynamicOp) return;

    // A subcommand that takes positionals swallows what is left; a flag must be one it declares.
    const known = optionNames(command);
    for (const token of argv) {
      if (!token.startsWith("-")) continue;
      const flag = token.split("=")[0];
      expect(known.has(flag), `imagestep ${invocation}: ${command.name()} has no option ${flag}`).toBe(true);
    }
    // A group without a subcommand named is a mistake in the skill, not a command.
    if (command !== program) {
      expect(
        command.commands.length === 0 || argv.some((t) => !t.startsWith("-")),
        `imagestep ${invocation}: names a group, not a command`
      ).toBe(true);
    }
  });
});

describe("imagestep skill", () => {
  it("prints the file, byte for byte, to stdout", async () => {
    const { stdout } = await run(process.execPath, [bin, "skill"]);
    expect(stdout).toBe(skillText());
  });

  it("--install claude-code writes ~/.claude/skills/<name>/SKILL.md and nothing else", async () => {
    const home = mkdtempSync(join(tmpdir(), "imagestep-skill-"));
    const { stderr } = await run(process.execPath, [bin, "skill", "--install", "claude-code"], { env: { ...process.env, HOME: home } });
    const installed = join(home, ".claude", "skills", SKILL_NAME, "SKILL.md");
    expect(readFileSync(installed, "utf8")).toBe(skillText());
    expect(stderr).toContain(installed);
  });

  it("refuses an install target it does not know", async () => {
    const error = await run(process.execPath, [bin, "skill", "--install", "cursor"]).catch((e) => e);
    expect(error.code).toBe(1);
    expect(error.stderr).toContain("claude-code");
  });
});
