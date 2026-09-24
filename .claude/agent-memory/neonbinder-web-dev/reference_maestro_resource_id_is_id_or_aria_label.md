---
name: maestro-resource-id-is-id-or-aria-label
description: maestro-web sets resource-id to `node.id || node.ariaLabel`, so a DOM id on a control HIDES its aria-label from every `id:` selector; find elements by a data attribute instead
metadata:
  type: reference
---

maestro-web reports an element's resource-id as `node.id || node.ariaLabel`.
A flow's `id: "Select Foo"` therefore matches the aria-label ONLY when the
element has no DOM id. Adding `id="x-row-123"` to a button, even just so code
can `getElementById` it for focus management, silently makes it unreachable
by name.

**Why:** in the NEO-300 multi-select pass I gave each tick box and name button
a DOM id so the arrow keys could find the next row. That hid "Select <row>"
from the Maestro flow written against it, and the coordinator caught it.

**How to apply:**
- Interactive or focusable elements (buttons, tick boxes, focusable
  `role="group"` scrollers) carry NO DOM id.
- When code needs to find a control, use a data attribute plus a scoped
  `querySelector` (e.g. `data-grouping-control`).
- `aria-controls`, `aria-labelledby` and `aria-describedby` still need ids.
  Put the id on the non-interactive target: a summary `<p>`, a heading, or an
  always-rendered wrapper around a focusable list (see HeldElsewhereNote).
- Pin it with a test that asserts `getAttribute("id")` is null on each control.

Related: [[maestro-web-text-is-direct-text-nodes-only]], [[disambiguate-duplicate-aria-labels-by-rewording]]
