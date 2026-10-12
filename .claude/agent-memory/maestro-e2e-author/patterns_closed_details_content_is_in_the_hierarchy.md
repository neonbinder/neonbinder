---
name: closed-details-content-is-in-the-hierarchy
description: maestro-web lists a CLOSED native <details>'s content with live on-screen bounds (SkippedNamesPanel's `Skipped names` list + `Unskip <name>` buttons) — an assertVisible on it passes while nothing is drawn
metadata:
  type: reference
---
A closed `<details>` hides its content on screen, but maestro-web's hierarchy
still reports every descendant with real, in-viewport bounds. Seen on the set
builder's checklist (`SkippedNamesPanel`, a closed `<details>` above the card
list): the `Skipped names` list and 20 `Unskip <name>` buttons sat at
y=0..628, overlapping the checklist rows, while the screenshot showed only the
rows.

**Why it matters:** `assertVisible` / `scrollUntilVisible` on anything inside a
closed disclosure passes without the operator ever being able to see it, and a
tap lands on whatever is actually drawn there (a checklist row). Same family as
[[inner-scroller-clip-is-invisible-to-maestro]]: maestro-web prunes by viewport
only.

**How to apply:** before asserting inside a `<details>`, open it by tapping its
`<summary>` and assert something only the open state renders. When reading a
failure dump, compare each node with the screenshot before trusting it.
