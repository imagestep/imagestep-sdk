# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## 0.1.0 — Unreleased

First release of the [ImageStep](https://imagestep.dev) MCP server: the image pipeline for agents, as MCP tools.

- Tools: `generate`, `transform` (every op in the catalogue but `generate`), `run_preset`, `job_status`,
  `search_assets`, `save_preset` and `send_feedback`. Images never enter the context window: every tool takes and
  returns asset references (ids, sizes, public URLs).
- Every tool that spends money has `dry_run` (the exact price, nothing created), and every error carries
  `retryable`, `param` and the service's request id. Write tools take an optional `idempotency_key`, so a retried
  call returns what the first one did instead of doing it twice.
- Runs over stdio on your machine (`npx -y @imagestep/mcp`, local files as input) or over HTTP; the same server is
  hosted at `https://mcp.imagestep.dev/mcp`.
