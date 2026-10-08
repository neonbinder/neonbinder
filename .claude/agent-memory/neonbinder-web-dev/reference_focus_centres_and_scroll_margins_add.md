---
name: focus-centres-and-scroll-margins-add
description: Chrome focus() CENTRES an off-screen target (scroll-margin does not steer it), and scrollIntoView ADDS html scroll-padding-top (80px) to the element's scroll-margin-top
metadata:
  type: reference
---

Measured in headless Chrome at a 1024x629 window (NEO-319):

- `el.scrollIntoView({block:"start"})` with `html { scroll-padding-top: 80px }`
  and `scroll-margin-top: 128px` (`scroll-mt-32`) parks the element at
  viewport **y=208**, not 128. The two add.
- `el.focus()` on an off-screen element CENTRES it; scroll-margin has no
  effect on where it lands. The `scroll-mt-32` comments in
  LeagueManagement.tsx / FranchiseManagement.tsx ("focusing parks it at
  y=80") describe neither behaviour.

**How to apply:** when a heading must take focus AND be shown under the
sticky app bar, `focus({ preventScroll: true })` then decide the scroll
yourself (`scrollIntoView({block:"start"})` + a `scroll-mt-*` sized as
"extra px below the 80px bar"). PlayerManagement's `PlayerDetail` heading
effect is the worked example. Re-measure with the static-markup recipe
([[reference_static_markup_visual_check]]) rather than trusting a comment.
