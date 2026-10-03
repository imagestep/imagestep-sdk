import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/program.js";

/**
 * imagestep#384 — README §3's flag table and §4's command reference restate the commander tree: which flags a command
 * takes, and what several of them default to (`--concurrency` default 3, `-s, --per-page` 100 since imagestep#435). /docs/cli renders the
 * same facts from the generated `cli-reference.js` (#318); this README is prose that picks "the flags that matter", so
 * it is held rather than generated: every flag it names exists on the subcommand it is written under, and every
 * default it states is the one commander has. It says nothing about the flags it leaves out — `--help` has those.
 *
 * The allowed values it prints (`all|published`, `op|key|day`) are not in the tree to compare with: no option declares
 * commander `choices`, the service validates them. `asset download --variant` is the exception that has a guard of its
 * own (the repo-root `test/asset-variants.test.js`, C68).
 */
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const program = buildProgram();

function between(from, to) {
  const start = README.indexOf(from);
  const end = README.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`README: no section between "${from}" and "${to}"`);
  return README.slice(start, end);
}

/** Every flag a code span names, the README's shorthands spelled out: `--min/max-width`, `--taken-from/-to`. */
function flags(span) {
  const out = [];
  for (const [token] of span.matchAll(/(?<![\w-])--?[a-zA-Z][\w-]*(?:\/-?[\w-]+)?/g)) {
    const pair = /^--(\w+)\/(\w+)-([\w-]+)$/.exec(token); // --min/max-width
    const tail = /^(--[\w-]+)-(\w+)\/-(\w+)$/.exec(token); // --taken-from/-to
    if (pair) out.push(`--${pair[1]}-${pair[3]}`, `--${pair[2]}-${pair[3]}`);
    else if (tail) out.push(`${tail[1]}-${tail[2]}`, `${tail[1]}-${tail[3]}`);
    else out.push(token);
  }
  return out;
}

/** `-c` or `--collection` → the option of `command` that answers to it. */
function option(command, flag) {
  return command.options.find((o) => o.short === flag || o.long === flag);
}

/**
 * What a row claims, in order: `{ command, flag, stated }` — the subcommand the flag is written under (the last span
 * that began with a subcommand's name), and the default the text right after its span states, if it states one:
 * "`--concurrency` default 3", "`-p, --page` 0", "`-o pretty\|json\|yaml`, default `pretty`", "`[-m …]` (default `x`)".
 */
function claims(groups, cell) {
  const out = [];
  let current = groups.length === 1 && groups[0].commands.length === 0 ? groups[0] : null;
  for (const m of cell.matchAll(/`([^`]+)`/g)) {
    const span = m[1];
    const first = span.split(/\s+/)[0];
    for (const group of groups) {
      const sub = group.commands.find((c) => c.name() === first);
      if (sub) current = sub;
      else if (group.name() === first && group.commands.length === 0) current = group;
    }
    const named = flags(span);
    if (named.length === 0) continue;
    const after = cell.slice(m.index + m[0].length);
    const stated = /^(?:,? \(?default `?([\w.-]+)`?| (\d+)\b)/.exec(after);
    // A default is claimed for the span's one option — `-p, --page` is one option written two ways.
    const one = named.length === 1 || named.filter((f) => f.startsWith("--")).length === 1;
    for (const flag of named) out.push({ command: current, flag, stated: one && stated ? (stated[1] ?? stated[2]) : undefined });
  }
  return out;
}

describe("README §4 names only flags the CLI has, with the defaults it has", () => {
  const rows = between("## 4. Command reference", "## 5.")
    .split("\n")
    .filter((line) => /^\| `/.test(line))
    .map((line) => line.split(" | "));

  it("reads the table at all", () => {
    expect(rows.length).toBeGreaterThanOrEqual(12);
  });

  it.each(rows.map(([head, cell]) => [head.replace(/^\| /, ""), cell]))("%s", (head, cell) => {
    const groups = [...head.matchAll(/`([\w-]+)`/g)].map(([, name]) => program.commands.find((c) => c.name() === name));
    expect(groups.every(Boolean), `${head} names a group the CLI does not have`).toBe(true);
    for (const { command, flag, stated } of claims(groups, cell)) {
      expect(command, `${head}: ${flag} is not written under a subcommand`).toBeTruthy();
      const found = option(command, flag);
      expect(found, `${head}: ${command.name()} has no ${flag}`).toBeDefined();
      if (stated !== undefined) expect(String(found.defaultValue), `${head}: ${command.name()} ${flag}`).toBe(stated);
    }
  });

  it("the defaults it states are really checked — a positive control on the phrasings above", () => {
    const stated = rows.flatMap(([head, cell]) => {
      const groups = [...head.matchAll(/`([\w-]+)`/g)].map(([, name]) => program.commands.find((c) => c.name() === name));
      return claims(groups, cell)
        .filter((c) => c.stated !== undefined)
        .map((c) => `${c.command.name()} ${c.flag}=${c.stated}`);
    });
    expect(stated).toEqual(
      expect.arrayContaining(["upload --concurrency=3", "list --page=0", "list --per-page=100", "get -o=pretty", "list -m=ai_image"])
    );
  });
});

describe("README §3's flag table is `image run`'s flags", () => {
  const run = program.commands.find((c) => c.name() === "image").commands.find((c) => c.name() === "run");
  const rows = between("| Flag | Meaning |", "**Retries**")
    .split("\n")
    .filter((line) => /^\| `/.test(line))
    .map((line) => line.split(" | "));

  it.each(rows.map(([flag, meaning]) => [flag.replace(/^\| `|`$/g, ""), meaning]))("%s", (span, meaning) => {
    const long = flags(span).find((f) => f.startsWith("--"));
    const found = option(run, long);
    expect(found, `image run has no ${long}`).toBeDefined();
    expect(found.flags).toBe(span);
    const stated = /default (\w+)/.exec(meaning)?.[1];
    if (stated !== undefined) expect(String(found.defaultValue)).toBe(stated);
  });
});
