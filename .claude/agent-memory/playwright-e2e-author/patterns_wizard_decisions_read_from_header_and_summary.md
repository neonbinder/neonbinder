---
name: wizard-decisions-read-from-header-and-summary
description: The wizard's "Decided (N)" list ("Skipped", "Linked to …") sits in the scrolling BODY under the presented row and goes off screen on tall rows or collapses past 5 — prove decisions by the header's "Step x of y" delta, the Save step's summary rows, or the row's own read-back via Back
metadata:
  type: feedback
---

Rule: never assert `Skipped` / `Added as new` / `Linked to X` from the Decided
list. Use:
- **one decision happened**: read the header text matching `Step x of y`
  (NEO-335; x = decided + 1 on a name step), keep x, act, then expect
  `Step ${x+1} of \d+`. Pin x, never y: y grows as staged steps arrive. The
  walk helpers may already have decided rows, so never hard-code `Step 2`.
- **what KIND every decision was**: `summaryRows` render only on the SAVE step
  ("Ready to save", heading "Save N cards?") since NEO-335 Phase 2, so reach
  it with the advance-to-save helper after the names-done footer
  (`Next (Enter)` or `Confirm & Save`). They omit zero lines except "Cards to
  save": "Skipped as not a name" present + "New players and teams" / "Linked
  to existing" absent = every decision was a skip (positive first).
- **what ONE decision was**: the read-back helper (footer Back, then the
  row's own "Decision for <name>" panel), never the Decided list.
- answer walk steps as SKIPS when a spec needs "all skips" to stay provable.

**Why:** NEO-330 moved skip specs onto 1995 hockey sets whose players hit
Wikidata ("Also on Wikidata, no years yet" lists ~10 clubs); the Decided list fell below the dialog body's visible area and a "Skipped" assert failed on a decision that had landed ("Step 2 of 16" in the header). Same rule as asserting inside a dialog: header and footer only. Related:
[[wizard-decided-list-and-batch-resume]].

**When the decision was the LAST name** the wizard is already on its first
post-name step, which has no Decided list and whose footer Back is
`Back to previous step` (not `... decision`); from the first post step it
presents the last name decided. `util-wizard-read-back-decision` taps either.
The reference catalogue makes one-name batches common (Topps Big League
stages one), and it also gives known players their own lines on the teams
step, so read a line's count off its heading, never `FETCHED - 1`
(NEO-335 merge, CI run 38302511049 attempt 2).
