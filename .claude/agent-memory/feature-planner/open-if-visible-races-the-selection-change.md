---
name: open-if-visible-races-the-selection-change
description: The spec idiom `expect(edit.or(hide))` then `if (await edit.isVisible()) click` can skip the click right after a Set Builder selection change
metadata:
  type: feedback
---

`SetAttributesPanel` stays mounted across selections and returns null until the new row and chain load. Straight after picking an option, `edit.or(hide)` can pass on the previous node's panel and `edit.isVisible()` can then read false in the null window, so nothing is clicked and the wait for "Hide attributes" runs out.

**Why:** the panel comes back collapsed, so the failure looks like a click that did nothing. It reads as flake but is a deterministic race in the spec.

**How to apply:** gate on the new node first with the heading `Attributes for <name> (<level>)`. To diagnose, read the steps in the blob report's `report.jsonl`: `isVisible` emits no step, so a missing Click step between two expects proves the branch skipped. The error-context snapshot shows the panel below the fold when the screenshot does not.
