# NEO-46 — autonomous "work to green" decision log (2026-06-08 PM)

User stepped away; mandate: drive PR #51 to green WITHOUT masking, log every decision.
Branch HEAD: 4aee996 (reverted the broken CDP "fix", matrix back to 2×2 — see D2).

## Confirmed root cause (forensics, not flaky-excuse)
- worker-bootstrap (the per-worker BSC/SL warm) intermittently fails at the marketplace warm.
- maestro.log: `MismatchedInputException: No content to map due to end-of-input` at
  `CdpWebDriver.executeJS`/`scroll` (Maestro CDP web-driver) + earlier "Detected a window change".
- Failure screenshot: page HEALTHY, "Testing stored credentials with BuySportsCards…" on screen
  (BSC login working) — the page was scrolled to Prize Pool; the flow then couldn't SCROLL back to the
  Sportlots tab. So it's NOT a login/rate-limit/browser-service failure. It's the Maestro CDP-scroll flake.
- Trigger surface: `util-login-to-bsc/sportlots` use `scrollUntilVisible` to reach the marketplace
  tab / "Test Credentials" / success message, which are BELOW THE FOLD at 1024×629 on `app/profile/page.tsx`.
  That page is a 1333-line monolith (~40 useState) with 2 reactive useQuery (getPrizes, getUserProfile)
  → fully re-renders on every state change during the test-creds flow, widening the CDP-empty-response window.

## Decisions
- **D1 (user, confirmed):** 2×2-vs-4×2 is NOT a per-warm flakiness difference — per-VM load is identical
  (2 workers/VM). 4×2 just has 8 warm attempts vs 4, so more chances to hit the same flake. → dropping shard
  count is EXPOSURE reduction, not a fix. Do NOT "fix" by shard count.
- **D2 (me, 4aee996):** reverted the agent's extendedWaitUntil-before-scroll "fix" — it BROKE the seed because
  Maestro's `visible` check can't see below-the-fold elements, so the non-scroll wait on the below-fold button
  never passed. Original scrollUntilVisible restored. (Matrix also at 2×2 in that commit; will revisit per D4.)
- **D3 (user, confirmed):** a server-side `/testing` warm endpoint = MASKING the product issue; withdrawn.
- **D4 (PENDING — this session):** choose the real, non-masking fix that removes the flaky scroll. Candidates:
    (a) make the creds controls IN-VIEWPORT at 1024×629 so no Maestro scroll is needed (layout change — real
        UX improvement: surface marketplace creds; risk: touches profile layout used by other flows).
    (b) decompose the creds section so the test-creds flow doesn't re-render the whole monolith (perf/quality
        fix; risk: low; BUT scroll remains, so may not fully fix).
    (c) upgrade/pin a Maestro version that fixes the CDP scroll (fixes the actual buggy component; risk: broad).
  Will pick after checking the Maestro version + the page's section order (below).

## D4 RESOLVED → make the bootstrap warm BEST-EFFORT (not the layout, not retry, not a backend bypass)
- Ruled OUT (a) in-viewport layout reorder: the profile page is long (Profile Settings → big
  PublicProfileEditor → Marketplace Credentials → Prize Pool). Moving creds to the top just pushes
  PublicProfileEditor below the fold → the profile-EDIT flows would then hit the SAME CDP-scroll flake.
  On a long re-rendering page SOMETHING is always below the fold; the CDP-scroll flake is a general
  Maestro-web limitation, not creds-specific. Reorder relocates the problem, doesn't fix it.
- Ruled OUT (c) Maestro upgrade: pinned 2.6.0; upgrading the whole harness to chase one CDP bug is too
  broad/uncertain for an autonomous change.
- WHY the bootstrap is special: a warm flake there ABORTS THE WHOLE SHARD (run-e2e-smoke.sh:774
  "Aborting: bootstrap must succeed on every worker"). Everywhere else a flake fails ONE flow (with retry).
  So the catastrophe is the all-or-nothing abort, not the flake itself.
- KEY FACTS that make the warm non-essential: (1) the BSC checklist fetch needs NO per-user sellerId
  (buysportscards.ts:484 — any valid bearer token authenticates), so the warm's stated "refresh sellerId"
  purpose is moot; (2) getSiteToken does LAZY re-auth on cache-miss (d272b6f, the production-correct path),
  so a worker with seeded creds but an unwarmed token will warm on its first marketplace fetch; (3) after
  serial-marketplace removal MOST flows never touch the marketplace, so a skipped warm affects only a handful.
