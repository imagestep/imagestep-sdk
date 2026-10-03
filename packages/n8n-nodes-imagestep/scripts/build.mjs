// Build = copy. The sources are plain CommonJS, which is exactly what n8n `require`s from the
// `n8n.nodes` / `n8n.credentials` manifest paths, so there is nothing to compile: `src/**` becomes
// `dist/**` byte for byte, and the one SVG icon is duplicated into the trigger's directory because
// n8n resolves `icon: "file:…"` relative to each node file.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(src, dist, { recursive: true });

const icon = join(dist, "nodes", "ImageStep", "imagestep.svg");
const triggerIcon = join(dist, "nodes", "ImageStepTrigger", "imagestep.svg");
if (!existsSync(triggerIcon)) cpSync(icon, triggerIcon);

console.log("n8n-nodes-imagestep: built dist/");
