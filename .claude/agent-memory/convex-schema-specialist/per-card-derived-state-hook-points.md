---
name: per-card-derived-state-hook-points
description: Every place a cardChecklist row is inserted, deleted, moved or re-parented — the sites any per-card derived state (counts, link tables, search fields) must hook; moves cross sets; prefer a ledger flushed once per mutation
metadata:
  type: reference
---

Derived per-card state (stored variant counts, `cardTeamLinks`,
`cardPlayerLinks`, `sportId`, search text) is only correct if EVERY card write
reaches it. Found while designing NEO-358 (2026-10-23):

- **Inserts:** `insertCardRow` (`cardRowCreate.ts`, used by the commit chunk
  and the parallel build) and `addCustomCard`. Make any new hook a REQUIRED
  parameter of `insertCardRow` so no caller can omit it.
- **Deletes:** `deleteCard`, commit finalize's delete phase,
  `deleteParallelCardsPage`, `wipeCardsPage`'s `dropCard` (including the
  variation children it drops). Route them all through one helper
  (`removeCardRow` in `cardRowDelete.ts`) and pin "every card delete goes
  through it"; the E2E reset drain is the one named exception.
- **Moves:** `setShapeMove.moveCards` is the only re-pointer of
  `selectorOptionId`. Moves CROSS SETS (S1 conversions: insert↔set,
  parallel↔set) but stay under one brand, so one year and one sport.
- **Re-parenting:** every writer of `variationOfCardId` (set/clear parent,
  finalize link/clear, `orphanVariationsOf` promoting a deleted parent's
  children, inserts that carry a parent) changes a base-only count with no
  insert or delete.

**How to apply:** for a count, use a per-mutation ledger (rowId → delta)
flushed once at the end of the transaction; OCC on the patched row serialises
concurrent chunks. Recount in place when the stored value is absent or would
go negative. Never cache a set-level total on the set row (one hot row for
every chunk). Pin "every mutation that inserts, deletes or moves a card also
flushes". Related: [[transient-side-table-checklist]].
