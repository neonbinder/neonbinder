---
name: armed-backfill-models-have-no-cursor
description: The selectorOptions backfill models (backfillVariantFacetAndBaseRole, backfillBrandUnknownRole) are ONE take(SCAN_LIMIT+1) transaction with no cursor; plans that say "SCAN_LIMIT + cursor like X" describe a shape that does not exist
metadata:
  type: project
---

`backfillVariantFacetAndBaseRole.run` reads every `variantType` row with
`.withIndex("by_level").take(20001)` in a single `internalMutation`, and
`backfillBrandUnknownRole.run` does the same over manufacturers at 4,000
(re-scoped by `parentId` on truncation). Neither pages. A planner citing
"SCAN_LIMIT + cursor like backfillVariantFacetAndBaseRole" is misremembering.

Why it matters: the binding limit on a fat-row scan is the 16 MiB data-read
budget, not the 32k scanned-docs count. A `variantType` row carries its
`children` id array (hundreds on an Insert/Parallel type), slot maps, labels
and features, so 20,000 of them can exceed 16 MiB long before 32k.

**How to apply:** for a new backfill over a table that can grow, specify a
real cursor: an `internalMutation` page (`.paginate({ numItems: 500, cursor })`,
~501 system ops like `RESET_BATCH_SIZE`) that does the env-flag + confirm
check itself, driven by an `internalAction` loop that sums counts and stops
on `isDone`, so the operator still runs one `npx convex run`. Keep ONE planner
shared by dry run and armed run (the models' rule). Related:
[[convex-two-transaction-limits]].
