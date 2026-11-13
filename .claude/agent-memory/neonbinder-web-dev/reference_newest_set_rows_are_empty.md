---
name: reference-newest-set-rows-are-empty
description: "Newest catalog sets" cannot be read from selectorOptions setName rows by creation time — nearly all are empty marketplace-list rows; walk the newest cardChecklist rows instead, hopping per variant
metadata:
  type: reference
---

`selectorOptions` set rows are made long before any card lands (a
marketplace's list of sets, E2E-minted sets). On a seeded per-worktree
deployment the newest ~600 set rows were all empty, so "the newest sets"
read from `by_level` desc + `hiddenAsEmpty` returned nothing (NEO-464 New on
NeonBinder). There is no index on set rows that orders by "got cards".

What works without a schema change: walk `cardChecklist` on the built-in
`by_creation_time` index, newest first. The newest card names a variant, so
a set (`CatalogReader.setRef(card.selectorOptionId)`). Then skip that whole
variant: its oldest card is `withIndex("by_selector_option", eq).first()`
(every index ends in `_creationTime`), and the next step asks for
`_creationTime < that`. Cap the steps (a set with many parallels takes one
step each) and read it once on the client (`useConvex().query`), never
subscribed: every card added anywhere would re-run it.

A proper fix (a stamp on the set when its first card lands, plus an index) is
a convex-schema-specialist plan.

Related: [[reference-ancestor-rollups-make-the-sport-row-hot]].
