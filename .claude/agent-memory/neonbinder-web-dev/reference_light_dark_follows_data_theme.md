---
name: light-dark-follows-data-theme
description: CSS light-dark() in a Tailwind arbitrary value follows NB's light/dark mode (theme.css sets color-scheme per data-theme) — the escape hatch for a colour with no role, plus two role gaps hit in NEO-356
metadata:
  type: reference
---

`app/theme.css` sets `color-scheme: light|dark` on `[data-theme]`, so CSS
`light-dark(A, B)` resolves per NB mode. Written as
`bg-[color:light-dark(oklch(93.2%_0.032_255.585),oklch(37.9%_0.146_265.522))]`
it passes `theme/no-raw-palette` (no hex, no `dark:`). Use oklch literals, not
`var(--color-blue-100)`: Tailwind 4 may not emit a palette var nothing else uses.
Used for the set picker's per-column selection fills (NEO-356), where every
column has its own hue and no role exists. It is an inline role, so flag it to
the coordinator as a token candidate rather than spreading it.

Role gaps worth knowing (dark values):
- `bg-hover` equals `bg-raised` (both gray-800). A row on a raised popover
  that used `hover:bg-gray-700` loses its hover entirely with `hover:bg-hover`;
  `hover:bg-rule-strong` (slate-700) keeps dark as it was.
- Neon as a BORDER or state ring fails 3:1 on white. `border-neon-X-text`
  is the fill in dark and the deepened hue in light, so it is a drop-in;
  `border-selection` / `ring-selection` for the cyan selected state.

Related: [[runtime-colour-needs-a-per-theme-split]].
