import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * imagestep#210 — `imagestep jobs estimate` posted to `/api/v1/jobs/estimate`, a route the service has
 * never had: the dry run is the submit endpoint itself with `?dryRun=true` (contract §5), so the
 * command was a 404 from the day it was copied over. Pinned here: the URL, that the body is the
 * same body `submit` sends, and that `--op` (the catalogue vocabulary) goes out without a job type
 * for the service to overwrite.
 */
vi.mock("../src/config.js", () => ({
  getToken: () => "is_sk_abcdefghijklmnopqrstuvwxyz012345",
  clearToken: () => {},
  setToken: () => {},
  setEnv: () => {},
  getServiceUrl: () => "https://api.imagestep.dev",
  getAuthUrl: () => "https://imagestep.dev",
  getConfigFile: () => "/tmp/config.yml"
}));

const mod = await import("../src/commands/jobs.js");
const jobsCommand = mod.jobsCommand ?? mod.default;

function okJson(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okJson({ success: true, data: { totalItems: 1, estimatedCredits: 0 } }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function run(...args) {
  await jobsCommand.parseAsync(args, { from: "user" });
  const [url, init] = fetchMock.mock.calls[0];
  return { url, init, body: JSON.parse(init.body) };
}

describe("imagestep jobs estimate", () => {
  it("prices through POST /api/v1/jobs?dryRun=true", async () => {
    const { url, init } = await run("estimate", "--op", "resize", "--asset-ids", "a1", "--params", '{"width":1200}');

    expect(url).toBe("https://api.imagestep.dev/api/v1/jobs?dryRun=true");
    expect(init.method).toBe("POST");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends --op without a job type, because the service derives the type from the op", async () => {
    const { body } = await run("estimate", "--op", "resize", "--asset-ids", "a1, a2", "--params", '{"width":1200}');

    expect(body).toEqual({ op: "resize", assetIds: ["a1", "a2"], parameters: { width: 1200 } });
  });

  // imagestep#586 — images not uploaded yet are priced by how many; on estimate only, since a submit needs them.
  it("sends --image-count as imageCount beside the ids, and only on estimate", async () => {
    const { body } = await run("estimate", "--op", "remove_bg", "--asset-ids", "a1", "--image-count", "20");
    expect(body).toEqual({ op: "remove_bg", assetIds: ["a1"], imageCount: 20 });
    fetchMock.mockClear();
    await expect(run("estimate", "--op", "remove_bg", "--image-count", "0")).rejects.toThrow(/process\.exit\(1\)/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(jobsCommand.commands.find((c) => c.name() === "submit").options.map((o) => o.long)).not.toContain("--image-count");
  });

  it("still sends --type when there is no --op, and accepts render", async () => {
    const { body } = await run("estimate", "--type", "render", "--preset-id", "builtin-template-og-image");

    expect(body).toEqual({ type: "render", presetId: "builtin-template-og-image" });
  });

  // imagestep#414 — an inline chain: the steps a preset would store, sent as `steps`, no type and no preset beside them.
  it("sends --steps as the job's inline chain, as a JSON string or a file", async () => {
    const steps = [
      { op: "remove_bg", model: "fal-ai/bria/background/remove" },
      { op: "resize", parameters: { width: 1200 } }
    ];
    const { body } = await run("estimate", "--steps", JSON.stringify(steps), "--asset-ids", "a1");
    expect(body).toEqual({ steps, assetIds: ["a1"] });

    const file = join(tmpdir(), `steps-${process.pid}.json`);
    writeFileSync(file, JSON.stringify(steps));
    try {
      const fromFile = await run("estimate", "--steps", file, "--asset-ids", "a1");
      expect(fromFile.body).toEqual({ steps, assetIds: ["a1"] });
    } finally {
      rmSync(file, { force: true });
    }
  });

  // imagestep#466 — a consistency preset's subjects go beside its inline steps, as the array the preset stores.
  it("sends --subjects beside --steps, and refuses one that is not an array before sending anything", async () => {
    const steps = [{ op: "generate", prompt: "{{subject.hero}} on a windowsill" }];
    const subjects = [{ name: "hero", referenceAssetIds: ["ast_ref1"], descriptor: "a blue enamel kettle" }];
    const { body } = await run("estimate", "--steps", JSON.stringify(steps), "--subjects", JSON.stringify(subjects), "--count", "1");
    expect(body).toEqual({ steps, subjects, count: 1 });
    expect(() => mod.buildJobRequest({ steps: JSON.stringify(steps), subjects: JSON.stringify(subjects[0]) })).toThrow(
      /subjects must be a JSON array/
    );
  });
});

describe("variants, templates and rows (#266)", () => {
  it("sends --variants as the job's variants, so the dry run prices every size", async () => {
    const variants = [
      { name: "ig", parameters: { width: 1080, height: 1350 } },
      { name: "og", parameters: { width: 1200, height: 630 } }
    ];
    const { body } = await run(
      "estimate",
      "--op",
      "resize",
      "--asset-ids",
      "a1,a2",
      "--params",
      '{"fit":"cover"}',
      "--variants",
      JSON.stringify(variants)
    );

    expect(body).toEqual({ op: "resize", assetIds: ["a1", "a2"], parameters: { fit: "cover" }, variants });
  });

  it("sends --template-id and --items (read from a file) for render_template", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const rows = [
      { title: "Hi", site: "imagestep.dev" },
      { title: "Bye", site: "imagestep.dev" }
    ];
    const file = join(mkdtempSync(join(tmpdir(), "imagestep-rows-")), "rows.json");
    writeFileSync(file, JSON.stringify(rows));

    const { url, body } = await run("submit", "--op", "render_template", "--template-id", "builtin-template-og-image@1", "--items", file);

    expect(url).toBe("https://api.imagestep.dev/api/v1/jobs");
    expect(body).toEqual({ op: "render_template", templateId: "builtin-template-og-image@1", items: rows });
  });
});

describe("imagestep jobs list", () => {
  // #261: `--trigger-type` / `--automation-id` were accepted and silently ignored by the service, so a
  // script "filtered" and got everything. A filter the API does not have must not be spellable here.
  it("offers only the filters GET /api/v1/jobs honours", () => {
    const list = jobsCommand.commands.find((c) => c.name() === "list");
    const flags = list.options.map((o) => o.long);
    expect(flags).toEqual(
      expect.arrayContaining(["--status", "--type", "--page", "--per-page", "--op", "--root-job-id", "--created-from", "--created-to"])
    );
    expect(flags.filter((f) => /trigger|automation/.test(f))).toEqual([]);
  });

  it("the window and the op reach the service as the service spells them (#442)", async () => {
    fetchMock.mockResolvedValue(okJson({ success: true, data: [], meta: { page: 0, perPage: 100, total: 0 } }));
    await jobsCommand.parseAsync(
      ["list", "--op", "remove_bg", "--root-job-id", "job_root", "--created-from", "2026-09-14", "--created-to", "2026-09-21"],
      { from: "user" }
    );
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: "0",
      perPage: "100",
      op: "remove_bg",
      rootJobId: "job_root",
      createdFrom: "2026-09-14",
      createdTo: "2026-09-21"
    });
  });

  it("sends status and type and nothing that names an automation", async () => {
    fetchMock.mockResolvedValue(okJson({ success: true, data: [], meta: { page: 0, perPage: 20, total: 0 } }));
    await jobsCommand.parseAsync(["list", "--status", "failed", "--type", "process"], { from: "user" });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ page: "0", perPage: "100", status: "FAILED", type: "process" });
  });
});
