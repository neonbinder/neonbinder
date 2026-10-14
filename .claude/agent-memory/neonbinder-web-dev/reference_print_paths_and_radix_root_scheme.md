---
name: print-paths-and-radix-root-scheme
description: Real printing goes through isolated srcdoc/popup documents that never load globals.css; a :root override in globals.css loses to Radix's later :root color-scheme rule — use html:root
metadata:
  type: reference
---

Every Print button in apps/web prints an ISOLATED document: `lib/print/print-html.ts`
`printHtmlDocument` (srcdoc iframe; labels, shipping, placeholders, spine) and the QR
page's `window.open` popup. Neither loads `app/globals.css`, so a theme change to the
app (NEO-341 made it dark-only) cannot reach the paper; `buildDocument` pins
`color-scheme: light` and black-on-white itself, with a unit test. Measured in Chromium:
even before that pin, a srcdoc iframe inside the dark page resolved `prefers-color-scheme`
to light and black text, so the pin is defensive, not a fix for a live bug.

`globals.css`'s `@media print` block only covers Ctrl+P of the page itself. Radix's
stylesheet is imported AFTER globals.css (src/main.tsx) and sets `color-scheme: dark`
on `:root:where(:has(.radix-themes[data-is-root-theme]...))` and on
`.radix-themes:where(.dark)`, both (0,1,0). A bare `:root` override loses on source
order; `html:root` and `:root .radix-themes` win. Verify with
`page.emulateMedia({ media: "print" })` + `getComputedStyle(documentElement).colorScheme`.

Tailwind light-text classes (`text-slate-300` etc.) still print pale on a Ctrl+P'd
screen; operator and marketing screens are not print surfaces, so no `!important` reset.

Related: [[reference_playwright_default_light_scheme_breaks_dark_variants]],
[[reference_static_markup_visual_check]].
