---
name: static-markup-visual-check
description: Cheapest screenshot of a layout-only UI change — copy dist/assets/index-*.css from `npm run build`, write the component's markup with real classes to a scratch HTML, render in headless Chrome inside fixed-width iframes (Chrome clamps --window-size to ~500px, faking overflow at 375); no Vite, Clerk or Convex needed
metadata:
  type: reference
---

For a change that is pure markup and Tailwind classes (a caption, a wrap rule,
a spacing fix), the heavy route ([[visual-harness-fake-convex-client]]: running
Vite, an iframe, a fake Convex client) is overkill. This takes about a minute:

1. `npm run build` in `apps/web`, then copy `dist/assets/index-*.css` into the
   scratchpad as `app.css`. The build only emits classes it found in source,
   so build AFTER the edit; grep the CSS for a new utility
   (`grep -o '\.wrap-anywhere{[^}]*}'`) to confirm Tailwind generated it.
2. Write a scratch `grid.html` that links `app.css` and repeats the
   component's markup with its real classes. Stand in for images with SVG data
   URIs at the real aspect ratios (portrait 250x350, landscape 350x250), and
   include the loading-state div and the longest realistic strings.
3. `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new
   --disable-gpu --hide-scrollbars --window-size=760,1540 --screenshot=<out>.png
   file://<scratch>/host.html`, where `host.html` holds `<iframe src="grid.html">`
   at `width:320px` and `width:375px` side by side. Render 1024 the same way
   (the CI E2E viewport, see [[e2e-viewport-is-the-ux-constraint]]), then Read
   the PNGs.

   **Never use `--window-size=375,…` for a phone width.** Chrome clamps the
   window to a minimum of about 500px, lays the page out at that width and
   then crops the screenshot to 375. Every row looks cut off on the right, a
   false overflow. NEO-327 reported one before the iframe host showed the same
   markup fitting at 320. Pin the width with an iframe.
4. To attribute a reflow fix, render the pre-fix classes too: `sed` the old
   classes back into a copy of the scratch HTML and screenshot both.

Limits: no React state, no live data, and the page's own container padding is
whatever you write. A layout problem the mock shows in markup you did NOT
change is a lead to check in the real app, not proof.
