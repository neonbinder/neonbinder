---
name: reference-abs-child-escapes-unpositioned-scroller
description: An `sr-only` (position:absolute) node inside an overflow-x scroll row escapes the row's clip unless the row is positioned; on Playwright's isMobile project that widens the document, zooms the layout viewport out and every click reports "<element> intercepts pointer events"
metadata:
  type: reference
---

`overflow: auto/hidden` clips an absolutely positioned descendant ONLY when the
scroller is (or contains) that descendant's containing block. An `sr-only` live
region inside the Set Builder's horizontal columns row took binder-layout's
`relative` wrapper as its containing block, sat at its static position at the
far end of the columns, and stretched the document to the row's full scroll
width (1818px at a deep drill), on desktop as well as on a phone.

Symptoms on the Playwright `e2e-mobile` project (Pixel 7, `isMobile`): Chromium
grows the layout viewport to fit (`innerWidth` 1648 on a 412px device), the page
looks shifted left in failure screenshots, and clicks fail with a rotating cast
of interceptors (the page container, the scroll row, a neighbouring panel).
Desktop does not show it because a non-mobile viewport just scrolls sideways.

How to find it: check `document.documentElement.scrollWidth` against
`clientWidth`, then list elements whose rect passes the viewport edge, keeping
absolute/fixed ones even under an overflow ancestor and printing their
`offsetParent`. A naive "skip anything inside an overflow ancestor" sweep
misses it. Fix: make the scroller `relative`. Don't use `overflow-x: hidden`
on body.

The same leak happens with a `truncate` line: an `sr-only` label inside a
nowrap span on a `truncate` `<p>` escaped the clip and widened the page by
about 50px. The fix there was `relative` on the `<p>`. When a page overflows
for no visible reason, look for an `sr-only` sitting just past the right edge.

Related: [[e2e-viewport-is-the-ux-constraint]].
