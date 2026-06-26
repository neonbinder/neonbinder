# Flow Stabilization — Resume Notes (2026-06-11, post-reboot)

**Branch:** `jburich/sync-maestro-agent-memory` (PR #53). Working-tree only; nothing committed/pushed.

## 🟢 THE BREAKTHROUGH: infra instability is fixed
The dominant adversary all day was an intermittent **JVM SIGSEGV in G1 garbage collection** (`G1ConcurrentMark::mark_in_bitmap`) — it produced the morning's 20 `hs_err` logs, drove the agent "Abort trap" cascades, and made every validation unreliable (agents kept *retrying through* the crashes and mislabeling the recoveries).
**Fix (proven): `export JAVA_TOOL_OPTIONS="-XX:+UseSerialGC"`** for all Maestro runs. A 2-hour batch post-fix logged **0 infra crashes, 0 new hs_err** (vs crashes on every prior attempt). Bake this into the runner permanently. (Also: a full reboot cleared the degraded Chrome/JVM state.)

## Validation runner that works (operator-driven, NO agents for maestro)
Agents CANNOT be trusted to run maestro — they spawn detached `run_in_background` retry scripts that cascade (proven 3×). **Author with agents (safe), but the OPERATOR runs all validation** via controlled scripts:
- Vite keeper: `/tmp/vite-keeper.sh` (Node 24.3.0, auto-restart). Vite = `dev:focused-fox-53` (https://localhost:3000).
- Batch validator: `/tmp/batch-validate.sh` (SerialGC, parallelism=1, picker `name:` comma-list, holds the conch the whole time).

## Batch results (fresh machine, SerialGC) — 3 green / 3 red, all diagnosed
- ✅ #31 parallel-grouping-reject (173s) · ✅ #33 sets-resync (35s) · ✅ #30 cancel-discards (passed, but 34min pollution-slow)
- ❌ #28 move-parallels — **data pollution** (hundreds of accumulated `${ATTEMPT_ID}` inserts in `pg-move-0`; 36-min run; Maestro can't scroll inner overflow containers)
- ❌ #32 set-attributes-edit / ❌ #34 tcdb-auto-enrich — **intermittent Clerk login** (both stuck on the sign-in page; 3 other flows signed in fine same batch). Re-running 2026-06-11 to see if it clears.

## 🔴 BLOCKER: clearing the set-builder pollution is non-trivial
`resetSetBuilderData` (convex/selectorOptions.ts:2010) wipes all selectorOptions BUT:
- It's `requireAdmin`-gated → `npx convex run` fails with "Not authenticated" (CLI has no admin JWT).
- `/testing/reset` only calls `resetMyTestState` (per-user profiles), NOT set-builder data.
- No UI button calls it. So there is currently **no working trigger** for it.
- **To clear:** need to add a trigger (testing-authed reset endpoint, an admin UI button, or a script with an admin token), OR manually delete via Convex dashboard.

## 📋 LINEAR ITEM TO FILE (Linear MCP token expired — file when re-auth'd)
**Title:** Custom set-builder entries (selectorOptions) can be added but never deleted — blocks E2E self-cleanup + leaves no pollution-reset path
**Body:** The Set Builder lets users "+ Custom" add custom sets/variant-types/inserts, but there is **no delete capability** — no UI affordance in `EntityColumn.tsx`, and the only delete mutation is `deleteCard` (cards). Consequences: (1) E2E parallel-grouping flows (#28/#30/#31) accumulate inserts across local re-runs and can't self-clean (CI is unaffected — fresh preview per run); (2) the only bulk reset `resetSetBuilderData` is admin-gated with no callable trigger. **Fix options:** (a) testing-only `deleteMyTestInserts(setName)` mutation gated to the test user + a testing reset endpoint (lightest; security-auditor review); (b) real "remove custom entry" product feature (UI ✕ + `deleteSelectorOption` mutation). Either also gives us a way to clear the dev pollution.

## NEXT STEPS (resume here)
1. Get a working set-builder reset trigger → clear `pg-move-0`/`pg-cancel-0` pollution → re-validate #28 (then we'll see if its crowded-column fix logic is actually green).
2. Confirm #32/#34 (Clerk-login intermittent) — re-run in progress; if they keep failing on Clerk, that's an auth-reliability issue to chase (PostHog `credential_test_failed` / Clerk testing tokens).
3. The remaining walk: #35–#57 still un-walked.
