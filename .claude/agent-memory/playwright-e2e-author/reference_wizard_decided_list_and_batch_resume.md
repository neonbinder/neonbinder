---
name: wizard-decided-list-and-batch-resume
description: "Entity-review wizard counter/batch traps: never pin the header TOTAL (it grows as lookups stage career teams); assert the header numerator rather than the Decided (N) list; hard-coded decision COUNTS break under the teams-first walk; and a review batch outlives its spec so a red spec cascades onto every sibling sharing the set"
metadata:
  type: reference
---

# Assert the header numerator, not the `Decided (N)` list

The decided-names list is the LAST thing in the wizard's dialog body. On a tall step
(a college team row with five possible matches above an expanded league grid) it can
sit far below the viewport, and its presence is no signal. Playwright reports it as
visible if it is rendered, but do not build the assertion on it. **Assert the header
instead: `getByText(/^<n> of \d+ reviewed/)`.** It is the wizard's own progress
numerator, sits at the top of the dialog, is always rendered, and carries the exact
count, so it is not a weaker claim than `Decided (n)`.

## Never pin the TOTAL: it grows while the review is open

`<n> of <M> reviewed`: only `<n>` is the spec's to assert. `<M>` grows while lookups
land, because a settled player's Wikidata career teams are staged as new New Team
rows. NEO-332: a spec captured `0 of 221` and read `0 of 229` ten seconds later on an
otherwise-correct screen. Assert `/^<n> of \d+ reviewed/` (anchored, so `0 of` never
matches `10 of`); if a value must be captured, keep only the leading digits.

## The teams-first walk breaks every hard-coded decision COUNT

`walkToPlayerRow` answers each team step to reach a player, and each answer is a
decision the wizard counts: confirm read `Discard 28 decisions?`, header `28 of 116
reviewed` (27 drained skips plus the spec's one create). Any literal `Discard 1
decision` / `Decided (1)` in a spec that walks to a player row is wrong. Prove the
spec's OWN decision by NAME, not by count: the skip variant leaves every drained row
reading `Skipped`, so `Added as new` is unique; the create variant leaves them `Added
as new`, so `Skipped` is unique.

# A review batch outlives its spec: one red spec cascades

`commitCardChecklist`'s batch is per (selectorOption, user) and persists. A spec that
ends any way except Cancel then Discard (failed assertion, timeout, killed run) leaves
its decisions on the set, and the next fetch **resumes** that batch: the wizard opens
at `N of M reviewed`, not `0 of M`. All the read-only wizard specs share one set, so
ONE red spec fails its siblings on their `0 of N reviewed` precondition and the report
shows several broken specs for one broken feature. Reproduced locally: two killed runs
left the set reading `887 checklist reviews are in progress here`.

Fix in the suite: `discardResumedReviewBatch` in `support/wizard.ts`, run right before
each caller's own HARD `0 of N reviewed` assertion (so a resume it fails to clear
still fails the spec). **Recovering a wedged fixture by hand:** fetch the checklist to
the wizard, then `cancelAndDiscard`; about 2 minutes. Do this before you leave a
shared preview.
