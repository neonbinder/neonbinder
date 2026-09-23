---
name: heavy-write-saturation-vs-blanket-stall
description: A second contention shape — cheap writes stay healthy while EXPENSIVE transactions and the entity-lookup drain go 5-25x slow; how to measure it, why the create-gate ruler can't see it, and the reset gap (entityReviewQueue is never drained) that makes late runs of the day worse
metadata:
  type: reference
---

[[bound-a-backend-stall-with-the-create-gate]] catches the window where
*everything* slows. There is a second, commoner shape it cannot see: the
deployment is saturated by a **class** of work, so per-transaction cost
scales while a 3-op write stays under the ruler's floor.

**The create-gate ruler has a ~1s polling floor.** Its healthy band
(0.95–1.31s) means "returned in under a second", not "returned in 0.98s".
A run can hold that band on all 146 samples and still be 5-25x slow on
anything big. Healthy create gates therefore **disprove a blanket stall
and prove nothing else** — do not stop there.

## The rulers that do see it

Pick steps whose cost scales and whose fixture is pinned, then compare the
SAME step across runs of the same branch:

- **A big single transaction.** `Save N changes` → `notVisible ".*Drag
  inserts under a parent.*"` (`applyParallelGroupings`, ~4 ops/entry).
  Maestro logs the element text, so the log proves the fixture identical
  across runs (`Save 141 changes` three runs running).
- **A big query.** `Confirm card matches` → `.*Review Changes — .*`
  (`diffChecklistAgainstExisting` over 220 rows). Healthy 0.33s.
- **The entity-lookup drain.** `notVisible ".*still looking up.*"`, the
  first one per wizard flow. Healthy 1-26s; a bad window puts six runners
  at 47-110s simultaneously.

Script all three over `runner-*/debug/*/maestro.log` (`onCommandStart` →
`onCommandFinished`, `HH:MM:SS.mmm` prefixes). Then sanity-check with the
median of junit `time` over the flows common to both runs: a ratio near
**1.00** with a handful of 1.3-2.0x outliers is this shape. A globally
slow run would move the median.

## Two run-level tells that precede any flow

Both come from `gh api .../actions/runs/<id>/jobs` plus the seed's own log:

- **The scripted reset's duration** = seed-step `started_at` → the first
  timestamp in `maestro-report-seed/debug/setup/maestro.log`. Healthy is
  10-16s. It is an action looping `resetSetBuilderDataFromCli` until
  `complete`, so its wall-clock is a direct read on how much residue the
  preview carries.
- **The seed step's own length.** Same code, same fixture, so a +35%
  seed is the deployment, not the branch.

## The reset gap that makes late runs of the day worse

`runSetBuilderReset` (`convex/selectorOptions.ts`) drains exactly:
selectorOptions, cardChecklist, cardCrossListings, players, playerAliases,
teams, teamAliases, franchises, leagues. **`entityReviewQueue`, its
batches and `checklistCandidates` are not in that list**, and the only
thing that removes them is the hourly `reap abandoned entity-review
batches` cron against a **24-hour** idle threshold (`crons.ts`). Several
CI runs in one day therefore stack their review rows on one preview: a
failure dump showing `N checklist reviews are in progress here` with N in
the thousands is that residue, and the reset's cost climbs run over run
(15s → 69s → 246s observed across one day's complete runs).

Ask for the reset to drain those tables — it is a product/CI fix, never a
flow wait. See also [[never-diagnose-timing-first]].
