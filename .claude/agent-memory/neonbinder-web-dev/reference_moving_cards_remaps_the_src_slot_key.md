---
name: moving-cards-remaps-the-src-slot-key
description: A cardChecklist row's platformData.<side>.src is a slot key on ITS OWN parent row; any re-parent of cards must remap it via the destination's allocateSlots, and clear (never carry) a src the map does not cover
metadata:
  type: reference
---

`cardChecklist.platformData.sportlots.src` / `.bsc.src` is NOT a marketplace id.
It is a slot key (`s0`, `b1`) on the card's current `selectorOptionId` row, and
slot keys are allocated per row. Two rows both have an `s0`.

So a mutation that moves cards to another row must:

- move the LINKS first (`allocateSlots(dest, { sportlots: [{id, label}] })`) and
  read the destination key per id from `slotByIdBySide`;
- build a source-slot → destination-slot map per SOURCE ROW (a set row and its
  Base can both hold `s0`) and rewrite each card's `src` through it;
- for a `src` the map does not cover (already dangling, or a side that stays
  behind): keep the `ref`, drop the `src`. Carrying the key over silently
  points the card at whatever the destination holds under that key — the exact
  repointing hazard slot keys exist to prevent.
- a card whose refs are attributed to BOTH a moving link and a link that stays
  cannot be split by id: refuse, never guess.

Also on the same path: `deleteEmptySelectorOptionRow` and
`collectSelectorOptionHoldings` are exported from `convex/selectorOptions.ts`
(NEO-305) so a door that empties rows ends them through the trash icon's own
holdings check, sweeps and audit log, in its own transaction. Guest
`cardCrossListings` pointing AT an emptied row are holdings too — carry them.

Worked example: `convex/setParallelConversion.ts` (`remapCardPlatformData`,
`moveCards`). Related: [[a-reparent-drops-a-row-out-of-its-open-column]].
