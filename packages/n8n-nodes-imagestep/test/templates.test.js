import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { properties } from "../nodes/ImageStep/description.ts";

const require = createRequire(import.meta.url);
const { NODE_TYPE, checkTemplate } = require("./template-check.js");

const DIR = join(import.meta.dirname, "..", "templates");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".json"));

/** imagestep#460 — n8n drops a hidden parameter on import without a word, so a stale template runs on defaults. */
describe("the templates this package ships", () => {
  it.each(FILES)("%s: every ImageStep node sets only fields the node shows", (file) => {
    const template = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    expect(template.nodes.some((n) => n.type === NODE_TYPE)).toBe(true);
    expect(checkTemplate(template, properties)).toEqual([]);
  });
});

describe("the check itself", () => {
  const node = (parameters) => ({ nodes: [{ name: "N", type: NODE_TYPE, parameters }] });

  it("catches a renamed option, a hidden field and a value that is not an option", () => {
    expect(checkTemplate(node({ resource: "op", operation: "run", op: "resize", options: { folder: "x" } }), properties)).toEqual([
      'N: "options.folder" is not an option (model, collection, retentionDays)'
    ]);
    expect(checkTemplate(node({ resource: "op", operation: "run", op: "resize", publish: true }), properties)).toEqual([
      'N: "publish" is not a field this node shows for these values'
    ]);
    expect(checkTemplate(node({ resource: "op", operation: "run", op: "resize", inputMode: "folder" }), properties)).toEqual([
      'N: "inputMode" = "folder" is not one of binary, assetIds, none'
    ]);
  });

  it("passes expressions and a live list's value, and reads a field's visibility off the values it depends on", () => {
    const run = {
      resource: "preset",
      operation: "run",
      preset: "carousel-brand",
      inputMode: "none",
      prompt: "={{ $json.prompt }}",
      count: 4
    };
    expect(checkTemplate(node({ ...run, storeResult: true, wait: true, publish: true }), properties)).toEqual([]);
  });
});
