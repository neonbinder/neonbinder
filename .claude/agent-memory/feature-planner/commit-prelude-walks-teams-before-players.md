---
name: commit-prelude-walks-teams-before-players
description: commitCardChecklistPrelude walks every TEAM name before any PLAYER name (one paged walkOffset), so a team row chosen from the card's player (career stints) cannot be recomputed silently at commit; the gate must hand it over as a decided review row
metadata:
  type: project
---
The commit prelude's resolve walk is one offset over `teamNameList` then
`playerNameList`, paged across transactions. When a team name is resolved,
no player id for that card exists yet in that transaction. Team identity is
also per NAME (`teamIdByName`), not per card.

So any rule of the form "the card's player tells us which same-name team row
it is" (NEO-490: a St. Louis Browns era picked from the player's stints)
cannot be a silent inference the commit re-derives. It has to be decided in
the review gate (`resolveUnknownsAndStartBatch`, which resolves players
BEFORE teams) and passed to the commit as a decided `entityReviewQueue` row
(an `autoLinked` origin), which the team loop honours as a link decision.
Player-side narrowings (`narrowSameNamePlayersByCardYear`) do not have this
problem: the gate and the commit both call the same function.

**Why:** found while planning NEO-490 (2026-11-11); reordering the paged walk
would touch NEO-296's budget/deferral contract.

**How to apply:** a plan that narrows a team by anything known only after
player resolution routes it through a decided row (schema literal on
`decision.autoLinked` + the hand-kept copies). Related:
[[reversible-auto-links-are-decisions-not-fast-path-answers]],
[[hand-kept-validator-copies-of-schema-shapes]].
