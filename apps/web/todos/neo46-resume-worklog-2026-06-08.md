# NEO-46 resume worklog — 2026-06-08 (after laptop crash)

Branch: `jburich/neo-46-scale-out-e2e-regression-across-multiple-free-runners-matrix` · PR #51
Plan: `~/.claude/plans/overnight-you-were-working-compiled-cherny.md`

## Root cause of the red on `d52b25c` (NOT sharding)
The "single setup track" refactor (`c8af6af`→`90bc204`→…) dropped `provides:setup-done` from the
producer but left `requires:setup-done` dangling on ~13 consumer flows → dep-graph skips them
("prerequisite not satisfied" = 13 of 14 failures). The uncommitted edits correctly FINISHED
removing the dangling `requires:` tags + excluded `setup` from threads — but the pre-matrix seed
job that replaces in-matrix setup didn't exist yet. That's the missing half.

## DECISION (user-confirmed 2026-06-08)
Pre-matrix **seed job** + **full cross-shard distribution** (not "keep setup on shard 0"). Setup
seeds the shared per-PR Convex preview once before the matrix fans out; every flow is independent.
Also confirmed: **dedup = propose & wait** (no autonomous deletes); **parallelism tuning is in scope**.

## User guidance while away (2026-06-08)
- Individual flows must keep passing (p=1) as I convert. Parallel (p=2) failures are EXPECTED/OK until Phase 5.
- Swap Phase 4 & 5: do commit/verify/drive-green FIRST, dedup LAST (still needs approval). "We can dedup later."

## Phase order (adjusted): 1 → 2 → 3 → 5 → 6 → 4(dedup, await approval)

---

## ✅ PHASE 1 — Pre-matrix seed infrastructure (DONE, validated plan-only)
- **`run-e2e-smoke.sh`**: added `setup` SELECT_MODE = the ONLY entry point that runs setup-tagged flows.
  Selects exactly `setup.yaml → setup-insert.yaml → setup-parallel.yaml` in EXPLICIT order (skips `sort -u`),
  forces `PARALLELISM=1` (single ordered writer; global reset must not race). Kept the uncommitted
  setup-exclusion in all/tag/grep modes + flat `is_distributable_flow() return 0`.
- **`.github/actions/maestro-runner/action.yml`** (NEW composite): bypass proxy + pinned Java/Chrome/Xvfb/Maestro.
  Shared by `seed` and `e2e` so runner prep never drifts. Faithful copy of the old inlined e2e steps.
- **`.github/workflows/e2e-tests.yml`**: new `seed` job (needs setup; runs `npm run test:e2e -- setup` at p=1,
  uploads `maestro-report-seed`); `e2e` refactored to use the composite + `needs: [setup, seed]`.
- **Verified resetMyTestState is per-user** (convex/testing.ts:30 — deletes only caller's publicProfiles/
  userProfiles/prizePool; NEVER touches global selectorOptions/cardChecklist/players/teams). So the matrix
  legs' Phase-0 worker-bootstrap (/testing/reset) can't wipe the seeded baseline. Seed-then-matrix is sound.
- **Validation (plan-only)**: `bash -n` clean; `setup` → 3 flows in order, p=1, all independent;
  shard0/shard1 partition disjoint + exhaustive (union 43 = single-shard total), NO setup leak,
  marketplace backbone (12) shard-0-only, global worker indexing shard0→EMAIL_0..1 / shard1→EMAIL_2..3.
- **Not yet committed.** Workflow YAML parses; job graph setup→seed→e2e→report correct. (actionlint
  download blocked by sandbox; relied on YAML parse + faithful copy.)

## ✅ PHASE 2 — Isolation correctness (DONE — already correct, NO edits needed)
- **Global-reset hazard = FALSE ALARM.** Only `setup.yaml:75` actually `tapOn: "Reset Set Builder Data"`.
  The checklist-fetch-cancel-dialog match was a COMMENT (line 28, local-run note). That flow also already
  engineers around a populated players/teams table (adds a uniquely-named custom player to force the dialog),
  so it's compatible with the seeded baseline. (Stale FRESH-DB comment can be cleaned in Phase 3.)
- **Per-worker namespacing CORRECT.** util-drill-to-custom-set.yaml uses `E2E Test Sport ${WORKER_INDEX}`
  throughout; WORKER_INDEX is the GLOBAL index (run_flow_on_worker passes global_worker) → shard0=...0/1,
  shard1=...2/3, no cross-shard collision. It already uses `below:{id:"Search sets"}` (not index:).
- **Credential restore CONFIRMED.** test-/save- bsc/sl flows all end with /testing/seed-credentials?redirect=/profile.

## Phase 3 precise scope (REAL index: selectors, comments excluded): 7 set-selector flows
  features-propagation, multi-source-panel-opens-dialog, set-attributes-edit, team-picker,
  topps-chrome-marketplace-read, tcdb-auto-enrich, topps-chrome-add-feature. (utils already converted.)
  Plus extendedWaitUntil{timeout} → 7s default where not marketplace/cold-sync. Delegate to maestro-e2e-author.

## Commits this session
- fba3603 ci: pre-matrix seed job + setup-only scheduler entry + composite action
- cf18661 test: finish flat-model tag migration
- 00b43e0 test: index: → below:{id:} in 7 flows (PUSHED — validated seed job)
- 3c8dce8 test: 2 shard-0 marketplace flow fixes (NOT pushed — batching with admin grant)

