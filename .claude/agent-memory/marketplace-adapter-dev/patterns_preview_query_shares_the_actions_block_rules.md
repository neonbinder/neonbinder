---
name: preview-query-shares-the-actions-block-rules
description: A list query that previews what an action will refuse drifts unless both call the same pure block-reason functions with the same pause set; pin with a list-then-build agreement test
metadata:
  type: feedback
---

When a subscribed query previews an action's verdict (blocked / buildable /
"unlinked"), the two drift whenever the query re-derives the rules: it reads a
different field (reach instead of ownership), skips the deployment pause, or
omits a check that needs card data. NEO-496 found four such gaps in
`getParallelsForBuild` vs `buildParallelChecklist`.

**Why:** the operator acts on the preview's counts; a preview that calls a
parallel buildable which the build then refuses is a lie on screen, and each
copy of a rule is one more place to forget the pause or a reason code.

**How to apply:** factor every pre-fetch refusal into exported pure functions
over the plan (plus a boolean summary of the card facts the rule reads), call
them from both sides in the action's order, thread `pausedSides()` into the
query's plan too (env reads work in queries). The query feeds the card facts
from its bounded sample, so it can miss a block but never invent one. Test
with one helper that runs the query then the action on the same rows and
asserts equal reasons, then plant the old logic and confirm those tests go red
([[a-green-suite-can-mean-the-test-stopped-testing]]).
