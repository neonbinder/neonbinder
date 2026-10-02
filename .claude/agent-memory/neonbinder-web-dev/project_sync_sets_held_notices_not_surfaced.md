---
name: project-sync-sets-held-notices-not-surfaced
description: Sync Sets (setName level) deliberately drops the store's heldElsewhere/withheldElsewhere/subtreeWalkSkipped at the action boundary — decided in NEO-312 not to build a notice channel; do not re-propose
metadata:
  type: project
---

The setName-level store (`storeSelectorOptions`) returns `heldElsewhere`,
`withheldElsewhere` and `subtreeWalkSkipped`, but `fetchAggregatedOptions`,
`syncSetsAcrossManufacturers` and the `selectorSyncStatus` row carry only
`message` + `unlinked`, so the Sets column (EntityColumn → `ensureSelectorOptions`)
never sees them. The skip is silent.

**Why:** decided 2026-10-01 (NEO-312): the save already holds a moved link, so
no duplicate is possible, and Sync Sets has always skipped client-held ids
silently via `listBrandSubtreeSlIds`. A status channel through four functions
and a table, for a stale-dialog race whose outcome is already safe, was judged
not worth it.

**How to apply:** if a task asks why Sync Sets shows no "left alone" note, this
is the answer; don't propose wiring `StoreHoldNotices` into the Sets column
unless the ask is explicitly to reverse this decision. Insert/parallel columns
(VariantForm/ParallelForm) DO surface them — see [[reference-copy-that-names-a-button-goes-stale]].
