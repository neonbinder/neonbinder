# E2E sharding + reliability plan (NEO-46 / NEO-47) — 2026-06-04

Plan only. **Blocked on the current in-flight PR merging to main.** When it lands: branch each
ticket off LATEST main in its own worktree (`jburich/neo-46-...`, `jburich/neo-47-...`), squash-merge,
launch pr-watcher after every push.

## Decisions locked (owner, 2026-06-04)

1. **Sync coverage stays — do NOT seed it away.** Auto-sync (Football→2026→Topps→… fetch + reconcile
   from BSC/SL) is the product; the suite must keep proving it works. NEO-47's original "remove the
   auto-sync dependency from drills" is wrong as written and is being **reframed to a fixture-vs-sync
   split** (see Phase B).
2. **Stand up the matrix NOW** against today's cascade (NEO-46). The audit + fixture-seed work is a
   fast-follow (Phase B), not a prerequisite.
3. **Start width 2×2** (2 shards × 2 workers = 4 global workers, `TEST_EMAIL_0..3`). Scale to 4×2
   (8 workers, `TEST_EMAIL_0..7`) once the wiring is proven green. Width is just the matrix list +
   account count.

## The core architectural fact

`run-e2e-smoke.sh` already classifies every flow into four buckets (`run-e2e-smoke.sh:241-249`):

