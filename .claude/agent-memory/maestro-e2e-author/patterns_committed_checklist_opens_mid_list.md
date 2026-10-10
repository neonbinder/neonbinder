---
name: committed-checklist-opens-mid-list
description: After a big checklist commit the set builder's virtualized list sits wherever its FIRST streamed batch put it (measured rows #146–#150 of 300); a fresh mount opens at the LAST row — so read a card back after re-entering the set, and pick a fixture club whose cards are at the END of the list
metadata:
  type: reference
---

`CardChecklist`'s Virtuoso has `initialTopMostItemIndex = last row` and an
inner scroller (`min(70vh, 800px)`) that `scrollUntilVisible` cannot move.
A commit streams cards in batches; the list MOUNTS on the first batch (its
"last row" then is the batch's last) and keeps that scroll position as the
rest arrive. Measured on a 300-card commit: the list showed #146–#150 at its
bottom edge, and the cards a flow wanted (#2–#34) were ~140 rows away.

**How to apply:** to assert a committed card's sub-line, re-enter the set
(a fresh load mounts with every card, so it opens at the true end) and make
the card you assert one of the LAST in natural card-number order. Find which
cards a club owns from the marketplace's facets before choosing (BSC
`teamName` + `cardNo` aggregations). Small sets (≤ ~7 rows) need none of
this. Worked example: `checklist-wizard-link-team-saves-alias` R2(h)
(Tigres de Aragua owns #290–#297), re-entering through
`util-open-one-marketplace-set-base`. Related:
[[virtualized-list-phantom-rows]], [[inner-scroller-clip-is-invisible-to-maestro]].
