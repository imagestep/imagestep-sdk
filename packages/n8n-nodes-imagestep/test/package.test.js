import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
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

  it("source imports only Node built-ins, n8n-workflow and relative files", () => {
    const allowed = new Set(["n8n-workflow"]);
    const seen = new Set();
    for (const file of ["nodes", "credentials", "lib"].flatMap((dir) => walk(join(root, dir))).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} must not require()`).not.toMatch(/\brequire\s*\(/);
      for (const m of text.matchAll(/^\s*(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/gm)) {
        const spec = m[1];
        seen.add(spec);
        if (spec.startsWith(".")) continue;
        const bare = spec.replace(/^node:/, "");
        const isBuiltin = spec.startsWith("node:") || builtinModules.includes(bare);
        expect(isBuiltin || allowed.has(spec), `${file} imports ${spec}`).toBe(true);
      }
      expect(text, `${file} must not import()`).not.toMatch(/\bimport\s*\(/);
    }
    // A pattern that stopped matching would pass every file above without reading one import.
    expect(seen).toContain("n8n-workflow");
  });
});

describe("build output", () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, "scripts", "build.mjs")], { stdio: "pipe" });
  });

  it("produces every path the n8n manifest names, and the icon each node and the credential name", () => {
    for (const rel of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) expect(existsSync(join(root, rel)), rel).toBe(true);
    expect(existsSync(join(root, "dist/nodes/ImageStep/ImageStep.node.json"))).toBe(true);
    // n8n resolves `icon: "file:…"` relative to the file that declares it.
    for (const rel of [...pkg.n8n.credentials, ...pkg.n8n.nodes]) {
      const { [basename(rel, ".js").split(".")[0]]: Type } = require(join(root, rel));
      const declared = new Type();
      const icon = (declared.description ?? declared).icon;
      expect(icon, rel).toMatch(/^file:/);
      expect(existsSync(join(root, dirname(rel), icon.slice("file:".length))), `${rel} → ${icon}`).toBe(true);
    }
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
    const hits = ["nodes", "credentials", "lib"]
      .flatMap((dir) => walk(join(root, dir)))
      .filter((file) => file.endsWith(".ts"))
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

/**
 * imagestep#602 — n8n's Creator Portal checks the source repo, not the tarball: 0.1.1 failed its automatic vetting with
 * "Can't find credential file in repo" while the sources sat under `src/`, and 0.1.2 failed it again with them at the
 * package root as JavaScript. It looks for what the n8n starter has — TypeScript: a `*.credentials.ts` under
 * `credentials/` and a `*.node.ts` per node under `nodes/`, the same paths the `n8n` manifest names under `dist/` as `.js`.
 */
describe("sources where n8n's Creator Portal looks for them", () => {
  it.each([...pkg.n8n.credentials, ...pkg.n8n.nodes])("%s is built from the same path at the package root, in TypeScript", (built) => {
    expect(built).toMatch(/^dist\/.+\.js$/);
    const source = built.slice("dist/".length).replace(/\.js$/, ".ts");
    expect(existsSync(join(root, source)), source).toBe(true);
  });

  it("keeps no JavaScript beside the TypeScript sources", () => {
    const js = ["nodes", "credentials", "lib"].flatMap((dir) => walk(join(root, dir))).filter((f) => /\.[cm]?js$/.test(f));
    expect(js).toEqual([]);
  });

  it("keeps no src/ directory", () => {
    expect(existsSync(join(root, "src"))).toBe(false);
  });
});
