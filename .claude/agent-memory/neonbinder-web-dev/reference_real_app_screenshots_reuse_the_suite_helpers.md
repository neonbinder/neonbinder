---
name: real-app-screenshots-reuse-the-suite-helpers
description: How to screenshot a signed-in flow on the real app without touching the repo — a scratch Playwright config + .shots.ts files that import playwright/support by absolute path
metadata:
  type: reference
---

To screenshot real app states (signed in, live data) for Jason without adding a
harness file to the product tree:

- Put `shots.config.ts` (a plain object export, no `@playwright/test` import),
  the `*.shots.ts` files and a `package.json` of `{"type":"module"}` in a
  scratchpad folder. Without that package.json the support files fail with
  "Cannot use 'import.meta' outside a module".
- Import `test`/`expect`/helpers from `<worktree>/apps/web/playwright/support/*`
  by absolute path, and run `npx playwright test --config <scratch>/shots.config.ts`
  from `apps/web` so the runner and the fixtures share one Playwright.
- Light/dark: `page.emulateMedia({ colorScheme })` works while the test user's
  theme is System; read `document.documentElement.dataset.theme` to confirm.
  Widths: `page.setViewportSize` mid-flow, so one walk shoots every size.
- A blocked `NeonButton` is `aria-disabled`, which Playwright treats as not
  enabled: press it with `click({ force: true })` (or the keyboard) to show the
  blocked state.
- Use a set whose spec is a reader (Cancel → Discard) for anything before the
  save; a committing shot spends a sole-writer set's fresh-only precondition, so
  name the set in the report. (Since NEO-482 checklist-disagreement picks count
  as decisions, so `cancelAndDiscard` works from that step too.)
- Run with the SAME env the spec runner uses, or the helpers take the wrong
  branch: `WORKER_INDEX=<n>` picks the test user (`TEST_EMAIL_<n>`), and only
  the worker the E2E agent bootstrapped has marketplace credentials (every
  other worker hits "Set Builder requires marketplace credentials"); probe
  each worker with a sign-in-only shot rather than seeding credentials, which
  is a real seller sign-in. Mirror `PAUSED_PLATFORMS` too, or the base picker
  helper waits for a paused side's candidates.
- Your own Vite needs `VITE_DEV_DISABLE_HTTPS=1` in an agent shell: mkcert
  otherwise tries `sudo security add-trusted-cert` and the server exits.
- Wait for the E2E agent's run to end before a shot that fetches: a worker
  bootstrap resets that user's state mid-shot, and two fetches share the
  marketplace's volume limit.

Related: [[reference_visual_harness_fake_convex_client]], [[reference_static_markup_visual_check]].