- DECISION: make the marketplace warm (util-login-to-bsc/sportlots) BEST-EFFORT in worker-bootstrap — a CDP
  flake during the warm no longer fails the bootstrap / aborts the shard. The worker proceeds with seeded
  creds; lazy re-auth warms the token on first use. The pre-warm is an OPTIMIZATION (fast first fetch), not a
  correctness requirement. NOT masking: real credential failures still surface — in the actual marketplace
  flow (low blast radius) + its retry — not silenced. Removes the single-flake-aborts-shard brittleness and
  makes 4×2/N×2 robust to the warm flake → can go back to 4×2 (user's wanted config).
- Delegating the flow edit to maestro-e2e-author (per the delegate-maestro rule). Will then restore 4×2 + push.
- RISK logged: relies on lazy re-auth being reliable under load; if a marketplace flow fails post-change,
  that's a real getSiteToken issue to diagnose (forensics), not re-mask.

## D5 — 2×2 baseline GREEN; going D4 + 4×2 (not merging the 2×2 band-aid)
- 4aee996 (2×2, reverted utils, NO D4) = FULLY GREEN: e2e-shard 23/0 + 24/0, seed 4/0, **e2e gate = SUCCESS**.
  → #51 is mergeable RIGHT NOW at 2×2. AND it confirms everything EXCEPT the 4×2 warm flake works — so D4
  targets the only remaining issue.
- Decision: do NOT merge the 2×2 band-aid. D4 (warm best-effort) makes the warm flake non-fatal at ANY shard
  count = the genuine robustness fix the user wanted. So go back to 4×2 (user's preferred config) WITH D4 and
  merge that. Committing D4 + 4×2 (worker-bootstrap optional warm + matrix [0,1,2,3]/SHARD_TOTAL 4).
- If D4+4×2 greens → merge #51 at 4×2-robust. If a shard still reds, pull the artifact (forensics): expect
  either (i) a warm flake now correctly DOWNGRADED to a warning (bootstrap passes, shard proceeds) = success,
  or (ii) a marketplace flow failing on lazy re-auth = a real getSiteToken issue to fix (not re-mask).
- Fallback always available: 4aee996 (2×2) is green if a stable merge is needed urgently.

## D6 — 9f2eb2e (D4+4×2) result: D4 WORKED, but the CDP flake is NOT the warm
- No shard aborted (D4 best-effort warm did its job). 2 shards reded on ONE flow each: sets-base (shard 0),
  set-attributes-edit (shard 2) — both the SAME CDP-scroll flake (MismatchedInputException), failing both retries.
- So the flake is general, not warm-specific. D4 is still correct (de-fangs the bootstrap blast radius) but
  isn't the root fix.

## D7 — ROOT CAUSE FOUND (user reframe: "Maestro IS usable, it's our setup"): p=2 within-VM Chrome contention
- DECISIVE EVIDENCE: the SEED job runs PARALLELISM=1 (one maestro process, one Chrome) on its own VM and is
  ROCK-STABLE across all runs — running the SAME scroll-heavy setup flows. The matrix legs run PARALLELISM=2
  (TWO separate `maestro test --platform web` processes per VM) and that is the ONLY place the CDP flake fires.
- Our per-worker isolation is ONLY `MAESTRO_OPTS=-Duser.home=<worker_home>` (Maestro's LOG dir) — NOTHING
  isolates the Chrome instance. The install bakes in `9222` (the default Chrome remote-debug port).
- INFERENCE: two concurrent maestro-web processes on one VM contend on a shared Chrome resource (the fixed CDP
  debug port / default user-data-dir) → CdpWebDriver.detectWindowChange latches the wrong window handle →
  subsequent CDP JS calls return empty (MismatchedInputException) and never recover → the flake. PostHog +
  Sentry are BOTH gated off in tests (VITE_CLERK_TESTING_ENABLED), so they are NOT the source here.
- This is the SAME class the team already documented in PostHogProvider (NEO-13, Maestro #3176/#3271/#3289:
  "detectWindowChange latches onto transient handles and never switches back") — but the transient handle here
  is the OTHER worker's Chrome window, not an analytics iframe.

## D8 (PENDING — user suggested --shard-split): fix the within-VM concurrency. Options:
  (A) Maestro-native `--shard-split N` (user's idea): one maestro process manages N isolated shards/browsers
      within a VM. RIGHT instinct. OPEN QUESTIONS: does Maestro 2.6.0 web spawn N ISOLATED browsers (vs one /
      serial)? is there a shard-index env flows can read for TEST_EMAIL_N? how to integrate Phase-0 bootstrap?
      No shard-index env found in the install grep. Needs a quick local validation.
  (B) PARALLELISM=1 + more GH-matrix shards (e.g. 8×1, we have 8 accounts): ZERO within-VM concurrency — each
      VM = exactly one maestro/Chrome (like the stable seed). Config-only (matrix [0..7], SHARD_TOTAL 8,
      PARALLELISM 1), uses existing infra + provisioned accounts. GUARANTEED to dodge the contention.
  → Recommend: validate (A) locally (cleaner if it works); ship (B) if (A) doesn't pan out. (B) is the
    confident fix that directly targets the evidenced root cause.

## D8 RESOLVED — `--shard-split` is NOT usable for web (LOCAL SPIKE):
  `maestro test --platform web --headless --shard-split 2` → "Not enough devices connected (1) to run the
  requested number of shards (2)." Maestro's native sharding is DEVICE-based (N connected Android/iOS
  emulators); web has exactly 1 device, so it can't spawn N browsers on one machine. So (A) is OUT — and we
  cannot eliminate run-e2e-smoke.sh via native sharding. (The script launches N separate `maestro test`
  processes BECAUSE that's the only way to parallelize web on one machine — and that multi-process Chrome
  sharing is the contention.)

## D9 — DECISION: web parallelizes ACROSS machines, not within one → PARALLELISM=1 + more GH-matrix shards
  - Each GH-matrix shard is its own VM = its own single maestro/Chrome (exactly like the stable p=1 seed).
    Zero within-VM concurrency → zero Chrome contention → no CDP flake. This is the natural model for web E2E.
  - Implementation = workflow config ONLY: matrix [0..7], SHARD_TOTAL "8", MAESTRO_PARALLELISM "1". run-e2e-
    smoke.sh already supports p=1 (serial worker-0 path). At p=1, shard N → worker N → TEST_EMAIL_N (we have
    0..7 provisioned). Keeps D4 (best-effort warm) as defense in depth.
  - On "eliminate run-e2e-smoke.sh": can't fully (still need per-shard flow partition + Phase-0 bootstrap +
    WORKER_INDEX→TEST_EMAIL mapping that Maestro doesn't do). BUT at p=1 it's much simpler (no lane scheduling),
    and the planned QUEUE turns each VM into a thin "claim flow → maestro test → repeat" loop = the closest we
    get to "run maestro directly". So: p=1+shards now for green; queue later for the simplification.
  - Implementing D9 now; pushing for a green run.
