---
name: inline-block-is-a-reader-group
description: An inline-block span inside a one-phrase <p> becomes its own Chrome AX "generic" node (a group between the words); role="presentation" flattens it back to plain text
metadata:
  type: reference
---

Laying out part of a sentence (a stat's words beside a big numeral, NEO-539 Hopper)
without splitting what a reader hears: flex/grid blockify the spans, and even
`display: inline-block` makes Chrome expose the span as a non-ignored `generic`
node, so the paragraph reads `StaticText "3"` then a group holding the words.
Adding `role="presentation"` to that span removes the node; the paragraph is back
to two StaticText children, textContent unchanged, ariaSnapshot `paragraph: 3 runs
sorted this week`.

**How to apply:** check with CDP `Accessibility.getFullAXTree` (walk from the
StaticText up to the paragraph and dump children); Playwright's `ariaSnapshot()`
alone flattens the group and will not show it. Inline-block's baseline is its LAST
line, so a two-line words block sits on the numeral's baseline by default — size
the words so two lines fill the figure height. See [[e2e-never-target-a-dom-id]].
