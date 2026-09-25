---
name: sync-sets-artefacts-key-per-scope
description: Anything Sync Sets writes "per year" must be keyed per (year, manufacturer scope) — the sync also runs for ONE manufacturer, and a year-wide array doc overflows 1 MiB; measure with getConvexSize
metadata:
  type: project
---

`syncSetsAcrossManufacturers` takes an optional `manufacturerId` and then
classifies only that scope. A persisted artefact of the SportLots phase that
is "one doc per year, replaced on every sync" therefore wipes every OTHER
brand's pending state whenever a single-brand sync runs. Key it on
`(yearId, manufacturerId)` and replace only the scopes this run classified
successfully (a scope whose SL list failed keeps its previous doc).

Size is the second reason. A scope is capped at `MAX_SL_SETS_PER_SYNC` (200)
roots with labels up to `MAX_SLOT_LABEL_LENGTH` (200 chars), but the number of
scopes per year is NOT capped: real brands fetched are capped at
`MAX_SL_BRANDS_PER_SYNC` (25), brands linked through SportLots' all-brands
option plus Unknown are not. Measured with `getConvexSize` (NEO-306,
2026-09-25): a 200-entry scope doc is ~22 KiB with typical labels, ~53 KiB at
200 ASCII chars, ~132 KiB at 200 three-byte chars — a year doc hits 1 MiB at
~46 / ~19 / ~8 scopes. Per scope it is 8x under the limit at worst.

**How to measure instead of guessing:** write a throwaway `.mjs` in
`apps/web` (so `convex/values` resolves from its node_modules) that builds
the worst-case doc and prints `getConvexSize(doc)`; delete it afterwards —
other builders share the worktree.

**How to apply:** any plan that says "one document per year" for set-sync
output — review queues, notices, summaries — gets re-keyed per scope, with
one compound index `["yearId", "manufacturerId"]` (the year-only read is its
prefix). Related: [[transient-side-table-checklist]],
[[convex-two-transaction-limits]].
