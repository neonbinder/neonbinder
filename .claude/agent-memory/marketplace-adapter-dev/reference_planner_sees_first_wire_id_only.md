---
name: planner-sees-first-wire-id-only
description: storeReconciledOptions' wire sides are arrays but planSelectorSync gets only ids[0] per side; every one-link-one-row check must also run on the extras at the write site
metadata:
  type: reference
---

`storeReconciledOptions` takes `platformData.bsc|sportlots` as `string | string[]`,
but `items` (what `planSelectorSync`, `itemsReachPastSiblings` and
`loadSyncHoldersElsewhere` see) is built from `wireToIds(...)[0]`. Tier 1, the
held-elsewhere check and the unchecked-side fail-closed only ever judge the
FIRST id per side. The insert path allocates every wire id, so before NEO-325's
re-audit a non-primary id already held by a sibling or elsewhere landed on a
second row.

The fix pattern (now in the store): `extraIdsByItem` (deduped, primary removed),
a `holderProbe` item list = items + one single-id probe per extra, passed ONLY to
the holder walk (never the planner, or the probes become planned items), and a
per-extra block check (sibling snapshot index + `linkBlocker`) in the insert
branch, reported via `linkWithheldEntry`.

**How to apply:** any new per-id rule in this store (or a new multi-id wire
field) has to cover the extras at the write site too; a planner-only change
leaves them unchecked. The match path refreshes only the primary slot, so it
never writes an extra. Sibling sharing of one SL id is legal M:1 (NEO-137) for
`attachPlatformIds` and intra-batch inserts; only the extras are blocked. Related:
[[store-loops-fall-through-to-insert]], [[judge-twins-before-filtering]].
