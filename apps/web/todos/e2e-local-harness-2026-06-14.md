# Local E2E harness — persistent workers on the real NEO-49 queue (2026-06-14)

Goal: validate the locally-failing Maestro flows the SAME way CI does. We drive the
**exact CI runner** (`run-e2e-queue.sh`) against the **real Convex `/e2e` work-queue**
(on the dev deployment), with **2 persistent workers**. Agents drip flows in and watch
for their own flow — no per-test stop/start, no `/tmp/...lock`.

## Why this == CI
- Same runner script, same `claimNext`/`markResult` path, same `maestro test` invocation
  and report flags. Headless = CI's 1024×629 viewport. 2 workers exercises real
  parallelism/contention (the class of bugs that only show under load).
- The only additions are **flag-gated and CI never triggers them**:
  - `run-e2e-queue.sh`: `E2E_QUEUE_DAEMON=1` → poll-forever instead of exit-on-drain.
  - `convex/e2eQueue.ts` + `convex/http.ts`: `enqueueFlows` / `getFlow` (+ `/e2e/add`,
    `/e2e/flow`) for drip-enqueue + per-flow watch. `seedQueue` (CI path) is untouched.

## One-time prereqs
- `E2E_QUEUE_SECRET` is already set on the dev deployment (verified 2026-06-14).
- JDK 21 at `/opt/homebrew/opt/openjdk@21/...`; Maestro installed (`~/.maestro/bin`).
- Worker accounts `TEST_EMAIL_0` / `TEST_EMAIL_1` provisioned (they are).

## Run it
```bash
# 1. Push the Convex fns to dev (one-shot; --typecheck disable dodges NEO-48 test-file tsc noise):
npx dotenv-cli -e .env.convex -- npx convex dev --once --typecheck disable

# 2. Vite up via the auto-restart keeper (local Vite SIGSEGVs; needs Node 24.3.0):
./vite-keeper.sh                      # leave running (own terminal/background); serves https://localhost:3000

# 3. Start the harness (2 persistent workers; staggered bootstrap):
./e2e-local-up.sh                     # leave running; WORKERS=2 by default

# 3. From anywhere in the repo, drip flows + watch:
./e2e-enqueue.sh .maestro/flows/set-selector/team-picker.yaml
./e2e-watch.sh   .maestro/flows/set-selector/team-picker.yaml
#    → ✅/❌ + maestro-report/junit/<slug>.xml + maestro-report/debug/<slug>/

# stop: Ctrl-C in the e2e-local-up.sh terminal (or: touch .e2e-local/stop)
```
`<slug>` = flow path with `.maestro/flows/` stripped and `/`→`_` (e.g.
`set-selector/team-picker.yaml` → `set-selector_team-picker`).

## RULES for background agents (load-bearing)
1. **Enqueue + watch only.** NEVER run `maestro` / `npm run test:e2e*` directly — the
   harness workers are the only maestro processes. A 2nd ad-hoc Chrome crashes the
   laptop and contends global `selectorOptions`.
2. Re-enqueue after a fix: `./e2e-enqueue.sh <flow>` resets an already-run flow to
   pending so it re-validates.
3. Forensics on FAIL: read `maestro-report/junit/<slug>.xml` and
   `maestro-report/debug/<slug>/` (screenshots) — never guess from a summary.
4. Pollution: if a set-selector flow needs a clean slate (#28/#30), use the
   **"Reset Set Builder Data"** admin button in the app (global wipe) before re-enqueuing.

## Caveats / watch-items
- 2 workers = 2 headless Chromes. If the laptop crashes tabs, drop to `WORKERS=1`.
- Workers share one dev SL/BSC account → bootstraps are staggered (`BOOTSTRAP_STAGGER`,
  default 90s). Marketplace-fetch flows running concurrently on both workers may 503 —
  same as CI; the runner's retry covers transient ones.
- Cross-session queue rows accumulate in dev under old `runId`s (harmless; each
  `e2e-local-up.sh` start mints a fresh `local-<epoch>` runId).

## Files
- `run-e2e-queue.sh` (CI runner; daemon flag added) · `e2e-local-up.sh` (orchestrator,
  2 workers) · `e2e-enqueue.sh` · `e2e-watch.sh` · `convex/e2eQueue.ts` + `convex/http.ts`
  (enqueueFlows/getFlow + /e2e/add, /e2e/flow). `.e2e-local/` is gitignored.
