---
name: reference_neo239_retire_custom_flow_impact
description: NEO-239 retired the isCustom flag — what that changes for specs: no "Custom" badge to assert, per-side marketplace resolvability replaces isCustomSubtree, any variantType is renameable, Base is a flag not a name
metadata:
  type: reference
---

# NEO-239 — "custom" is not a thing any more

The `isCustom` boolean is deprecated (kept in the schema, never read or written). A
row either carries marketplace ids or it does not, and both behave identically.

## What specs may no longer assert

- **There is no "Custom" badge.** Provenance is shown by the BSC/SL pills only, and
  a hand-added row has neither, so "this row is hand-made" is NOT assertable in the
  UI. Prove survival/creation with the row's own VALUE instead.
- `SyncDoneNotice`'s old "no bare word Custom" constraint is retired with it.

## The fetch gate: say it the new way

NEO-22's `isCustomSubtree` ("once custom, always custom") is replaced by **per-side
resolvability: a marketplace side is fetched only when the ids that side needs are
present on the ancestors.** BSC needs `sport`, `year`, `setName`; SportLots needs
`sport`, `year` (+ `manufacturer` to attach). A hand-made subtree has no ids anywhere,
so neither side is resolvable, neither is fetched, and every column still goes idle
instantly: the invariant the per-worker fixture specs depend on. `SET-REGISTRY.md`
states it this way; don't reintroduce the `isCustomSubtree` wording.

## Renames

`refusesValueRename` is deleted. **Any variantType can be renamed**: Base is now
`metadata.isBase` (an NB role flag) and the BSC `variant` facet comes off the row's
tagged slot, so no display value is load-bearing. `SetAttributesPanel` renders
`RenameEntityControl` unconditionally. The rename spec renames a hand-added
variantType inside its own minted set. That test is not a tautology: hand-added rows
no longer get the `isCustom` flag the OLD refusal exempted, so the old server would
refuse the exact rename it performs.

## Base is a flag, not a name

The Base column is terminal only when the variantType row carries `metadata.isBase`;
there is no name fallback. Derived at variantType-sync time from a BSC `base` slot,
plus a one-shot backfill for existing rows and a "Mark as base set" control.
`drillToBaseVariant` and its dependents therefore only pass on a deployment whose 2024
Topps Chrome Base row has the flag. On a **PR preview** that is automatic: the preview
starts empty and the seed re-syncs every variantType row from BSC, so the flag must be
derived on the sync's INSERT branch, not only on match
([[reference_ci_convex_preview_starts_empty]]). Shared dev's rows predate the flag and
would need the backfill, one more reason to validate against the preview
([[feedback_never_push_a_branch_convex_to_shared_dev]]).
