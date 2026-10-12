---
name: wizard-returns-to-batch-order-player-after-staged-team
description: Since NEO-330 an answered New Team step that player A's typed career team (or "Decide team") staged returns the walk to A (league → team → A); before that it went to the first undecided player in batch order. Back / Change / Back to review clear the return; A decided meanwhile falls back to batch order
metadata:
  type: reference
---

**Current behaviour (NEO-330, `returnTo` in `entity-review-nav.ts`):** typing a
career team on player A (or pressing "Decide team") stages a New Team step and
records a return stack; once that step — and any `New League:` step staged
ahead of it — is answered (create, link or skip), the walk presents A again.
Only when the operator had started editing A; if A was decided meanwhile the
walk falls back to batch order. Back, the Decided list's "Change" and "Back to
review" clear the return.

**What a flow can lean on:** the career-team chip list is keyed by A's review
row, so asserting `<club> (2001.2005)` right after the step proves the walk
returned to A — `checklist-wizard-career-team-commits` is the E2E proof
(red on the old nav, green on the new, Memphis RiverKings, 2026-10-10).
After A is DECIDED the walk moves on in batch order as before.

**History:** before the fix `resolveNav` took `nextUndecided(rows)` (first
settled undecided player in batch ORDER), while the walk util stops on
whichever row settled FIRST (a Wikidata no-match settles fastest), so on a
mixed batch the two differed and the chip assert failed on a row that never
had a chip. Flows on fixtures where they coincided (Orioles, Big League)
passed by luck. See [[neo248-career-team-entry-years-lost]].
