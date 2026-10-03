import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("package manifest (n8n verification guidelines)", () => {
  it("has zero runtime dependencies — n8n-workflow is a dev/peer dependency only", () => {
    // `pnpm update` rewrites the manifest and drops an empty `dependencies` (9eb15c76): absent is the same promise.
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(Object.keys(pkg.devDependencies)).toContain("n8n-workflow");
    expect(pkg.peerDependencies).toEqual({ "n8n-workflow": "*" });
  });

  it("carries the community-node keyword, MIT license, provenance and the n8n manifest", () => {
    expect(pkg.name).toBe("n8n-nodes-imagestep");
    expect(pkg.keywords).toContain("n8n-community-node-package");
    expect(pkg.license).toBe("MIT");
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    // `dist` is the whole runtime; `templates` the importable workflows the README and /docs/n8n
    // promise with the package (#571 — they were left out of the tarball); the other two are the licence
    // trip the Creator Portal reads — our MIT text and the third-party notice, generated from the repo
    // root by `scripts/sync-notices.mjs` and pinned by `test/notices.test.js`.
    expect(pkg.files).toEqual(["dist", "templates", "LICENSE", "THIRD-PARTY-NOTICES.md"]);
    expect(pkg.n8n.n8nNodesApiVersion).toBe(1);
    expect(pkg.n8n.credentials).toEqual(["dist/credentials/ImageStepApi.credentials.js"]);
    expect(pkg.n8n.nodes).toEqual(["dist/nodes/ImageStep/ImageStep.node.js", "dist/nodes/ImageStepTrigger/ImageStepTrigger.node.js"]);
  });

  it("source requires only Node built-ins, n8n-workflow and relative files", () => {
    const allowed = new Set(["n8n-workflow"]);
    for (const file of walk(join(root, "src")).filter((f) => f.endsWith(".js"))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
        const spec = m[1];
        if (spec.startsWith(".")) continue;
        const bare = spec.replace(/^node:/, "");
        const isBuiltin = spec.startsWith("node:") || builtinModules.includes(bare);
        expect(isBuiltin || allowed.has(spec), `${file} requires ${spec}`).toBe(true);
      }
      expect(text, `${file} must not import()`).not.toMatch(/\bimport\s*\(/);
    }
  });
});

describe("build output", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "pipe" });
  });

  it("produces every path the n8n manifest names, plus the icon next to each node", () => {
    for (const rel of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) expect(existsSync(join(root, rel)), rel).toBe(true);
    expect(existsSync(join(root, "dist/nodes/ImageStep/imagestep.svg"))).toBe(true);
    expect(existsSync(join(root, "dist/nodes/ImageStepTrigger/imagestep.svg"))).toBe(true);
    expect(existsSync(join(root, "dist/nodes/ImageStep/ImageStep.node.json"))).toBe(true);
  });

  it("exports a class named after each file, the way n8n's loader looks it up", () => {
    const { ImageStep } = require(join(root, "dist/nodes/ImageStep/ImageStep.node.js"));
    const { ImageStepTrigger } = require(join(root, "dist/nodes/ImageStepTrigger/ImageStepTrigger.node.js"));
    const { ImageStepApi } = require(join(root, "dist/credentials/ImageStepApi.credentials.js"));
    expect(new ImageStep().description.name).toBe("imageStep");
    expect(new ImageStepTrigger().description.name).toBe("imageStepTrigger");
    expect(new ImageStepApi().name).toBe("imageStepApi");
    const entry = require(join(root, "index.js"));
    expect(Object.keys(entry).sort()).toEqual(["ImageStep", "ImageStepApi", "ImageStepTrigger"]);
  });
});

/**
 * What n8n's own scanner (`@n8n/scan-community-package`, run before a node is verified) refused in 0.1.0 (imagestep#602):
 * a package.json without an author name and email, and a timer global in the node's code — the lint rule
 * `@n8n/community-nodes/no-restricted-globals` wants n8n-workflow's `sleep` instead. Held here so neither comes back.
 */
describe("n8n's community package scan", () => {
  it("names an author with a name and an email", () => {
    expect(pkg.author?.name).toBeTruthy();
    expect(pkg.author?.email).toMatch(/^[^@\s]+@[^@\s]+$/);
  });

  it("uses no timer global in the node's code (n8n-workflow's sleep instead)", () => {
    const hits = walk(join(root, "src"))
      .filter((file) => file.endsWith(".js"))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, i) => [line, i + 1])
          .filter(([line]) => /\b(setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)\s*\(/.test(line))
          .map(([, n]) => `${file.slice(root.length + 1)}:${n}`)
      );
    expect(hits).toEqual([]);
  });
});
