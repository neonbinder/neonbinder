---
name: reference-unlayered-css-beats-tailwind-utilities
description: Feature stylesheets (p2.css, binders.css, cards.css) are unlayered, so their rules beat every Tailwind v4 utility and theme.css signature class regardless of specificity; strip the legacy colours before adding a role/signature class
metadata:
  type: reference
---

Tailwind v4 puts utilities (and `@utility` signatures such as `shelf-ledge`,
`pip-*`, `shadow-offset`) in `@layer utilities`, and `.binder-tab` lives in
`@layer components`. The app's plain feature stylesheets imported from
components (`app/collection/prototypes/p2/p2.css`,
`app/collection/final/binders/binders.css`, `cards/cards.css`, ...) are
UNLAYERED, and unlayered CSS outranks any layered rule whatever the specificity.

Consequences seen in NEO-356 (B2):
- Adding `shelf-ledge` beside `.p2-ledge` did nothing until the gradient and
  box-shadow were deleted from `.p2-ledge` itself (keep only the size there).
- The reverse is useful: a small unlayered class (`.demo-tab-lit`) overrides
  `.binder-tab`'s component-layer colours without `!important`.
- Mode-specific overrides for those feature classes go in the same unlayered
  file as `[data-theme="light"] .p2-page { ... }`; the forced-dark prototypes
  never match them.

Related: [[reference-data-theme-dark-scopes-a-subtree]].
