# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

## 0.1.2 — 2026-10-24

### Added

- No colour when `NO_COLOR` is set to anything but an empty string (https://no-color.org), or with the new global
  `--no-color` option: the log lines, the `-o json` / `-o yaml` highlighting and the table borders. `--no-color` used to
  fail as an unknown option, and `NO_COLOR` was ignored; only a pipe or `TERM=dumb` turned colour off.

### Changed

- `models list` reads the API's camelCase model fields and `params` (its Supported params column is the keys of
  `params`), ahead of the snake_case names going on 2027-01-12
  (https://imagestep.dev/docs/changelog#2026-10-14-model-fields). `-o json` prints the answer as the API sent it.
- `imagestep asset delete <id> -o json` prints the same shape for one id as for several, `{"deletedCount": 1,
  "deleted": ["<id>"]}`. One id used to print `{"deleted": 1}`.
- `imagestep asset upload` names the API's code beside a refused file's reason, e.g. `Rejected by server: File exceeds
  100 MB size limit (payload_too_large)`.

### Fixed

- A PEF, SRW, NRW or another RAW format that is a TIFF container counts as that RAW, not as `image/tiff`:
  `asset upload --mime-type pef` used to skip every PEF and `--mime-type tiff` took them in.

### Security

- `undici` `^8.12.1` → `^8.12.2` ([GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), high:
  8.0.0–8.12.1 are affected). The CLI loads it only to accept a self-signed certificate on an `https://…localhost` API URL.

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
