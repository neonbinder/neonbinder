---
name: ancestor-rollups-make-the-sport-row-hot
description: A count rolled up selectorOptions parentId chains (subtreeCardCount) writes the sport/year/brand rows on every card write; cross-set OCC and query fan-out follow; how the ledger survives same-transaction row deletes and re-parents
metadata:
  type: reference
---

Rolling a per-row value up the `selectorOptions` `parentId` chain (NEO-358
`subtreeCardCount`, kept by `CardCountLedger.flush`) turns the sport, year and
brand rows into hot documents: every card insert/delete/move anywhere in a
sport now PATCHES them.

- **OCC:** card writers already READ those rows (`findSportForSelectorOption`
  in the commit chunk, chain walks), and Convex validates the whole read set
  at commit. So two concurrent card-writing mutations in different sets of
  one sport now conflict and the loser re-runs in full. Before the rollup,
  only writers on one variant row did. Parallel E2E shards mostly share one
  sport, so it shows up there first.
- **Query fan-out:** every query that reads those rows (`CatalogReader.setRef`
  on every card path, admin sport/year columns) re-runs on every card write
  in the sport.
- The way out, if it bites: keep the rollup off the structural rows (a
  separate counter table keyed by row id, read beside the row) and/or move
  propagation above the set to a scheduled mutation, with the chain resolved
  in the writing transaction.

Ledger mechanics that worked (see the cardCounts.ts header):
- A row deleted before the flush: record `row → parentId` while it exists
  (`rememberChain`, called from `removeCardRow`); the flush walks a missing doc
  through the hint, but a LIVE doc's own `parentId` always wins, so a re-parent
  after the hint is still right.
- Re-parent: `moveSubtree` records -stored at the old parent and +stored at
  the new one; pending card deltas go to whatever chain the row sits on at
  flush. The two compose in any order, and shared ancestors net to zero.
- Unknown (absent) counts stay absent; a drift that would go negative clears
  to absent rather than clamping, because a clamped 0 would hide rows.

Related: [[action-blind-insert-is-invisible-to-occ]], [[convex-test-transaction-limits-pin-the-read-set]].
