---
name: radix-scale-overrides-lose-to-radix
description: Radix Themes' own `.dark`/`.light`/`[data-accent-color]` variable rules load after globals.css and win at equal specificity on the Theme element; a (0,1,0) override of --green-9, --color-background or --focus-8 is dead code
metadata:
  type: reference
---

`src/main.tsx` imports `app/globals.css` BEFORE `@radix-ui/themes/styles.css`,
and both are unlayered. Radix sets its scales on the Theme element itself
(`.dark, .dark-theme {...}`, `:root, .light, .light-theme {...}`), its
`--color-background`/`--color-panel-solid` on `:is(.dark) :where(.radix-themes)`,
and `--focus-8` on `[data-accent-color]`. A globals.css rule with the same
selector shape (0,1,0) loses on source order, so it never reaches a Radix
component. Measured in NEO-356 with getComputedStyle on
`.radix-themes[data-is-root-theme]`: `--green-9` was Radix's `#30a46c`, not the
`#00d558` the remap in globals.css (and DESIGN.md) claimed; `--color-background`
was Radix's sage `#101211`.

**How to apply:** to really override a Radix variable, out-specify it on the
element Radix sets it on, e.g. `[data-theme] :is(.radix-themes, [data-accent-color]) { --focus-8: var(--focus) }`
(0,2,0), or `[data-theme="light"] .radix-themes { --color-background: ... }`.
Verify with a computed-style probe, not by reading the CSS. Variables Radix
defines only on `:root` (`--pink-contrast`) are beaten by `html:root`.
Related: [[print-paths-and-radix-root-scheme]].
