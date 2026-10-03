# Contributing

Thank you for helping. A few things are different here from most repositories.

## This repository is an export

The code is developed in ImageStep's main repository, where the API and every client change together in one commit,
and exported here as snapshots. So:

- **Issues** are the best way to report a bug or ask for something. Please say which package and version, and include
  the `requestId` from the error if the API answered one.
- **Pull requests** are welcome. We do not merge them here: we apply the change in the main repository, credit you
  with a `Co-authored-by` line, and it arrives here with the next export, at which point we close your pull request
  with a link to it.
- Some generated files (the SDKs' API types) are written from the API's OpenAPI document upstream; please describe a
  change to them rather than editing them.
- The n8n node is exported to a repository of its own,
  [imagestep/n8n-nodes-imagestep](https://github.com/imagestep/n8n-nodes-imagestep); its issues go there.

## English only

Code, comments, documentation, issues, pull requests and commit messages here are in English.

## Issue references in comments

Comments in the code cite issues as `imagestep#123` or `#123`. Those numbers are in our internal tracker, not in this
repository's issues; they are kept so a line can be traced back to the decision behind it.

## Running the checks

```sh
pnpm install
pnpm check
pnpm test
pnpm test:python
```
