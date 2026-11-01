---
name: patterns_convex_run_long_action_budget
description: `npx convex run` of an internalAction gives up after ~5 min (bare "Error", exit 1) while the action keeps running; any seed/admin action that pages a whole table needs a time budget + resume cursor, and the caller loops (e2e-baseline.sh reset pattern)
metadata:
  type: pattern
---

## The CLI wait is the limit, not the action's

`npx convex run <internalAction>` waits ~5 minutes for the result, then prints a
bare `Error` and exits 1 while the action continues server-side (first seen on
the reset action; e2e-baseline.sh documents it). An action that pages ~100k+
rows through `ctx.runQuery` (4000 rows a page, dozens of round trips) finishes
in well under a minute on a healthy deployment but can cross 5 minutes on a
slow one, and the caller then sees an ordinary failure, not a timeout.

**House pattern** (e2e-baseline.sh `reset`): the action takes a time budget
(~2.5 min), returns `{complete:false, resume:...}` with its partial result,
and the shell/Node caller loops until `complete:true` with a hard pass cap.
Apply it to every new read-everything or delete-everything action the seed or
an admin script runs via `convex run`; a single unbounded call is a latent CI
red that looks like a PR failure.

## Reading a deployment through functions instead of `convex export`

A snapshot export is a Convex job outside our functions and can hang while the
deployment answers reads in 100 ms. Reading table numbers (`normalizeId` probe
over `encodeId(n, zeros)`), emptiness and counts through internal functions
run with the deploy credentials removes that dependency, but it couples the
loader to the target having the *current* code deployed; in CI that holds
because `web-preview` (which runs `convex deploy`) is a `needs:` of `e2e`.
Every schema table on a fresh deployment already has a table number (the
export always lists them, empty or not), so a "no table number" refusal means a
misspelt table or stale code, not an empty table.

## Measure what a limit measures

`e2e-seed-reset.sh` times the whole `cli.mjs load` as "import seconds" and
compares it to `NB_SEED_MAX_IMPORT_S`; preflight and the verifying count walk
are inside that number. Any read added to the loader eats into the import
limit's headroom, so re-baseline the limit from CI summaries after changing
what the loader does around the import.
