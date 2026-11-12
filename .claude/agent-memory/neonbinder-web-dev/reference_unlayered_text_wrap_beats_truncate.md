---
name: unlayered-text-wrap-beats-truncate
description: app/globals.css sets `text-wrap: pretty|balance` on p/li/h* OUTSIDE any @layer, so it beats Tailwind's layered `truncate` (white-space: nowrap) — a `<p className="truncate">` wraps instead of clipping; long-name overflow needs min-w-0 + wrap-anywhere, not truncate
metadata:
  type: reference
---

`app/globals.css` declares `:where(p, li, dd, blockquote) { text-wrap: pretty }`
and `:where(h1..h6) { text-wrap: balance }` after `@layer theme, base, radix,
components, utilities;`, but not inside a layer. Unlayered rules beat every
layered rule whatever the specificity, so the comment there ("zero specificity,
so any utility still wins") is wrong. `text-wrap` is a shorthand that sets
`text-wrap-mode: wrap`, which overrides `.truncate`'s `white-space: nowrap`.
Seen in NEO-499: the Set Builder breadcrumb `<p className="truncate" title=…>`
wrapped onto four lines on a phone instead of clipping with an ellipsis.

**How to apply:** for a long unbroken name (set names can be one 200-char
token) use WizardChrome's pattern, `min-w-0 wrap-anywhere` on the text and
`min-w-0` on every flex ancestor, plus `shrink-0` on any icon beside it. Don't
count on `truncate` on a p/li/heading. Moving that globals block into
`@layer base` would restore truncation across the app (about 15 files use
`truncate` on such elements), so that is a separate, app-wide change.

Measure overflow with a throwaway spec that compares
`documentElement.scrollWidth` with `clientWidth`. A shipped spec may not call
`evaluate` (GUIDE hard rule 8), so it proves the result with `boundingBox()`
against `page.viewportSize()` instead.

Related: [[e2e-viewport-is-the-ux-constraint]], [[caption-under-an-image-never-widens-it]].
