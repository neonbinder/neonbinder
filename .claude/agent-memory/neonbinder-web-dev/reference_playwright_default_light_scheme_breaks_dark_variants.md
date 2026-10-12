---
name: reference_playwright_default_light_scheme_breaks_dark_variants
description: Playwright's headless Chromium runs prefers-color-scheme light by default; NB's Radix theme is appearance="dark" but Tailwind `dark:` variants follow the OS, so light-mode users (and axe in E2E) see white header/cards with near-white text
metadata:
  type: reference
---

The app forces Radix `appearance="dark"` in `src/main.tsx`, but the Tailwind
`dark:` variants on the marketing pages (`app/landing.tsx`, the header's
`.neon-header`, feature cards with `bg-white`/`bg-slate-50` plus `dark:`
overrides) follow `prefers-color-scheme`. Playwright's default `colorScheme`
is `light`, so in E2E (and for any real user whose OS is set to light) the
header renders white with `#eceeed` text (contrast about 1.1). axe's
`color-contrast` reports it on every public page (NEO-341, first
`expectAccessible` run).

**How to apply:** a contrast failure on a white or `#f8fafc` background in
an E2E screenshot is this light-scheme mismatch, not the dark neon design.
It is a real product bug (fix the variants so the page is dark whatever the
OS says), never a reason to force `colorScheme: "dark"` in the Playwright
config just to get green. The `text-slate-500`/`text-slate-600` body copy
on `#101211` fails contrast in both schemes. See [[gates-in-a-shared-worktree]].
