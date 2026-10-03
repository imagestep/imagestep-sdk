import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * imagestep#658 — `server.json` is the entry in the official MCP registry (`mcp-publisher publish`), and the registry
 * checks it against npm: the package must exist at that version and carry the same `mcpName`. Held to package.json here,
 * so a version bump without the entry, or the entry without the bump, is red before it reaches the registry.
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const bin = readFileSync(new URL("../bin/imagestep-mcp.js", import.meta.url), "utf8");

describe("server.json, the MCP registry entry", () => {
  it("is named by the package's mcpName", () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it("describes this version of this npm package", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, version: pkg.version });
  });

  it("names the environment variable the stdio server reads", () => {
    const [variable] = server.packages[0].environmentVariables;
    expect(bin).toContain(`process.env.${variable.name}`);
    expect(variable).toMatchObject({ isRequired: true, isSecret: true });
  });

  it("fits the registry's description limit and points at this package's source", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.repository).toMatchObject({ source: "github", subfolder: "packages/mcp" });
    expect(pkg.repository.url).toContain(server.repository.url.replace("https://", ""));
  });
});
