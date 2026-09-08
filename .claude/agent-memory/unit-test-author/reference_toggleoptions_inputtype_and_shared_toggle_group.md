---
name: reference_toggleoptions_inputtype_and_shared_toggle_group
description: How ExpectedFeature's "toggleOptions" inputType renders/tests (Autographed/Short Print), and the shared "Set attribute toggles" group in SetAttributesPanel (NEO-71-74)
metadata:
  type: reference
---

Added in NEO-71-74 (apps/web, PR #73): a new `ExpectedFeature.inputType`
value `"toggleOptions"` sits alongside `"text"|"select"|"checkbox"|"boolean"`.
Deleted in the same change: the `"derived"` inputType (vintage was its only
user — now a plain `"checkbox"`) and the `applicableAtLevels` field
(cardType/parallelName's only user — both keys removed entirely from
`EXPECTED_FEATURES`, along with `manufacturer`).

**`toggleOptions` contract** (`ToggleOptionsValueControl` in
`FeatureValueControl.tsx`): same `options` array as `"select"` used to have,
plus optional `toggleLabels` (index-aligned, index 0 unused) that overrides
pill TEXT only — the STORED value is always the raw `options` string (e.g.
clicking the "Sticker" pill still calls `onSave("Sticker/Label")`).
`options[0]` ("None") is the implicit off-state and never gets its own pill
— only `options.slice(1)` render. Each pill's aria-label is
`` `${ariaLabel}: ${pillLabel}` `` (e.g. `"Value for Autographed: On Card"`,
`"Value for Autographed: Sticker"`) — the base `"Value for {label}"` prefix
is preserved for Maestro compatibility, but this means `getByLabelText("Value
for Autographed")` alone no longer matches anything (not unique/exact) —
query the full `"Value for {label}: {pill}"` string instead, and use
`queryByRole("combobox")` to assert "no dropdown" when inverting an old
select-based test.

**Grouping in `SetAttributesPanel.tsx`**: any feature with
`inputType === "checkbox" || "toggleOptions"` is partitioned OUT of the
2-column grid into one shared `role="group" aria-label="Set attribute
toggles"` flex-wrap row, rendered above the grid. Test membership with
`within(screen.getByRole("group", { name: "Set attribute toggles" }))
.getByLabelText(...)`, and confirm a plain field (e.g. "Season") is absent
from that group via `within(group).queryByLabelText(...)`.

**`CardFeatureRow` (CardFeaturesEditor.tsx / CardDetailPanel.tsx) was NOT
updated for this new type** — its checkbox-branch condition still only
checks `"checkbox"` (not `"toggleOptions"`), so Autographed/Short Print there
fall through to the same labeled-box "default" branch as before (unlike
SetAttributesPanel, where checkbox/toggleOptions share one row). This is a
deliberate asymmetry between the two panels, not a bug — don't "fix" the
CardDetailPanel test to expect a bare pill group there.

Related: [[reference_carddetailpanel_dirty_guard_and_stub_children]] (same
file's dirty-guard-via-× convention still applies unchanged).