| bucket | touches | shardable? |
|---|---|---|
| `isolated` | global tables via "Reset Set Builder Data" | **No — pin to shard 0** |
| `marketplace` | real BSC/SL login (503 on concurrent) | **No — pin to shard 0** |
| `depgraph` (cascade) | shared `selectorOptions`/`cardChecklist` (`setup-done→sets-loaded→cards-loaded`) | **No — pin to shard 0** |
| `independent` | per-user rows only (TEST_EMAIL_${N}'s own Clerk user) | **Yes — distribute** |

Worker isolation keys off `WORKER_INDEX` (`:367`) → `TEST_EMAIL_${N}` → a distinct Clerk user. That's
the seam that lets workers spread across machines: give each shard a **globally unique** worker range
over **one shared backend** (the per-PR Convex preview, already wired).

The **serial backbone** (isolated + marketplace + cascade, incl. the sync-subject flows) stays on
shard 0. Only `independent` flows distribute. Wall-clock ≈ max(shard-0 backbone, fixture shards).
Phase B shrinks the backbone by moving fixture-consumers off it; it does NOT remove sync tests.

## Two correctness traps the tickets gloss over

**Trap 1 — global worker indices must be unique across machines.** Two shards both using
`TEST_EMAIL_0` sign in as the *same* Clerk user and clobber each other. Fix = a clean local/global
split: keep the **local** index for log/results files, `maestro-home/worker-N` dirs, and concurrency
caps; pass a **global** index `local + SHARD_INDEX*PARALLELISM` to flows (only the `-e WORKER_INDEX`
value and `ATTEMPT_ID` change).

**Trap 2 — only shard 0 may warm marketplace tokens.** `worker-bootstrap.yaml` warms BSC/SL tokens
per worker via `util-login-to-bsc`. N shards bootstrapping concurrently = up to N×2 simultaneous logins
to the *same* dev BSC account → the exact 503 the `serial-marketplace` lane exists to prevent. Fix =
non-shard-0 bootstrap **seeds creds** (`seedMyTestCredentials` = Secret-Manager store, no login) but
**skips the login warm-up** (`util-login-to-bsc` / `util-login-to-sportlots`). Corollary: any
`independent` flow that triggers a real marketplace fetch must be re-tagged `serial-marketplace`
(→ pinned to shard 0). The Phase B audit confirms none slip through.

---

## Phase A — NEO-46: shard-aware runner + matrix workflow (stand up now)

### A1. `run-e2e-smoke.sh` (surgical)

- **New env, after PARALLELISM (~`:130`):**
  ```bash
  SHARD_INDEX="${SHARD_INDEX:-0}"
  SHARD_TOTAL="${SHARD_TOTAL:-1}"
  WORKER_INDEX_BASE="${WORKER_INDEX_BASE:-$((SHARD_INDEX * PARALLELISM))}"
  ```
- **Shard partition, right after categorization/bucketing (~`:265`, BEFORE the depgraph level
  computation at `:271`):**
  - If `SHARD_TOTAL > 1` and `SHARD_INDEX != 0`: empty `ISOLATED_FLOWS`, `MARKETPLACE_FLOWS`,
    `DEPGRAPH_FLOWS` (serial backbone is shard-0-only) so `MAX_LEVEL` stays `-1` there.
  - Partition `INDEPENDENT_FLOWS` deterministically: keep index `i` where `i % SHARD_TOTAL ==
    SHARD_INDEX` (flows are already `find | sort`-stable, so every shard agrees on the partition).
  - **Phase-A conservatism:** until the Phase B audit runs, keep `independent` flows that live under
    `set-selector/` on shard 0 too (they may implicitly read global `selectorOptions` mid-reset).
    Only distribute the clearly-global-free dirs: `auth/`, `profile/`, `home/`, `dashboard/`,
    `public-profile/`. (Cheap heuristic: a path-prefix allowlist for "distributable".)
- **`run_flow_on_worker` (`:355`):** add `local global_worker=$(( worker_index + WORKER_INDEX_BASE ))`;
  pass `-e WORKER_INDEX=$global_worker` and build `ATTEMPT_ID="w${global_worker}-..."`. Leave
  `log_file`/`results_file`/`worker_home` keyed by **local** `worker_index`.
- **Phase 0 bootstrap (`:486`):** loops local `0..P-1` unchanged (maps to global users via the line
  above). Add `MAESTRO_BOOTSTRAP_SKIP_MARKETPLACE_WARM` — on non-shard-0 select a lighter bootstrap
  (sign-in + `/testing/reset` + `/testing/seed-credentials`, **no** `util-login-to-bsc/sportlots`).
  Cleanest as a separate PO-readable `worker-bootstrap-light.yaml` chosen by shard, vs. `when:`
  conditions inside the YAML.
- Everything else (lanes, cascade prereq tracking, retry, timeout, aggregation) is unchanged.

### A2. `.github/workflows/e2e-tests.yml` → 3 jobs

- **`setup`** — resolve the Vercel preview URL once (existing poll steps), expose it as a job output
  so shards don't each re-poll. *Phase A:* no separate global-seed step yet (shard 0 still owns the
  destructive reset via the cascade). *Phase B:* this job calls the fixture-seed endpoint once and the
  matrix `needs:` it as the barrier.
- **`e2e`** — `strategy.matrix.shard: [0, 1]` (→ `[0,1,2,3]` at 4×2), `needs: setup`,
  `fail-fast: false`. Each leg: setup-java / setup-chrome / Xvfb / install Maestro / start the
  bypass proxy (each runner needs its own localhost:3000) / `npm run test:e2e` with
  `SHARD_INDEX=${{ matrix.shard }}`, `SHARD_TOTAL=<N>`, `MAESTRO_PARALLELISM=2`,
  `REPORT_DIR=maestro-report`. Upload artifact `maestro-report-shard-${{ matrix.shard }}`.
  **Gate = the legs' own exit codes** (a shard with any FAIL exits 1 → that required check is red).
