# ImageStep SDK

The client side of [ImageStep](https://imagestep.dev), the image step for your automations: generate, edit, remove
backgrounds, upscale, convert and read metadata as one reliable step in your code, an n8n workflow or an AI agent.

Everything that runs on your side of the API lives here:

| Directory | Package | What it is |
|---|---|---|
| [`sdk/js`](sdk/js) | [`imagestep`](https://www.npmjs.com/package/imagestep) on npm | JavaScript SDK for Node 20+, Deno, Bun and edge runtimes. Zero runtime dependencies, ESM + CommonJS, typed |
| [`sdk/python`](sdk/python) | [`imagestep`](https://pypi.org/project/imagestep/) on PyPI | Python SDK for Python 3.10+, with a sync and an async client |
| [`apps/cli`](apps/cli) | [`imagestep-cli`](https://www.npmjs.com/package/imagestep-cli) on npm | The command-line client, binary `imagestep` |
| [`packages/mcp`](packages/mcp) | [`@imagestep/mcp`](https://www.npmjs.com/package/@imagestep/mcp) on npm | MCP server: presets, assets and jobs as tools for agents. Also hosted at `https://mcp.imagestep.dev/mcp` |
| [`skills/imagestep`](skills/imagestep) | — | Agent skill for Claude Code, Codex or Cursor: `npx skills add imagestep/imagestep-sdk` |
| [`recipes`](recipes) | — | Complete pipelines to copy: a JS SDK script, an n8n template and a README each |

The n8n community node and trigger, [`n8n-nodes-imagestep`](https://www.npmjs.com/package/n8n-nodes-imagestep), have
a repository of their own: [imagestep/n8n-nodes-imagestep](https://github.com/imagestep/n8n-nodes-imagestep).

Each directory has its own README. The documentation is at [imagestep.dev/docs](https://imagestep.dev/docs), and the
API reference at [imagestep.dev/docs/api](https://imagestep.dev/docs/api).

## Quick start

Create an API key at [imagestep.dev/keys](https://imagestep.dev/keys), then:

```sh
npm install imagestep
```

```js
import { ImageStep } from "imagestep";

const client = new ImageStep({ apiKey: process.env.IMAGESTEP_API_KEY });

const asset = await client.assets.upload("./product.jpg");
const job = await client.ops.removeBg(asset.id, { wait: true });
const [cutout] = await client.jobs.outputs(job);
const [published] = await client.assets.publish(cutout.id);
console.log(published.publicUrl);
```

## How this repository works

The code here is exported from ImageStep's main repository, where the API and its clients change together, in one
commit. Each commit here is a snapshot of that export, and releases are tagged here: a `v*` tag publishes every
package whose version is not on npm or PyPI yet, with provenance, from this repository's GitHub Actions.

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Development

```sh
pnpm install          # Node 22.19+ for the workspace (the CLI's floor); pnpm is pinned by packageManager
pnpm check            # lint + format
pnpm test             # every JavaScript package's unit tests
pnpm test:python      # the Python SDK's tests (needs uv)
```

## License

MIT, see [LICENSE](LICENSE). Every package carries its own `LICENSE` and `THIRD-PARTY-NOTICES.md`.
