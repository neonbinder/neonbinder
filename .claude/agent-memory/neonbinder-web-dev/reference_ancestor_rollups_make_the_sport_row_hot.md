---
name: ancestor-rollups-make-the-sport-row-hot
description: A count rolled up selectorOptions parentId chains writes the sport/year/brand rows on every card write (cross-set OCC, query fan-out); NEO-364 fix = exact counts from the set down + a one-time hasCards flag above; ledger delete/re-parent mechanics
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
- What shipped (NEO-364, Jason's call): exact subtree counts from the SET
  down only; sport/year/brand carry a one-time `hasCards` boolean, set by the
  first flush that brings a card (or a re-homed subtree with cards / of
  unknown size) and never written again, never cleared. The flush still
  READS those rows (chain walk) but a read is no conflict when nobody writes.
  Judge "a card arrived" per contribution, not on the net delta (add in one
  set + delete in another nets 0 at the sport). Absent flag = hidden, so a
  rollout needs the backfill run straight after deploy, and the E2E seed's
  card writes must go through the ledger (they do: commit chunk + parallel
  build). A reference-seed bundle must strip `hasCards` from sport rows or a
  preview shows prod's sports empty.
- Pattern for "born with level-dependent fields": a `newRowSubtreeCounts(level)`
  helper spread first into every insert, and the pin test checks the argument
  equals the insert's own `level` key (shorthand `level` or `level: "x"`).

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
