---
name: image-sized-link-is-zero-wide-before-decode
description: A link/button whose only box is an `h-N w-auto` img is 0 px wide until the image decodes — axe target-size fails in that window; size the control as a 5/7 frame instead
metadata:
  type: reference
---

An `<a>`/`<button>` whose width comes from a child `<img className="h-48 w-auto">`
measures 0 x 192 until the image decodes (measured in Playwright's headless
Chromium with a failing src: old 0.0x192, framed 137.1x192). Playwright's
axe check can run in that window and report `target-size` (serious) on the
link — a product race, not a spec flake (NEO-496, RequestReview "Their photos").

Fix: put the size on the control, not the image —
`block aspect-[5/7] h-N overflow-hidden rounded border … bg-raised-deep focus-outline`
on the link, `h-full w-full object-contain` on the img (5/7 = a 2.5 x 3.5 in
card; contain letterboxes an odd photo). Pin it in the component test by
asserting the link's classes include `aspect-[5/7]` + `h-N` and not `w-auto`
(happy-dom has no layout, so classes are the only handle).

A bare `<img className="aspect-[5/7] h-12 w-auto">` (CopyPhotosField LineThumb)
also gets its width before load — CSS `aspect-ratio` applies to a loading
replaced element. A plain `h-N w-auto` img outside any control is not an axe
target-size issue, only layout shift.

To measure a pre-load box quickly: scratch HTML with `file:///nonexistent/x.jpg`
srcs (a blackholed http src makes `--dump-dom` hang) and a sync script writing
getBoundingClientRect into a `<pre>`, run through
`~/Library/Caches/ms-playwright/chromium_headless_shell-*/…/chrome-headless-shell --dump-dom`.
See [[static-markup-visual-check]].
