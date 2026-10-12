---
name: patterns-neo330-reference-seed-ci
description: NEO-330 private-bundle download in a public-repo E2E job — id-token:write is job-wide, gcloud echoes the gs:// URI, convex import errors can echo a row; what held (internal reset scope, fixed zip paths, no extraction)
metadata:
  type: project
---

NEO-330 loads a private prod-derived bundle into every PR preview from the E2E
seed job. Durable review points for any "fetch private data in CI on a public
repo" change:

- **`id-token: write` is job-wide.** Every later step (Maestro install,
  `npx --yes convex@x` with unlocked transitive deps, the PR's own scripts) can
  read `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and mint the WIF identity, and
  `google-github-actions/auth` also exports ADC env vars + writes
  `gha-creds-*.json` to the workspace ROOT. Check artifact paths never include
  the root; prefer the smallest job that needs the identity, or at least
  delete the creds file and blank the env after the one download.
- **`gcloud storage cp` prints "Copying gs://… to file://…"** — a repo
  *variable* is not masked. `::add-mask::` the URI (and the bucket) first, or
  run gcloud with `--no-user-output-enabled`.
- **Convex import/deploy schema errors include the offending document
  ("Object: {...}")** — a CLI child run with `stdio: inherit` puts a prod row
  into public Actions logs. Capture and redact.
- Check that a bundle can't be "valid but empty": a format/count/strip check
  passes an empty table, so a clobbered bundle seeds nothing silently. Ask for
  a non-zero floor per table.
- What held: the reset `scope` arg stayed on the `internalAction` with a
  literal-union validator (no public path); import-zip entry paths are built
  from fixed table names (no zip-slip; reads use `unzip -p`, never extract);
  spawn uses argv arrays and the deployment name is regex-validated first.

Related: [[patterns-convex-cli-target-selection]], [[patterns-testing-endpoint-gate]].
