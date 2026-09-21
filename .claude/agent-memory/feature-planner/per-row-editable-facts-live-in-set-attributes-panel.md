---
name: per-row-editable-facts-live-in-set-attributes-panel
description: Any operator-editable fact about a selectorOptions row goes into SetAttributesPanel as a "Value for {label}" row, never a new box beside a column; role flags are never operator checkboxes
metadata:
  type: feedback
---

A per-row editable fact (a feature, the team, the card-number prefix) belongs
in `SetAttributesPanel` as a row with the `Value for {label}` accessible name,
`useFieldTestClass`, the `useReactiveField` commit contract and the
`Saved {label}` / `Cleared {label}` toasts. Role flags (`isBase`, `isInsert`,
`isParallel`) are never operator checkboxes: they are derived once at row
creation (from the row's level and the parent variantType's `isBase` or its
`variant`-tagged BSC slot id — sync and hand-made rows alike) and re-derived only when the operator moves the row's level.

**Why:** NEO-291 retired the separate "Metadata" box under the Variants column:
it duplicated the panel's editing surface, its checkboxes re-derived roles from
the variantType's display name on every render (the NEO-239 smell), and its
spread-merge mutation could not clear a value.

**How to apply:** when a ticket adds "an editable field on a set/variant row",
plan it as a panel row plus a narrow `setSelectorOption<Field>` mutation with
NEO-217 clear semantics; when it adds "a kind/role", plan a creation-time
derivation and a header control like `BaseRoleControl`, not a checkbox.
