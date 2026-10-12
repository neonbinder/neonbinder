---
name: past-era-team-fixture
description: NEO-330 past-era flow on 2025 Topps WttC 3X MVP — the team step's era options live in a 192px option list that needs a touch-drag pin, no card surface shows a team's era, and why the needs-a-team fixer / Fill-conflict paths cannot share this fixture (one commit per run; Fill's conflict rows need a fillable card beside them)
metadata:
  type: reference
---

**Fixture shape (measured 2026-10-11, catalogue preview):** 36-card Base,
BSC-only fetch stages `0 new players + 1 new teams`: `New Team: Philadelphia
Athletics` (four catalogue rows, none covering 2025). Brooklyn Dodgers (one
dated row) links on its own at the fetch. Flow:
`checklist-wizard-past-era-team-link-commits`. It is the ONLY small
2012–2026 Base found with a player carrying both an ambiguous-era club card
and another club's card (Foxx #34/#35 A's, #36 Red Sox); the BSC scan over
every set naming Phil. A's / St. Louis Browns / Washington Senators / St.
Louis Stars / Detroit Stars found one other, 2016 Panini Pantheon (95 cards,
same-name legends Frank Thomas and Tony Gwynn).

**The era options are an inner scroller.** Focusing the empty `Search all
teams` opens a `max-h-48` (192px) list ABOVE the field: the exact rows first
("same name · <league> · <years>"), then close matches. Five options overflow
it; maestro still "sees" the clipped last era and a tap lands on the field.
Pin the list to its end with one touch drag inside it (`swipe` 30%,42% →
30%,20%), then tap the era LINE by a full-match regex
(`same name . [A-Z]+ . 1901.1954`) — a hidden sentence in the step lists all
four eras in ONE node (y≈522), so `.*1901.1954.*` taps it instead.

**No card surface prints an era**: the decision line ("Linked to
Philadelphia Athletics"), the row sub-line, the drawer chip and Player
Management's card list are all `teamFullName`. Prove WHICH era at the pick
(the option's era line), and the link's arrival by the sub-line; the stored
id is a read-only `--inline-query` measurement, not an E2E claim.

**One commit per run decides the fixture's outcome.** The wizard link
(operator past-era link → cards) and a teamless A's card (needs-a-team
fixer with era chips, Fill conflict) are mutually exclusive on #34/#35: a
team decision applies to every card naming the club, and a card resolved at
commit never gets `bscTeamName` (only the post-commit BSC check stamps it,
and only on a teamless card). Removing the team in the drawer later leaves no
listing name.

**Fill's conflict rows need a fillable card beside them.** `FillTeamsControl`
opens its preview only when `fillable > 0`; an all-conflict set gets the
count-only notice "Nothing to fill — N cards still need a team, and they're
your call (N where the listing disagrees)…". So "Listing: X · Fill: Y (from
#N)" is reachable only on a set that ALSO has a teamless card a tier can fill
without a contradicting listing (e.g. a card BSC lists with no team). See
[[catalogue-seeded-wizard-staging]], [[touch-swipe-scrolls-a-dialog-body]],
[[committed-checklist-opens-mid-list]].
