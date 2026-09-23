---
name: a-reparent-drops-a-row-out-of-its-open-column
description: SetSelector's columns are scoped to the selected parent id, so any mutation that re-parents a row makes it vanish from the open column while everything below it keeps working — re-point the parent column, don't clear the selection
metadata:
  type: reference
---

Every column in `components/modules/SetSelector.tsx` queries by the **selected
parent id** (`Sets` is scoped to `selectedManufacturerRowId`, `Variant Types` to
`selectedSetId`, and so on). Everything *below* a row, by contrast, keys on that
row's **own** id — which a re-parent does not change.

So a mutation that moves a row under a different parent produces a split screen:
the panel, the checklist and the deeper columns carry on describing the row,
while the column the operator is actually looking at silently stops listing it.
A success toast beside a column that no longer shows the row is the operator
being told two different things.

**The fix is to re-point, not to clear.** Set the parent-level selection to the
destination and leave the row selected; the column re-queries and the row is
sitting under its new parent, which is the evidence the toast cannot supply.
Do *not* reuse the level's own `handleXSelect` — those call `clearFrom(depth+1)`
and throw away the selection below. `onDeleted` (which does clear, and parks
focus) is the shape for a row that is *gone*; a re-parent is not that.

The pattern already existed before anyone noticed the gap: picking a set inside
the All Brands view back-fills the Manufacturers column from the set's own
parent, for exactly this reason.

Worked example: `handleSetMoved` / `SetAttributesPanel`'s `onMoved` (NEO-294).
Ask this question of any future mutation that changes a `selectorOptions` row's
`parentId`.
