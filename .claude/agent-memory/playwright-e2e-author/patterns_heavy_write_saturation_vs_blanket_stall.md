---
name: heavy-write-saturation-vs-blanket-stall
description: A second contention shape — cheap writes stay healthy while EXPENSIVE transactions and the entity-lookup drain go 5-25x slow; how to tell it from a blanket stall, and the reset gap (entityReviewQueue is never drained) that makes late runs of the day worse
metadata:
  type: reference
---

[[bound-a-backend-stall-with-the-create-gate]] catches the window where
*everything* slows. There is a second, commoner shape: the deployment is
saturated by a **class** of work, so per-transaction cost scales while a 3-op
write stays fast. A healthy cheap-write measurement therefore **disproves a
blanket stall and proves nothing else**.

(The numbers below were measured on the previous Maestro suite; re-measure them
from Playwright step timings before quoting them.)

## Rulers that see it

Pick steps whose cost scales and whose fixture is pinned, then compare the SAME
step across runs of the same branch:

- **A big single transaction**: `Save N changes` on Group Parallels
  (`applyParallelGroupings`, ~4 ops/entry); the rendered N proves the fixture
  identical across runs.
- **A big query**: `Confirm card matches` to the `Review Changes` dialog
  (`diffChecklistAgainstExisting` over 220 rows). Healthy 0.33 s.
- **The entity-lookup drain**: the first "still looking up" going away per wizard
  spec. Healthy 1-26 s; a bad window puts six shards at 47-110 s at once.

Take per-step durations from the Playwright report / JUnit timings of the runs
being compared. Sanity-check with the median spec duration over the specs common
to both runs: a ratio near **1.00** with a handful of 1.3-2.0x outliers is this
shape; a globally slow run would move the median.

## Two run-level tells that precede any spec
Both come from `gh api .../actions/runs/<id>/jobs` plus the seed's own log:
- **The scripted reset's duration** (seed-step start to the first seed log line).
  Healthy is 10-16 s. It loops `resetSetBuilderDataFromCli` until `complete`, so
  its wall-clock is a direct read on how much residue the preview carries.
- **The seed step's own length.** Same code, same fixture: a +35% seed is the
  deployment, not the branch.

## The reset gap that makes late runs of the day worse
`runSetBuilderReset` (`convex/selectorOptions.ts`) drains exactly: selectorOptions,
cardChecklist, cardCrossListings, players, playerAliases, teams, teamAliases,
franchises, leagues. **`entityReviewQueue`, its batches and `checklistCandidates`
are not in that list**, and the only thing that removes them is the hourly `reap
abandoned entity-review batches` cron against a **24-hour** idle threshold. Several
CI runs in one day stack their review rows on one preview: a failure snapshot
showing `N checklist reviews are in progress here` with N in the thousands is that
residue, and the reset's cost climbs run over run (15 s, 69 s, 246 s observed
across one day). Ask for the reset to drain those tables: a product/CI fix, never
a spec wait. See [[feedback-never-diagnose-timing-first]].
