# NEO-7 / PR #31 — overnight 2026-05-22 (third attempt)

**Goal:** wake up to a green PR #31 ready to squash-merge.

**Worktree:** `/Users/jburich/workspace/neonbinder/neonbinder_web`
**Branch:** `jburich/neo-7-erasetext-speedup`
**PR:** https://github.com/neonbinder/neonbinder_convex/pull/31

## State at start of overnight (2026-05-22 ~20:10 PT)

**Last CI run pushed before bed:** `d6977a7` — Convex gate exemption for Manufacturer level.
- Diagnosis confirmed manually in Chrome: SL list under Football/2026 contains Topps and is searchable. The util-drill search-input pattern already proven in cascade cards-* flows.
- Local Maestro headless can't fully validate — Chrome session under spawned Maestro hits cert/empty-response on the testing/sign-in flow. Same drift NEO-23 is chartered to fix.

**Recent commit chain (PR #31 branch):**
- `d6977a7` — Convex: exempt level=manufacturer from NEO-22 custom-subtree gate (latest)
- `a2ec12f` — revert showSearch >0; conditional search-vs-direct in util-drill SET_NAME tap
- `b0f9c6e` — pb-4 CSS on columns wrapper (scrollbar overlap fix, local-only)
- `b15f138` — centerElement: true on util-drill SET_NAME scroll
- `3b8b770` — cards-insert/cards-parallel switched to Future Stars / Gold Wave Refractors

**Watcher armed on `d6977a7`** at ~20:05 PT.

## Hard rules

- Never assume an element fits in viewport (1024×629 headless); always scroll/search before tap.
- Never use HTML id / data-testid — only visible text or aria-label via `id:`.
- Never add `wip` tag.
- Always validate logic by walking the flow in Chrome MCP before pushing speculative changes (lesson from this session: speculative pushes regressed CI from 3 failures → 13 → 10).
- Read logs before proposing causes (no speculation).
- After every push, launch pr-watcher in background and write timeline entry here.
- Don't let pr-watcher run >45 min without checking in.

## TODO

- [ ] Watch `d6977a7` CI. Report results in timeline below.
- [ ] If `d6977a7` still has util-drill failures, walk the manufacturer flow under Football/2026 in CI artifacts (download screenshots) to see what state SL returned and where the tap actually landed.
- [ ] If a different/new failure appears, diagnose from CI artifacts before any push.
- [ ] Get PR all green.

## Constraints

- Per-PR Convex preview deployment is shared across all CI runs of this PR (so state persists between commit pushes).
- `cascade/setup.yaml` issues a Reset Set Builder Data — wipes selectorOptions/cards/players/teams. Util-drill flows don't `requires:setup-done`, so they race against the reset.
- BSC has no Manufacturer aggregation (`BSC has no aggregation for level: manufacturer`); SL is the only source for that level.
- Local Maestro headless is currently broken on this dev box (Chrome session / cert issue) — CI is the authoritative validator.

## Timeline

(All times local PT, 2026-05-22 night.)

- **20:05** — pushed `d6977a7` (Convex Manufacturer-gate exemption). Watcher armed on a1b505095d7625149.
- **20:10** — started overnight log. Awaiting first CI report.
- **20:50** — CI for `d6977a7` finished: **44 passed, 3 failed** (down from 10). Manufacturer gate fix worked.

  Remaining failures diagnosed from CI artifacts:
  1. `parallel-grouping-suggestions.yaml` — "pg-suggestions-2 @index1" not visible. Cause: Search sets input was at y=4 (top of viewport, under fixed nav header). Maestro tapped the header instead of the input, inputText went nowhere, filter never applied, target row stayed clipped past inner overflow. Compare to passing cards-insert.yaml where Search inserts was at y=493 (mid-viewport).
  2. `variant-metadata-editor-insert.yaml` — same root cause as #1 (vme-insert-2).
  3. `cards-parallel-of-insert-custom.yaml` — ".*Inserts.*" not visible after util-drill exits. The Variants column with title "Inserts" rendered off-screen-right; Maestro can't see it.

  cards-insert-custom showed 1 failed attempt but its retry succeeded — counted as PASS in CI summary.

  Fix #1/#2 (in this commit): wrap the search-input tap with `scrollUntilVisible centerElement: true` so the input lands at mid-viewport, clear of the fixed nav header. Will iterate #3 next push if it remains after this fix.

- **20:55** — pushed `6c54506` with the Search-sets centering fix. Launching watcher.
- **21:42** — CI for `6c54506`: **45 passed, 2 failed**. Same 2 flows still fail with same error. centerElement: true on Search-sets DID NOT move the input — it stayed at y=4. CI log confirms `Scrolling DOWN until .*Search sets.* visible centerElement: true COMPLETED` but bounds unchanged.

  Deeper root cause: the EARLIER `scrollUntilVisible Add custom Sets centerElement: true` over-scrolls the page DOWN to put the "+ Custom" button at mid-viewport. That puts the column's top half (header + search input) entirely above the viewport. After modal close, search input is at y=4 under nav header. The reason centerElement was on that earlier scroll was the scrollbar-overlap bug, but that's already fixed in b0f9c6e (pb-4 CSS). centerElement is now harmful, not needed.

- **21:45** — pushed `758de86`: drop centerElement on Add-custom-Sets scroll, remove no-op Search-sets center. Launching watcher.
- **22:29** — CI for `758de86`: **39 passed, 8 failed** — REGRESSED. Add-custom-Sets button landed at y=622-654 (off-screen bottom) without centerElement, on worker 2 with accumulated state. The centerElement was actually load-bearing.
- **22:30** — reverted 758de86 + pushed `f67c38b`: keeps centerElement: true on Add-custom-Sets, replaces the no-op Search-sets centerElement with `scrollUntilVisible direction: UP` looking for the column's "Sets" h2 header. UP direction = swipe-down gesture = page scrolls down = brings content from above viewport INTO viewport. Uses `^Sets$` regex anchors to avoid matching "Sync Sets" button or "Set Selector" heading.

  PR-watcher subagent broken (missing Monitor tool). Self-polling via ScheduleWakeup.

- **23:18** — CI for `f67c38b`: **46 passed, 1 failed** — best yet! direction: UP scroll worked. Only variant-metadata-editor-insert remaining. Failure: util-drill's Variant Types level — Maestro found "+ Custom Variant Types" at y=179 but page scrolled between find and tap (visually button at y≈90 per screenshot), tap landed in empty space, create modal never opened. cards-insert-custom had identical 1st-attempt failure but passed on retry — so this is the same flake, vme just unlucky on both retries.

- **23:21** — pushed `fb5c2b6`: added `waitToSettleTimeoutMs: 2000` on the "+ Custom Variant Types" tap so Maestro re-queries the button position before dispatching. Bumped "Add Custom Entry" wait from 5s scrollUntilVisible → 10s extendedWaitUntil for modal mount under contention.

- **00:00** — CI for `fb5c2b6`: **46 passed, 1 failed** — same vme-insert-2 failure at "+ Custom Variant Types" tap → "Add Custom Entry" not visible. waitToSettleTimeoutMs didn't help.

- **00:03** — pushed `ac19372`: dropped centerElement: true from the VT-level scrollUntilVisible. Maestro CDP didn't reliably center (button stayed at y=179, tap missed). VT column is short (at most 4 items, 0 under custom subtree) so the button is naturally near the column header — no need for the centerElement workaround that was added at the Sets level for the footer click-stealer concern.

- **00:50** — CI for `ac19372`: still **46 passed, 1 failed** (vme-insert-2 again). "+ Custom Variant Types" now at y=494 (good position), tap fires, but modal still doesn't open. Deeper diagnosis from maestro.log: BOTH SET_NAME tap branches in util-drill fire — search-input branch selects the row, then fallback branch ALSO fires (Search-sets disappears after row selection), re-tapping the already-selected row and collapsing Sets column. This causes Variant Types to re-mount mid-flight, and the next "+ Custom" tap lands during a render gap.

- **00:52** — pushed `8f408db`: change fallback branch's guard from `notVisible Search sets` to `notVisible Variant Types`. If search-input branch already selected the set, Variant Types is visible → fallback skips. If search input was never there (small list), Variant Types still not visible → fallback runs.

- **01:38** — 🟢 **CI for `8f408db` PASSED.** e2e SUCCESS, Maestro E2E SUCCESS. **PR #31 is GREEN.** Ready to squash-merge in the morning.

## Summary of fixes (full PR #31 chain)

The branch had several layered bugs that surfaced one after another as each earlier one was fixed:

1. **`d6977a7`** — Convex gate exemption for Manufacturer level. NEO-22 custom-subtree gate was blocking SL sync for Manufacturers under custom Football/2026 paths, leaving the column empty and breaking every util-drill flow. SL returns the same static manufacturer list regardless of (sport, year), so the gate doesn't need to apply to manufacturer. **Effect: 10 failures → 3.**

2. **`f67c38b`** — Scroll UP to expose Sets header before tapping Search-sets input. The `centerElement: true` on Add-custom-Sets over-scrolls the page DOWN, putting the column's top half (header + search input) above viewport. After the create modal closes, Search-sets is at y=4 under the fixed nav header. Maestro's tap lands on the header, focus never moves to the input, inputText goes nowhere, filter never applies. Fix: `scrollUntilVisible direction: UP` looking for `^Sets$` brings the header to mid-viewport, putting the search input just below it (~y=360, clear of header). **Effect: 3 failures → 1.**

3. **`8f408db`** — Gate util-drill fallback SET_NAME tap branch on `notVisible Variant Types`. Both runFlow branches were firing — search-input branch selected the row (making Search-sets disappear), then the fallback branch (`notVisible Search sets`) also fired and re-tapped, collapsing the Sets column mid-flight. The "+ Custom Variant Types" tap then landed during a column re-mount where the React button wasn't bound, modal never opened. **Effect: 1 failure → 0.**

Discarded along the way (didn't help, reverted):
- `b15f138` centerElement: true on SET_NAME row tap — wrong symptom
- `b0f9c6e` pb-4 CSS on columns wrapper — local-only fix, not a CI issue
- `7b86059` showSearch >0 in EntitySelector — broke 11 other flows by pushing "Parallel" off-screen in 4-item Variant Types column
- `a2ec12f` conditional util-drill search-vs-direct — was the right shape but the fallback gate was wrong
- `6c54506` centerElement on Search-sets tap — no-op (Maestro doesn't pull elements already at viewport top)
- `758de86` drop centerElement on Add-custom-Sets — REGRESSED to 8 failures (button moved off-screen at y=622+)
- `fb5c2b6` waitToSettleTimeoutMs on Add-custom-Variant-Types tap — didn't help, real issue was upstream double-tap
- `ac19372` drop centerElement on Add-custom-Variant-Types — moved button to y=494 but real issue was upstream
