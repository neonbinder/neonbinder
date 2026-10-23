---
name: reference-local-screenshot-script-gotchas
description: Driving local Vite with a throwaway Playwright script for screenshots — the sign-in redirect URL fools a waitForURL regex, and a "An error occurred" page is often a Convex function the local backend lacks
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

A script outside apps/web cannot bare-import `playwright` (ESM resolves from the
script's directory); import `<apps/web>/node_modules/playwright/index.mjs` by
absolute path.

Related: [[gates-in-a-shared-worktree]], [[reference-fresh-worktree-missing-env-local]].
