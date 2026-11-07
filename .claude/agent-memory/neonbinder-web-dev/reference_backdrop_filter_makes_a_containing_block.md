---
name: reference-backdrop-filter-makes-a-containing-block
description: backdrop-filter makes a box the containing block for absolute children, so a "fixed" close button inside a blurred scroller scrolls away; put the blur on a sibling layer
metadata:
  type: reference
---

`backdrop-filter` (like `filter` and `transform`) makes its box the containing block for absolute and fixed descendants. A close button positioned inside a blurred scroller therefore scrolls with the content, and nothing looks wrong until the content overflows. Move the blur to its own `aria-hidden` sibling and keep the button as a sibling of the scroller (`.nb-toploader-dim`, NEO-444).

Related: `h-0 min-h-full overflow-y-auto` gives a stretched flex item's child no height of its own, so long content scrolls instead of growing the row (the public binder's inside cover). The vertical twin of [[reference-caption-under-an-image-never-widens-it]].