- **`report`** — `needs: [e2e]`, `if: always()`. Download all shard artifacts, then run the existing
  `action-junit-report` over `maestro-report-shard-*/junit/*.xml` (ONE merged "Maestro E2E" check) and
  one merged sticky comment (concatenate each shard's `summary.md`). Move the publish/sticky steps here
  so we don't post N duplicate checks.
- Keep `concurrency.cancel-in-progress`. Drop per-job `timeout-minutes` to ~30 (shards are smaller).

### A3. Test accounts (provisioning — real task, do first)

- 2×2 needs `TEST_EMAIL_0..3` + `NEW_PROFILE_TEST_EMAIL_0..3`; 4×2 needs `_0..7` (~16 Clerk users).
- **TODO/verify:** confirm where `resolveTestEmail` reads these (Vercel serverless fn env vs Convex
  env — `api/auth/testing.ts` reads `process.env[...]`) and provision the env vars there for the
  preview environment, each backed by a real Clerk test user. Today only `_0..2` exist.

### A4. Acceptance (Phase A)

Full suite green across the matrix, no flow dropped, $0 compute (free `ubuntu-latest`), one merged
pass/fail check + one sticky comment. Re-running a single failed shard leg must NOT re-destroy global
state (shard-0-only reset is idempotent; other shards never touch it).

---

## Phase B — NEO-47 reframed: fixture-vs-sync split (fast-follow)

**Principle:** seed *preconditions*, never the *subject*. A flow that exists to verify sync keeps
driving the real cascade and asserting on it; a flow that only needs a populated hierarchy gets that
hierarchy seeded.

- **B1. Audit + classify** every drill/cascade/`requires:`-tagged flow as **sync-subject** (keep
  driving real auto-sync; assert the fetched+reconciled hierarchy) vs **fixture-consumer** (precondition
  only — e.g. `team-picker`, `edit-and-delete-card`, `features-propagation`). Output: a table in the
  ticket. **Guarantee at least one flow drives the full real cascade end-to-end**, including the
  Football/2026 thunder-herd path.
- **B2. Fixture-seed endpoint:** extend `convex/testing.ts` (alongside `resetMyTestState` /
  `seedMyTestCredentials`) to seed the `selectorOptions` / `cardChecklist` / `teams` hierarchy directly
  for fixture-consumers — no UI cascade, no marketplace fetch. The `setup` job calls it once; shard 0
  stops owning the destructive UI build.
- **B3. Keep + harden sync-subject flows:** pin to shard 0's serial backbone, retry **only** true infra
  crashes (CDP `Failed to execute JS`, JVM SIGSEGV), never assertions. Pin/upgrade Maestro and verify
  whether a newer release fixes the `CdpWebDriver` crash; report upstream if not.
- **B4. Rebalance:** with fixture-consumers seeded → they become `independent` and distribute,
  shrinking shard 0. Drop the Phase-A `set-selector/`-stays-on-shard-0 conservatism for the reclassified
  flows. Sync-subject flows that use **per-worker custom sets** (`util-drill-to-custom-set`) can even
  parallelize since they don't share global rows — optional optimization.
- **Playwright:** record the decision as "no for this org" (PO-readable YAML + one tool for web+returning
  mobile). Revisit only if B1–B3 fail to produce a reliably-green gate AND those assumptions change.

### Acceptance (Phase B)

Reliably-green full web gate (N reruns, 0 flake) at acceptable wall-clock via fixture-seeding + sync-test
hardening + scale-out — Maestro retained, **all sync coverage intact**.

---

## Decision gate noted but deferred (per owner: shard now)

NEO-46's "evaluate first" alternative — a free OSS-tier 8-core third-party runner (Blacksmith /
Ubicloud / Depot, free for public repos) as a one-line `runs-on:` swap + `MAESTRO_PARALLELISM≈4` — was
**not chosen as the first step**. Keep it in the back pocket: if matrix orchestration proves more
fragile than expected, a free bigger runner relieves CPU starvation for the whole suite (incl. the sync
backbone) with far less engineering. Revisit if Phase A stalls.

## Open questions to resolve during implementation

- Exact host of `TEST_EMAIL_${N}` env (Vercel fn vs Convex preview env) → drives A3 provisioning.
- Do any `independent` flows trigger a real BSC/SL fetch? (Trap 2 audit — fold into B1.)
- Balanced distribution: start round-robin; if shards skew, switch to longest-processing-time using
  per-flow durations from JUnit.
