# NEO-46 overnight worklog — 2026-06-04 (resume file)

**GOAL (user /goal):** an all-green NEO-46 PR ready for review in the morning.
Autonomous overnight run; user asleep; broad permission to use Clerk/Vercel APIs,
read `.env*` (tonight only), drive Chrome. Keep this log current for crash recovery.

## Where things live
- **Worktree:** `/Users/jburich/workspace/neonbinder-worktrees/neo-46-e2e-sharding`
- **Branch:** `jburich/neo-46-scale-out-e2e-regression-across-multiple-free-runners-matrix` (off origin/main `996dfd2` = PR #50)
- **Plan of record:** `todos/neo46-47-e2e-sharding-plan-2026-06-04.md` (Phase A = this PR)
- **Files being changed (in worktree):**
  - `run-e2e-smoke.sh` (A1 — shard-aware)
  - `.github/workflows/e2e-tests.yml` (A2 — 3-job matrix)
  - `.maestro/flows/profile/worker-bootstrap-light.yaml` (NEW — shards 1+ bootstrap, no marketplace warm)

## DONE
- [x] Confirmed blocker cleared: PR #50 merged 2026-06-04 06:30 CDT; main clean.
- [x] Worktree created off origin/main.
- [x] **A3 test accounts provisioned (worker 3):**
  - Clerk (dev `sk_test_` instance): `dev+e2e-4@neonbinder.io` (user_3EhKp3oAWBR9rVblBUsP0n1gq6z),
    `dev+e2e-4-profile@neonbinder.io` (user_3EhKp5hlqJGuJKNQ2msBkGqv1vn). password_enabled=false, email verified.
  - Vercel env (Preview scope): `TEST_EMAIL_3`, `NEW_PROFILE_TEST_EMAIL_3`. Verified each resolves to 1 Clerk user.
  - Convention: worker N → `dev+e2e-${N+1}@neonbinder.io` / `...-profile`. (saved as memory reference_e2e_test_account_provisioning)

## KEY FACTS (evidence-gathered)
- Categorization (54 flows): 6 isolated, 4 marketplace, 26 depgraph (levels 0..3), 18 independent.
  - Independent in global-free dirs (distributable): 11 → auth(2) dashboard(1) home(5) profile(3: edit/fill/view).
  - Independent in set-selector/: 7 → pinned to shard 0 in Phase A (conservatism).
- `public-profile/` dir does NOT exist. Allowlist dirs = auth, dashboard, home, profile.
- No branch-protection required checks on main (checks: null) → safe to restructure jobs.
- worker-bootstrap.yaml = sign-in→reset→seed-credentials redirect chain + wait "Profile Settings"
  + runFlow util-login-to-bsc + runFlow util-login-to-sportlots. LIGHT = drop the two runFlow steps.
- `.env*` NOT in worktree (gitignored). Local maestro runs would need env copied from main checkout
  `/Users/jburich/workspace/neonbinder/neonbinder_web/.env.local`. CI is the real gate for sharding.

## DESIGN (Phase A)
- New env: `SHARD_INDEX` (0), `SHARD_TOTAL` (1), `WORKER_INDEX_BASE` (=SHARD_INDEX*PARALLELISM).
- Non-zero shard: empty ISOLATED/MARKETPLACE/DEPGRAPH buckets (backbone is shard-0-only) → MAX_LEVEL stays -1.
- Partition INDEPENDENT_FLOWS: distributable (allowlist dirs) split by `i % SHARD_TOTAL == SHARD_INDEX`;
  set-selector independents stay on shard 0 only.
- run_flow_on_worker: global_worker = local + WORKER_INDEX_BASE; pass `-e WORKER_INDEX=$global_worker`,
  ATTEMPT_ID uses global. Keep log/results/home keyed by LOCAL index.
- Phase 0: shard 0 uses worker-bootstrap.yaml (full warm); shards 1+ use worker-bootstrap-light.yaml.
- 2×2 mapping: shard0 workers→global 0,1→TEST_EMAIL_0,_1 ; shard1 workers→global 2,3→TEST_EMAIL_2,_3.
- Trap 2 OK: only shard 0 warms marketplace, and its Phase 0 is serial (≤1 BSC login at a time). Shards 1+ never warm.

## A2 workflow shape
- `setup`: resolve Vercel preview URL once (existing 2 poll steps) → job output `url`.
- `e2e`: needs setup; strategy.matrix.shard [0,1]; fail-fast:false; per-leg: checkout/java/chrome/Xvfb/install maestro/
  start bypass proxy (uses needs.setup.outputs.url)/run npm test:e2e with SHARD_INDEX, SHARD_TOTAL=2, PARALLELISM=2,
  REPORT_DIR=maestro-report; upload artifact maestro-report-shard-${shard}. Gate = leg exit code.
- `report`: needs [e2e]; if always; download all maestro-report-shard-*; action-junit-report over
  maestro-report-shard-*/junit/*.xml (check_name "Maestro E2E"); sticky comment concatenating shard summaries.
- Keep concurrency cancel-in-progress. Per-leg timeout ~30m.

## STATUS / NEXT
- [x] A1 run-e2e-smoke.sh
- [x] worker-bootstrap-light.yaml (maestro-e2e-author)
- [x] A2 workflow
- [x] validate (plan-only shard 0/1 disjoint+exhaustive, actionlint clean, bash -n clean, default unchanged)
- [x] commit (13de21f) + push + PR #51 + pr-watcher launched
- [ ] drive CI to green  ← CURRENT

## PR
- **PR #51:** https://github.com/neonbinder/neonbinder_convex/pull/51
- Repo on GitHub is `neonbinder/neonbinder_convex` (dir name neonbinder_web).
- Branch: jburich/neo-46-scale-out-e2e-regression-across-multiple-free-runners-matrix
- Commit: 13de21f

## If resuming after crash
1. `cd /Users/jburich/workspace/neonbinder-worktrees/neo-46-e2e-sharding`
2. `gh pr checks 51 --repo neonbinder/neonbinder_convex` — see leg status (e2e (0), e2e (1), report + vercel/lint/build).
3. If a shard leg is red: `gh run view <run-id> --repo neonbinder/neonbinder_convex --log-failed`, download the
   maestro-report-shard-N artifact, read the failing flow's maestro.log + screenshot. NO flaky excuses — forensics first.
   The flows themselves are already green on main (PR #50); a NEW failure under sharding is most likely:
   (a) a distributable flow that actually needs marketplace creds (re-tag serial-marketplace → pins to shard 0), or
   (b) global-worker/account wiring (TEST_EMAIL_2/3 resolution), or (c) the light bootstrap missing some state a
   shard-1 flow needs. Reproduce locally by copying env from main checkout's .env.local and running
   `SHARD_INDEX=1 SHARD_TOTAL=2 MAESTRO_PARALLELISM=2 npm run test:e2e` against local Vite.
4. Fix → commit → push (pr-watcher auto-launched after each push) → re-watch.

## DECISION LOG — SL adapter empty-result instability (2026-06-05, user away, autonomous)
- Run 2 (commit d870997, SL 3s+retry timeout fix) still failed parallel-grouping-suggestions (50/51), but the
  screenshots PROVED the timeout fix worked: Manufacturers no longer hangs "Syncing" 30s — it now fast-fails to
  "No manufacturers available. Sync marketplaces to populate." So SL returned **0 brands** for Football/2026.
  Attempt 1 failed at YEARS ("Syncing Year Options" stuck), attempt 2 at MANUFACTURERS (empty). Sports column was
  FULLY populated both times → NOT a global reset wipe. Variable failure level + sibling flows on the identical
  Football/2026 path passing = a **flaky/transient empty SL response**, not a fixed code path.
- USER (active, then stepped away): "not expected that SL returns nothing. What did SL return in the adapter? If
  the SL adapter is returning nothing the problem is certainly there — debug what is happening and stabilize it."
  Then: "make a decision, log it, fix it, push the PR, continue until green, do not wait on me." (Browser-driving
  their live SL session was denied / they left, so no live SL ground truth available.)
- ROOT (code): fetchSportLotsSelectorOptions POSTs newinven.tpl (sprt,yr) and parseSelectOptions(html,"brd").
  On an empty/missing target <select> it records success:true result_count:0 — silently treats a glitch as "no
  data." sport/year/manufacturer are ALWAYS populated upstream, so 0 = transient SL glitch.
- DECISION (shipped): retry the selector fetch on an EMPTY parse (up to SL_SELECTOR_FETCH_MAX_ATTEMPTS=3, 500ms
  backoff) — re-POST the same query; SL almost always returns the data on a retry. Plus full diagnostics each
  empty attempt: console.warn `sl_selector_empty_result` {sprt,yr,targetSelect,status,htmlLen,targetSelectPresent,
  presentSelects} AND a queryable PostHog `selector_sync_empty` event on persistent-empty. This both stabilizes
  (likely greens it) AND, if it stays red, captures exactly what SL returned (status/htmlLen/which selects present)
  so the next fix is evidence-based — no more guessing. convex/adapters/sportlots.ts, typecheck clean.

## ROOT CAUSE NAILED (2026-06-05) + REAL FIX (commit 56620c9)
- Pulled the warmed dev SL cookie via the browser service (OIDC: gcloud impersonate neonbinder-convex SA →
  GET <browser-url>/credentials/sportlots-credentials-user_<clerk>/token) and replicated the adapter's exact
  newinven.tpl POST. FINDINGS:
  - VALID cookie → SL returns 14 brands (Topps/Panini/...) every time, for Football/2026 AND Baseball/2024,
    on www AND non-www. The brand list is STATIC (POST sprt/yr are ignored; dropdowns filter client-side).
  - INVALID/missing cookie → 423-byte login.tpl meta-refresh stub, NO <select>. isSessionExpired() catches it.
  - So the adapter ISN'T broken for valid queries. The E2E "0 manufacturers / Football missing" = a
    SESSION-REJECTION (login stub), and the adapter returned a DEAD "session expired" error WITHOUT re-authing;
    getSiteToken kept returning the dead cookie (expiresAt still fresh). All test workers SHARE one SL account
    (DEV_SPORTLOTS_USERNAME, convex/testing.ts:94).
  - User's www/http quirk: real but does NOT bite the adapter — it's already https://www. everywhere (verified
    both repos) and explicit-cookie fetches are host-agnostic (non-www returned 14 brands too).
- FIX (56620c9, convex/adapters/sportlots.ts, the production-correct one): on a session-rejection/empty parse in
  fetchSportLotsSelectorOptions, force a re-auth via internal.credentials.authenticateSportlots, refresh the
  cookie via getSportLotsCookie, retry the POST (bounded, 500ms backoff). Removed the dead session_expired
  early-return + the band-aid that re-POSTed the same dead cookie. Exhausted re-auth → clean "Re-authenticate
  from Profile" error. Cookie never logged. Typecheck clean. This is the recovery getSiteToken's own comment
  intends but only did on expiresAt. A real user's invalidated SL session now recovers transparently.
- HOW TO GET SL GROUND TRUTH AGAIN (autonomous): /tmp script — mint OIDC for the browser svc, GET the cookie,
  POST newinven.tpl. PostHog query: us.posthog.com project 239150, query API /api/projects/239150/query/ with
  posthog_csrftoken header (Chrome session); adapter_sync_call events carry error_class/result_count/status_code.

## ACTUAL ROOT CAUSE (PostHog-confirmed) + REAL FIX (commit d272b6f)
- PostHog (project 239150) adapter_sync_call data REWROTE the diagnosis:
  - SL manufacturer fetch ALWAYS succeeds (result_count 14, 9x). sport→11, year→121. NOT empty. NOT session_expired (ZERO such events).
  - The ONLY failures: `no_credentials` (null token) on sport ×2 + year ×2.
  - Run 3 failure window (14:39:29, when parallel-grouping-suggestions died): BOTH bsc/sport AND sportlots/sport
    returned `no_credentials` → aggregator 0 sports → "Football not visible" → drill failed.
- So the prior SL fixes (timeout d870997, empty-retry ebc7840, session-rejection re-auth 56620c9) addressed cases
  that don't occur. The real bug: getSiteToken (convex/credentials.ts) returns null on a MISSING cached token
  WITHOUT re-authing — it only re-auths a STALE token. The browser-service token cache TTL evicts a worker's
  token mid-run (~18min after warm); a later fetch gets null → `no_credentials` → empty column. Affects SL AND BSC.
- FIX (d272b6f): getSiteToken on cache-miss → refreshSiteToken (re-auth/login from the still-seeded creds) →
  re-read, instead of returning null. Production-correct ("fetches just work" per its own comment). Typecheck clean.
- KEY TOOL: PostHog query API works via Chrome (us.posthog.com proj 239150, /api/projects/239150/query/ + posthog_csrftoken).
  Use it to diagnose each run's actual adapter_sync_call error_class/result_count — this is how to get ground truth fast.
- pr-watcher is BLOCKED (needs Monitor tool permission); using a Bash background poll to watch run 5 instead.

## CI iteration notes (append as runs happen)
- Runs 1-3 (13de21f/d870997/ebc7840): e2e(0) FAILED — parallel-grouping-suggestions, root cause = no_credentials (above).
- Run 4 (56620c9): superseded/cancelled by d272b6f push (wrong fix; session-rejection doesn't occur).
- Run 5 (d272b6f): the real no_credentials fix. ✅✅ GREEN — e2e(0) 51/51 (48m53s), e2e(1) green, report green,
  Maestro E2E green, Vercel green. parallel-grouping-suggestions PASSES. Mid-run PostHog confirmed: 0 no_credentials,
  0 credential_test_failed (no bot-protection / login storm), 0 selector_sync_empty. GOAL ACHIEVED — green NEO-46 PR.

## WHY the token got evicted (user's deeper question) + the proper fix (commit 2fb9a3e)
- Eviction cause (confirmed in code): the credential store does a FULL OVERWRITE, not a merge. PUT /credentials
  (neonbinder_browser index.ts:287) → updateCredentials({username,password}) (secrets-manager.ts:123) writes a
  new secret version with ONLY username+password → DROPS the cached token/expiresAt. Every E2E flow launched
  through /testing/seed-credentials (41 flows), so EVERY flow re-wrote the secret and WIPED the token; only the
  Phase-0 bootstrap re-warmed it. parallel-grouping-suggestions launches after bootstrap, seeds (token gone),
  next fetch → no_credentials. (Hits real users too: re-saving creds in Profile invalidates your live session.)
- Cache TTL is 30 DAYS (not the cause). validateCachedCookie clears on transient = a separate latent risk, not this.
- USER DECISION: skip the browser-service merge-preserve fix (rare for real users). Instead seed ONCE in setup and
  stop flows from re-seeding (the per-flow re-seed is wasted time AND the token-wipe).
- FIX (2fb9a3e, maestro-e2e-author): removed /testing/seed-credentials from 37 flow URLs (kept only in
  worker-bootstrap{,-light}); the 5 clear-flows (admin-missing-{both,bsc,sl}, save-{bsc,sl}) restore creds at the
  end like test-{bsc,sl} already do. Validated: all flows parse, plan-only unchanged (54, 6/4/18/26), seed only in
  bootstrap + restores. Saves ~36 Secret-Manager writes/run + the token-wipes. getSiteToken re-auth (d272b6f)
  remains the safety net for the few clear/restore wipes + real users.
- Run 6 (2fb9a3e): watching. Expect SL/BSC seed-credential writes to drop sharply + still green.

## STATUS: PR #51 green at run 5; run 6 (seed-once efficiency+correctness) in flight.
### ROOT CAUSE of the 1 failing flow (parallel-grouping-suggestions) — found 2026-06-05 AM
- shard 0: 50 passed / 1 failed. Only failure = set-selector/parallel-grouping-suggestions (failed BOTH attempts).
- Failure is inside util-drill-to-custom-set.yaml LEVEL 3: after Football→2026, the Manufacturers column
  stuck on "Syncing Manufacturer Options" (ManufacturerForm loading) for 30s → `.*Search manufacturers.*` never appeared.
- WHY: `convex/selectorOptions.ts:2331-2339` — the custom-subtree gate that skips BSC/SL EXEMPTS
  `level === "manufacturer"`. So every custom Football/2026 subtree does a LIVE SportLots manufacturer fetch
  (`fetchAggregatedOptions` → ManufacturerForm.tsx:33). SL returns the same STATIC manufacturer list regardless
  of (sport,year) (per the code's own comment), stored per-parent → redundant re-fetch for every subtree.
  EntityColumn gate (EntityColumn.tsx:74-84) re-fires whenever items.length===0 + per-mount useRef → no global
  "synced" memo. Under the sharded timing one redundant SL fetch hung >30s → fail. NOT orchestration; pre-existing.
- User guidance: "the sync is global; should happen once in setup and not re-run." Manufacturer fetch should
  reuse the global static list, not re-hit SL per custom subtree.
- USER CORRECTION (2026-06-05 AM): there is NO global list — each (sport,year) MUST sync its own manufacturers
  from SL every time (future plan: trim to manufacturers that actually have sets for that year). The sync is a
  regular user action; it should load in ~1-2s. If SL doesn't respond in 3s → treat as fetch error, LOG it, RETRY.
- ACTUAL "what failed" (evidence): auth fine (browser svc logs: login_sportlots 520ms / login_bsc 767ms success at
  03:06:52). The slow part = the SL options POST to newinven.tpl (direct Convex→SL, sportlots.ts:252), which rode
  the 30s SL_FETCH_TIMEOUT_MS. For manufacturers BSC fast-returns empty (buysportscards.ts:199 "manufacturer has
  no BSC facet"), so SL is the only blocking call. resolveSportLotsPlatformValue falls back to displayValue when a
  custom row has no SL slug → posts sprt=Football&yr=2026 (literals) → SL stalls → 30s freeze → flow failed.
- FIX SHIPPED (sportlots.ts): slFetch() gains timeoutMs param (default 30s, heavy calls unchanged). New
  slSelectorFetchWithRetry() wraps the newinven selector POST (sport/year/manufacturer) with a 3s per-attempt
  budget + up to 3 attempts, logging {msg:"sl_selector_fetch_retry",requestId,level,attempt,error} each miss;
  throws after 3 misses → aggregator records a real fetch error. Normal path unchanged (~1s, first attempt).
  User confirmed: 3×3s, land in PR #51. Typecheck clean (only pre-existing .test.ts vitest noise).

- Run 1 (commit 13de21f, GH run 26992144916): started ~21:45 CDT 2026-06-04.
  - ✅ ORCHESTRATION WORKS: `setup` job passed (resolved Vercel preview URL); both matrix legs
    `e2e (0)` + `e2e (1)` started 21:45:43 CDT. Vercel preview deployed green. No other gating
    workflows on PRs (only E2E + Vercel; no separate lint/build/typecheck checks).
  - Watching for leg results. `e2e (1)` (shard 1, 5 trivial flows + light bootstrap) = early canary
    for global-worker/account wiring; `e2e (0)` (full backbone) ETA ~22:35 CDT.
  - Active wake: Monitor task bea6e59a4 (emits per-leg terminal transitions; exits when all terminal).
    (pr-watcher agent returned an initial snapshot then ended — not a live watcher.)
  - `report` job appears only after both legs finish (needs:[e2e]); posts merged "Maestro E2E" check + sticky comment.

---
## 2026-06-05 PM — runs 5→7 (the real saga lives in higher sections; quick index)
- Run 5 (d272b6f, getSiteToken re-auth on cache-miss) = **GREEN 51/51**. no_credentials fixed.
- Run 6 (2fb9a3e, seed-once: seed creds once in bootstrap, flows don't re-seed; 5 clear-flows restore) = **50/51**.
  parallel-grouping-suggestions PASSES. FAILED: move-parallels-of-inserts-custom — Football Years column never
  settled. Mis-called bot-protection; USER CORRECTED (SL=30yr site, no challenge). "Not a valid Email Address"
  log = save-sportlots-credentials' INTENTIONAL fake-cred test on account=new-profile (red herring). Real cause:
  year fetch HUNG before recordAdapterCall (allSettled had no overall deadline) → silent, nothing logged.
- Run 7 (ff15de6) = **stage-attributed selector-sync timeouts** (in NEO-46 PR per user). SL 3s×3 unchanged; BSC
  30s→10s×3 (+ checklist split to own 30s); aggregator withChildDeadline (SL 12s/BSC 35s) so allSettled can't
  hang → ALWAYS records stage=aggregator+timed_out_platform; 4 FE forms + useSelectorSync hook 38s backstop →
  Retry + selector_sync_fe_timeout; adapter_sync_call gains stage/attempt/timed_out_platform. Both bounds the
  hang (≤35s < Maestro 60s) AND records the stage if it recurs. WATCHING.
- PR last GREEN at run 5 (d272b6f) if a fallback is needed.

## OVERNIGHT 2026-06-06 (user asleep) — mandate + state
- Run 11 = 18ae336 "manufacturer obeys once-custom-always-custom" (exemption removed + util-drill custom Topps +
  cascade/setup pre-warm removed). VALIDATED LOCALLY 4/4 (cascade/setup, move-parallels, cards-parallel-custom).
  BUILDING now.
- IF run 11 GREEN (this attempt) → squash-merge PR #51 → THEN implement NEO-46 Phase B (real sharding) as a 2nd PR
  in a FRESH worktree off LATEST main; iterate to fastest-sharding sweet spot (scalable for many more tests);
  validate LOCALLY (npm + Chrome) before EVERY push; goal = green Phase B PR waiting by morning.
- IF run 11 RED → iterate to green → squash-merge → STOP + wait for morning (NO Phase B).
- Phase B design (NEO-49): per-PR Convex preview = ONE shared deployment → global selectorOptions shared → the
  cascade (Baseball setup→sets→cards, ~15min, sequential, builds global data) is the floor + stays on 1 shard.
  Distribute the parallelizable parts: marketplace lane needs per-worker accounts; the custom-drill set-selector
  independents build their OWN E2E Test Sport subtree (not Baseball) so may be distributable IF decoupled from
  setup-done. Provision TEST_EMAIL_4..7 (Clerk sk_test + Vercel Preview vars). MUST verify data-isolation per shard.
- LOCAL E2E SETUP (worktree): copy main neonbinder_web/.env.local|.env.convex|.env|.env.test (gitignored); Java 21
  at /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home; deploy via
  `npx dotenv-cli -e .env.convex -- npx convex dev --once --typecheck disable` (test-file tsc blocked = NEO-48);
  Vite https://localhost:3000; run `JAVA_HOME=<21> APP_URL=https://localhost:3000 MAESTRO_PARALLELISM=1 npm run
  test:e2e:pick -- 'grep:<flows>'` (picker = tag/name:/grep:; bare path doesn't match).
- CLEANUP OWED: dev:all's setup-env.sh set shared dev SITE_URL=http://localhost:3000 (restore to dev URL); worktree
  .env* copies are gitignored.

## RUN 11 (18ae336) = 51/51 except move-parallels (FAILED both attempts, w1) → NOT green-this-attempt → NO Phase B.
- Root cause (hard evidence, /tmp/r11 maestro.log): year column under custom E2E Test Sport — scrollUntilVisible
  FOUND "Add custom Years" at y=109 (vis 1.0) @03:11:53, then tapOn FAILED "Element not found" for the full ~15s
  retry @03:11:56–03:12:11. So the column RE-SYNCED and removed "+ Custom Years" for >15s. PASSED at p=1 (local),
  FAILED at p=2 (CI) → CONCURRENCY RACE: two workers building the SHARED "E2E Test Sport" subtree churn each
  other's reactive columns. NOT the manufacturer change (year was always custom-only).
- FIX (iterate-to-green, not Phase B): make the custom subtree PER-WORKER — "E2E Test Sport ${WORKER_INDEX}" in
  util-drill-to-custom-set.yaml (+ any refs). Isolates concurrent workers → no shared-node churn. Validate p=1
  (no regression; p=2 is crash-risky on laptop) → push → CI (p=2) validates. If still flaky, iterate.

## RUN 12 = ba3cb02 "per-worker isolate custom subtree" — PUSHED, WATCHING (poll bteowaja4).
- VALIDATED LOCALLY AT p=2 (laptop handled it fine, no crash): cascade/setup + move-parallels + cards-parallel-
  custom + cards-insert-custom + parallel-grouping-suggestions = 7 passed / 0 failed. The run-11 year-column
  concurrency bug is GONE (move-parallels now passes). 2 flows passed ON RETRY — attempt-1 failed at the SHARED
  Sports column: "No visible element found: id: Add custom Sports" (~19s). DIFFERENT, pre-existing flake (NEO-47):
  the shared synced Sports column re-enters sync mode under p=2 contention → EntityColumn hides the idle "+ Custom"
  row (components/SetSelector/EntityColumn.tsx:150-194) → scrollUntilVisible (util sport step, 10s) misses it. The
  util already waits for "Baseball" (60s idle signal, line 67-69) BEFORE the scroll → the miss is a re-sync AFTER
  Baseball appears, not a cold-sync.
- IF RUN 12 GREEN (retries catch the residual) → squash-merge PR #51 → STOP (no Phase B, since I had to iterate).
- IF RUN 12 RED → pull artifact, observe the EXACT failing flow/step/screenshot (do NOT guess), fix the Sports-
  column re-sync precisely, validate p=2, push, iterate. Candidate (UNVERIFIED): auto-sync (EntityColumn.tsx 81-91)
  re-fires when items transiently resolves to [] under contention despite autoSyncedRef — needs observation.

## RUN 12 = ba3cb02 RED (51 passed, 1 failed = move-parallels both attempts). ROOT CAUSE FOUND (code + tags + artifact).
- The Sports-column theory was WRONG. Real cause: move-parallels (and parallel-grouping-*) are tagged INDEPENDENT
  (no requires:). run-e2e-smoke.sh scheduler (lines 776-867): the ISOLATED lane clicks the global "Reset Set
  Builder Data" (wipes ALL selectorOptions) and runs CONCURRENTLY with the INDEPENDENT lane — only the cascade is
  gated on isolated finishing (line 864). A custom subtree (E2E Test Sport N) does NOT survive the wipe (synced data
  re-syncs; custom doesn't) → the independent flow's 2026 is deleted mid-run → fails. CI artifact (/tmp/r12): the
  `when notVisible 2026` block was SKIPPED (2026 visible @04:31:40) then assertVisible 2026 FAILED @04:31:44 — 2026
  vanished for >4s (a real delete, not a flicker). PROOF: every custom-drill flow tagged requires:setup-done
  (cards-parallel-custom etc.) PASSED; the 6 without it are the flaky ones. This also explains run 5 green (Football
  = SYNCED, survives the wipe) vs now (E2E Test Sport = CUSTOM).
- FIX (RUN 13): tag the 6 mis-tagged util-drill consumers with requires:setup-done → moves them to dep-graph level
  1, gated AFTER the isolated reset + cascade/setup → no concurrent wipe. Flows: cards-parallel-of-insert-custom,
  move-parallels-of-inserts-custom, parallel-grouping-{suggestions,accept-and-save,cancel-discards,reject-parallel}.
  Independent 18→12, Dep-graph 27→33, no cycle. Tags-only (NO convex change). Validating at p=2 WITH empty-state
  (isolated) present (poll brr3v2npc) → if the custom-drill flows pass with the reset present, fix proven → push run 13.
- VALIDATED p=2 LOCALLY: all 6 ex-independents (cards-parallel-of-insert-custom, move-parallels, 4× parallel-grouping)
  pass CLEANLY (10/0, NO retries) at Cascade level 1. move-parallels (run-12 both-fail) now passes clean. (empty-state
  wasn't pulled by the grep so the isolated lane wasn't in this local run, but dep-graph-after-isolated gating is a
  scheduler code guarantee, line 864 — CI run 13 exercises the real isolated lane.) PUSHED a3edaa6 = RUN 13, WATCHING.
- IF RUN 13 GREEN → squash-merge PR #51 → STOP, wait for user (no Phase B, since iterated).
- IF RUN 13 RED → pull artifact; residual risk = depgraph on-retry flakes from run 12 (features-propagation,
  edit-and-delete-card, custom-entry-survives-resync, Test BSC Credentials — all PASSED on retry in run 12, broad
  column-settle/creds, not the clobber). If one both-fails, observe + fix precisely, validate p=2, iterate.
