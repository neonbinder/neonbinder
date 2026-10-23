---
name: runtime-colour-needs-a-per-theme-split
description: A data-driven colour (team livery) can never pass 4.5:1 on both a light and a dark surface with one hex — since NEO-356, decide for the current mode via useTheme().mode + tokens.ts surfaces
metadata:
  type: reference
---

No single hex clears 4.5:1 on both white (needs L <= ~0.18) and graphite
gray-800 (needs L >= ~0.26), so "use it only if it passes both" silently drops
every colour. Decide for the mode the page is in.

Since NEO-356 (roles + `<html data-theme>`), the pattern is:

```tsx
const { mode } = useTheme();                       // src/theme/ThemeProvider
const ground = tokenHex("raised", mode);           // src/theme/tokens.ts
const color = passes(hex, ground) ? hex : null;
<span className={color ? undefined : "text-ink-2"} style={color ? { color } : undefined}>
```

Check every surface the row sits on in that mode: base, hover, and
translucent highlights composited over the base (`bg-neon-green/20`).
`useTheme()` outside a provider reads `<html data-theme>` (dark by default), so
a unit test sets `document.documentElement.dataset.theme` per case.
Worked examples: `PlayerPicker` `liveryColor`, `TeamsOnCardsSection`
`liveryTextColor`, `SetAttributesPanel` `teamTextColor`.

The pre-NEO-356 version used two CSS vars and a `dark:` pair; `dark:` is now
banned by `theme/no-raw-palette`. See [[light-dark-follows-data-theme]].
