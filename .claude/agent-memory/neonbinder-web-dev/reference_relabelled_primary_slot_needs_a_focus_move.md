---
name: reference_relabelled_primary_slot_needs_a_focus_move
description: When one footer button is relabelled to a new action by a step switch, move focus off it (heading); arm the focus ref only on a real state change; a park-on-heading effect must follow the opener-reading open effect
metadata:
  type: reference
---

A wizard footer often reuses one button slot for the step's primary action. If a click on that slot
switches the step and the same element becomes a DIFFERENT action (NEO-332: the pick step's
"Create new" becomes the New Player step's "Add as New Player"), focus stays on it, and a keyboard
user's second Enter performs the new action without having seen the new screen.

**How to apply:** on the switch, move focus to the new step's heading (`tabIndex={-1}`, focused from
script only). On the way back, return focus to the control that started the switch. Queue the focus
in a ref and apply it in an effect after render, so the target exists.

**Round-3 audit additions (NEO-332):**
- Arm the focus ref only when the state change really happens (the flag is added or removed). A ref set on a no-op change sits there until the NEXT unrelated change to that state, and then moves focus for no reason.
- A "focus fell to `<body>` after the presented row changed, park it on the heading" effect must be declared AFTER the dialog's open effect that reads `document.activeElement` as the opener. Effects run in declaration order; declared first, it moves focus before the opener is read and close-time focus return goes to the heading. Skip parking when focus is inside another open `[role=dialog]` (a stacked confirm or New Team dialog).
- An arrival the operator did not cause (a live query turning the step into another step) gets a line in the footer's existing live region, not a second region, and focus is left alone if it is on a footer control (the one element that survives the swap).
- A mouse double-click still lands on the relabelled slot. Moving focus does not prevent that; only a guard on the click does.
