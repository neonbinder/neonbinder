---
name: radix-scale-overrides-lose-to-radix
description: Radix Themes sets its scales (--green-9, --color-background, --focus-8) on the Theme element itself, so an override on <html> never reaches a Radix component; override on the Theme element and probe computed values
metadata:
  type: reference
---

Radix sets its scales on the Theme element itself (`.dark, .dark-theme {...}`,
`:root, .light, .light-theme {...}`), its `--color-background`/`--color-panel-solid`
on `:is(.dark) :where(.radix-themes)`, and `--focus-8` on `[data-accent-color]`.
A globals.css rule on `<html>` (`[data-theme="dark"] { --green-9 }`) is
redefined by the Theme element below it, so it never reaches a Radix
component. Since NEO-364 Radix sits in a `radix` cascade layer, so an
unlayered rule of ours beats it on the SAME element whatever the specificity
(see [[radix-button-box-beats-tailwind]]); before that, Radix loaded after
globals.css unlayered and won equal-specificity ties too. Measured after
NEO-364: `--green-9` on `<html>` is now our `#00d558`, on the Theme element
still Radix's `#30a46c`. Measured in NEO-356 with getComputedStyle on
`.radix-themes[data-is-root-theme]`: `--green-9` was Radix's `#30a46c`, not the
`#00d558` the remap in globals.css (and DESIGN.md) claimed; `--color-background`
was Radix's sage `#101211`.

**How to apply:** to really override a Radix variable, out-specify it on the
element Radix sets it on, e.g. `[data-theme] :is(.radix-themes, [data-accent-color]) { --focus-8: var(--focus) }`
(0,2,0), or `[data-theme="light"] .radix-themes { --color-background: ... }`.
Verify with a computed-style probe, not by reading the CSS. Variables Radix
defines only on `:root` (`--pink-contrast`) are beaten by `html:root`.
Related: [[print-paths-and-radix-root-scheme]].
