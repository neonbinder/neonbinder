# NEO-29 overnight log — 2026-05-29

**Goal:** PR #41 (`neonbinder/neonbinder_convex`, branch `jburich/neo-29-…`) E2E **all green, reliably**.
**Hard rule:** DO NOT merge anything (user merges in the morning). #36 + IoC prod release already merged/deployed earlier — leave them.

## Standing constraints / lessons (carry these all night)
- **No login-burst.** The login-retry amplifier was removed (loginWithRetry retries only on 503). Do NOT reintroduce retry-on-failure — it hammered BSC into a ~6-min 500 burst.
- **BSC cold login ~22.9s, cached <1s.** A cold Puppeteer login can trip BSC under burst/high volume; it recovers after cooldown. Don't fire many runs in rapid succession — if BSC starts 500ing, back off ~30-60min before the next run.
- **Trust the run `conclusion`, NOT the maestro sticky PR comment** unless its `updated_at` is after the run's `createdAt` (the comment goes stale across runs).
- **Diagnose from evidence:** gcloud browser logs (`/login/bsc` status + `[challenge page detected]`), PostHog `credential_test_failed` (challengeDetected/snippet — live on dev now), and the failure screenshots in the `maestro-report` artifact. No speculation.
- **Delegate Maestro flow edits to the maestro-e2e-author agent.** Convex edits I can do directly.
- 10s UI rule holds everywhere EXCEPT the marketplace warm step (sanctioned 30s).
- Reliable watch = `gh run watch <id>` in background + a ScheduleWakeup heartbeat; the pr-watcher *agent* is unreliable (returns early) — don't rely on it.

## State at bedtime
- Last run (26613306515): FAIL — root cause = warm-step success message off-screen; `extendedWaitUntil{visible}` doesn't scroll. BSC logins were 5/5 200 (burst fixed). Approved fix: `scrollUntilVisible` + 30s in util-login-to-bsc/sl + test-bsc/sl-credentials.
- maestro-e2e-author agent applying that fix now (background, agentId aaafd7efde2193f4b).

## Decision log (append-only)
- 00:?? Removed login retry-on-failure (only 503 retries) — commit 5854706. Burst gone (BSC 5/5 200 next run) but run still failed on the off-screen warm assertion.
- ~02:?? Root-caused warm-assertion: success banner renders below the Test-Credentials button (page.tsx:875-897); flows used non-scrolling `extendedWaitUntil`. Fix = scrollUntilVisible + 30s. Delegated to maestro-e2e-author.
- (overnight entries follow…)

- 02:5x Warm-step fix committed (ebd5872) + pushed: replaced extendedWaitUntil{visible} with
  scrollUntilVisible + assertVisible (30s, sanctioned exception) in util-login-to-bsc/sl +
  test-bsc/sl-credentials. Verified: scrollUntilVisible present, no 240000 left, zero cred refs.
  Also updated 10s-rule memory with the sanctioned 30s exception. New e2e run 26615120263 (started
  02:54:02Z); gh run watch (task b42xrhi2v) + heartbeat watching. Awaiting result.
  NOTE/follow-up: test-bsc/sl-credentials have several timeout:30000 — a few may be on non-auth
  scrolls (Clear lifecycle); 30s there is a harmless ceiling but slightly over the 10s rule. Tighten
  the non-auth ones to ~10s in a later pass if green; not blocking tonight.

- 03:0x Run 26615120263 FAILED again at worker-bootstrap (~44-71s, all 3 workers). EVIDENCE: BSC
  /login all 200 (2 cold ~18-20s + 4 cached <1s, no 500, no challenge) — login works. NO SL logins
  (failed before reaching SL warm). Failure is in util-login-to-bsc warm step: success message NOT
  asserted. Screenshots show viewport STUCK at the public-profile section (credential section just
  below) across the whole 30s — scrollUntilVisible is NOT moving the viewport down to the message
  (likely the known headless-web scroll-container gotcha, not just timing). JUnit only says "Unknown
  error"; maestro.log was excluded so no step detail.
- 03:1x Re-included maestro.log in the artifact (commit f9b2488) — SAFE now (no secrets in -e), needed
  for step-level debugging. Flag for morning: this relaxes the artifact allowlist; keep or re-tighten.
  New run 26616126656 (watch task drives next step). Will read maestro.log to pinpoint the warm-step
  failure, then fix precisely (likely via maestro-e2e-author — scroll-container handling).

