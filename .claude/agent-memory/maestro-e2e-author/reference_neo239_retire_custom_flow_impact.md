---
name: reference_neo239_retire_custom_flow_impact
description: NEO-239 retired the isCustom flag — what that changes for Maestro flows: no "Custom" badge to assert, per-side marketplace resolvability replaces isCustomSubtree, any variantType is renameable, and hand-added rows are no longer flagged
metadata:
  type: reference
---

# NEO-239 — "custom" is not a thing any more

The `isCustom` boolean is deprecated (kept in the schema, never read or
written). A row either carries marketplace ids or it does not, and both behave
identically.

## What flows may no longer assert

- **There is no "Custom" badge.** The three `text: "Custom"` + `rightOf`
  assertions (`custom-entry-survives-resync` ×2, `cards-parallel-custom` ×1) are
  gone. Provenance is shown by the BSC/SL pills only, and a hand-added row has
  neither — so "this row is hand-made" is NOT assertable in the UI. Prove
  survival/creation with the row's own VALUE instead.
- `SyncDoneNotice`'s old "no bare word Custom" constraint is retired with it.

## The fetch gate — say it the new way

NEO-22's `isCustomSubtree` ("once custom, always custom") is replaced by
**per-side resolvability: a marketplace side is fetched only when the ids that
side needs are present on the ancestors.** BSC needs `sport`, `year`,
`setName`; SportLots needs `sport`, `year` (+ `manufacturer` to attach). A
hand-made subtree has no ids anywhere, so neither side is resolvable, neither is
fetched, and every column still goes idle instantly — the invariant the 37
per-worker fixture flows depend on. `.maestro/SET-REGISTRY.md` states it this
way in three places; don't reintroduce the `isCustomSubtree` wording.

## Renames

`refusesValueRename` is deleted. **Any variantType can be renamed** — Base is
now `metadata.isBase` (an NB role flag) and the BSC `variant` facet comes off
the row's tagged slot, so no display value is load-bearing. `SetAttributesPanel`
renders `RenameEntityControl` unconditionally (`canRenameSelectorRow` is gone).
`rename-selector-option.yaml` has a PART 2 that renames a hand-added variantType
inside its own `rnm-<worker>-<attempt>` set.

Note *why* that test is not a tautology: hand-added rows no longer get the
`isCustom` flag the OLD refusal exempted, so the old server would refuse the
exact rename PART 2 performs.

## Base is a flag, not a name

The Base column is terminal only when the variantType row carries
`metadata.isBase`; there is no name fallback. Derived at variantType-sync time
from a BSC `base` slot, plus a one-shot backfill for existing rows and a
"Mark as base set" control. `util-drill-to-base-variant` and its dependents
(`sets-base`, `checklist-renders-rich-fields`, `multi-source-panel-opens-dialog`,
`checklist-bsc-team-enrichment`, `signed-by-autofills-from-players`,
`util-drill-to-2024-topps-chrome`) therefore only pass on a deployment whose
2024 Topps Chrome Base row has the flag. On a **PR preview** that is automatic:
the preview starts empty and the setup track re-syncs every variantType row from
BSC, so the flag must be derived on the sync's INSERT branch, not only on match
— see [[reference_ci_convex_preview_starts_empty]]. Shared dev's rows predate
the flag and would need the backfill, which is one more reason to validate
against the preview rather than dev
([[feedback_never_push_a_branch_convex_to_shared_dev]]).
