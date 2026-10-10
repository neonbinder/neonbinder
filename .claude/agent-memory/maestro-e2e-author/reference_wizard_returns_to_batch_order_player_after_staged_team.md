---
name: wizard-returns-to-batch-order-player-after-staged-team
description: After "Add career team" hops to the club's New Team step and it is answered, the wizard presents the FIRST settled undecided player in batch order, not the player who staged it — so a flow's "back on the player, chip reads <club> (2001–2005)" holds only when the two coincide (found NEO-330 on Memphis RiverKings)
metadata:
  type: reference
---

Mechanism (`entity-review-nav.ts`): the walk's player is an IMPLICIT pin —
whichever row settled first (a Wikidata no-match settles fastest, so on a
mixed batch it is often not the first row in order). Staging a career team
makes that pin stale (`waitingOnStagedTeams`); answering the step makes the
team row stale; `resolveNav` then takes `nextUndecided(rows)` = the first
settled undecided player IN BATCH ORDER. Nothing returns to the staging row.
The chip is not lost (keyed by that row id), it is just on a row no longer
shown.

Measured 2026-10-10: typed on "Dan Brown" (first settled), came back on
"Scott Brower" (first in order); `checklist-wizard-career-team-commits` red on
its chip assert. Orioles/Big League passed only because the two rows were the
same. Reported as a product finding (return to the staging player?) — do not
route a flow around it without a decision. A flow-side alternative, if the
nav is ruled correct: decide the walk's row first so the presented player IS
`nextUndecided`, then stage. See [[neo248-career-team-entry-years-lost]].
