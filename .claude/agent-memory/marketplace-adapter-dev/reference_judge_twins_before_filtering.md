---
name: judge-twins-before-filtering
description: Name-twin detection must run on the FULL marketplace list before any id filter (Base drop, held/used ids, covered ids); a filtered-out twin makes its sibling look unique to every exactly-one guard downstream
metadata:
  type: reference
---

Any exactly-one guard (`computeMatches` passes, `nameTwinKeys`, the store's
`nameSharedInBatch`) only sees the list it is handed. Every place that drops
items first (fetchRawOptions' Base-id drop, VariantForm's held/used filters,
routeSlSets' covered ids) can remove one twin and leave the other looking
unique, so it gets auto-paired or auto-created.

**How to apply:** compute twin-ness on the raw list and carry it forward as
ids (fetchRawOptions `twinIds`, computeMatches `blocked`, routeSlSets counts
covered entries when it flags `twin`). Also: `foldedPrefixMatches` accepts
equality, so an "exempt from exact match" rule must also skip `stripped ===
hider` on the prefix road, or the exact match comes back through it.

Related: [[pure-router-rows-carry-nb-value]], [[store-loops-fall-through-to-insert]].