- 03:35 Run 26616126656 FAILED — but PROGRESS: maestro.log shows the BSC warm step now PASSES
  ("Assert .*BSC account authenticated successfully.* COMPLETED" → util-login-to-bsc COMPLETED). The
  scrollUntilVisible fix worked for BSC. New failure is in util-login-to-sportlots at `tapOn
  "Sportlots"`: CDP MismatchedInputException ("No content to map due to end-of-input") + "null cannot
  be cast to non-null type kotlin.Int". ROOT CAUSE: the Sportlots platform tab is at bounds
  [203,612]-[300,650]; bottom (650) is BELOW the 1024x629 headless viewport fold (629), so the tap
  triggers Maestro scrollToPoint → CDP flake (the documented headless edge-button gotcha). The flow
  scrolls to center "Select Platform" (leaving the tab at the bottom edge) then taps it. BSC util
  passes because BSC is the default tab (no platform-switch tap). FIX: scrollUntilVisible the
  "Sportlots" tab with centerElement:true (bring it off the edge) before tapping. Delegating to
  maestro-e2e-author. (Also: re-included maestro.log was essential here — kept it.)

- 03:4x SL center-tab fix committed (dde731d) + pushed: scrollUntilVisible "Sportlots" centerElement:true
  before all 8 tapOn "Sportlots" (7 flows: util-login-to-sportlots, setup/clear-then-setup/test-sportlots,
  admin-missing-sl/both, refresh-sportlots-creds). Matches centerElement pattern used across the suite.
  Zero cred refs. New run 26616532566. Watching.

- 04:0x Run 26616532566 FAILED 27/27 — BUT MAJOR PROGRESS: worker-bootstrap PASSES now (both warm
  fixes worked; 35→27). Remaining 3 distinct failures (different layer): 
  (1) cascade/setup — after tap "Baseball", ".*Search years.*" never appears; screenshot shows Years
      column "No years available... Syncing Year Options..." → the year-OPTIONS marketplace sync is
      running but empty at 10s. Browser logs show GET /credentials/<user>/token = 404 for one test
      user (user_3DPlQMAl...) vs 200 for another (user_3DPlRJ2...). So cascade/setup's token is COLD →
      the sync does a cold login (~20s) → exceeds the 10s "Search years" wait. ROOT CAUSE = MY warm-once
      refactor REMOVED cascade/setup's own warm (main warmed via setup-bsc/sl before drilling);
      worker-bootstrap's warm doesn't reliably cover this flow's user. REGRESSION, fixable.
  (2) parallel-grouping-accept-and-save — same class: ".*Search manufacturers.*" never appears after
      "2026" (util-drill-to-custom-set sync, cold token).
  (3) set-selector-smoke — NEO-8 CDP MismatchedInputException + "Sync Sports" not found (separate CDP
      flake, not the warm issue).
  FIX: restore warming (util-login-to-bsc/sl) to the marketplace-sync flows before they drill/sync —
  cached token = ~0.5s no-op when already warm, so no login burst. Delegating to maestro-e2e-author.
  set-selector-smoke's "Sync Sports" CDP flake handled alongside (warm + center the button).

- 04:1x Warm-before-sync fix committed (9d95ebb) + pushed: util-login-to-bsc/sl warm added to
  cascade/setup (before Baseball drill), parallel-grouping-accept-and-save (before custom-set drill),
  set-selector-smoke (before Sync Sports + centerElement on the tab). NOTE: util-drill-to-custom-set's
  own contract says custom subtrees short-circuit the BSC/SL sync ("no adapter calls") — which
  contradicts the cold-token theory for parallel-grouping's "Search manufacturers". So running this to
  GET EVIDENCE: cascade/setup warm is well-evidenced (un-skips ~24 cascade-dependent flows); the run
  will show if parallel-grouping + set-selector-smoke are actually fixed or need a different fix.
  Did NOT centralize warm into util-drill-to-custom-set yet (contested assumption — wait for evidence).
  New run 26617727291. Watching.

- 04:2x Run 26617727291 FAILED — but the ONLY failure was worker-bootstrap on **worker 0** (w1+w2
  PASSED). w0 failed BOTH attempts on the Sportlots warm with the NEO-8 CDP flake
  (MismatchedInputException "No content to map due to end-of-input") during the scroll on the heavy
  /profile page. The SL center-tab fix WORKED on w1/w2 (util-login-to-sportlots COMPLETED), w0 just
  didn't recover from the intermittent CDP error. NO deterministic failures this run (cascade/setup
  etc. not in the failed list). So the remaining blocker to RELIABLE green = intermittent NEO-8 CDP
  web-driver flakiness on the warm-step scroll, ~2/3 workers pass. This is pre-existing infra flake,
  not a NEO-29 code defect.
  NEXT (one targeted de-flake): util-login-to-sportlots does a redundant DOUBLE openLink /profile +
  scrolls immediately (page reflowing → CDP empty-response). Remove the redundant openLink + add
  waitToSettle/settle before the scrolls to reduce the CDP-during-reflow window. If still flaky →
  MORNING RECOMMENDATION: warm tokens SERVER-SIDE (eliminate the flaky UI "Test Credentials" warm taps
  entirely) — a Convex change (seed schedules authenticate; tradeoff: async race vs seed-page block) —
  OR a NEO-8 CDP-stability pass. Both are design calls for the user; deterministic NEO-29 work is DONE.

