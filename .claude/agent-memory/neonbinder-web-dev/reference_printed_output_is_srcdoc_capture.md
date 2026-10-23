---
name: printed-output-is-srcdoc-capture
description: How to prove a Print Shop change left the printed output unchanged - capture the print iframe's srcdoc / QR popup HTML, not a page screenshot
metadata:
  type: reference
---

Every Print Shop tool (shipping label, blackout, placeholder sheets, spine
labels) prints through `lib/print/print-html.ts`: a hidden iframe whose
`srcdoc` is inline-styled markup plus explicit CSS; the app stylesheet never
loads there. The QR tool `document.write`s a popup. So the theme, Tailwind
classes and `globals.css`'s `@media print` cannot reach the paper.

To prove "printed output unchanged" (theme work, refactors):
- `addInitScript` that wraps the `HTMLIFrameElement.prototype.srcdoc` setter
  and stubs `window.open` to collect the HTML, click each Print button, then
  hash the HTML and `setContent` it on a fresh page with
  `emulateMedia({ media: "print" })` and compare screenshots. Compare against
  a Vite run from the `main/` reference checkout on another port.
- The QR popup has no `color-scheme`, so its render follows the CONTEXT's
  `colorScheme` (dark gutters in a dark context). Compare like with like.
- Only the collection need list prints the page itself (`window.print`,
  pinned black-on-white by `cards.css` `!important` rules); print-emulate
  that page.

**Why:** a page screenshot under print emulation shows the chrome, which is
not what reaches the printer; srcdoc equality is the actual proof (NEO-356 B4).
**How to apply:** any change near app/print, lib/print or the print modules.
Related: [[gates-in-a-shared-worktree]]
