---
name: reference_playwright_default_light_scheme_breaks_dark_variants
description: Tailwind `dark:` in apps/web is class-based since NEO-341 (globals.css @custom-variant + class="dark" on <html>); before that it followed prefers-color-scheme and light-OS users (and Playwright's default light scheme) got white-on-white
metadata:
  type: reference
---

Fixed in NEO-341. `app/globals.css` declares
`@custom-variant dark (&:where(.dark, .dark *));`, `index.html` puts
`class="dark"` on `<html>` (covers `createPortal(document.body)` too; Radix's
`<Theme appearance="dark">` renders `.radix-themes.dark` inside it), and
`:root` pins `--background`/`--foreground` dark with `color-scheme: dark`.
The old `@media (prefers-color-scheme: dark)` block is gone. The compiled
CSS should contain zero `prefers-color-scheme` rules.

Before the fix, Tailwind v4's default `dark:` followed the OS, so under a
light OS (and in Playwright, whose default `colorScheme` is light) every
`bg-white dark:bg-gray-800` / `text-slate-600 dark:text-slate-400` pair
rendered its light half on the dark Radix page: `bg-background` headers went
white with near-white `.neon-header` text, axe flagged 10 contrast nodes.

**How to apply:**
- The light halves of existing `dark:` pairs are now dead code. New code on a
  dark surface can just use the dark tone; no pair needed.
- Many comments across SetSelector/ (CardDetailPanel, CardChecklist,
  ParallelBuildPanel, ReconciliationModal…) still reason about a "light-mode
  bg-white" render. That render no longer happens; do not design around it.
- Never fix a contrast failure by forcing `colorScheme` in playwright.config.
- A white/#f8fafc background in an E2E screenshot now means a hardcoded light
  class, not the OS scheme.
See [[gates-in-a-shared-worktree]], [[reference_slate_border_contrast_on_slate_900]].
