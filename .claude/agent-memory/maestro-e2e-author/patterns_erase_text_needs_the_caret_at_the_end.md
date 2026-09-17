---
name: erase-text-needs-the-caret-at-the-end
description: maestro-web `eraseText` is N Selenium Backspaces at the active element's CARET — a label tap focuses a textarea with the caret at 0 and erases nothing; tap the box itself (centre click, past the end of a short value) before erasing
metadata:
  type: reference
---

`CdpWebDriver.eraseText` = `withActiveElement { sendKeys(BACK_SPACE × n) }`
(decompiled from the pinned maestro-client.jar). Backspace deletes from the
caret, and Selenium does not move the caret on an element that is ALREADY
focused. So:

* `tapOn: "<label text>"` → the label's implicit association focuses the
  `<textarea>`/`<input>` with the caret at position **0** → `eraseText: 120`
  changes nothing, silently. Measured on Team Management's "Also known as"
  box (NEO-284): the chip list survived 120 Backspaces.
* `tapOn` the control itself → the click lands at its centre; for a one-line
  value shorter than half the box that is past the end of the text → caret at
  the end → erase works. This is why `tapOn id: "New team name"` +
  `eraseText: 40` has always worked in the admin flows.

Selecting the control when its text equals a sibling's (chip vs textarea):
`tapOn: { text: "<value>", below: { text: "<label>" } }` — `below` sorts by
distance, and the box sits nearer the label than the chips under it.

Cost: ~8s for 120 Backspaces (one sendKeys each); size the count to the
field's ceiling, not larger.

Related: [[maestro-web-getnodetext-form-values]], [[input-primitive-has-no-resource-id]].
