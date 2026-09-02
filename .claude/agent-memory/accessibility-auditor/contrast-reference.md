---
name: contrast-reference
description: Measured WCAG contrast ratios for NeonBinder's neon palette and slate grays against the app's actual dark backgrounds — use before re-deriving these by hand
metadata:
  type: project
---

Actual token values live in `apps/web/tailwind.config.js` (verify before trusting
this — CLAUDE.md's doc comment for neon-pink says #FF2EB3, the tailwind config
itself says #FF2E9A; the config is authoritative for rendered contrast).

## Ratios against dark backgrounds (slate-950 #020617, slate-900 #0f172a, slate-800 #1e293b, black)

All computed with the standard WCAG relative-luminance formula. Full method: see
the python snippet pattern below if these need re-checking after a palette change.

| Color | Hex | vs slate-950 | vs slate-900 | vs slate-800 | Passes 4.5:1 normal text? |
|---|---|---|---|---|---|
| neon-green | #00D558 | 10.24 | 9.06 | 7.42 | Yes, comfortably |
| neon-yellow | #FFE600 | 15.92 | 14.09 | 11.54 | Yes, comfortably |
| neon-blue | #00C2FF | 9.76 | 8.64 | 7.08 | Yes, comfortably |
| neon-pink | #FF2E9A | 5.87 | 5.19 | 4.26 | Yes vs -950/-900; borderline/fails vs -800 |
| neon-purple | #A44AFF | 4.80 | 4.25 | 3.48 | Only vs black/-950; fails as normal text vs -900/-800 (large-text/non-text 3:1 only) |
| slate-400 | #94a3b8 | 7.87 | 6.96 | 5.71 | Yes |
| slate-500 | #64748b | 4.24 | 3.75 | 3.07 | **No** — this is the recurring bug, see below |
| slate-600 | #475569 | 2.66 | 2.36 | 1.93 | **No, badly** |

## The recurring bug: `text-slate-500` / `text-slate-600` used for secondary text

Found repeatedly in `apps/web/app/print/placeholders/*.tsx` (figcaptions,
filenames, hint text, job-id display) — these two grays read as "a little
dimmer than slate-400" in the editor but fail 1.4.3 against every dark
background actually used in this app (3.07–4.24:1 for slate-500, 1.93–2.66:1
for slate-600; both need 4.5:1). **The fix used every time: swap to
`text-slate-400`** (5.71–7.87:1, comfortable pass) — it's still visibly a muted
secondary color, just legible. Grep `text-slate-500\b` and `text-slate-600\b`
in any new placeholder/print code as a first pass.

## Opacity compounds this

`opacity-60` (or similar) applied to a container pushes even *passing* colors
toward failure — e.g. neon-green text inside an `opacity-60` wrapper over
slate-900 drops to ~3.97:1 (fails). Check contrast on the *effective* blended
color when a finding involves a dimmed/excluded/disabled state, not just the
undimmed token value.

## White/black text on neon backgrounds (buttons) — see [[neonbutton-contrast-defect]]

White text on `#00C2FF` (secondary/blue) = **2.07:1**. White text on `#FF2E9A`
(cancel/pink) = **3.44:1**. Both fail 4.5:1 for normal-size button text. Black
text on `#00D558` (primary/green) = 10.66:1, fine.

## Tailwind v4 default `gray-*` scale (OKLCH-defined) — resolved sRGB hex

This app also uses plain Tailwind `gray-*` (not `slate-*`) in some components
(e.g. `apps/web/components/SetSelector/sync-review-modal.tsx`,
`CardPairingModal.tsx`). Tailwind v4's theme defines these in OKLCH
(`node_modules/tailwindcss/theme.css`), not hex, so they need conversion before
computing contrast. Resolved once (NEO-203 audit) via a manual OKLCH→sRGB
implementation — reuse these rather than re-deriving:

| Token | OKLCH | sRGB hex |
|---|---|---|
| gray-100 | 96.7% 0.003 264.542 | #f3f4f6 |
| gray-300 | 87.2% 0.01 258.338 | #d1d5dc |
| gray-400 | 70.7% 0.022 261.325 | #99a1af |
| gray-500 | 55.1% 0.027 264.364 | #6a7282 |
| gray-700 | 37.3% 0.034 259.733 | #364153 |
| gray-800 | 27.8% 0.033 256.848 | #1e2939 |
| gray-900 | 21% 0.034 264.665 | #101828 |
| cyan-900 | 39.8% 0.07 227.392 | #104e64 |
| cyan-100 | 95.6% 0.045 203.388 | #cefafe |

`gray-500` vs opaque `gray-900` = **3.67:1** — fails 4.5:1, same recurring
pattern as `slate-500` above but on the OTHER gray scale. `gray-400` vs
`gray-900` = 6.82:1, passes. **Same fix applies: swap `text-gray-500` →
`text-gray-400`.** Found live in `sync-review-modal.tsx` (5 occurrences, all
fixed in the NEO-203 audit) — check both `slate-500\b` and `gray-500\b` (and
the `-600` variants of each) whenever auditing new dark-theme UI here.

## Chained opacity where text and background SHARE a hue — opacity direction reverses

Normal chained-opacity intuition (see
[[nested-opacity-contrast-and-radiogroup]]) is "less background opacity means
more of the (darker) container shows through, so contrast against light text
goes UP." That reverses when the background tint is the SAME color as the
text — e.g. `bg-[#FF2EB3]/NN text-[#FF2EB3]` (a colored badge with matching
text, as in `sync-review-modal.tsx`'s "needs review" tier-1 badge). There,
*raising* the opacity drags the badge background toward the text's own hue,
so contrast *falls* as opacity increases (at `/20` it was 3.99:1 — fails; at
opacity 0, i.e. no tint at all, it's ~4.95:1 — the ceiling). The fix is to
LOWER the opacity, not raise it: `/10` measured 4.55:1, clearing 4.5:1 with a
small margin. Always check which direction opacity is pushing contrast when
text and its background tint are literally the same hex — it is not always
"more opacity = worse" or "more opacity = better," it depends on whether text
and background are moving toward or away from each other in color space.

## Open question, not yet resolved

`apps/web/app/globals.css` sets `body` background via `--background` which is
white (`#ffffff`) unless `prefers-color-scheme: dark` matches — there is no
forced-dark class anywhere found in `src/layouts/*.tsx` or `src/main.tsx`. If a
user's OS is in light mode, the ambient page background could be white while
every component still hardcodes light-on-dark text colors (slate-200/300/400,
neon-*). Every contrast finding in this file assumes the dark background is
what actually renders (consistent with CLAUDE.md calling this a fixed dark
theme, and with how every component already styles its own boxes as if the
canvas were dark). Flagged as a caveat, not chased down — worth a real
investigation the next time contrast is audited, since the whole premise of
"neon on dark passes" depends on it.