## ✅ KEYSTONE VALIDATED IN CI (run on cf18661, repeated on 00b43e0)
- setup ✓ → **seed SUCCESS (~9 min)** → e2e legs correctly waited (needs:[setup,seed]) → report ✓.
- Suite went from 28/14 (broken) → **40 passed / 7 failed**. The seed-then-matrix architecture WORKS.

## ✅ PHASE 3 (index: conversions) — done, pushed (00b43e0). 7 flows: index: → below:{id:}.

## 🔬 PHASE 5 forensics — the 7 failures on 00b43e0, ALL root-caused (no flaky excuses):
### (5 of 7) dev+e2e-4 is NOT a Clerk admin  ← user's hypothesis, CONFIRMED
- Clean 100% split by user on shard 1: TEST_EMAIL_2 (dev+e2e-3) = 5/5 set-selector PASS;
  TEST_EMAIL_3 (dev+e2e-4) = 5/5 FAIL. Read-only Clerk API: dev+e2e-1/2/3 role='admin',
  **dev+e2e-4 role=None**. AdminLayout (src/layouts/AdminLayout.tsx) bounces non-admins from
  /set-selector → /dashboard (screenshot proof: failing flows land on the Dashboard).
- FIX: set publicMetadata.role='admin' on dev+e2e-4 (user_3EhKp3oAWBR9rVblBUsP0n1gq6z), Clerk dev sk_test.
  Agent PATCH was sandbox-blocked (privilege elevation) → AWAITING user to run it (Option A `!` command) or re-authorize.
- Phase 6 NOTE: TEST_EMAIL_4..7 (dev+e2e-5..8) will also need admin when the matrix widens.
### (2 of 7) real shard-0 flow bugs — FIXED in 3c8dce8
- refresh-sportlots-creds: footer-steal on "Clear Credentials" (y=557) → added centerElement: true.
- checklist-fetch-cancel-dialog: final Fetch/Refresh assert off-screen after scroll-down → scrollUntilVisible UP to
  id "Sync card checklist"; + made custom card ATTEMPT_ID-unique (retry was duplicating #9001).

## ✅ ADMIN GRANT APPLIED + 3c8dce8 PUSHED (full validation run in flight, pr-watcher armed).
- dev+e2e-4 → role=admin (verified). 3c8dce8 = the 2 shard-0 fixes. Expect a clean/near-clean run.

## ✅ PROVISIONED 8-WORKER CAPACITY (user: "provision all clerk users, needed for sure") — for Phase 6.
- Clerk: created dev+e2e-5..8 (mains, role=admin) + dev+e2e-5..8-profile. Verified ALL 8 mains (e2e-1..8) = admin.
  New ids: e2e-5 user_3ErKn1C2BTc8aQX6zdTj6l624Lh, e2e-6 user_3ErKnFWUYxAVmbRZQORM6nmP1n0,
  e2e-7 user_3ErKnTxxqKvpjNyZpjTyV1EsAY5, e2e-8 user_3ErKnNqrxRzpVIDnXV5ihH7b4xT (+ profiles).
- Vercel Preview: added TEST_EMAIL_4..7 + NEW_PROFILE_TEST_EMAIL_4..7 (→ dev+e2e-5..8 / -profile). Take effect next preview build.
- Ready for up to 8 workers (4×2). reference_e2e_test_account_provisioning memory updated with the MANDATORY admin-grant step.

## PHASE 6 plan (after 2×2 confirmed green): widen matrix [0,1]→[0,1,2,3], SHARD_TOTAL "2"→"4", measure wall-clock.
- CAVEAT to measure: shard 0 owns the serial-marketplace backbone (12 flows, shard-0-only) = likely the wall-clock FLOOR.
  4 shards offloads shard-0's INDEPENDENT slice to shards 2/3 but NOT its marketplace-serial time. If marketplace dominates,
  4×2 ≈ 2×2 — the real win needs shrinking the marketplace backbone (deeper, separate work). Measure before committing a config.

## ✅✅ MILESTONE (d6fb59d) — serial-marketplace ELIMINATED, every flow independent, FULLY GREEN at 2×2.
- 23/0 + 24/0 + seed 4/0; "Phase 0 complete" ×3 (both shards warmed marketplace successfully — incl. shard-1 workers
  warming for the FIRST time, zero rate-limit issue → confirms no concurrent-login limit). Total 33.5 min, shards
  balanced (e2e0 22.1 / e2e1 22.7) vs the old 25.6/16.4. The sellerId force-login (test-masking-a-bug) removal was the
  last fix. User's warm-once-reuse hypothesis fully validated.
- Timing breakdown: setup 1.8 + seed 8.7 + max(legs ~22) + report 0.1 = 33.5 min.

## PHASE 6 (in progress): widen 2×2 → 4×2. matrix [0,1]→[0,1,2,3], SHARD_TOTAL "2"→"4". Accounts e2e-5..8 provisioned + admin + Vercel vars.
- Expect each leg ~11-13 flows/shard → matrix ~13 min → total ~setup 1.8 + seed 8.7 + ~13 + 0.1 ≈ ~24 min.
- After 4×2: the SEED (8.7 min, serial pre-matrix) becomes the dominant fixed cost (~36% of total) → next optimization target (cascade), separate from sharding.

## STILL OWED (lower priority): scheduler tidy (delete dormant isolated/marketplace/depgraph lane code now 0 flows);
## extendedWaitUntil{timeout}→7s convention pass (won't change pass/fail); Phase 4 dedup proposal (await user approval).
