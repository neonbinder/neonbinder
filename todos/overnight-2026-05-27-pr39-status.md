# Overnight Work Report — 2026-05-27

## TL;DR

PR #39 (NEO-24): final CI state **53 passed / 2 failed** (started session at 22/33). **Not merged** per your direction. Two persistent failures both trace to a fundamental Virtuoso × Maestro incompatibility — Maestro's page-level `scrollUntilVisible` cannot reach content inside a Virtuoso-virtualized inner scroll. The fix requires either pagination or rendering the edit form outside Virtuoso, which I chose not to attempt in the remaining time budget because it'd be a 200-300 line refactor with significant risk of new regressions.

Observability PRs (#40 web, #33 browser) committed and pushed but **could not merge tonight** — both blocked by independent infra concerns (main's flakiness for #40, NEO-20-era Cloud Run IAM gap on the integration test for #33). Both will unblock once PR #39 lands on main.

## Final CI state — PR #39 at `ba0d5ae`

Run `26496207606`: **53 passed, 2 failed**

Remaining failures (both Virtuoso inner-scroll issues):
- `features-propagation.yaml` — `id: Save card edit` not visible after expanding CardFeaturesEditor inside the edit form. Edit form's `max-h-[70vh] overflow-y-auto` puts Save below the visible portion of the inner scroll once the 8-field features grid renders. Maestro's `scrollUntilVisible` scrolls the page, not the inner container, so Save is unreachable.
- `team-picker-regression.yaml` — `id: Card name` not visible after the Edit tap. Worker 2 race: a concurrent worker's mutation refetches the global `cardChecklist` live query, which shifts row y-coords between Maestro's lookup and tap. `waitToSettleTimeoutMs: 2000` on the Edit tap is a partial mitigation but doesn't fully close the race. team-picker.yaml on worker 0 (serial lane) does NOT hit this.

## Commits pushed to PR #39 (in order)

| Commit | Effect |
|---|---|
| `e406709` | Clerk testing-token retry + real error surfacing. 10 unit tests, security-audit clean. Unblocked the sign-in flake masking everything else. |
| `d2c1589` | Move AdminTools out of `set-selector/page.tsx`'s full-width break-out wrapper. Fixes 1.4% leftmost-button clip at 1024px (`Seed Test Teams` unreachable). |
| `986b7cb` | Remove `opacity-0 group-hover:opacity-100` from CardChecklistItem row actions. Always-visible Edit/Delete reachable by Maestro headless web. |
| `4c174e7` | `scrollToIndex({behavior: "smooth"})` → `"auto"` after Add-Card. Removes animation race against Maestro's visibility check. |
| `1901673` | Step E `Base` scroll: add `direction: UP + centerElement: true` (clone of Step B's pattern). |
| `65da960` | TeamPicker `+ Add team` button: drop the toggle, make it `setPopoverOpen(true)` (no-op when open). Removes the silent-close on test re-tap. |
| `3fc8f42` | Revert sticky Save: restore outer `max-h-[70vh] overflow-y-auto` so the TeamPicker popover (positioned absolute) isn't clipped by an inner overflow. Yankees chip now appears reliably. |
| `ba0d5ae` | Virtuoso `initialTopMostItemIndex={sortedCards.length - 1}`: start the cards list scrolled to the bottom. New custom cards (highest sortOrder) are rendered in DOM on first paint, so re-navigation tests can find their just-saved card. |

## Failures pinned + dispositions

| Flow | Status | Reason |
|---|---|---|
| `cascade/setup.yaml` | ✅ Fixed | CSS clip + Clerk token retry + Seed Test Teams reachable |
| `card-features-missing.yaml` | ✅ Fixed | smooth → auto scroll |
| `team-picker.yaml` | ✅ Fixed | non-toggle + popover not clipped + initialTopMostItemIndex |
| `edit-and-delete-card.yaml` | ✅ Fixed | popover not clipped |
| All parallel-grouping flows | ✅ Fixed (Clerk token) | Were cascading on sign-in flake |
| `view-profile.yaml` | ✅ Fixed (Clerk token) | Same |
| `features-propagation.yaml` | ❌ Save card edit hidden in inner scroll | Architectural — see follow-up |
| `team-picker-regression.yaml` | ❌ Card name not visible | Concurrent-worker race (worker 2) — see follow-up |

## Observability PRs

### PR #40 web — https://github.com/neonbinder/neonbinder_convex/pull/40

- Commit: `cb9c5c3 feat(observability): adapter API perf timing into PostHog`
- 5 files: `convex/observability.ts` + tests, `convex/selectorOptions.ts`, `convex/adapters/buysportscards.ts`, `convex/adapters/sportlots.ts`
- Captures `adapter_sync_call` PostHog event with `requestId` correlation + per-stage timing (`token_ms`, `filters_call_ms`, `sl_ms`, `bsc_ms`) + closed-set error tags
- Security audit clean
- **Blocked from merge**: repo ruleset requires `e2e` to pass; PR #40 inherits main's flakiness, which the PR #39 fixes resolve. Once PR #39 lands → rebase PR #40 → e2e passes → merge.

### PR #33 browser — https://github.com/neonbinder/neonbinder_browser/pull/33

- Commit: `b89bcf1 feat(observability): structured login timing logs for adapter perf dashboard`
- 1 file: `src/index.ts`. `browser_login_call` JSON log on `/login/bsc` and `/login/sportlots` with closed-set error tags.
- Security audit clean
- **Blocked from merge**: `preview-login-probe` failing 403 Forbidden on `PUT /credentials/...`. This is a **pre-existing Cloud Run IAM bug** from NEO-20 (#31): the integration test (`tests/integration/_helpers.mjs`) still sends only `x-internal-key`, but the service moved behind Cloud Run IAM which requires a Google OIDC ID token. Smoke test was updated to expect `SMOKE_TEST_ID_TOKEN` but the workflow doesn't set it, so smoke vacuously passes (skips all tests when env-var missing). Integration test runs and fails. **Drafted the fix and reverted** because (a) the workflow needs `gcloud auth print-identity-token --audiences=<preview_url>` to mint the token, (b) the helpers need `Authorization: Bearer ...` added, (c) the deployer SA may lack `roles/run.invoker` and need `--impersonate-service-account=neonbinder-convex@...` — the IAM choice needs your call.

## Path forward for the 2 remaining PR #39 failures

### features-propagation: Save card edit hidden

**Architectural fix:** render the card edit form OUTSIDE the Virtuoso container so its bounds aren't constrained by Virtuoso's 70vh visible window. Either:

- **Inline above/below the cards list**: when a card enters editing mode, lift `<CardChecklistItem editing>` content into the parent `CardChecklist` and render it at the top/bottom of the cards section. Single source of truth: `editingCardId` in CardChecklist state. The selected card row in the Virtuoso list shows a "currently editing" indicator instead of expanding.
- **Modal/overlay**: use a Radix Dialog or similar to render the edit form as a modal portal. Visually distinct from the inline-edit pattern but fully outside any virtualization concern. Trade-off: modal UX may not match the rest of the SetSelector.

Either is ~200 lines of refactor. I deliberately didn't attempt this overnight because the last 3 CI iterations each introduced different regressions and I didn't want to ship a refactor I couldn't test locally end-to-end.

### team-picker-regression: Card name not visible (concurrent worker race)

**Lighter fix candidates:**

1. **Move team-picker-regression to worker 0's serial lane** (run-e2e-smoke.sh has a serial-vs-parallel knob). Worker 0 is the only lane that doesn't get its cardChecklist mutated by concurrent runs. team-picker.yaml is already there and passes. This is a 1-line YAML change to the cascade-runner config — likely the lowest-risk fix.
2. Increase `waitToSettleTimeoutMs` on the Edit tap from 2000 → 5000. Wider window for the live-query refetch to settle. May increase total run time but each retry hits 0% before the race triggers.

Option 1 is a Maestro test infra change and should go through the maestro-e2e-author agent per `feedback_delegate_maestro_tests`.

## What I did NOT do (deliberately)

- **Did not merge PR #39** (your direction)
- **Did not extend any test timeout** (your rule)
- **Did not add `wip` tags** to any flow
- **Did not modify SetFeaturesPanel / CardFeaturesEditor** to disambiguate the shared `id: "Value for League"` aria-label — the agent-memory note flags this as a known fragile pattern. Future PR.
- **Did not bypass repo rulesets** to force-merge

## Key lessons (so the next session doesn't repeat the loop)

- **Virtuoso + Maestro are fundamentally incompatible** for tests that interact with arbitrary off-fold rows. Either disable virtualization for the cards list (page too long for `scrollUntilVisible direction:UP` to reach upper-page elements within 15 s) or accept that scrolling deep into the list requires programmatic scroll. The middle ground I tried (`initialTopMostItemIndex` at end) helps for re-navigation lookups of recently-added cards but doesn't help once features expand the editing item.
- **`opacity-0 group-hover:*` is hostile to headless Maestro web.** No mouse hover means the element stays invisible. CDP tap fires on it but `setEditing(true)` doesn't fire — Maestro logs `Tap COMPLETED` WITHOUT the usual `"Something has changed in the UI judging by view hierarchy"` follow-up. That mismatch is the canary.
- **`scrollToIndex({ behavior: "smooth" })`** races Maestro's visibility check. Use `"auto"`.
- **Inner overflow:auto clips absolute-positioned popovers.** Watch for this when an interactive popover lives inside a scrollable container.
- **Toggle buttons in a feature where tests assume "always open"** are a class of fragility. Make the trigger `setOpen(true)` (idempotent) instead of `setOpen(v => !v)` (toggle).
- **Maestro's `tapOn id:` matches the FIRST in-DOM occurrence**, not the most-visible. When the same aria-label appears in two places (SetFeaturesPanel vs CardFeaturesEditor), layout-shifting changes can flip which one gets the tap.

## Final repo state

- `~/workspace/neonbinder/neonbinder_web-neo24` (NEO-24 worktree): clean, your stashed Maestro WIP from the start of the session was popped back and is sitting untracked in `~/workspace/neonbinder/neonbinder_web-neo24/maestro-report-neo24/` — that's local debug output and can be deleted.
- `~/workspace/neonbinder/neonbinder_web-observe-adapter-perf`: `jburich/observe-adapter-perf` clean, PR #40 open
- `~/workspace/neonbinder/neonbinder_browser-observe-adapter-perf`: `jburich/observe-adapter-perf` clean, PR #33 open

Local Vite + browser service NOT running on your machine (stopped them mid-session).
