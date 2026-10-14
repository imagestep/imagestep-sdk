# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## Unreleased

### Changed

- `models list` reads the API's camelCase model fields and `params` (its Supported params column is the keys of
  `params`), ahead of the snake_case names going on 2027-01-12
  (https://imagestep.dev/docs/changelog#2026-10-14-model-fields). `-o json` prints the answer as the API sent it.
- `imagestep asset delete <id> -o json` prints the same shape for one id as for several, `{"deletedCount": 1,
  "deleted": ["<id>"]}`. One id used to print `{"deleted": 1}`.
- `imagestep asset upload` names the API's code beside a refused file's reason, e.g. `Rejected by server: File exceeds
  100 MB size limit (payload_too_large)`.

## 0.1.1 — 2026-10-03

### Fixed

- The package names ImageStep as its author, and the configuration code no longer carries maintainer-only notes
  about the development environment. No change in behaviour.

## 0.1.0 — 2026-10-03

First release of `imagestep`, the command-line client for the [ImageStep](https://imagestep.dev) API.

- `imagestep login`: browser sign-in over a loopback redirect with PKCE, so the API key never travels in a URL;
  `IMAGESTEP_API_KEY` works without any login for CI, containers and agents.
- `image`: synchronous transforms from the terminal, one subcommand per op the API offers today, nothing stored.
- `asset`, `jobs`, `preset`, `template`, `models`, `ops`, `webhook`, `feedback`, `usage`, `guidelines` and
  `skill` cover the rest of the API; `jobs submit --wait` and `jobs outputs --download` take a job from submit to
  files on disk.
- Made for programs as much as people: `-o json` prints exactly one JSON document on stdout (errors included), and
  the exit code says whether to fix the request (3), retry it (4) or look at the command line (1).
