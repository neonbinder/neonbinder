---
name: axe-contrast-ignores-aria-hidden
description: axe-core 4.13 color-contrast measures text under aria-hidden and role="img" too; a preview of user-chosen colours fails it, and the answer is not to scan that state, never to change the product
metadata:
  type: reference
---

axe-core 4.13 `color-contrast` has `excludeHidden: false`, and `color-contrast-matches`
skips only: option/empty select/non-text inputs, disabled or `inert` subtrees, nodes
with no direct text-node child, zero font-size, and text clipped/off-screen. It does
NOT skip `aria-hidden="true"` or `role="img"` subtrees. Verified by reading
`node_modules/axe-core/axe.js` (NEO-350).

So a live preview of colours the user picked (the Print Shop spine-label designer)
fails axe whenever the user picks a low-contrast pair, even inside `aria-hidden`.

**How to apply:** do not change the product to satisfy that scan. Jason, NEO-350:
rewriting the print preview (SVG `<img>` of the sheet) just to pass a test was
"a product change just for testing purposes" on a page whose job is faithful
physical printing; it was reverted. The page already warns about low contrast; an
E2E asserts the warning and runs `expectAccessible` only on the page's default
colours. Related: [[neon-contrast-ink-and-axe-text-shadow]].
