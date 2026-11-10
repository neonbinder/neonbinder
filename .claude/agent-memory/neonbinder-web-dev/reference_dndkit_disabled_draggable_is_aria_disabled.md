---
name: dndkit-disabled-draggable-is-aria-disabled
description: useDraggable({ disabled: true }) spreads aria-disabled="true" via `attributes`; on a row that wraps live buttons that disables them for AT and Playwright (click refuses "element is disabled")
metadata:
  type: reference
---

dnd-kit's `attributes` include `aria-disabled={disabled}`. Spread onto a row
container (role="group") that holds buttons, `aria-disabled="true"` cascades:
Chrome exposes every descendant as disabled and Playwright's actionability
check refuses to click them, even though no button is natively disabled.
NEO-472 hit it with a "has parallels" jump button inside a non-draggable row.

Fix: override after the spread (`{...attributes} aria-disabled={undefined}`)
and let the row's own controls carry their state (native `disabled` on the
ones that really are). A unit test can pin it with
`row.hasAttribute("aria-disabled") === false`.

Related: [[dndkit-row-control-is-a-handle-sibling]], [[dndkit-droppables-in-their-own-scroll-pane]].
