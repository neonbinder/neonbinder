---
name: axe-target-size-and-animation-false-reds
description: How to diagnose Playwright axe reds on mobile — target-size "partially obscured" counts only focusable widgets as obscurers (the sticky header's buttons), and colour-contrast reds on a Clerk dialog can be its fade-in, not its palette
metadata:
  type: reference
---

Two axe signatures from the Playwright E2E suite (playwright/support/a11y.ts) that do not mean what they look like:

1. **target-size "partially obscured"** on a button that looks fine. axe 4.13's `targetSizeEvaluate` treats only FOCUSABLE WIDGETS overlapping the target as obscurers — a sticky bar's background never counts, its buttons (Clerk UserButton, Sign out, menu toggle) do. So it fires when the page's own scroll (a panel's `scrollIntoView` reveal, a scroll after an error) parks a button straddling the binder-header's controls. The sanitised attachment drops relatedNodes; to see the obscurer, run AxeBuilder `.withRules(["target-size"])` in a throwaway script and print `n.any[].relatedNodes`. NEO-341 fixed it by making binder-header sticky only from `sm` up, with `scroll-padding-top` moved under the same breakpoint in globals.css.

2. **colour-contrast on a Clerk modal** with odd near-palette colours (e.g. muted text and the primary at ~55% strength on ~#090a09). That is Clerk's backdrop + content opacity fade-in sampled mid-animation; at rest the clerkNeonAppearance palette passes. Check `document.getAnimations()` and the ancestor opacity chain before touching colours.

**Why:** both look like palette/layout bugs and invite the wrong fix (recolouring Clerk, nudging one button).
**How to apply:** measure first with a throwaway script (sign in with `/testing/sign-in?redirect=<path>&worker=<n>` on `devices["Pixel 7"]`), and put the fix where the cause is. See [[gates-in-a-shared-worktree]].
