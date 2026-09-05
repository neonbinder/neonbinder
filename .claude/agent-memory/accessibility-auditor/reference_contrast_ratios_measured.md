---
name: reference-contrast-ratios-measured
description: Measured WCAG contrast ratios for this project's actual neon/slate hex values against its real dark backgrounds — reuse instead of recomputing or guessing
metadata:
  type: reference
---

Page background in dark mode is `#0a0a0a` (apps/web/app/globals.css `--background`
under the dark media query), NOT pure black and NOT `bg-slate-950` — use this,
not the CLAUDE.md "Primary=#00D558 / Cancel=#FF2EB3 / Accent=#00B7FF" doc colors,
as the ground truth for the ground color. Tailwind config
(`apps/web/tailwind.config.js`) is the ground truth for the neon hex values —
it disagrees slightly with CLAUDE.md's docs: config has `neon-pink: #FF2E9A`
(not `#FF2EB3`) and `neon-blue: #00C2FF` (not `#00B7FF`). Always read
`tailwind.config.js` directly rather than trusting the prose doc.

Measured (relative-luminance method, WCAG formula), admin master-list row
surfaces in `TeamManagement.tsx` / similar:

| Foreground | Background | Ratio | Verdict |
|---|---|---|---|
| `text-slate-400` #94a3b8 | `#0a0a0a` (idle row) | ~7.73:1 | AA + AAA pass |
| `text-slate-400` #94a3b8 | `bg-slate-900` #0f172a (hover fill) | ~6.97:1 | AA + AAA pass |
| `text-slate-400` #94a3b8 | `bg-neon-purple/10` (#A44AFF @10%) over `#0a0a0a` ≈ rgb(25,16,35) | ~7.19:1 | AA + AAA pass |
| `text-neon-orange` #FF9E00 | same three backgrounds above | ~8.6–9.6:1 | AA + AAA pass (also clears the 3:1 non-text floor easily) |
| `text-neon-pink` #FF2E9A | `#0a0a0a` (detail panel surface) | ~5.76:1 | AA pass, AAA (7:1) fails |

Takeaway for this codebase: `text-slate-400` metadata lines and `text-neon-orange`
state glyphs on the dark admin surfaces are NOT a contrast risk — they clear AA
by a wide margin even composited under the low-alpha neon selection tints. Don't
flag them reflexively just because "neon on dark" is the named risk category;
verify the actual composited color before writing a finding.
`text-neon-pink` is the one worth double-checking case by case: it clears AA
(4.5:1) but not AAA, so if a future review target becomes AAA, revisit it, and
recompute if it's ever placed on a lighter panel surface than `#0a0a0a`.

Compositing `bg-color/opacity` Tailwind utilities: browsers do the alpha blend
in the encoded (non-linear) sRGB values, i.e. `result = alpha*fg + (1-alpha)*bg`
per channel in 0–255 space, THEN that composited sRGB triple gets linearized
for the luminance formula — don't linearize the two layers separately and then
blend.
