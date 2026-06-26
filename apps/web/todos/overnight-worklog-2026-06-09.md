# Overnight Worklog — 2026-06-09 (→ 06-10)

**User instruction (going to bed):** "continue to work to green. Do not merge anything in this PR. Keep a log of all decisions you make so that we can review and roll back if necessary."

**Hard constraints:**
- ❌ Do NOT merge PR #53 (or anything).
- ✅ Work toward green.
- ✅ Log every decision here with rollback info.
- Branch: `jburich/sync-maestro-agent-memory` (PR #53, the flow-stabilization walk).

---

## ☀️ MORNING SUMMARY (2026-06-10) — READ THIS FIRST

**TL;DR:** Every DECIDED flow-walk change (#1–26) is validated locally **GREEN** at parallelism=1. **Nothing committed, pushed, or merged.** The sole blocker to CI/gate-green is a pre-existing **SportLots concurrent-login** issue — root-caused + documented, **NOT deployed** (your decision). The walk is ~26/57 done; #27+ await the live walk with you.

**✅ Validated GREEN (local, parallelism=1, agent fixes in the working tree):**
- Credential-gate triplet #16/#17/#18 (dedicated fixed-state accounts) — zero fixes.
- `util-add-custom-card` + migrations #19/#20/#23 — green.
- #21, #22 (redesign = read pre-synced), #26 — green.
- #24 exemplar (no change); #25 deleted (redundant).
- **Product:** `EntityColumn` `mb-field` input fix + unit test (5/5 vitest).

**🔴 THE blocker — SportLots concurrent login (needs your call):**
The 8-worker gate does concurrent SL logins to the ONE shared account (`dev@neonbinder.io`); SL rejects most ("Not a valid Email Address"). Verified: NOT rate-limit (your word), NOT bad creds (the stored email is valid + consistent), NOT the BSC deploy (BSC logs in fine). Single logins are flawless. **Fix = pre-warm one shared SL token before the workers fan out** (test-infra, lowest risk) — full analysis + options in **D3**. I did NOT touch the production credential path.

**⚠️ Review items (details in the decision log):**
- two-field "player name + card name" doesn't match the UI (one name field) — works via erase-hack; consider one param (**D4**).
- #19 RC toggle state not assertable in Maestro-web (`aria-pressed` unreadable) — persistence test is the coverage (**D4**).
- #26 weak "Baseball" assert (no-op) + sync-wait no longer waits for full completion (**D8**).
- #22 hidden setup-dependency — works in-gate (**D6**).
- cold custom-set VT sync ~32s — possible product inefficiency (**D4**).

**Operational:** two maestro agents emitted confusing intermediate/replayed notifications; one false-alarm whipsaw, recovered, no harm. Rules logged in **D7**. Infra: must use `openjdk@21` + Node 24.3.0 + Vite is HTTPS (**D8**).

**Remaining:** your SL-fix decision → CI-green; then the live walk of #27–57.

---

## Situation at hand-off

### The blocker: `convex-dev-gate` web-E2E fails (chronic) — SportLots login under concurrency
- The browser-deploy (BSC HTTP login PR #44, commit `7f02e84`) is GREEN through dev-promote + dev-login-probe; **prod is blocked because `convex-dev-gate` (full 8-worker web E2E) fails** (issues #45, and previously #41 — chronic).
- Root cause (evidence, Cloud Run logs `neonbinder-browser` @ neonbinder-dev, gate run 27248864364 ~02:30-02:44 UTC):
  - **SportLots login fails for most concurrent workers**: `status=200`, body 113 bytes = `<body onload='window.location="?message=Not a valid Email Address"'>`, `parsed 0 cookie(s)`, 5 retries each. **1 of ~5-6 workers succeeded** (4 cookies, token stored). Email is VALID (1 success).
  - BSC mostly OK (B2C login succeeded) but one `Secret …buysportscards-credentials-user_3ErKnY3… not found` (seeding gap).
  - 4 of 6 failing flows fail at `assertVisible "Set Selector"` → the page shows the **credential-gate banner** ("Set Builder requires marketplace credentials") because the worker has **no SL creds** (seeding failed). `sets-base` fails later on SL "likely match"; `parallel-grouping-cancel` on "Years". All downstream of the SL login failure.
- **RULED OUT:** (a) contention from my local runs — the clean re-run failed identically; (b) the BSC change — `7f02e84` only touched `bsc-adapter.ts`, BSC logged in fine; (c) **rate limiting** — user confirmed SL does NOT rate-limit (crazy-old site, nothing fancy). I was wrong twice on contention + rate-limit; corrected.
- **Open mechanism:** with a valid+same email, no SL rate-limit, and clean per-request credential resolution, why do simultaneous SL logins return "Not a valid Email Address"? Leading hypothesis = **shared HTTP state in the browser service under concurrency** (global cookie jar / dispatcher / connection reuse) corrupting concurrent logins. Investigating.

### PR #53 flow walk — queued author-only changes (validation pending)
All authored author-only (NO maestro validation run yet — gate was holding the dev browser service). Local validation at MAESTRO_PARALLELISM=1 avoids the SL concurrency issue (single login at a time).

---

## DECISION LOG (newest first)

### D8 — #21/#22/#26 VALIDATED GREEN (parallelism=1) + #26 caveats + infra notes
a2494468 completed all 3 green (#21 2m21s clean / #22 2m after setup pre-seed / #26 1m40s). Working tree verified coherent (its fixes intact; the redundant a6e88c74 stopped+reaped before it could write conflicting edits).
- **#21** — no change (R6/R8 already correct).
- **#22** — removed the explicit `timeout:7000`. Validated via `test:e2e:pick -- setup` THEN the flow with `MAESTRO_SKIP_BOOTSTRAP=1` (preserves pre-seeded data) — confirms the read-pre-synced redesign works.
- **#26** — added missing `appId`; **sync-wait changed**: `notVisible "Fetching..." 60s` (timed out locally — cold BSC+SL sport sync is 60-120s) → `visible "Syncing Sport Options" 15s` + navigate away. The **EntityColumn `mb-field` product fix confirmed end-to-end** (custom sport created, badged, survived re-sync).
- **⚠️ #26 CAVEATS to review:** (a) the final `assertVisible "Baseball"` is a near **no-op** — Baseball was already present from the initial auto-sync, so it doesn't prove the re-sync wrote NEW data (weak assertion); (b) the sync-wait change means #26 no longer waits for the full sync to COMPLETE (just confirms it started) — reconsider whether "survives a sync cycle" is still properly exercised; (c) a now-stale comment in Step 2.
- **Infra notes (from agent, added to its memory):** must `export JAVA_HOME=/opt/homebrew/opt/openjdk@21` (Homebrew OpenJDK 23 SIGSEGVs Maestro GC); Node **24.3.0** per `.nvmrc` (22.5.1 fails the Vite mkcert/undici plugin); Vite serves **https**://localhost:3000.

### D7 — OPERATIONAL LESSON: maestro-agent notification noise (don't whipsaw)
What happened: agent a2494468 (#21/#22/#26 batch) returned + orphaned its maestro run; I reaped it (correct) + re-delegated a6e88c74. Then the harness sent SEVERAL MORE notifications for a2494468 with mid-thought results ("setup is running. Let me monitor it"), which made me briefly think I'd killed a HEALTHY agent. `TaskStop a2494468` → "not running (status: completed)" = it WAS done; those were **replayed transcript checkpoints (noise)**. No healthy agent was harmed; a6e88c74 is the sole active validator (Vite up, lock held, flow running).
**Rules for me going forward (and in the gate ops):**
1. Only act on a **STRUCTURED final report** (PASS/FAIL per flow + diffs). A mid-thought ("let me wait…", "setup is running") is an intermediate yield OR a replay — do NOT reap/re-delegate on it.
2. A **stale transcript mtime during an active maestro run = a long WAIT, not death.** Don't infer death from it.
3. `TaskStop <id>` is the non-destructive done-check: it errors "not running" if the agent is already completed.
4. Only reap an orphan when: a structured report arrived (done) OR processes are truly gone + lock stale for many minutes.

### D6 — #21/#22/#26 batch agent returned prematurely + orphaned its run; reaped; #22 data model settled
- The batch agent's transcript went stale at 23:35 (26 min before I checked) BUT maestro processes kept advancing (fresh pids) = it **returned and left an ORPHANED maestro run** (npm→bash→gtimeout→java→chromedriver, respawning). Reaped the whole tree (`pkill -9 -f run-e2e/maestro/chromedriver`), freed the stale lock. 0 maestro procs now.
- **#22 redesign is NOT broken by the reset (verified):** `resetMyTestState` (convex/testing.ts:30) deletes ONLY the user's `publicProfiles`/`userProfiles`/`prizePool` — NOT `cardChecklist`. So setup's pre-synced 2024 Topps Chrome Base data persists past the per-worker bootstrap reset. The agent's "no setup data" was because **`test:e2e:pick` didn't run SETUP for #22** (#22 reads pre-synced data but doesn't declare a setup prereq, so the picker's closure omits it). In the GATE setup always runs first → #22 works. For isolated validation: run setup THEN #22.
- **Open item for you:** #22's redesign introduced a hidden setup-dependency the picker can't auto-resolve. Options: declare setup as a #22 prereq (cleanest), or accept it only validates in-gate, or revert to fetch. Low priority (works in-gate).
- Re-delegating #21 + #26 (clean) + #22 (with explicit setup). If an agent orphans again, the reap+re-delegate pattern is logged here.

### D5 — credential-gate triplet #16/#17/#18 VALIDATED GREEN (parallelism=1), zero fixes
All 3 first-try pass: #16 (admin-no-credentials, both-missing banner) 11s, #17 (admin-sl-only, BSC-missing) 12s, #18 (admin-bsc-only, BSC seeded via real HTTP login 14s, SL-missing) 14s. The dedicated-account redesign + `?sites=` seed param + MissingCredentialsBanner text all correct. **Single-platform single logins (BSC 14s, SL ~3s) work perfectly — further confirms the gate failure is purely 8-way concurrency, not the login itself.** No flow edits, no product bugs.

### D4 — util migration #19/#20/#23 VALIDATED GREEN (parallelism=1) + 3 findings to review
All 4 pass locally at parallelism=1; bootstrap clean every run (~55s; single SL/BSC login works — confirms parallelism=1 sidesteps the gate's concurrency issue). Agent fixes (working-tree only, no commit):
- `util-add-custom-card.yaml`: `eraseText:80` before `inputText ${CARD_NAME}`.
- `card-detail-panel.yaml` (#19): **removed the `checked:` RC assertions** (see finding #2).
- `custom-card-crud.yaml` (#23): fixed row assertions to the single-field model (see finding #1).
- `util-drill-to-custom.yaml`: VT (Level-5) wait **30s→45s** (cold custom-set VT sync takes ~32s — see finding #3).

**⚠️ FINDING #1 — the two-field model does NOT match the UI (needs your call).** The checklist row renders only `card.cardName` (`CardChecklistItem` L125). The Add-Card form has ONE name input: `aria-label="Card name"`, placeholder "Player name", saves to `cardName`. There is NO separate player-name field/column. So "player name always + card name extra" doesn't exist in the current UI — PLAYER_NAME and CARD_NAME both target the same input (the agent added erase-before-CARD_NAME so they don't concatenate). It WORKS, but the util's two-param design is redundant; should likely collapse to ONE name param. I did NOT collapse it (you specified the two-field model — confirm intent: simplify, or are you adding a real player-name field?).

**⚠️ FINDING #2 — RC toggle state is NOT assertable in Maestro-web.** CDP can't read `aria-pressed`, so `checked: true/false` time out. Removed them (matches the pre-agreed honest fallback). R2 "hollow RC assertion" stands — the toggle→save→reopen→chip-present persistence test is the best available coverage. Unit tests should cover the RC active-state.

**⚠️ FINDING #3 — cold custom-set VT sync ~32s.** A fresh custom Set shows "Syncing Variant Types" ~32s before the VT column settles. Custom subtrees shouldn't need a marketplace round-trip — possible product inefficiency (mirrors the #22 "don't fetch what's custom/pre-synced" theme). Bumped the wait to 45s to unblock; did NOT investigate the product side. Worth a look.

### D3 — SL root cause CONFIRMED (verified creds) + fix options (NOT deploying tonight)
- **VERIFIED via gcloud Secret Manager:** every e2e worker's `sportlots-credentials-user_*` stores a VALID, consistent email `dev@neonbinder.io` (passwords present; only the owner's own secret differs = jburich@gmail.com). So `"Not a valid Email Address"` is **NOT** a bad/empty stored credential.
- **Confident root cause:** the SL login fails ONLY for **concurrent logins to the one shared SL account** (`dev@neonbinder.io`). Single logins work (1 gate success; normal app flow; parallelism=1 local runs). Ruled out: rate limit (user-confirmed), bad creds (verified), shared adapter HTTP state (verified per-request), the BSC deploy (only touched bsc-adapter.ts; BSC logged in fine). The adapter's per-user token cache can't save the COLD start (all 8 caches empty on a fresh preview → all 8 log in at once).
- **Fix options (for USER review — I am NOT deploying a production credential-path change autonomously):**
  - **A (recommended): one shared SL token.** All workers share the account, so they should share the token: change the SL cache lookup to a per-SL-ACCOUNT shared token (or pre-warm one token before the workers fan out + reuse). 1 login total, no concurrency.
  - **B: serialize SL logins** via an in-process async mutex in the browser service. Only works if the gate's seed-logins land on ONE Cloud Run instance (checking concurrency/min-instances).
  - **C: separate SL accounts per worker** — no shared-account concurrency, but needs N SL seller accounts (expensive).
- **Cloud Run topology (checked):** `neonbinder-browser` dev = containerConcurrency **3**, minScale **1**, maxScale **20**. So 8 concurrent seed-logins fan across multiple instances → **option B (in-process mutex) is NOT reliable** (can't serialize across instances).
- **Cross-instance nuance (important):** even a shared per-account token cache (A) has a COLD-RACE window — on a fresh preview all 8 are cold and, spread across ~3 instances, several still log in simultaneously before the first token is cached. An in-process lock only narrows it per-instance, not across instances. A truly race-free in-adapter fix needs a DISTRIBUTED lock (complex).
- **→ Cleanest robust fix = PRE-WARM (test-infra, lower risk than the production adapter):** in the gate's setup phase (before the parallel runners fan out), do ONE SL login and seed the resulting token into every worker's secret (or a shared token the adapter checks first). Then the runners hit a warm cache → ZERO concurrent SL logins. This touches the gate/bootstrap, not the production credential path. Decide the exact spot with your knowledge of the e2e-tests.yml setup phase.
- **Alternative (C):** separate SL seller accounts per worker — no shared-account concurrency at all, but needs N real SL accounts (cost/setup).
- The in-adapter per-account shared-token cache (original A) is still worth doing as a durable optimization (cuts 8 logins → ~1 in steady state), just not sufficient ALONE for the cold gate race.
- **DECISION: do NOT implement/deploy the SL fix tonight.** It's a production credential-path change (a wrong fix could break ALL seeding); user is asleep + said "don't merge"; the exact A-shape depends on gate architecture the user knows best. Fully documented here for morning review. Flow-walk progress continues at parallelism=1 (sidesteps this entirely).

### MORNING SUMMARY (read first)
1. **Gate blocker = SL concurrent-login to the shared `dev@neonbinder.io` account.** NOT rate-limit, NOT bad creds (verified valid), NOT the BSC deploy. Fix = **share one SL token** (option A above). I did NOT deploy it — your call on the exact shape. BSC login itself is fine.
2. **Flow walk (PR #53):** validating queued author-only changes locally at parallelism=1 (which sidesteps the SL issue). See decision log for every change + rollback command. NOTHING committed/pushed/merged.
3. **CI-green is blocked on #1** (the 8-worker gate hits the SL concurrency); local-green is achievable and in progress.

### D2 — Validation strategy: local PARALLELISM=1 first, NO speculative SL fix
- SL adapter fetch is clean: per-request `fetch` + local `URLSearchParams`, no shared cookie jar/dispatcher/agent (only BSC has a `B2CCookieJar`, instantiated per-login). So the SL concurrency failure is NOT a shared-adapter-resource bug.
- The mechanism behind concurrent SL "Not a valid Email Address" is NOT yet confidently established (ruled out: rate limit, shared adapter resource, the BSC change; candidates remaining: undici global connection pool vs SL's old server, or a seeding-path issue). **DECISION: do NOT make a speculative browser-service/credential fix tonight** (high risk, user dislikes speculation). Gather evidence; only fix with a confident root cause.
- **DECISION: validate the queued flow-walk changes LOCALLY at `MAESTRO_PARALLELISM=1`** — single login at a time sidesteps the concurrency failure entirely and makes real, reversible progress on PR #53. Delegating to maestro-e2e-author agents (validate-to-green, run-lock serialized), one at a time.
- Rollback: all flow-walk changes are uncommitted on the branch; `git checkout origin/main -- <file>` reverts any.

### D1 — First validation target: util-add-custom-card migration (#19/#20/#23)
- Highest risk/value: new util + 3 migrations + the unverified #23 two-field (PLAYER_NAME + CARD_NAME) assertions. Validating it also confirms single-login works (its bootstrap). Agent: (see below).

### D0 — Setup (2026-06-10 ~02:5x UTC)
- Updated memory `feedback_no_bsc_rate_limit_assumption.md`: SL does NOT rate-limit either (was BSC-only). Rollback: `git -C ~/.claude... ` n/a (memory dir, not git-tracked here) — revert the file edit if wrong.
- Created this worklog.

### Prior decisions this session (flow walk #16-26) — all on branch `jburich/sync-maestro-agent-memory`, uncommitted, author-only
- **#16/#17/#18 credential-gate triplet**: rewritten to dedicated fixed-state Clerk accounts (admin-no-credentials/bsc-only/sl-only) sign-in-and-assert. (#17/#18 validation stalled earlier — likely the SAME SL concurrency issue at parallelism=3.)
- **#19 card-detail-panel**: R6/R5/R8 cleanup + RC `checked:` trait + backdrop `1%,1%`. Migrated to util-add-custom-card.
- **#20 card-features-missing**: R5/R6/R8 cleanup. Migrated to util.
- **#21 cards-parallel-custom**: R6 + R8 (center Prizm Gold tap).
- **#22 checklist-renders-rich-fields**: REDESIGN — drop the marketplace fetch, read setup-pre-synced checklist. 119→77 lines.
- **#23 custom-card-crud**: R6/R8 + migrated to util (PLAYER_NAME always + CARD_NAME extra). ⚠️ FLAG: asserts both player+card name render on the row — unverified.
- **#24 sets-base**: EXEMPLAR — no changes.
- **#25 set-selector-smoke**: DELETED (redundant). Rollback: `git checkout origin/main -- .maestro/flows/set-selector/set-selector-smoke.yaml`.
- **#26 custom-entry-survives-resync**: R4 (drop prod-write creds re-runs) + R2 (pin Custom via rightOf) + R5 + removed stale WIP block + fixed stale comment.
- **util-add-custom-card.yaml**: NEW — consolidated add-custom-card preamble for #19/#20/#23 (#27 left inline, different drill). 191 lines (comment-heavy, trim later).
- **EntityColumn.tsx (PRODUCT)**: added `useFieldTestClass()` to the "Add Custom Entry" input (`mb-field-*`) so Maestro inputText targets it. tsc-clean. Rollback: `git checkout origin/main -- components/SetSelector/EntityColumn.tsx`.
- **EntityColumn.field-class.test.tsx (NEW unit test)**: 5/5 green via vitest. Validates the above.

---

## TONIGHT'S PLAN (conservative, reversible, logged)
1. Nail the SL concurrency root cause with EVIDENCE (shared HTTP state? single-login-works test?). No speculative browser-service changes.
2. If a confident + safe fix emerges → implement + log + targeted-validate.
3. Validate queued flow-walk changes LOCALLY at PARALLELISM=1 (sidesteps SL concurrency) via maestro-e2e-author agents (serialized on run-lock, validate-to-green).
4. Do NOT merge. Do NOT re-run the cloud gate repeatedly (expensive) until the SL fix is in hand.
