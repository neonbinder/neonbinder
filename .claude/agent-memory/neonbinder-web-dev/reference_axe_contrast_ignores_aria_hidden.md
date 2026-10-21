---
name: axe-contrast-ignores-aria-hidden
description: axe-core 4.13 color-contrast measures text under aria-hidden and role="img" too (excludeHidden:false); a user-chosen-colour preview must be a real <img>, not hidden DOM text
metadata:
  type: reference
---

axe-core 4.13 `color-contrast` has `excludeHidden: false`, and `color-contrast-matches`
skips only: option/empty select/non-text inputs, disabled or `inert` subtrees, nodes
with no direct text-node child, zero font-size, and text clipped/off-screen. It does
NOT skip `aria-hidden="true"` or `role="img"` subtrees — contrast is a sighted-user
criterion. Verified by reading `node_modules/axe-core/axe.js` and in Chromium (NEO-350).

So a live preview of colours the user picked (spine label designer) fails axe whenever
the user picks a low-contrast pair, even inside `aria-hidden`. `inert` would silence
it but is an exclusion in disguise. The WCAG-grounded fix is to make the preview a
picture: `<img alt>` of an SVG `data:` URL whose `<foreignObject>` holds the same
print markup (1.4.3 "part of a picture", 1.4.5 "essential"). See
`lib/print/spine-preview-image.ts`.

**How to apply:** a swatch/preview showing user-chosen text colours → render as an
image with an alt. An SVG image fetches nothing: embed fonts as `data:` URIs, and
re-serialize HTML through DOMParser + XMLSerializer — malformed attributes (e.g. a
`"` inside `style="..."`) yield invalid XML and a broken image (naturalWidth 0).
Component tests then need a `vi.stubGlobal("fetch")` for the font files (NEO-188 guard).
Related: [[neon-contrast-ink-and-axe-text-shadow]].
