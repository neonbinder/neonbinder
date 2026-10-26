---
name: reference-local-screenshot-script-gotchas
description: Driving local Vite with a throwaway Playwright script for screenshots/contrast — sign-in redirect fools waitForURL, "An error occurred" is often a missing Convex function, faked dark misreads team livery, computed colours come back as oklch
metadata:
  type: reference
---

Two traps when screenshotting signed-in pages with an ad-hoc Playwright script
against a spare-port Vite (not the E2E harness):

1. `/testing/sign-in?redirect=/admin` itself ENDS in `/admin`, so
   `page.waitForURL(/\/admin$/)` resolves instantly on the sign-in page and every
   "admin" screenshot is the Clerk sign-in card. Wait on the pathname instead:
   `page.waitForURL((u) => u.pathname.startsWith("/admin"))`.
2. A full-page "An error occurred. Please refresh the page." is the Sentry error
   boundary. Before suspecting your change, read the console error: the usual
   cause is `Could not find public function for '<module>:<fn>'`, i.e. the
   backend Vite points at has not got a function newer than its last deploy.
   That is environment, not a bug in the diff; screenshot what loads and report
   the rest. Console `%o` args serialise as nothing through `msg.args()`;
   wrap `console.error` in `addInitScript` and stash `e.stack` on `window`.

3. Measuring dark mode by setting `<html data-theme="dark">` by hand gives
   false contrast failures on team livery: `teamTextColor(team, surface)` is
   computed in React from the theme context, so a hand-flipped attribute
   re-colours the CSS roles but leaves the livery text painted for light
   (NEO-364: "Yankees navy 1.07:1" was this artifact; real dark measured
   9.16:1). Use the page's own theme control (the demo's "Demo theme" Dark
   radio, or the profile setting) in a context created with
   `colorScheme: "dark"`.
4. Computed colours come back as `oklch(...)`/`color(...)` for the theme
   roles, so a regex `rgb()` parser silently skips layers and measures
   against the body. Normalise through a 1x1 canvas (`fillStyle = c`,
   `fillRect`, `getImageData`) and composite translucent layers up the
   ancestor chain before computing the ratio.

A script outside apps/web cannot bare-import `playwright` (ESM resolves from the
script's directory); import `<apps/web>/node_modules/playwright/index.mjs` by
absolute path.

Related: [[gates-in-a-shared-worktree]], [[reference-fresh-worktree-missing-env-local]].
