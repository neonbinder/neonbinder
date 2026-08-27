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
