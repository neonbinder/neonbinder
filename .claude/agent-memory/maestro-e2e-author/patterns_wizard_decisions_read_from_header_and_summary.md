---
name: wizard-decisions-read-from-header-and-summary
description: The wizard's "Decided (N)" list ("Skipped", "Linked to …") sits in the scrolling BODY under the presented row and goes off screen on tall rows or collapses past 5 — prove decisions by the header count delta and the all-decided summary rows instead
metadata:
  type: feedback
---

Rule: never assert `Skipped` / `Added as new` / `Linked to X` from the Decided
list. Use:
- **one decision happened**: `copyTextFrom "[0-9]+ of [0-9]+ reviewed.*"`,
  stash both numbers, act, then wait for `"${before+1} of ${total} reviewed.*"`
  (the walk utils may already have decided rows, so never hard-code `1 of`).
- **what KIND every decision was**: at all-decided, `summaryRows` render at
  the TOP of the body and omit zero lines except "Cards to save": "Skipped as
  not a name" present + "New players and teams" / "Linked to existing" absent
  = every decision was a skip (positive before negatives).
- answer walk steps as SKIPS when a flow needs "all skips" to stay provable.

**Why:** NEO-330 moved skip flows onto 1995 hockey sets whose players hit
Wikidata ("Also on Wikidata, no years yet" lists ~10 clubs); the Decided list
fell below y=629 and `"Skipped" is visible` failed on a decision that had
landed ("1 of 16 reviewed" in the header). Same README rule as "Asserting
inside a dialog: header and footer only". Related:
[[wizard-decided-list-and-batch-resume]].
