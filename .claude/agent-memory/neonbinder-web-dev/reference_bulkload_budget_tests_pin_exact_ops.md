---
name: bulkload-budget-tests-pin-exact-ops
description: convex/bulkLoad.test.ts pins EXACT opsSpent (854 for 50 ordinary rows, 989 for 5 heavy rows) — any new read on the create path turns them red; reuse a read the loop already made instead of re-pricing the budget
metadata:
  type: reference
---

The team loader's NEO-296 budget tests assert `res.opsSpent` to the op
(50 × 17 + 4 = 854; 4 + 5 × 197 = 989), and each per-row step charges `ops`
explicitly. Adding a lookup to `create()` (NEO-307's "our name is another
team's alias" check) moved them to 904 / 994.

**Why:** the arithmetic is the regression guard that the ordinary preload
still lands in one call under `BULK_LOAD_TEAM_OP_BUDGET` (900), so changing
the expected numbers is re-pricing the budget, not fixing a test.

**How to apply:** before adding a read to a loader branch, check whether the
row loop already asked the same question (step 3's alias leg reads
`findTeamsByAlias(fullName)` whenever the name found nothing) and cache it per
row; fetch only on the paths that skipped that step (a replayed decision, a
same-name era found by name). Run the WHOLE bulkLoad.test.ts, not a `-t`
filter — the budget tests are the ones a filtered run hides.
Related: [[reference_convex_system_op_budget_and_bounded_walks]].
