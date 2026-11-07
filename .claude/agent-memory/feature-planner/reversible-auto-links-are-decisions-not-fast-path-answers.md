---
name: reversible-auto-links-are-decisions-not-fast-path-answers
description: Any automatic name link the operator must be able to see and undo in the review wizard has to be an entityReviewQueue row with a link decision, never an entry in checklistNameResolutions or a silent gate answer; and the commit prelude must honour a row's decision before its exactly-one fast path
metadata:
  type: project
---
An auto-link that is "visible and reversible" (shows in the wizard's Decided
list with Change) must be a review row carrying a `link` decision. It must NOT
also be written to `checklistNameResolutions`, and it must not stay a silent
gate answer: the commit prelude's resolve loop takes the exactly-one
`sameNamePlayers` answer (and the NEO-402 stored answer) BEFORE it reads the
review row's decision, so a stored or in-sport "one match" would silently
override the operator's Change. The commit also checks the linked player
against the ROW's sport, so a cross-sport auto-link row is inserted with
`sportId` = the player's home sport (the shape `switchRowSport` leaves), which
passes with no relaxation and, with `addSetSport` absent, writes nothing to the
player.

**Why:** planned for NEO-424 (set-history player resolution, 2026-11-03). The
NEO-402 fast path was designed for names that never reach the wizard; once an
inference can be overruled by a human, decision precedence has to be explicit.

**How to apply:** any plan that adds an automatic resolution the operator can
revisit lists (1) the row + decision origin marker, (2) decision-before-fast-
path in `commitCardChecklistPrelude`'s resolve loop and the creates pass's
`already.length === 1` skip, (3) silence only when inference and today's lookup
agree. Related: [[hand-kept-validator-copies-of-schema-shapes]],
[[wizard-chrome-strings-are-suite-wide-e2e-gates]].
