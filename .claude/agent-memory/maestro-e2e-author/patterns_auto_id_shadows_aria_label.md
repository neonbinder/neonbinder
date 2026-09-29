---
name: auto-id-shadows-aria-label
description: A React useId() (`_r_xx_`) on an element that also has an aria-label hides the label from Maestro — `id: "<label>"` fails while the element is plainly on screen; read the hierarchy's resource-id, fix in product
metadata:
  type: feedback
---

maestro-web builds resource-id as `node.id || node.ariaLabel || …`, so any DOM
`id` wins. An element given `id={useId()}` for `aria-controls` /
`aria-labelledby` AND an `aria-label` flows target reports `resource-id:
"_r_1c_"` in the hierarchy dump, and `id: "<label>"` fails with the element
visibly rendered in the failure screenshot.

**Why:** NEO-313 lost a CI cycle: two flows gated on `id: "Choose a sport"`
(SportSwitch listbox) that could never match; unit tests using
`getByRole(..., {name})` were green because the accessible name was fine.

**How to apply:** when an `id:` assert fails on something the screenshot shows,
walk the dump to the element's bounds and read its resource-id before anything
else. `_r_..._` means an auto id: the fix is product code (move the id to a
non-interactive wrapper, as `SlSetReviewModal`/`primitives/Input` headers
prescribe), never a flow targeting the DOM id ([[e2e-never-target-a-dom-id]]).
Before writing `id: "<label>"` against a new component, grep it for `id={`
on the same element as the `aria-label`.
