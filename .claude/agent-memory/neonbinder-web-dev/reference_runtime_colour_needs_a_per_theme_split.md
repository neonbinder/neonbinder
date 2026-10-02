---
name: runtime-colour-needs-a-per-theme-split
description: A data-driven colour (team livery) on a `bg-white dark:bg-gray-800` surface can never pass 4.5:1 in both themes with one hex — decide per theme and feed two CSS custom properties
metadata:
  type: reference
---

Tailwind 4's `dark:` here is the `prefers-color-scheme` media variant, while
Radix is forced `appearance="dark"` — so a popover written
`bg-white dark:bg-gray-800` really renders WHITE for a light-OS user. Any
runtime colour (team `primaryColor`) shown on it must be checked per theme.

No single hex clears 4.5:1 on both white (needs L <= ~0.18) and gray-800
(needs L >= ~0.26), so "use it only if it passes both" silently drops every
colour. Decide each theme independently and render:

```tsx
style={{ "--livery-light": light, "--livery-dark": dark } as CSSProperties}
className={`${light ? "text-[color:var(--livery-light)]" : "text-gray-700"} ${
  dark ? "dark:text-[color:var(--livery-dark)]" : "dark:text-gray-300"}`}
```

Check every surface the row sits on in that theme: base, hover
(`gray-100` / `gray-700`), and translucent highlights composited over the base
(`bg-[#00D558]/20` has no dark split). Tailwind 4 grays are oklch — use
gray-800 ~ `#1e2939`, gray-700 ~ `#364153`, not the v3 hexes.
`PlayerPicker`'s `liveryColors` (NEO-313) is the worked example.
