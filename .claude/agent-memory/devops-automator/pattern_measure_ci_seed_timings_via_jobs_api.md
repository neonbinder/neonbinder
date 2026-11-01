---
name: pattern_measure_ci_seed_timings_via_jobs_api
description: Measure E2E seed and shard durations per attempt from the GitHub jobs API (steps carry started_at/completed_at) instead of reading run logs; what the numbers looked like in late October 2026
metadata:
  type: patterns
---

`gh api repos/<repo>/actions/runs/<id>/attempts/<n>/jobs?per_page=100` returns
every job of that attempt WITH its steps, each carrying `started_at`,
`completed_at` and `conclusion`. That is enough to measure the seed's
"Scripted reset + reference catalogue" step, the `setup` project step and
each shard's wall-clock for every attempt of every run, without downloading a
single log. GraphQL is blocked from cloud sessions; REST is enough. ~1 call
per attempt, ~5 s each, so run it in the background for a week of runs.

Things that bit:
- `gh run list --json` has no `runAttempt`; use the REST `workflow_runs`
  listing (`run_attempt`) and iterate attempts 1..n yourself.
- A cancelled attempt still lists its jobs; the job in progress at the
  cancel shows `conclusion: cancelled` on the step that was running, which is
  how to tell "cancelled mid-seed" from "cancelled mid-shards".
- Labels in `e2e-seed-reset.sh`'s summary bracket more than they say:
  "import seconds" is export + import + export (NEO-330 loader). Measure the
  step, not the label.

Shape of the data over 145 runs / 209 attempts (2026-10-24..11-01): seed step
median ~126 s, p90 ~215 s, long tail to ~1000 s concentrated on a few
branches that were pushed to many times (a preview is reused per branch);
~28 % of attempts cancelled by the next push, almost all mid-shard.
