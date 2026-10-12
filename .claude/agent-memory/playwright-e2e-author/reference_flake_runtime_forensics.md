---
name: flake-runtime-forensics
description: How to get RUNTIME proof (not elimination) for an intermittent E2E flake from a run's artifacts, and how to size a real fixture from a GREEN run before asserting on it
metadata:
  type: reference
---

Techniques proven during the NEO-81 set-selector flake sweep. Use when the user
demands PROVEN runtime evidence, not conclusions-by-elimination. (Originally
written against the Maestro suite; the technique is artifact-agnostic. Map "step
timestamps" to the Playwright report / JUnit step timings and "failure
screenshot + hierarchy" to the screenshot + `error-context.md`.)

## Capture artifacts FAST: they expire
`gh run download <run-id> -n <shard results artifact> -D <dir>`. Each shard's
artifact holds the failure screenshots, `error-context.md` and the report data.
All shard JOBS can show "success" even with failed specs (the gate job is what
reds), so read the gate and the per-spec results, not the shard's conclusion.
Never upload or commit traces (Clerk testing tokens).

## The strongest single technique: the in-run cross-client control
When spec A fails waiting on some query/render, find another spec B **in the same
run** that exercises the SAME query on the SAME deployment in an overlapping
window. Compare their step timings. If B resolved it in ~0.3 s while A stalled
16 s, the backend/query/data are healthy and the fault is **A's client**
(per-client websocket/subscription delivery), not the backend. This is MORE
probative than a fresh single-user reproduction because it uses the actual failing
deployment. Also check A's OWN earlier steps: if A's socket delivered shallower
queries fine right before, the stall is one specific late-added subscription, not
a socket outage.

## Concurrent-writer / contention check (refute or confirm)
Map every shard's per-spec execution window against the stall window. A
write-contention theory needs a spec that WRITES the same docs running DURING the
stall. (NEO-81: the only Topps-Chrome writer finished 58 s before, so contention was
refuted by timing.)

## Which runtime log sources are retrievable
- **CI preview Convex logs: retrievable, but only for ~15 minutes.** Take the
  deployment name from the `E2E / seed` job log, then `npx convex logs --deployment
  <name> --history 2000 --success --jsonl` as a logged-in CLI. It is read-only and
  needs no deploy key. `--history` caps at whatever the deployment still holds
  (~983 entries on a busy preview, 14 minutes), so **pull them while the run is
  still finishing or not at all.** It streams after printing the history, so wrap it
  in `timeout`.
- **PostHog query API: NOT accessible from repo env** (only the client ingestion
  key; HogQL needs a personal API key that isn't present).
- **Shared dev backend:** read-only `npx convex logs`/`env list` works, but `npx
  convex run` on an admin-gated query fails (`requireAdmin` needs a user JWT the CLI
  lacks), so measuring a query needs driving the app.

## Gotcha: don't over-read the loading UI
EntityColumn's idle "Sync X" buttons render whenever `syncStatus?.status !==
"syncing"`, true for BOTH `null` (resolved, no sync) AND still-pending (undefined).
So idle buttons do NOT prove `getSelectorSyncStatus` resolved. The only hard client
fact is EntitySelector's "Loading X…" = its `getSelectorOptions` is `undefined`.

## A re-run DELETES the previous attempt's artifacts: download first
`gh run rerun` bumps the run to attempt 2 and GitHub drops attempt 1's artifacts
(`/actions/runs/{id}/artifacts` returns `total_count: 0`). Cost paid on NEO-236:
the screenshot for the one red spec was gone before diagnosis started. **Download
the shard artifacts BEFORE asking for a re-run.**

What survives a re-run is the attempt-scoped job log:
`gh api repos/O/R/actions/runs/{id}/attempts/1/jobs` for the job ids, then
`gh api repos/O/R/actions/jobs/{job_id}/logs --allow-escape-sequences | sed 's/\x1b\[[0-9;]*m//g'`.
That tells you WHICH spec and WHAT error, never what the screen showed.

## Size a real fixture from a GREEN run before writing an assert on it
Before asserting on a list whose length is the marketplace's business, read the
count from the last green run's rendered text or the convex-logs
`adapter_sync_call` lines: NEO-300 found 2026 Bowman nests 141 parallels, which ruled
out asserting a row inside a disclosure that renders in a dialog's non-scrolling
header; and a 156-set reconcile Save measured 1.0 s, which is the measurement a
sanctioned longer wait needs recorded at the site (GUIDE hard rule 3), not an
inherited large number.
