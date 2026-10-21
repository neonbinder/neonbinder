---
name: container-own-cqw-resolves-upward
description: An element with container-type cannot size ITSELF in cqw — its own cqw resolves against an ancestor container or the viewport, so `borderRadius: 5cqw` on a 88px card became a pill; use % (e.g. "5% / 3.57%") on the container, cqw only on descendants
metadata:
  type: reference
---

Container query units on the element that DECLARES `container-type` do not
measure that element. They resolve against the nearest ancestor container,
and with none, the small viewport. NEO-350's CardFace scales its internals with
`cqw` off a `containerType: "inline-size"` root; the same `cqw` radius on the
root of the sibling `EmptySleeve` turned an 88px sleeve into a pill (5cqw of a
1280px viewport = 64px).

**How to apply:** size anything ON the container (radius, padding, border) in
`%` or fixed units; a 5:7 card's "5% of width" radius is `"5% / 3.57%"`. Put
`cqw` only on children. Spot it in a screenshot: shapes that look right in a
grid but wrong in isolation, or radii that change with the window width.
Related: [[static-markup-visual-check]].
