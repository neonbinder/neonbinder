---
name: reference-blob-report-times-one-expect-across-runs
description: To tell a branch regression from CI variance on an E2E budget miss, read one expect's duration out of the pw-report blob (report.jsonl) across many PR runs, branch and main-based
metadata:
  type: reference
---

A spec that misses its 7 s budget by a hair is either a regression or the tail
of a slow-but-unchanged operation. Diffing code alone cannot tell them apart;
the CI blob reports can.

- `gh run download <run> -p 'pw-report-*'` then unzip each
  `report/blob/*.zip`; `report.jsonl` holds every step of every test, passing
  ones included, as `onStepBegin` (startTime, params.locator) and
  `onStepEnd` (duration, error). Match the step by its locator text (e.g.
  `Saved [0-9]+ cards`) and map testId to title via the `onProject` event.
- Sample the same step on 5-10 runs of the branch AND of other PRs (which
  stand in for main: E2E never runs on main itself). Overlapping
  distributions = variance, not a regression.
- `results.json` only has test.step durations, and the convex-logs-* artifact
  only carries log-line events, so neither times a single action.
- Check concurrency before blaming code: other shards commit large sets at
  the same second on the one preview deployment.

Example (NEO-339, 2026-10-21): wizard Confirm & Save to "Saved 300 cards" on
the 300-card BSC-only fixture took 3.4-6.0 s on main-based PRs and 3.4-6.5 s
on the branch; one >7 s miss was the tail. The commit path's code was
function-for-function unchanged. See [[e2e-viewport-is-the-ux-constraint]].
