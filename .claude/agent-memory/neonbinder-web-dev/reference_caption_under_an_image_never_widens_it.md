---
name: caption-under-an-image-never-widens-it
description: To let a long caption (a filename) wrap under a scan without widening the figure, use figure `flex flex-col items-center min-w-20` + caption `w-0 min-w-full wrap-anywhere text-balance`; `w-min` on the figure collapses preflight images to zero
metadata:
  type: reference
---

Worked out on NEO-327 (review-grid side captions, "Front · <filename>").

- **`w-min` on the figure is a trap.** Tailwind preflight gives `img`
  `max-width: 100%`, and a replaced element with a percentage max-width has a
  min-content contribution of ZERO (CSS Sizing "compressible replaced
  elements"). A `w-min` figure then shrinks to its min-width and squeezes a
  landscape scan.
- **What works:** figure `m-0 flex min-w-20 flex-col items-center`, caption
  `w-0 min-w-full`. `w-0` gives the caption no say in the figure's width,
  `min-w-full` then fills whatever the image chose. `min-w-20` covers the
  loading state, when the image has no width yet.
- `wrap-anywhere` (Tailwind 4.1+, `overflow-wrap:anywhere`) breaks an unspaced
  name like `IMG_20241005_0001.jpg` instead of truncating it. Truncation hides
  the END of a scan name, which is the part that tells two scans apart.
- `text-balance` makes a short `Front · scan-01.jpg` break after the dot
  ("Front ·" / "scan-01.jpg") instead of at the hyphen ("scan-" / "01.jpg").
- Keep the caption ONE string expression (`{sideCaption(...)}`), not
  `Front · {name}` in JSX, which is two text nodes; see
  [[reference_maestro_web_text_is_direct_text_nodes_only]].

Checked with [[reference_static_markup_visual_check]] at 375 and 1024 wide.
