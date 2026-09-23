---
name: inert-list-trigger-not-covered
description: A disclosure trigger + inert options list + non-portalled confirm dialog pattern must mark the TRIGGER inert too, not just the list, or a screen-reader virtual cursor can still reach and reactivate it
metadata:
  type: feedback
---

Found in `MoveSetToBrandControl.tsx` (NEO-294): opening a brand picker list,
choosing a brand raises a non-portalled `ConfirmDialog` (`fixed inset-0 z-50`
overlay, rendered as a DOM sibling, not `createPortal`ed). The list container
correctly goes `inert={target !== null}` while the confirm is up — right
call over `aria-hidden` (doesn't leave focusable descendants reachable) — and
a `data-brand-id` + effect restores focus to the chosen row on Cancel.

**What was missed:** the disclosure trigger button ("Move to another brand")
that opened the list is a DOM sibling of both the list and the dialog, and it
was left OUT of the `inert` scope. `ConfirmDialog`'s own Tab-trap (scoped to
its own subtree via `querySelectorAll`) stops literal Tab/Shift+Tab from
reaching it, and the overlay's opaque backdrop stops a mouse click — but
neither stops a screen reader's browse/virtual cursor (arrow-key navigation,
not Tab-driven) from landing on and activating a plain, non-disabled,
non-inert button elsewhere in the DOM. Activating it while the confirm is
open calls the trigger's own toggle handler, which can unmount the list out
from under the still-open confirm (the list's `open` state and the confirm's
`target` state are independent), leaving `listRef.current` null when the
confirm later tries to restore focus into it — a real focus-loss-to-`<body>`
bug, not just a theoretical AT-only gap.

**Why:** `aria-modal="true"` is a promise to AT that nothing outside the
dialog subtree exists; honoring it for a non-portalled dialog means every
DOM sibling that isn't the dialog itself needs `inert` while it's open — not
just the one sibling that happens to look like "the background content."

**How to apply:** whenever a house control raises a non-portalled
`ConfirmDialog` from inside a disclosure (list/panel opened by a trigger),
check that `inert` is applied to a wrapper spanning trigger + list + anything
else that's a DOM sibling of the dialog — not scoped narrowly to "the list
that looks dangerous." Reproduce mentally: what does a screen-reader browse
cursor see as still-live while the confirm is open?
