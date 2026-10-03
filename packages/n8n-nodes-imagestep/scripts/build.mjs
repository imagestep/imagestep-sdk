// Build = `tsc`, then the files tsc does not emit. The sources are TypeScript in the n8n starter's layout — `nodes/**`,
// `credentials/**`, `lib/**` at the package root — compiled to CommonJS under `dist/` at the same paths, which is what n8n
// `require`s from the `n8n.nodes` / `n8n.credentials` manifest paths. tsc also writes `lib/static-ops.json`, which
// `lib/ops.ts` imports; the codex files (`*.node.json`) and the icon are copied. n8n resolves `icon: "file:…"` relative to
// each node file, and the trigger names the ImageStep node's icon (`file:../ImageStep/imagestep.svg`), so one SVG serves both.
//
// TypeScript and this layout are what n8n's Creator Portal checks in the source repo: its automatic vetting failed 0.1.1
// with "Can't find credential file in repo" (imagestep#602), and n8n's verification guidelines ask for TypeScript.
//
//   node scripts/build.mjs        build into dist/
//   build(outDir)                 the same into another directory (the console's docs reference reads the node from one)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

/** Files next to the sources that tsc leaves alone but n8n reads: the codex and the icon. */
const ASSET = /\.(node\.json|svg)$/;

function assets(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return assets(path);
    return ASSET.test(name) ? [path] : [];
  });
}

export function build(outDir = join(root, "dist")) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json"), "--outDir", outDir], { stdio: "inherit" });
  for (const file of ["nodes", "credentials"].flatMap((dir) => assets(join(root, dir)))) {
    cpSync(file, join(outDir, relative(root, file)));
  }
  return outDir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  build();
  console.log("n8n-nodes-imagestep: built dist/");
}
