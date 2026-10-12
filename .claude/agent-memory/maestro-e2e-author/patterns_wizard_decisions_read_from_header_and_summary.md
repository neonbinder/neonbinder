---
name: wizard-decisions-read-from-header-and-summary
description: The wizard's "Decided (N)" list ("Skipped", "Linked to …") sits in the scrolling BODY under the presented row and goes off screen on tall rows or collapses past 5 — prove decisions by the header's "Step x of y" delta, the Save step's summary rows, or the row's own read-back via Back
metadata:
  type: feedback
---

Rule: never assert `Skipped` / `Added as new` / `Linked to X` from the Decided
list. Use:
- **one decision happened**: `copyTextFrom "Step [0-9]+ of [0-9]+"` (NEO-335;
  x = decided + 1 on a name step), stash x, act, then wait for
  `"Step ${x+1} of [0-9]+"`. Pin x, never y: y grows as staged steps arrive.
  The walk utils may already have decided rows, so never hard-code `Step 2`.
- **what KIND every decision was**: `summaryRows` render only on the SAVE step
  ("Ready to save", heading "Save N cards?") since NEO-335 Phase 2 — reach it
  with `util-wizard-advance-to-save` after the names-done footer
  (`Next \(Enter\)|.*Confirm & Save.*`). They omit zero lines except "Cards
  to save": "Skipped as not a name" present + "New players and teams" /
  "Linked to existing" absent = every decision was a skip (positive first).
- **what ONE decision was**: `util-wizard-read-back-decision` (Back → the
  row's own "Decision for <name>" panel), never the Decided list.
- answer walk steps as SKIPS when a flow needs "all skips" to stay provable.

**Why:** NEO-330 moved skip flows onto 1995 hockey sets whose players hit
Wikidata ("Also on Wikidata, no years yet" lists ~10 clubs); the Decided list
fell below y=629 and `"Skipped" is visible` failed on a decision that had
landed ("1 of 16 reviewed" in the header). Same README rule as "Asserting
inside a dialog: header and footer only". Related:
[[wizard-decided-list-and-batch-resume]].
