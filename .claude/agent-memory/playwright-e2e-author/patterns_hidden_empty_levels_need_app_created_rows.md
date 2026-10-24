---
name: hidden-empty-levels-need-app-created-rows
description: NEO-358 subtree counts - prove "empty level is hidden" on a row the spec's own set builder drill creates, never a bundle row
metadata:
  type: patterns
---

The collector's Checklists cascade hides a level whose stored subtree card count is exactly 0. Reference-bundle rows carry NO subtree count (unknown, always shown), so a bundle row can never prove the hide. Rows the app creates are born at 0 and are the fixture: drill a per-worker hand-made set in the set builder, look for it in `/collection` > Checklists > Sets (absent), add a card (present), delete it (absent again).

**Why:** an absence assert on a not-yet-loaded column passes vacuously (R2).
**How to apply:** first assert a real sibling in the same listbox is visible (Topps Chrome under Baseball > 2024 > Topps), then `toHaveCount(0)` on the hand-made option; the same locator turning visible after the card proves it was the filter.
