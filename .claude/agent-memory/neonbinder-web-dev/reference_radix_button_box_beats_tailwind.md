---
name: radix-button-box-beats-tailwind
description: Radix Themes CSS sits in a `radix` cascade layer under Tailwind's utilities (NEO-364), so plain utilities on NeonButton/Radix Button work (min-h, w, flex-1, absolute, hidden); never import Radix's CSS from JS or add `!` for sizing
metadata:
  type: reference
---

`app/globals.css` opens with `@layer theme, base, radix, components, utilities;`
and imports `@radix-ui/themes/styles.css` with `layer(radix)`. Radix therefore
beats Tailwind's preflight (`base`) but loses to every utility, so `min-h-11`,
`w-9`, `flex-1`, `ml-auto`, `absolute`, `lg:hidden`, `rounded-full`, `px-4` on a
NeonButton apply as written. `src/theme/radix-layer.test.tsx` locks the order
and fails if anything imports Radix's stylesheet from JS.

**Why:** until NEO-364, `src/main.tsx` imported Radix's CSS unlayered, and its
`.rt-reset:where(button){all: unset}` plus `.rt-Button` box rules outranked
every layered utility: `min-h-10` rendered 32px, `w-9` 32px, `absolute` stayed
static, `hidden sm:inline-flex` never hid. Call sites piled up `!` suffixes and
`<span className="contents lg:hidden">` wrappers, and many plain utilities sat
inert for weeks. Fixing the layer made them all live at once, so a stale class
can suddenly change a layout (the header's Sign out had an inert
`hidden sm:inline-flex` that would have hidden it on phones).

**How to apply:** write plain utilities on NeonButton; no `!`, no `contents`
wrapper. Radix stays first in the radix layer: never move its import back to
`src/main.tsx`, and never put it below `base` (preflight's `* { padding: 0 }`
would strip every Radix control's padding). Colour is still NeonButton's: the
unlayered `.rt-BaseButton.neon-button` rule beats a `bg-*`/`text-*` utility on
purpose. Our own unlayered CSS (globals.css, feature stylesheets) now beats
Radix on the same element whatever its specificity. When you change an old
class on a Radix element, check it with `getComputedStyle`, since it may have
been dead before. Related: [[radix-scale-overrides-lose-to-radix]],
[[unlayered-css-beats-tailwind-utilities]].
