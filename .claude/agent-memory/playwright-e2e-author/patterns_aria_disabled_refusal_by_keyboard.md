---
name: aria-disabled-refusal-by-keyboard
description: Prove an aria-disabled control refuses by focus() + keyboard Enter, and blur a field before clicking a control its value enables
metadata:
  type: pattern
---

A control that is `aria-disabled="true"` cannot be `click()`ed (Playwright waits for enabled and times out at 7 s). To prove it refuses: assert `toHaveAttribute("aria-disabled","true")` and `toHaveAccessibleDescription(reason)`, then `await control.focus(); await page.keyboard.press("Enter")` and assert the visible non-effect plus where focus landed (house precedent in the BSC listing spec).

The reverse trap: a value typed in a field that enables the control is often kept on BLUR. Playwright's click on the still-aria-disabled control would wait forever, because the blur only happens on the click. Press Tab first, assert the control lost `aria-disabled`, then click it.

Related: [[patterns_collection_optimistic_writes_wait_for_the_notice]]
