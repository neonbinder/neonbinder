---
name: print-only-region-has-specificity
description: A "print only this region" sheet keyed on body:has([data-x]) * hides the region too unless the visible rule carries the same :has() prefix; Playwright fullPage screenshots under emulateMedia print come out blank
metadata:
  type: reference
---

NEO-350 prototype 3's need list prints alone via `visibility` in `@media print`.
`body:has([data-p3-print]) * { visibility: hidden !important }` is (0,1,1);
a plain `[data-p3-print] * { visibility: visible !important }` is (0,1,0), so
the hide rule wins and the page prints blank. Prefix the visible rules with the
same `body:has([data-p3-print])` so they win on order.

Checking it: `page.emulateMedia({ media: "print" })` then a **viewport**
screenshot (or `page.pdf`) shows the print sheet; a `fullPage: true` screenshot
under print emulation came out all white even with the rules correct. Probe
`getComputedStyle(...).visibility` before believing a blank capture.

Related: [[print-paths-and-radix-root-scheme]], [[static-markup-visual-check]]
