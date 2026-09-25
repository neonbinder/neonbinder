---
name: reference_autocomplete_list_is_a_fixed_layer
description: The shared Autocomplete's list is position:fixed, anchored to the field (flips above), and portalled into the nearest role="dialog" (else body) — an absolute list was clipped by a dialog's overflow-y-auto body and ran under its footer in CI (NEO-307)
metadata:
  type: reference
---

Since NEO-307 `components/primitives/Autocomplete.tsx` renders its listbox via
`createPortal` into `input.closest('[role="dialog"]') ?? body`, `fixed`,
positioned in a layout effect from the field's rect (re-measured on capture
scroll + resize), flipping above when the room below is short, shrinking
`max-height` to fit.

**Why:** CI at 1024x629 — an `absolute` list inside NewTeamDialog's scrolling
body ran under the pinned footer, so a tap on the last option hit the footer.

**How to apply:**
- A NEW host whose `role="dialog"` root (or any ancestor of it) has a
  `transform`, `filter`, `backdrop-filter` or `contain` breaks `fixed`
  (it becomes relative to that ancestor). The current roots are
  `fixed inset-0` overlays with none of those — keep it that way, or the
  list mispositions.
- Never portal the list to `<body>` from inside a modal: `inertBackground`
  (see [[inert-the-opener-behind-confirmdialog]]) would make it inert.
- In tests, scope option queries to the listbox by name (`"<label>
  suggestions"`) — a page's native `<select>` options share `role="option"`.
- happy-dom has no layout: stub the input's `getBoundingClientRect` and
  `window.innerHeight` to test placement.
