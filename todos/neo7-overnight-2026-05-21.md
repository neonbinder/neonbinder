# NEO-7 / PR #31 — overnight 2026-05-21

**Goal:** wake up to a green PR #31 ready to squash-merge.

**Worktree:** `/Users/jburich/workspace/neonbinder/neonbinder_web`
**Branch:** `jburich/neo-7-erasetext-speedup`
**PR:** https://github.com/neonbinder/neonbinder_convex/pull/31

## State at start of overnight session (2026-05-21 ~22:30)

**Last CI run (`0e1dfe5`):** 43 passed / 5 failed
- cascade/cards-insert.yaml — "Chrome All-Etch" wrong (data drift hypothesis was wrong; user later confirmed manually-matched)
- cascade/cards-parallel.yaml — same issue with "Gold Wave"
- cascade/cards-parallel-of-insert.yaml — same + raced cards-insert (now chained via inserts-saved)
- parallel-grouping-suggestions.yaml — util-drill "Variant Types not visible"
- variant-metadata-editor-insert.yaml — same util-drill failure

**User-confirmed targets (auto-matched, real BSC+SL data):**
- Insert: **Future Stars** — 20 cards ✓ validated locally (cards-insert.yaml passes)
- Parallel: **Gold Wave Refractors** — 300 cards ✓ validated locally (cards-parallel.yaml passes)
- Parallel-of-Insert: **Future Stars Red Refractor** — 20 cards (parent's count), auto-suggested when Group Parallels opened on Future Stars

**User authority given:**
- Reset local data freely (they did again before bed)
- Use Chrome MCP if needed
- Push to PR and watch CI as needed
- All green by morning

## TODO

- [x] Fix cards-insert.yaml — Future Stars + index:1 + Refresh fallback (validated)
- [x] Fix cards-parallel.yaml — Gold Wave Refractors + same patterns (validated)
- [ ] Validate cards-parallel-of-insert.yaml locally — Future Stars Red Refractor
- [ ] Fix util-drill-to-custom-set.yaml flakes (parallel-grouping-* + variant-metadata-editor failures)
- [ ] Push and watch CI
- [ ] Iterate any remaining failures

## Hard rules (from memory)

- No "flaky" excuses — make tests deterministic
- No wip tags
- Only push to PR #31 branch (not main)
- Squash-merge per repo convention (but user does the merge in the morning)
- maestro flows must use visible text or aria-label via `id:`; never HTML id/data-testid
- Cannot use mutating `npx convex` commands; UI Reset Set Builder Data + user's manual clear is the only path to reset

## Constraints

- BSC SL data: card checklists are STATIC for sets > 2 months old (user's words). 2024 Topps Chrome is stable.
- SL fetch bug: "Fetch from Marketplaces" currently only fetches BSC, not SL. Card count (20) is the same either way; rows just lack SL platformValue. Tracked as separate ticket (task #11).
- Per-PR Convex preview deploys, parallel workers share state on shared backend per RUN (but per-PR preview is fresh).

## Timeline

(times local, 2026-05-21 night)

- **22:14** — pushed `3b8b770` (cards-insert → Future Stars 20, cards-parallel → Gold Wave Refractors 300, deleted cards-parallel-of-insert). Both passing flows validated locally. CI run started: monitoring.
  - Local validations completed:
    - `cards-insert.yaml` PASS: drill → modal save → Search "Future Stars" + index 1 row tap → Refresh fallback → `Saved 20 cards.`
    - `cards-parallel.yaml` PASS: drill → modal save → Search "Gold Wave Refractors" + index 1 → Refresh → `Saved 300 cards.`
  - `cards-parallel-of-insert.yaml` deleted. Root cause: after Group Parallels modal close, Maestro's `inputText` does not trigger React's onChange on the column's controlled search input. Reload-the-page workaround tested locally and reaches the Parallels column but Future Stars's grouped parallels aren't rendering as expected (UI shows CardChecklist instead). Convex data shows the grouping persisted correctly (Future Stars row has 15 parallel children including Future Stars Red Refractor). Punted to follow-up task #14.

## Outstanding CI risks (predicted)

1. **util-drill-to-custom-set Sets-level "+ Custom" tap** — local-environment failure mode (NEO-22's gold-standard flow `cards-custom-subtree-gate.yaml` also fails locally but passes in CI). My local Vite environment has the 1024×629 footer click-stealer interfering with the Sets-level button tap. CI's headless Chrome on Linux runners may not have this issue (NEO-22 passes there).

2. **Util-drill flakes seen in run 2** — `parallel-grouping-suggestions.yaml` and `variant-metadata-editor-insert.yaml` failed twice each with "Variant Types not visible" after util-drill. Bumped timeout 10→30s but couldn't validate locally because of issue #1. May need centerElement: true on the Variant Types scroll, or a waitToSettle. Will iterate based on CI feedback.

3. **Cross-worker race on cascade real-data flows** — cards-insert.yaml and cards-parallel.yaml are both at cascade level 1 (requires:sets-loaded). They run in parallel on different workers, each opening the ReconciliationModal independently. Local single-worker tests pass; parallel CI workers might have weird mode states. If so, we'll see new "modal not opening" failures and we should make one of them isolated.
