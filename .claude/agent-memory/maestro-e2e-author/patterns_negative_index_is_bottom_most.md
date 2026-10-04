---
name: negative-index-is-bottom-most
description: Selector `index:` sorts matches by bounds y then x and accepts negatives (`-1` = bottom-most on screen) — the clean way to tap a REAL row in a bottom-opening virtuoso list instead of a clipped phantom
metadata:
  type: reference
---

`index:` is not DOM order. Decompiled from the pinned `maestro-client.jar`
(`maestro.Filters.index` + `INDEX_COMPARATOR`): matches are sorted by
`bounds.y`, then `bounds.x`, and a negative index counts back from the end
(`size + idx`). `Orchestra` parses the string with `Double.parseDouble`, so
`index: -1` parses (offline harness shows `index=-1`) and reaches the filter.
It runs on the viewport-pruned hierarchy, so `-1` = the lowest match that is
at least 10% on screen.

**Use:** CardChecklist's virtuoso opens at its END and over-renders clipped
rows ABOVE its viewport that Maestro calls 100% visible
([[virtualized-list-phantom-rows]]). Those phantoms are always the TOP
matches, so `id: "Edit card .+"` + `index: -1` always resolves to a real,
painted row (the list's last card once it is centred). Pair the scroll and
the tap with the same selector; centring converges because the bottom-most
visible row becomes the true last row as the page moves. First used in
`set-selector/base-parallels-build-from-section.yaml` STEP 4 (NEO-321) —
not yet CI-proven at the time of writing; confirm from that flow's first
green run before citing it as measured.

Do not use it where the list does NOT open at its end: there the
bottom-most match is a bottom-overscan phantom instead.
