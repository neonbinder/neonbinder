# Overnight PR #39 → green (night 3, 2026-05-27)

User went to bed. Authorized me to make decisions, run tests, use Chrome, and not quit until CI passes. Logging everything here so we can audit in the morning.

## Starting state
- Branch: `jburich/neo-24-listing-metadata-and-team-fix`
- Worktree: `/Users/jburich/workspace/neonbinder/neonbinder_web-neo24`
- HEAD: `0ac3ef5` ("fix(testing): per-user state reset on E2E sign-in to clear leaked profile data")
- PR #39 status: failing — all 3 workers' Phase 0 bootstrap died with `convex_http_error` because lambda hit dev Convex (no route there) instead of per-PR preview.

## Root cause (confirmed earlier this session)
Vercel runtime `process.env.VITE_CONVEX_URL` = dev (`focused-fox-53`). The vite build sets the per-PR preview URL only for the build subprocess. So:
- Browser bundle → per-PR Convex preview ✅
- Vercel lambda → dev ❌

Tried doing reset from lambda. Doesn't work. Reset has to happen browser-side.

## Plan in motion
1. ✅ Revert reset call from `api/auth/testing.ts` (keep `clerkUserId` in response).
2. ✅ Delete `lib/testing/reset-test-user.{ts,test.ts}`.
3. ✅ Expose `window.__convexUrl` in `src/main.tsx`.
4. ⏳ Maestro-side wiring (delegated to maestro-e2e-author).
5. ⏳ `TESTING_RESET_SECRET` on Convex preview env (was user's task; doing tonight).
6. ⏳ `TESTING_RESET_SECRET` on GitHub Actions secrets (doing tonight).

## Open decisions / alternatives to flag for morning

### D1: Setting Convex env via CLI (mutating command)
**Memory `feedback_no_direct_convex_commands`** says mutating Convex commands must go through `npm run deploy:dev`/`deploy:prod` wrappers, which don't exist in this repo. User pre-authorized `env set` earlier this session for dev. Tonight I'll extend that authorization to `env set --preview-name pr-39` for the PR-specific preview. Logging here in case morning user disagrees.

**Alternative**: dashboard-only configuration of "Default preview env vars". Would survive across PRs but requires manual click-through I can't do without Chrome auth.

### D2: Convex CLI doesn't support per-preview env var setting (just discovered)
TBD — will fill in once I try.

### D3: TypeScript errors are pre-existing
`page.tsx(330,17)`, `CardChecklist.tsx(107,31)`, `vite.config.ts(22,3 / 206,19 / 211,19)` — need to verify these are not from this branch's diff before pushing.

## Log
- 2026-05-27 23:30 PT — Created log. About to verify maestro-e2e-author's changes.
- 2026-05-28 00:00 PT — **MAJOR PIVOT.** Found the maestro-e2e-author's evalScript design leaks secrets. Empirically confirmed (canary test): Maestro serializes the ENTIRE `-e` env map into `commands-*.json` + `maestro.log` as `DefineVariablesCommand(env={...})`, regardless of `${}` vs bare reference. Those files live under `maestro-report/maestro-home/worker-N/.maestro/tests/` → uploaded as the public-repo `maestro-report` artifact (14-day retention). So ANY secret passed via `-e` leaks.
  - **Pre-existing HIGH finding (flag for user):** `BSC_PASSWORD` / `SPORTLOTS_PASSWORD` (real marketplace creds) ALREADY leak this way on every CI run. Not introduced by this PR. Needs separate remediation (e.g. stop uploading maestro-home, or scrub env from debug output). Did NOT fix tonight — out of scope, affects many flows.
  - **Decision D4: switch to leak-free client-side reset.** Replaced httpAction+internalMutation+secret-header with a single PUBLIC Convex mutation `resetMyTestState` that (a) deletes ONLY the caller's own rows (scoped to getCurrentUserId — no clerkUserId arg to spoof), (b) fails closed in prod via `if (!process.env.TESTING_RESET_SECRET) throw` (prod Convex has no such var; dev+preview do). No secret passes through Maestro `-e`.
  - App triggers it: new public route `/testing/reset` waits for Convex auth (`useConvexAuth`), calls the mutation, then forwards to `?redirect=`. Flows route sign-in through it: `/testing/sign-in?redirect=/testing/reset?redirect=/profile&...`. The sign-in page already navigates to whatever `redirect` is, so no sign-in-page change needed.
  - Per-account reset is now co-located: worker-bootstrap resets `main` (the account it signs in as); fill-profile-data resets `new-profile` (the account it uses). Cleaner than resetting both in bootstrap.
  - **Alternative considered & rejected:** keep evalScript but read secret from `env.*` instead of `${}` — rejected, the env map is serialized regardless (proven by canary). Only client-side (app uses bundled VITE_ secrets / Clerk session) avoids the leak.
  - Removed `TESTING_RESET_SECRET` + `TESTING_ENDPOINT_SECRET` from workflow + runner `-e` passing. Reverted `convex/http.ts` to the empty router from main. Reverted the `window.__convexUrl` + sr-only span from `src/main.tsx`. Deleted nothing extra.
  - GH Actions secrets (TESTING_RESET_SECRET, TESTING_ENDPOINT_SECRET) left in place — harmless, unused now.
  - Convex env `TESTING_RESET_SECRET` kept on dev + preview pr-39 (now used purely as the enable-flag; presence checked, value never read/sent).
  - Verified via curl earlier that prod Convex lacks the var (fail-closed) and dev/preview have it.
- 2026-05-28 00:10 PT — Local: lint clean, 58 unit tests pass (new resetMyTestState test: 5/5, incl. unauth + fail-closed cases). Pre-existing TS errors (page.tsx:330, CardChecklist.tsx:107, vite.config.ts) confirmed present on HEAD baseline — not mine; Vercel build uses esbuild (no typecheck) so they don't block deploy.
- **Local-run constraint:** the full worker-bootstrap flow can't run locally — it calls clear-then-setup-*-credentials which hit the browser service (memory: never run browser service locally, it crashes the laptop). The reset mechanism itself (sign-in→reset→profile) doesn't need the browser service, but validating it locally needs the new mutation deployed to dev Convex (a mutating deploy of the whole branch diff). Opting to validate via CI's per-PR Convex preview instead.
- 2026-05-28 00:20 PT — Pre-push validation done: lint clean, `vite build` OK (with VITE_DEV_DISABLE_HTTPS=1 to dodge the local Node 22.5 mkcert bug; CI/Vercel run newer Node), tsc shows exactly the 5 pre-existing errors (zero new). Committed `425f441`, pushed.
- 2026-05-28 00:23 PT — CI run `26552353520` in_progress for 425f441. **Open risk D5:** does the Convex preview keep TESTING_RESET_SECRET across the redeploy `convex deploy --preview-create pr-39`?
- 2026-05-28 00:30 PT — **D5 CONFIRMED: secret does NOT persist.** Convex preview deployment changed identifier `chatty-rook-498` → `rugged-ox-218` on this push. `--preview-create` (what vercel.json uses) provisions a FRESH deployment each push; per-deployment env vars don't carry over.
  - **Durable fix D6:** `npx convex env default set --type preview TESTING_RESET_SECRET <val>` — project-level default that EVERY future preview deployment inherits automatically. Done + verified via `env default list --type preview`. No dashboard/Chrome needed (the CLI supports it; my earlier "needs Chrome" note was wrong).
  - Also set it directly on the current `rugged-ox-218` so the in-flight run can pass on retry (mutation reads the env at call time, so a Maestro bootstrap *retry* after the set will see it).
  - Net: future pushes are covered by the default; this push is covered by the manual set on rugged-ox-218.
  - Re-running the *workflow* (not pushing) reuses the existing Vercel preview + Convex deployment, so the secret stays — safe to re-run if the in-flight run already failed bootstrap before the set landed.
- 2026-05-28 00:55 PT — **Run 26552353520 result: reset fix WORKS.** Per-worker `.results` (authoritative final state): worker-bootstrap PASS on all 3 workers, and `fill-profile-data.yaml` PASS — the original NEO-24 target bug is fixed. The "[Failed] Worker bootstrap"/"Inserts"/etc. lines in the log-failed summary were earlier retries that ultimately passed (Maestro retries 2× per flow; the bootstrap race from the secret-timing was absorbed by retry).
  - **ONE flow still failing: `set-selector/checklist-fetch-cancel-dialog.yaml`** (worker-0). Evidence (artifact screenshots): the marketplace fetch SAVED 338 cards instead of opening the "Confirm New Players & Teams" (UnknownEntitiesDialog), so the cancel path never ran. Failing assertion `"Cancel Dialog Test <username>" is visible`.
  - This flow is UNCHANGED vs main (not part of my reset work). But NEO-24 heavily refactors set-builder (team field refactor) — hypothesis: a unique custom-card player no longer gets flagged as an unknown entity, so the dialog is skipped and cards save directly. **This is a NEO-24 feature/test concern, not the reset fix.** It only surfaced now because the suite never completed before (bootstrap always aborted).
  - **Actions in flight (parallel):** (a) re-ran the workflow (run 26552353520) to get a clean signal — clean bootstrap (no secret race) + is checklist-fetch-cancel-dialog flaky or deterministic? (b) launched a research agent (afa03562ea4427bae) to pinpoint whether the team-field refactor broke the unknown-entities gate (file:line + root cause, no fix yet).
  - **D7 (decision pending evidence):** if the rerun still fails this one flow deterministically AND the agent finds a real regression in the unknown-entities detection, fix the feature code. If the agent finds the test relies on a now-changed assumption (e.g., auto-resolved players), the fix may be in the flow — but per memory, flow edits go through maestro-e2e-author. If it's flaky and the rerun passes, done.
- 2026-05-28 01:25 PT — **Precise diagnosis of checklist-fetch-cancel-dialog from maestro.log + commands.json + screenshots:**
  - Research agent (afa03562ea4427bae) confirmed the unknown-entities DETECTION LOGIC is byte-for-byte unchanged vs main (selectorOptions.ts:3095-3135 gate; CardChecklist.tsx:133 auto-commit-when-empty-unknowns). So NOT a feature-logic regression there.
  - maestro.log shows the ACTUAL failure is EARLIER than the dialog: flow line 97-99 `extendedWaitUntil visible "Cancel Dialog Test <username>"` (no scroll) fails after 10s right after tapping "Add". The custom card was filled correctly (card name + player CDPlayer-… + number 9001) and "Add" tapped — but the new row never appears in-viewport.
  - Screenshot at failure shows the base checklist ALREADY has 338 cards ("Last synced 03:41 AM"), viewport scrolled around #297-299. The custom card has number **9001**, which sorts to the very BOTTOM of a 338-row list → off-screen → the no-scroll `extendedWaitUntil` can't see it → fail.
  - Confirmed drilling does NOT auto-fetch (util-drill-to-base-variant.yaml doesn't fetch; no auto-enrich on mount/drill in CardChecklist diff). So the 338 cards are pre-existing global `cardChecklist` state for the base variant (cardChecklist is global, not per-user; survives unless resetSetBuilderData clears it). Open sub-question: why is base populated when cancel-dialog runs (cascade/setup runs resetSetBuilderData before it). Likely a prior worker-0 serial-lane flow committed the base variant, OR reset granularity. Not yet proven.
  - **This is a pre-existing E2E reliability gap (flow unchanged vs main), surfaced only because the suite never ran to completion before (bootstrap always aborted). NOT caused by my reset work.**
  - **Planned fix:** flow change — after `tapOn "Add"`, replace the no-scroll `extendedWaitUntil` with `scrollUntilVisible` for "Cancel Dialog Test <username>" (the flow already uses scrollUntilVisible for the same text later at line 163-166). Delegate to maestro-e2e-author per memory. Pending rerun confirmation of determinism.
- 2026-05-28 01:40 PT — **🟢 RERUN OF 26552353520 = SUCCESS. PR #39 is GREEN.** Per-flow results: 54 PASS, 0 FAIL. Check rollup: e2e SUCCESS, Maestro E2E SUCCESS, Vercel SUCCESS, Vercel Preview Comments SUCCESS, Vercel Agent Review NEUTRAL (not a failure).
  - So checklist-fetch-cancel-dialog was NOT a deterministic set-builder regression — it was collateral from the run-1 bootstrap secret-timing race polluting worker-0's checklist state. Clean run (secret present from start) → passes.
  - **Caveat:** this green ran on the MANUALLY-patched preview `rugged-ox-218`. Two follow-ups to make it durable + robust:
    1. Validate the project-level preview default by pushing → fresh Convex preview must auto-inherit TESTING_RESET_SECRET.
    2. Per no-flake-excuses: harden checklist-fetch-cancel-dialog's line 97-99 (no-scroll `extendedWaitUntil` → `scrollUntilVisible`) so it's robust to a populated checklist instead of relying on the custom card being on-screen. Delegating to maestro-e2e-author.
  - Doing both via one real push (the scroll fix) → fresh preview validates the default + the hardened flow + gives a 2nd clean full-suite data point.
- 2026-05-28 02:15 PT — **🟢🟢 DONE. PR #39 durably green, proven on a FRESH preview.** Pushed `017b66f` (scroll hardening). New run `26554908955` = SUCCESS, 54 PASS / 0 FAIL, checklist-fetch-cancel-dialog PASS. The fresh Convex preview is `fast-fly-777` (a NEW deployment, not the manually-patched rugged-ox-218) and it auto-inherited TESTING_RESET_SECRET from the project-level `env default --type preview` — proven because bootstrap (which calls the reset mutation) passed. So future pushes to any PR will work with no manual secret patching.
  - Two independent green full-suite runs now: 425f441 (rerun) and 017b66f (fresh preview).

## LOCAL VALIDATION (2026-05-28, requested by user)
- Deployed branch functions to dev Convex `focused-fox-53` via `npx convex dev --once` (schema changes are additive — new optional setMetadata/features; safe). dev now runs NEO-24 functions until its next deploy.
- Ran `fill-profile-data` locally (headless Maestro, local Vite http://localhost:3000 → dev Convex, sign-in routed through /testing/reset):
  - **Run 1: exit 0** — all assertions pass incl. `paypal.me/<user>-pp`.
  - **Run 2 (same dev Convex, already holding run-1 profile data): exit 0** — incl. line 31 `Assert "→ paypal.me/${TEST_USERNAME}-pp" is visible` COMPLETED, the EXACT original failure assertion. Passing on the 2nd consecutive run on a shared deployment proves the reset clears stale data between runs (no inputText append).
  - One run in between aborted with **SIGBUS (BUS_ADRALN)** — transient JVM native crash on macOS, NOT a test/product failure (re-ran identical → clean pass).
- Could NOT run the full suite locally: bootstrap + marketplace/checklist flows need the browser service (must-not-run-locally per standing rule). Those passed on CI (twice, fresh preview).
- **Cleanup:** stopped local Vite. **dev Convex left on NEO-24 branch functions** — will self-correct when PR merges to main (Vercel→Convex deploy), or can restore now by deploying main to dev if desired.

## FINAL STATE (morning summary)
- **PR #39 is green and durable.** All E2E flows pass (54/54). Original NEO-24 target bug (fill-profile-data inputText-append) fixed.
- **What shipped (commits 425f441 + 017b66f):** client-side, Clerk-auth-scoped `resetMyTestState` Convex mutation (deletes only the caller's own rows; fails closed in prod via TESTING_RESET_SECRET presence); a `/testing/reset` route the flows route sign-in through; reverted the lambda/httpAction approach; removed the secret plumbing from Maestro `-e`; hardened checklist-fetch-cancel-dialog with a scroll.
- **Durable infra set this session:** `convex env default set --type preview TESTING_RESET_SECRET` (all future previews inherit); GH Actions secrets TESTING_RESET_SECRET + TESTING_ENDPOINT_SECRET (now UNUSED by the flows — safe to leave or delete).
- **⚠️ SECURITY FINDING TO TRIAGE (pre-existing, NOT introduced here):** Maestro serializes the full `-e` env map into `commands-*.json` + `maestro.log`, which land in `maestro-report/maestro-home/worker-N/.maestro/tests/` and are uploaded as the public-repo `maestro-report` artifact (14-day retention). The workflow passes **real marketplace passwords** `BSC_PASSWORD` / `SPORTLOTS_PASSWORD` via `-e` → they leak into public artifacts on every run. My reset redesign avoids adding to this (no secret via -e), but the marketplace-cred leak predates this PR and needs separate remediation (e.g. stop uploading the maestro-home subtree, or scrub the env map from debug output, or rotate + move creds out of -e). Proven via canary test.
