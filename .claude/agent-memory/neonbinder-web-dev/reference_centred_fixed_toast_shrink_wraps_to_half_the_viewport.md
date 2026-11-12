---
name: centred-fixed-toast-shrink-wraps-to-half-the-viewport
description: A `fixed left-1/2 -translate-x-1/2` toast shrink-wraps to 50vw, so a max-w cap never binds and long text wraps in a half-width box; use a `fixed inset-x-4 flex flex-col items-center` band with the box `max-w-full wrap-anywhere`
metadata:
  type: reference
---

A fixed box positioned `left-1/2 -translate-x-1/2` gets its shrink-to-fit
width from the space between `left: 50%` and the right edge, i.e. half the
viewport. `max-w-[calc(100vw-2rem)]` on it never binds, so a toast quoting a
long name wraps in a box about 187px wide on a 375px phone (accessibility
auditor, NEO-499).

Pattern: the outer wrapper is the band, the inner element is the box.

- Wrapper: `pointer-events-none fixed inset-x-4 top-20 z-50 flex flex-col items-center`
  (`flex-col` so two always-mounted live regions still stack).
- Live-region divs (if any): `max-w-full`. Keep them always mounted.
- Box: `max-w-full wrap-anywhere px-4 py-2 …`.

Measured at 375px: the box grows to 343px (the band) and wraps inside it.
Used in SetAttributesPanel and EntityColumn (identical wrappers; change both).

Companion: when only the name lines of a form should break anywhere, put
`wrap-anywhere` on those lines, not the form, or button labels break
mid-word too. See [[unlayered-text-wrap-beats-truncate]].

Top-aligning a wrapped name's neighbours without moving one-line rows: use
`items-start` and nudge each small item to centre on the 24px first line
(`mt-0.5` for a 20px pill or `h-5` icon, `mt-1` for a 16px `text-xs` line).
Measured centres matched `items-center` exactly on one-line rows.
