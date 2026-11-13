---
name: reference-axe-catches-hover-where-the-pointer-rests
description: An expectAccessible after click + goBack can flag color-contrast on a :hover fill, because the mouse still rests where the clicked control was and the new layout puts another link under it; it reproduces only in a batch whose data shifts the layout
metadata:
  type: reference
---

Playwright leaves the mouse where its last click landed. After `link.click()`
then `page.goBack()`, the page re-renders and whatever now sits under that
point is in `:hover`. axe then measures its hover colours. On the NEO-464
dashboard a hopper run link (`hover:bg-hover-raised` with `text-ink-3`
inside) slid under the pointer only when an earlier spec in the same run left
extra sections up top, so the red came and went with the batch order and
never reproduced alone.

**How to apply:** a contrast red whose selector is a link's inner span, seen
only in a batch, read it as hover. It is a real bug (a mouse user sees that
state): give the quiet ink a `group-hover:text-ink-2` step on the hover fill,
never move the mouse in the spec to dodge it. Dark `ink-3` on `hover-raised`
is under 4.5:1. Related: [[reference_axe_target_size_and_animation_false_reds]].
