---
name: happy-dom-pads-inline-span-in-accessible-name
description: In happy-dom (no layout) dom-accessibility-api treats a child <span> as block and pads it with spaces, so a link "Label<span class=sr-only>, done</span>" is named "Label , done" in a unit test but "Label, done" in Chrome
metadata:
  type: reference
---

happy-dom computes no CSS display, so dom-accessibility-api cannot tell a
`<span>` is inline and joins it to its sibling text with a space. A control
whose visible label is followed by an sr-only status span (", done",
", still to do") gets the name `"Label , done"` in a components-project test,
while a browser (and therefore the Playwright spec) reads `"Label, done"`.

**How to apply:** do not change the markup to please the test. Match the name
with a normalising function in the unit test,
`getByRole("link", { name: (n) => n.replace(" ,", ",") === expected })`, and
keep the exact string for the E2E spec. Found on NEO-415's eBay setup
checklist step links.
