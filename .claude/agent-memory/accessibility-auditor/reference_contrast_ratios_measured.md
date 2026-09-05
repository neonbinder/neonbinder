---
name: reference-contrast-ratios-measured
description: Verified WCAG contrast ratios for specific color pairs used in this project's dark/light-aware components, so future audits don't have to re-derive them from hex
metadata:
  type: pattern
---

**Note:** MEMORY.md previously pointed at this file with a summary ("real bg is
`#0a0a0a`, tailwind.config.js hex values differ slightly from CLAUDE.md prose;
slate-400/neon-orange pass comfortably, neon-pink passes AA not AAA") but the
file itself was missing when this entry was written (2026-09-05, NEO-236 audit
of `TeamPicker.tsx`). That summary is carried forward below but **not
re-verified this session** — confirm hexes against `tailwind.config.js` /
`globals.css` before relying on it again.

## Carried forward, not re-verified this session
- Page background is `#0a0a0a`, not the `#000` implied by CLAUDE.md's prose.
- `tailwind.config.js`'s neon hex values differ slightly from the values
  written in CLAUDE.md (Primary=#00D558, Cancel=#FF2EB3, Accent=#00B7FF) — use
  the config file as the source of truth, not the doc prose.
- `slate-400` and the neon-orange accent pass comfortably against the real dark
  background.
- Neon pink (`#FF2EB3`) passes AA but not AAA on the dark background.

## Verified this session (`TeamPicker.tsx`'s popover, `bg-white dark:bg-gray-800`)
Popover container is `bg-white dark:bg-gray-800` — an explicit local surface,
independent of the page's `#0a0a0a` background above. Measured against
`#FFFFFF` (light) / `#1F2937` = Tailwind `gray-800` (dark):

| Classes | Light (on #FFFFFF) | Dark (on #1F2937) | Verdict |
|---|---|---|---|
| `text-gray-600 dark:text-gray-400` | 7.85:1 | 4.87:1 | Pass AA normal text (both) |
| `text-gray-900 dark:text-gray-100` | ~17.7:1 | ~13.3:1 | Pass AA/AAA, large margin |
| `text-[#C2178A] dark:text-[#FF6FCB]` (error text, NOT the `#FF2EB3` brand pink) | 5.55:1 | 5.87:1 | Pass AA normal text (both) |
| `text-gray-500` (do not use here) | ~2.8:1 on `gray-800` | — | **Fails** — recurring gray-500-on-dark bug, already called out in the file's own comments |

**Recurring bug to watch for:** `text-gray-500` on a `dark:bg-gray-800`
surface fails 1.4.3 (~2.8:1). `gray-600`/`gray-400` is the validated
light/dark substitute pair for this exact popover surface — reuse it rather
than re-deriving, and flag any new `text-gray-500` on a dark surface on sight.

**Note the surface split:** the popover's own chrome (`bg-white
dark:bg-gray-800`) tracks the light/dark theme, but the `Input` primitive's
`bare` mode still applies `BASE_INPUT` unconditionally — `bg-slate-900
text-slate-100`, hardcoded regardless of theme (see the primitive's own
comment: "a hardcoded surface needs a hardcoded foreground"). So every text
`<Input bare>` inside this popover renders as a dark navy box floating on the
white/gray-800 popover chrome in *both* themes — by design, not a bug, and
already true of the pre-existing search box before NEO-236 added two more
fields with the same styling.

## Verified this session (`EntityReviewWizard.tsx`'s dialog, `bg-gray-900`, dark-only — no light variant)

The wizard dialog card is `bg-gray-900` (Tailwind default `#111827`), not the
`dark:bg-gray-800` popover surface above — slightly darker, same failure mode.
Computed (not measured with a tool, but via the standard WCAG relative
luminance formula):

| Classes | On `#111827` | Verdict |
|---|---|---|
| `text-gray-500` (#6B7280) | ≈3.67:1 | **Fails** SC 1.4.3 for normal/small text (needs 4.5:1) |
| `text-gray-400` (#9CA3AF) | ≈6.98:1 | Pass AA with margin |
| `text-[#FF2EB3]` (brand pink refusal text) | ≈5.32:1 | Pass AA normal text |

Same recurring bug as the `dark:bg-gray-800` popover: `text-gray-500` fails on
`bg-gray-900` too — this is now confirmed on two distinct dark surfaces in
this app, so treat "gray-500 on any dark gray-9xx/8xx surface" as failing by
default and reach for `gray-400` (text) or `gray-600`/`gray-400` (the
light/dark pair, on a surface that has both) without re-deriving.
