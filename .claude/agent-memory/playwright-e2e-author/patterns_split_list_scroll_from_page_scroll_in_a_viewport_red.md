---
name: split-list-scroll-from-page-scroll-in-a-viewport-red
description: toBeInViewport "ratio 0" on a row in a scrolling list has two independent causes (the list's own scrollTop, the page's scrollY); read which from the failure PNG before blaming either, and how to rule out a dev-only cause cheaply
metadata:
  type: patterns
---

A red `expect(row).toBeInViewport()` ("viewport ratio 0") on a row inside a
virtual/fold list (NEO-276 column re-expand spec) can be the LIST not scrolled to
the row, or the PAGE not scrolled to the list. Tell them apart from the failure
PNG: compare which row sits first in the list against a local full-page
screenshot (`page.screenshot({ fullPage: true })` in a scratch copy of the spec).
In the Sports column the centred list starts at "Multi Sport" with Racing 4th
(page y=673 on a 1024x629 viewport, so just under the fold at page scrollY 0).
A CI PNG showing that list with the page header and Admin tabs still on screen
means the list scroll was right and the page scrollY was 0.

Measured at sport level (Racing selected): document height 1434, scrollIntoView
of the Sports heading leaves scrollY 299 and holds it (10 probes at 150 ms).
Row 4 is in view from scrollY 30 on, so only a scrollY of ~0 reds it.

Cheap ways to rule out "dev-only": `vite build --outDir <scratch>` is ~2 s here; a
20-line node static server (SPA fallback, proxy `/api/*` to the dev Vite, because
the sign-in hop's `/api/auth/testing` exists only under `vite serve`) lets the
spec run against the PRODUCTION bundle like CI's Vercel preview. A `git archive
origin/main` snapshot Vite (see [[probe-vite-from-a-head-snapshot]]) answers
"did this branch change the height" with one `document.documentElement.scrollHeight`
probe on each side.

Delete the build, snapshot and every `--output` folder when done (traces).
