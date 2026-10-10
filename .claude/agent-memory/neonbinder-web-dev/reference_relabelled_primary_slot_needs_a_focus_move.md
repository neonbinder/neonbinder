---
name: reference_relabelled_primary_slot_needs_a_focus_move
description: When one footer button is relabelled to a new action by a step switch (e.g. "Create new" → "Add as New Player"), move focus off it, or a second Enter fires the new action
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
