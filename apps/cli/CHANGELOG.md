# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/),
and before 1.0 a minor version may change the interface.

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
