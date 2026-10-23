---
name: tailwind-js-config-colours-are-inlined
description: Tailwind 4 inlines tailwind.config.js colours (neon-*) as literal hex; only @theme colours compile to var(--color-*) and can be re-pointed by CSS variables
metadata:
  type: reference
---

In apps/web, Tailwind 4 loads `tailwind.config.js` through `@config`. Colours
defined there (the `neon-*` family) compile to literal hex in every utility
(`.bg-neon-blue { background-color: #00C2FF }`), while Tailwind's default
palette (`gray-*`, `slate-*`, `white`, `black`) compiles to
`var(--color-…)`. So a theme made of variable overrides cannot reach a neon
utility unless the colour is also declared in a CSS `@theme { --color-neon-blue: … }`
block; after that the utility (and its `/opacity` variants via color-mix) uses
the variable. Arbitrary values (`ring-[#00C2FF]`, `hover:bg-[#33e07c]`) never
become variables; override them with scoped selectors.

**Why:** found building the light-theme prototypes (`app/collection/light`);
verify with `curl http://localhost:<port>/app/globals.css?direct` and grep the
utility.

**How to apply:** any re-theming, per-section recolouring or runtime colour
switch: check the compiled utility first. Related: [[reference_runtime_colour_needs_a_per_theme_split]].
