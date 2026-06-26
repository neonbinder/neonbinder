# NEO-49 — Dynamic E2E work-queue (design)

Branch: `jburich/neo-49-e2e-dynamic-queue`, stacked on `#51` HEAD `288d6d7` (rebase onto main after #51 squash-merges).

## Why
Static modulo sharding is imbalanced (slow flows cluster: we saw 12 vs 17.3-min legs at 4×2) and needs `SHARD_TOTAL` re-tuning as the suite grows (we're at <20% of the product). A shared pull-queue makes dispatch **dynamic (work-stealing)**: every runner drains the same pool, they all finish together, and growth is free — add flows (auto-queued) + add runners (more pullers), zero re-tuning. Bonus: the queue **is** the live run state → real-time monitoring + per-flow duration history (fixes the GH-API-lag / inferred-watcher pain).

## Architecture
Per-PR Convex preview is the shared, transactional coordinator. Convex mutations are serializable (OCC) → atomic "pop next pending" with no locks.

```
seed job        →  enumerate flows (find .maestro/flows) → POST /api/e2e/seed  (one runId)
runner matrix   →  homogeneous runner: [0..N]; each local worker loops:
                     claim → run maestro → markResult → repeat until claim returns null
gate ("e2e")    →  query getStatus(runId): failed==0 AND running==0 AND pending==0 → green
report          →  same as today (per-flow junit) OR rendered from the queue
```

## Pieces
- **DONE — Convex `e2eFlowQueue` table** (`convex/schema.ts`): `{runId, flowPath, status, claimedBy, attempts, startedAt, finishedAt}`, indexes `by_run_status`, `by_run_flow`.
- **DONE — Convex fns** (`convex/e2eQueue.ts`): `seedQueue` (idempotent), `claimNext` (atomic; optional lease-reclaim of dead-worker rows), `markResult`, `getStatus`. All fail closed in prod (`TESTING_RESET_SECRET` gate).
- **TODO — transport (REVISED).** A Vercel function CANNOT bridge to the per-PR preview Convex: `api/auth/testing.ts:153-156` documents that a Vercel function's `process.env.VITE_CONVEX_URL` is the **dev** Convex URL (from the dashboard), NOT the per-PR preview that the client bundle (`window.__convexUrl`) uses. So Vercel-fn → Convex would write the queue to the wrong deployment (dev), with a chicken/egg deploy problem. **Corrected approach: Convex HTTP actions** (`convex/http.ts`) wrapping the mutations (`/e2e/seed|claim|result|status`), gated by the `E2E_QUEUE_SECRET` header — co-located with the test data on the per-PR preview, per-PR isolated, no dev coupling. The bash runner calls the preview Convex **`.convex.site`** HTTP URL directly (it's public; no Vercel protection, so no bypass proxy needed).
  - **Resolve the preview Convex URL once**: the `setup` job already outputs the Vercel preview URL; have it ALSO output the Convex URL by fetching the preview app and extracting `window.__convexUrl` (or the bundled `VITE_CONVEX_URL`), and pass it to the runner jobs (like `needs.setup.outputs.url`). Runner hits `${CONVEX_SITE_URL}/e2e/claim` etc.
- **TODO — `run-e2e-smoke.sh`**: replace the modulo-partition + lane/category machinery with: bootstrap workers (unchanged) → each worker loops `curl POST $APP_URL/api/e2e/claim {runId,claimedBy} → run flow → curl POST .../result`. `runId` = `$GITHUB_RUN_ID` (passed in). The `x-testing-auth` secret comes from a GH secret, **never** via Maestro `-e`. Keep the existing per-worker `WORKER_INDEX`/account mapping + warm-once bootstrap.
- **TODO — workflow**: add an `enqueue` step (after seed; enumerate flows → POST /api/e2e/seed). Matrix becomes homogeneous `runner: [0..N]` (drop SHARD_INDEX/SHARD_TOTAL). The `e2e` gate job (already added in #51) stays — point it at `getStatus` (or keep aggregating leg exit codes; legs now exit nonzero if any of their claimed flows failed). `report` unchanged.
- **TODO — monitoring**: `api/e2e/status` already gives counts; optional tiny `/testing/run-status?runId=` page or a one-line `curl` for live progress.

## Security posture (for audit)
- **Prod fail-closed (critical):** Convex fns throw unless `TESTING_RESET_SECRET` set (dev/preview only); Vercel fns 404 unless `VERCEL_ENV` preview/dev. The queue cannot exist in prod.
- **Caller auth:** Vercel fns require `x-testing-auth === TESTING_ENDPOINT_SECRET` (a GH secret in CI, never in Maestro `-e` per NEO-29).
- **Data sensitivity:** queue rows are ephemeral, per-run test metadata — flow paths + pass/fail. No PII, no credentials, no product data.
- **RESOLVED by security audit (was an OPEN QUESTION):** env-presence + Vercel-layer auth is NOT enough. The Convex URL is in the preview client bundle (`window.__convexUrl`), so anyone who loads the preview could call `markResult` directly, bypass the Vercel `x-testing-auth`, and force a FALSE-GREEN on the merge-blocking `e2e` gate (main auto-deploys to prod) — a CI-integrity hole independent of data sensitivity. FIX (applied in `convex/e2eQueue.ts`): every fn now takes a `secret` arg compared to a dedicated `E2E_QUEUE_SECRET` env (presence = enabled, dev/preview only → prod fail-closed; decoupled from `TESTING_RESET_SECRET`). Plus `flowPath` is validated `^\.maestro/flows/[A-Za-z0-9._/-]+\.yaml$` (it reaches `maestro test "$flow"` on a secret-holding runner) and `seedQueue` bounds the batch.
- **Provisioning owed (when wiring CI):** set `E2E_QUEUE_SECRET` on the Convex **preview** env (`convex env default set --type preview`) AND give the `api/e2e/*` Vercel functions the same value (so they forward it). Verify prod has NEITHER `E2E_QUEUE_SECRET` (Convex) NOR `TESTING_ENDPOINT_SECRET` (Vercel). In runner/api: never `echo`/`set -x` the curl carrying the secret; keep it out of Maestro `-e`; keep `commands-*.json` excluded from artifact upload.
- **Re-audit owed:** once `api/e2e/*` + the rewritten `run-e2e-smoke.sh` exist (this review covered the contract, not the implementation).

## Sequencing
1. (this branch) build + locally typecheck the Convex fns, Vercel fns, runner, workflow.
2. Security-auditor review of the endpoint design BEFORE wiring CI.
3. After #51 merges: rebase onto main (`git rebase --onto origin/main 288d6d7`), open PR, drive green.
