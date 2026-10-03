import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * What can be checked about the recipes without calling the API (imagestep#458 / #650).
 *
 * The recipes are the copy of the API that readers run as-is, so they drift the moment the API moves and nothing here
 * runs them. Running them needs a live service (`pnpm test:e2e:recipes` in the upstream repo); these checks need only
 * the files, so they run with every unit test: no spelling of an API the recipes no longer run against, every n8n
 * template sets only fields the ImageStep node shows, and every recipe folder is complete and listed.
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { properties: N8N_PROPERTIES } = require("../../packages/n8n-nodes-imagestep/nodes/ImageStep/description.js");
const { checkTemplate } = require("../../packages/n8n-nodes-imagestep/test/template-check.js");

/** A recipe is a top-level folder with an n8n template in it. */
const RECIPES = readdirSync(ROOT)
  .filter((name) => statSync(join(ROOT, name)).isDirectory() && existsSync(join(ROOT, name, "n8n-template.json")))
  .sort();

/** Spellings of the API these recipes were first written for (imagestep#241 · #331 · #347 · #366). */
const STALE = [
  /aiPresets/,
  /ai-presets/,
  /folderId/,
  /\bfolder: ?["'`]/,
  /[{,]\s*folder\b/,
  /"folder"/,
  /mm_sk_/,
  /basicInfo/,
  /assets\.label\(/
];

const TEXT = /\.(mjs|js|json|md|csv|txt|html|css)$/;

function textFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "test") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return textFiles(path);
    return TEXT.test(name) ? [path] : [];
  });
}

describe("recipes", () => {
  it("found the recipe folders", () => {
    // A filter that stopped matching would leave every check below with nothing to check.
    expect(RECIPES.length).toBeGreaterThanOrEqual(5);
  });

  it("uses no spelling of an API the recipes no longer run against", () => {
    const hits = [];
    for (const file of textFiles(ROOT)) {
      const text = readFileSync(file, "utf8");
      for (const re of STALE) if (re.test(text)) hits.push(`${relative(ROOT, file)}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it.each(RECIPES)("%s: its n8n template sets only fields the ImageStep node shows", (dir) => {
    const template = JSON.parse(readFileSync(join(ROOT, dir, "n8n-template.json"), "utf8"));
    expect(checkTemplate(template, N8N_PROPERTIES)).toEqual([]);
  });

  it.each(RECIPES)("%s: has a README, a script that package.json runs, and a row in the root README", (dir) => {
    expect(existsSync(join(ROOT, dir, "README.md")), `${dir}/README.md`).toBe(true);
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const runs = Object.values(scripts).filter((command) => command.startsWith(`node ${dir}/`));
    expect(runs, `no package.json script runs ${dir}`).toHaveLength(1);
    expect(existsSync(join(ROOT, runs[0].slice("node ".length)))).toBe(true);
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(`(${dir}/)`);
  });
});
