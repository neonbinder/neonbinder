---
name: insert-fixture-needs-its-column-writer
description: An INSERT row exists only after its variant-type column's reconcile is SAVED, and an insert whose BSC and SportLots names differ is never auto-matched (it waits in Pending) — so an insert fixture depends on whoever writes that column; check the column's sole writer and the saved Ready list before proposing one
metadata:
  type: reference
---

**Rule:** before proposing an insert as a fixture, answer two questions with
read-only evidence:

1. **Who writes its column?** `SET-REGISTRY.md` names a sole writer per
   variant-type column. If that writer REQUIRES a fresh column (its reconcile
   "opens on its own", e.g. `reconcile-sportlots-twins-save-each-to-its-own-set`
   on 2024 Topps flagship › Insert), no other flow can save that column
   without breaking it, in either run order (the queue has no ordering).
2. **Is the insert auto-matched?** The reconcile auto-pairs by name; BSC and
   SportLots often name one insert differently (BSC `1989 Topps Baseball 35th
   Anniversary All-Stars` vs SportLots `2024 Topps 1989 Topps All Star`
   #307353, brand-stripped to `1989 Topps All Star`). Such a pair waits in
   Pending and the row is created only by an operator pairing (or `Make its
   own set`) plus a Save. Check the saved column read-only after a green CI run
   (`selectorOptions` children of the variant-type row): 2024 Topps flagship ›
   Insert held 149 rows and no 1989 All-Stars row.

**Why:** NEO-330 (2026-10-10) — an owner-approved insert fixture turned out to
need a reconcile Save on a column another flow owns fresh; found at the clash
check, before any flow was written.

**How to apply:** a fixture's provisioning is part of the proposal: name the
step that creates the row (setup, the fixture flow, or the column's writer)
and what the column's current writer must change. SportLots' public listing
by year (`SetNbr`/`SetInfo`/`CardInfo`) and BSC's shop facets (`variantName`
under `setName`) give both names offline. See [[splitting-a-flow-over-shared-real-data]].
