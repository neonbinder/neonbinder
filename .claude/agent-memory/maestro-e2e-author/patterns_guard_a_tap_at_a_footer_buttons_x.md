---
name: guard-a-tap-at-a-footer-buttons-x
description: In a fixed dialog whose body scrolls under a pinned footer, a body tap at the same x as a footer button (row buttons / a search box's × vs Save) lands on that button when the target is clipped; guard it with "an element below the target is above the footer's Cancel" before tapping
metadata:
  type: feedback
---

Before tapping a dialog-body element whose x overlaps a footer button, assert
that something rendered BELOW the target sits ABOVE the footer:

```yaml
- assertVisible:
    id: "<an element that renders below the target>"
    below: { id: "<the target>" }
    above: { text: "Cancel" }        # the pinned footer's own button
- tapOn: { id: "<the target>" }
```

**Why:** maestro-web never sees an inner scroller's clip
([[inner-scroller-clip-is-invisible-to-maestro]]), so a row button scrolled
under ReconciliationModal's footer is still "visible" and the click lands on
whatever the footer has there. Every SportLots row's `Make its own set`
(x≈858-976) and the search box's `×` (x≈959-979) share Save's x (877-983), so
a layout change (NEO-325's Base-check counter + sleeves added ~150px above the
column) turns a mis-tap into a SAVE on the shared real set (R7a). A guard
fails by name instead. `above:`/`below:` compare TOP edges and accept any one
anchor, so the guard only bounds the target's top to (Cancel top − the gap to
the next element) — pick a "below" element at least a row down.

**How to apply:** any dialog-body tap whose x falls inside a footer button's
x range, especially after a feature adds height above the body's rows. Taps
at an x the footer leaves empty (a search box's centre, a left-column filter)
cannot write; they need no guard, only the next step's positive.

Related: [[touch-swipe-scrolls-a-dialog-body]], [[neo325-base-check-selectors]].
