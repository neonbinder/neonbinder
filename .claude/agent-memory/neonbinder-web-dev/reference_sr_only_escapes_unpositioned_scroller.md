---
name: sr-only-escapes-unpositioned-scroller
description: A horizontal overflow-x-auto rail widens the whole page on phones when its children hold sr-only spans and the scroller itself is not positioned
metadata:
  type: reference
---

Tailwind `sr-only` is `position:absolute`. An absolute box is clipped by an
`overflow:auto` ancestor only when that ancestor (or something between) is its
containing block, i.e. positioned. A rail like
`<nav class="relative"><ul class="flex overflow-x-auto">…<span class="sr-only">`
puts the containing block on the nav, *outside* the scroller, so the sr-only
spans of off-screen stops sit at their real x and widen
`documentElement.scrollWidth` (NEO-364 Inventory rail: 653px at a 375 viewport).
The page then pans sideways and taps on later controls miss.

**How to apply:** give the scrolling element itself (or each stop) `relative`.
To find it, walk up from the scroller logging `scrollWidth` per ancestor: the
first ancestor whose scrollWidth exceeds the scroller's own width is holding
escaped absolute content. It only reproduced under the `mobile` viewport preset
(touch emulation hides scrollbars), not a plain 412px resize.
