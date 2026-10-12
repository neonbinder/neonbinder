---
name: center-element-is-one-sided
description: maestro's centerElement check is ONE-SIDED per direction (UP accepts centre > 0.3H, DOWN accepts centre < 0.7H) — a centred scroll does not fix where a target rests, so rows below/above it can land past the fold; scroll to each row you assert
metadata:
  type: reference
---

Decompiled from the pinned jars (`maestro/UiElement.isElementNearScreenCenter`,
`Orchestra.scrollUntilVisible`): with H = the height grid (625 in CI),
threshold = H/5 = 125 around H/2 = 312, and only ONE side is checked:

- `direction: UP` → "centred" ⇔ element centre > ~187 (anything lower,
  down to the fold, is accepted).
- `direction: DOWN` → "centred" ⇔ element centre < ~437 (anything higher,
  up into the sticky-header band, is accepted).
- A target outside its band gets a ~313px swipe, then the band is re-tested.

So `centerElement` is "not stuck at the near edge", not "in the middle". A
centred UP scroll to a header control can leave it at y≈480; a list below it
then starts past y=629, where the viewport-clipped hierarchy cannot see it,
and a negative assert on those rows passes vacuously.

**How to apply:** assert a list row only after scrolling to THAT row (R6: the
scroll is the assertion; direction from DOM order, R5). To make a
`notVisible` on a sibling row mean "gone", first DOWN-centre the row above
its slot (centre < 437 keeps ~2 rows below it on screen at 80px rows), and
re-centre a control before tapping it (a DOWN scroll can leave it under the
sticky header). A layout shift of a few dozen px upstream (NEO-334: +40px
after picking a variant type) is enough to flip where these land, so a flow
that "passed for months" on a fixed resting point was relying on luck.
Worked example: `checklist-attention-badge-and-filter.yaml`, THE FILTER.

Related: [[below-the-fold-asserts-and-bottom-locked-scrolls]],
[[negative-asserts-pass-on-a-dead-page]].
