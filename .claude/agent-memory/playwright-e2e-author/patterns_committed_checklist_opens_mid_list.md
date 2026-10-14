---
name: committed-checklist-opens-mid-list
description: After a big checklist commit the set builder's virtualized list sits wherever its FIRST streamed batch put it (measured rows #146–#150 of 300); a fresh mount opens at the LAST row — so read a card back after re-entering the set, and pick a fixture club whose cards are at the END of the list
metadata:
  type: reference
---

`CardChecklist`'s Virtuoso has `initialTopMostItemIndex = last row` and an
inner scroller (`min(70vh, 800px)`) that a page-level scroll cannot move.
A commit streams cards in batches; the list MOUNTS on the first batch (its
"last row" then is the batch's last) and keeps that scroll position as the
rest arrive. Measured on a 300-card commit: the list showed #146–#150 at its
bottom edge, and the cards a flow wanted (#2–#34) were ~140 rows away.

**How to apply:** to assert a committed card's sub-line, re-enter the set
(a fresh load mounts with every card, so it opens at the true end) and make
the card you assert one of the LAST in natural card-number order. Find which
cards a club owns from the marketplace's facets before choosing (BSC
`teamName` + `cardNo` aggregations). Small sets (≤ ~7 rows) need none of
this. Worked example: the past-era team-link spec (#34–#36 are the last rows of a 36-card
Base; #25–#27 are ~5 rows up, reached by scrolling the list's own scroller from a row),
re-entering through the open-one-marketplace-set-base helper. Pin a sub-line to ONE row
by its position between its own number node and the next row's. Related:
[[virtualized-list-phantom-rows]].
