---
name: reference-data-theme-dark-scopes-a-subtree
description: NEO-356 theme roles can be pinned dark for one subtree with data-theme="dark" (theme.css selects `:root, [data-theme="dark"]`); light-only signatures still match via the html ancestor
metadata:
  type: reference
---

`app/theme.css` declares the dark role values on `:root, [data-theme="dark"]`, so
putting `data-theme="dark"` on any element re-scopes every role (`text-ink`,
`bg-surface`, `--focus`, opacity mixes like `border-ink/10`) to dark for its
descendants, with no `dark:` variant and no allowlist entry. Used in NEO-356 for
fixed-dark scenes inside a light page: the /binder-tracking "Take it for a spin"
night shelf and the seller storefronts `/u/:username` and `/u/:username/sale`
(user brand colours with white ink).

Caveats:
- Signatures written as `[data-theme="light"] &` (shadow-offset, `.binder-tab`
  light rules) still match inside the scope, because `<html>` is the light
  ancestor. Do not use them inside a dark scope.
- `useTheme().mode` stays "light" inside the scope, so `BrandMark`/`PullingLogo`
  pick the light Mark there; use the PNG directly in a dark scope.
- Radix colour scales are also keyed on `[data-theme="dark"]`, so they re-scope too.

Related: when screenshotting through `/testing/sign-in?redirect=/dashboard`,
Playwright's `waitForURL("**/dashboard")` matches the sign-in URL itself (the
glob sees the query string); wait on `u.pathname === "/dashboard"` instead.
