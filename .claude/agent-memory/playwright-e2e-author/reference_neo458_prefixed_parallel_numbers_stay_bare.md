---
name: neo458-prefixed-parallel-numbers-stay-bare
description: NEO-458 - how a BSC-prefixed parallel (Football 2026 Bowman Chrome, BCV-) is built through the UI, why NB's numbers stay bare, the drill, and why no number-mismatch negative control exists
metadata:
  type: reference
---

A parallel's cards are a COPY of Base's NB cards (NEO-312/321), each re-linked to
the parallel's own BSC card by number with the row's Card prefix taken off BSC's.
So the prefix is a LINK key, never stored on the number: Football 2026 Bowman
Base is bare (`#26 Dak Prescott`), Parallel > Chrome built from it is bare too,
while BSC spells them `BCV-26`. Setting the prefix AFTER the build links nothing
new; set it first, then "Build from Base" (`Chrome - Built 198 cards, 2 left
off ... 2 on BSC that Base doesn't have`). A prefix on a parallel row is read by
`prefixOf(chain)` in `parallelChecklistBuild.ts`; the BSC fetch path
(`fetchCardChecklist`) strips it only for the SportLots lookup and stores BSC's
number as given - that was the wrong model for this flow.

The tree under a SportLots pause: `drillToColdManufacturer(..., manufacturer:
"Bowman")` hand-makes the brand; the Set is `Bowman`, variant types `Base` /
`Insert` / `Parallel`; the parallel's row is an `insert`-level row named
`Chrome` under the `Parallel` variantType. The collector cascade reads Football >
2026 > Bowman > Bowman > Parallel > Parallel (column, singular) > Chrome, and the
checklist region is `2026 Bowman Chrome` (year + set + parallel name). Base is
200 cards, four unknown players, no team step, saved in about 15 s.

Traps met on the way:
- After picking Base the Variant Types column is the collapsed card
  `Variant Types: Base - change`: click it to reopen before picking Parallel.
- Wait for `Parallels: Chrome - change` before `Edit attributes`, or the toggle
  opens the Parallel TYPE's panel (no Card prefix field).
- A parallel-role leaf has no "Sync card checklist", only "Build from Base".
- The card drawer has NO number field, and a BSC ref is only set by a fetch or a
  build, so a card cannot be given a number that differs from its BSC row through
  the product. The "stays held for a different number" negative control is
  unit-test only (`lib/bscSheetPlan.test.ts`, `listingDrain.test.ts`).
- A filtered collector checklist with no hits reads `No cards match.` and `0 of
  198 cards`, not `0 cards`.
