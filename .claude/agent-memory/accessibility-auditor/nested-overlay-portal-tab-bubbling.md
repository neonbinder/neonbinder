---
name: nested-overlay-portal-tab-bubbling
description: An Overlay (or any portalled dialog with a root onKeyDown Tab trap) rendered as a React CHILD of another Overlay gets its Tab keydowns re-handled by the outer trap via React portal bubbling — Tab goes dead inside the inner dialog; also translucent notice-danger-bg over a photo fails contrast
metadata:
  type: project
---

React synthetic events bubble through the React tree, not the DOM tree, so a portalled
dialog mounted inside another portalled dialog's children sends every keydown to the
outer dialog's handlers too. `app/collection/prototypes/p1/Overlay.tsx`'s Tab trap
computes `inside = panel.contains(active)` (DOM), which is false for the inner dialog's
controls, so `!lies(...)` is true and it `preventDefault`s every Tab, then tries to focus
its own first control, which is `inert` (no-op). Net effect: Tab does nothing in the inner
dialog. Found in NEO-481 (CardPhotoViewer opened from CopyPhotosField/LineThumb inside
CardDrawer, and HeldPhotosField inside RequestCardDialog). Verified with a scratch vitest:
the same viewer mounted as a React SIBLING of the drawer Overlay leaves Tab un-prevented.

**Why:** unit tests wrap the inner dialog in a plain `<div onKeyDown>`, which only checks
Escape; nothing exercises Tab with a real outer Overlay.

**How to apply:** whenever a diff mounts a dialog from inside an Overlay's children, check
both where it is in the React tree and every ancestor key handler. Fix at the Overlay:
`if (!panelRef.current?.contains(e.target as Node)) return;` at the top of its onKeyDown
(covers Escape too), or mount the inner dialog as a sibling (RealAddCardsTab's pattern).
Escape is safe only because the inner dialog calls `stopPropagation`.

Contrast side note from the same audit: `bg-notice-danger-bg` is 30% translucent in dark
mode; as a chip over a photo, notice-danger-ink measures 1.24:1 over white pixels (3.84
over mid-grey). Give an over-photo chip an opaque ground. Related: [[nested-dialog-focus-trap]],
[[patterns_modal_dialog]], [[contrast-reference]].
