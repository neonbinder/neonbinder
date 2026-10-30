---
name: cross-run-artifacts
description: A CI job that reads another run's artifacts (timings, reports) must treat them as untrusted — fork PRs run their own workflow edits and can upload anything
metadata:
  type: reference
---

When a workflow downloads artifacts from OTHER runs (e.g. e2e.yml's `timings` job
reading recent `pw-merged` reports, NEO-389), the artifact is untrusted input:

- A fork PR runs its own edited copy of the workflow, so its run can "succeed"
  and upload a crafted artifact. Filter run listings to this repo's branches:
  `gh api repos/$GITHUB_REPOSITORY/actions/workflows/<file>/runs?status=success`
  with `--jq '... select(.head_repository.full_name == env.GITHUB_REPOSITORY)'`.
  (`gh run list --json` has no head-repository field.)
- Clamp any number taken from it, and make sure it can only weigh or order
  work, never decide what runs (the spec list must come from the checkout).
- Download into `$RUNNER_TEMP` and copy the one expected file by name; never
  download straight into the source tree of a job that holds secrets.
- A step that builds output from the artifact should fall back on failure,
  never fail the suite, and flag `fresh` only after every check passed.
