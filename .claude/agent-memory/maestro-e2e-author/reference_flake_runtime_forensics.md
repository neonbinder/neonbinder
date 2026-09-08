---
name: flake-runtime-forensics
description: How to get RUNTIME proof (not elimination) for an intermittent E2E flake — cross-client control from the same run's artifacts; which log sources are/aren't retrievable
metadata:
  type: reference
---

Techniques proven during the NEO-81 set-selector flake sweep (run 28600417580). Use when the user demands PROVEN runtime evidence, not conclusions-by-elimination.

## Capture artifacts FAST — they expire
`gh run download <run-id> -n maestro-report-runner-<N> -D <dir>`. Each runner artifact holds `debug/<flow>/maestro.log` (timestamped, step-by-step), `debug/<flow>/screenshot-❌-*.png` (at the failing assertion), `junit/*.xml`, and `logs/runner-<N>.results` (PASS/FAIL per flow). A failing runner's artifact is notably LARGER (~97KB vs ~40KB) because it carries the failure screenshot. All runner JOBS can show "success" even with first-attempt FAILs (CI retries pass on retry) — the first-attempt failures live in `.results` + the debug screenshots.

## The strongest single technique: the in-run cross-client control
When flow A fails waiting on some query/render, find another flow B **in the same run** that exercises the SAME query on the SAME deployment in an overlapping window. Compare their maestro.log timestamps for that step. If B resolved it in ~0.3s while A stalled 16s, the backend/query/data are healthy → the fault is **A's client** (per-client websocket/subscription delivery), not the backend. This is MORE probative than a fresh single-user reproduction because it uses the actual failing deployment. Also check A's OWN earlier steps: if A's socket delivered the shallower queries fine right before, the stall is one specific late-added subscription, not a socket outage. (NEO-81 Flake 1: r6 marketplace-read got getSelectorOptions(variantType) in 0.3s while r0 sets-resync stalled 16.8s, 5s apart, same set/deployment.)

## Concurrent-writer / contention check (refute or confirm)
Map every runner's per-flow execution window (`grep -oE '^[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}'` head/tail of each maestro.log) against the stall window. A write-contention theory needs a flow that WRITES the same docs running DURING the stall. (NEO-81: the only Topps-Chrome writer, topps-chrome-add-feature via feature propagation to variantType nodes, finished 58s before → contention refuted by timing.)

## Which runtime log sources are retrievable (2026-07)
- **CI preview Convex logs: NOT retrievable.** Ephemeral per-PR previews need a deploy key you don't have; `npx convex logs --url https://<dep>.convex.cloud` fails "No CONVEX_DEPLOYMENT set". Find the preview deployment name from the `E2E / setup`/`seed` job logs (it extracts the `x-convex-url` meta / prints `<dep>.convex.site`).
- **PostHog query API: NOT accessible from repo env.** Only the client ingestion key `VITE_POSTHOG_KEY` (phc_) is in .env.local; HogQL/query API needs a personal API key (phx_) that isn't present. (Client-side capture events like `selector_sync_fe_timeout` / `adapter_sync_call` exist but you can't query them without the personal key.)
- **Live shared dev backend:** a checkout whose `.env.local` is `CONVEX_DEPLOYMENT`-linked to it can run read-only `npx convex logs`/`env list` work from there. But `npx convex run` on an admin-gated query fails (`requireAdmin` needs a user JWT the CLI lacks), so measuring a query needs driving the app, not a direct call.

## Gotcha: don't over-read the loading UI
EntityColumn's idle "Sync X" buttons render whenever `syncStatus?.status !== "syncing"` — true for BOTH `null` (resolved, no sync) AND still-pending (undefined). So idle buttons do NOT prove getSelectorSyncStatus resolved; you can't infer table-specific asymmetry from the screenshot. The only hard client fact is EntitySelector's "Loading X…" = its getSelectorOptions is `undefined`.

## A re-run DELETES the previous attempt's artifacts — download first

`gh run rerun` bumps the run to attempt 2 and GitHub drops attempt 1's
artifacts: `/actions/runs/{id}/artifacts` returns `total_count: 0`, and the
repo-level `/actions/artifacts` list carries nothing for that run id either.
Cost paid on NEO-236 CI run 2 (33985966243) — the screenshot and
`screen-hierarchy` JSON for the one red flow were gone before diagnosis
started. **Download the `maestro-report-runner-*` artifact BEFORE asking for a
re-run.**

What survives a re-run is the attempt-scoped job log:
`gh api repos/O/R/actions/runs/{id}/attempts/1/jobs` for the job ids, then
`gh api repos/O/R/actions/jobs/{job_id}/logs --allow-escape-sequences | sed 's/\x1b\[[0-9;]*m//g'`.
That gives the per-flow `[Failed] <name> (Ns) (<maestro error>)` line and the
gate's `queue status: {"failed":N,...}` — enough to know WHICH flow and WHAT
error, never enough to see the screen.

Also note the runner jobs all conclude `success` even when a flow fails: the
queue records the failure and the separate `E2E / e2e` gate job is what reds.
Do not read "runner (7): success" as "nothing failed on r7".