- 04:3x De-flake committed (fceea2c) + pushed: removed redundant double openLink /profile + added
  "Profile Settings" settle gate + waitToSettleTimeoutMs:1000 on warm-step scrolls in util-login-bsc/sl.
  Targets the NEO-8 CDP MismatchedInputException that failed w0 last run. New run 26618163560. Watching.
  STOP-CONDITION: if this run is GREEN → log green + stop. If it FAILS again only on the intermittent
  CDP flake (no deterministic failure) → STOP iterating + write morning summary recommending
  server-side token warming (eliminate UI warm taps). Don't gamble on lucky all-pass.

═══════════════════════════════════════════════════════════════════════════
## MORNING SUMMARY (2026-05-29 ~04:45 — loop stopped; NOT reliably green; NOTHING merged)
═══════════════════════════════════════════════════════════════════════════

### Bottom line
PR #41's E2E is NOT reliably green. ALL deterministic failures are fixed; the ONLY remaining blocker
is intermittent **NEO-8 CDP web-driver flakiness** (`MismatchedInputException: No content to map due
to end-of-input`) on the warm-step scroll on the heavy /profile page. Last 2 runs failed ONLY on this
(worker-bootstrap 1 FAIL / 2 PASS each time — different worker, recovers ~2/3 of the time). This is
pre-existing Maestro-web infra flake, NOT a NEO-29 code defect. I stopped firing runs rather than
gamble on a lucky all-3-workers-pass.

### Delivered + verified this effort (all on branch jburich/neo-29-…, PR #41 — NOT merged)
- **-e credential leak ELIMINATED**: server-side seedMyTestCredentials + /testing/seed-credentials route;
  every flow off `-e`; run-e2e-smoke.sh + e2e-tests.yml stripped of secrets; artifact allowlist.
- **Browser deploy pipeline fixed + PROD CAUGHT UP** (this was merged/applied, separate from #41):
  browser #36 (login-probe OIDC) + IoC #22→#23 (deployer run.invoker, applied dev+prod) → prod went
  from 15 commits behind to current.
- **Login retry-on-failure removed** (only 503 retries) — it was amplifying BSC logins into a burst.
- **Warm-step fixes**: scroll-to-success-message; SL platform-tab centerElement; warm-before-sync in
  cascade/setup; CDP de-flake (remove redundant /profile reload + Profile-Settings settle gate +
  waitToSettleTimeoutMs:1000).
- **Login-failure diagnostics LIVE** (browser #34 deployed dev+prod; Convex forwarding in #41) →
  PostHog `credential_test_failed` now carries challengeDetected/url/snippet. Memory saved
  (reference_login_failure_diagnostics).
- **maestro.log re-included in the artifact** (commit f9b2488) for debugging — SAFE (no -e secrets).
  ⚠️ DECIDE: keep, or re-tighten the allowlist.

### Trajectory: 35 failed → 27 → now only the intermittent CDP flake on 1 worker.

### To reach RELIABLE green — your call (all options leave NEO-29's leak fix intact):
1. **PREFERRED — warm tokens SERVER-SIDE**: have seedMyTestCredentials warm the marketplace token
   (so the flaky UI "Test Credentials" warm taps + /profile scrolls are removed entirely → no CDP
   flake there). Tradeoff to decide: async warm (race: cascade may fetch before warm done) vs the seed
   page awaiting the warm (slower redirect). Needs an internal authenticate-by-userId variant (scheduled
   fns lack auth ctx). This is the durable fix.
2. **NEO-8 CDP-stability pass**: Maestro version/config, virtualize the heavy /profile DOM, or bump
   flow-retries — broader, separate.
3. **Merge #41 as-is**: the credential-leak changes are correct + verified; the only red is pre-existing
   intermittent CDP infra flake. Your judgment (you said merge IF reliably green — it's not, but the
   failures aren't the PR's logic).

I recommend option 1 (server-side warm) but it's a design choice I didn't want to make autonomously at
4am. Nothing merged. PR #41 = github.com/neonbinder/neonbinder_convex/pull/41.
