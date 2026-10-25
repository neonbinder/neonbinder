---
name: scroll-on-focus-swallows-mouse-clicks
description: An onFocus handler that scrolls the page eats mouse clicks (focus fires between mousedown and mouseup); gate it on :focus-visible — final/binders/trayClear.ts
metadata:
  type: reference
---

A mouse press focuses its control between mousedown and mouseup. Any
`onFocus` that scrolls (NEO-359: `keepClearOfTray`, which lifted a control out
from under the pinned pack tray for WCAG 2.4.11) moves the control from under
the pointer, the mouseup lands elsewhere and the click never fires. It is
intermittent (3 of 16 tries on a spine), so E2E reads it as a flake.

**How to apply:** scroll-on-focus helpers act only on keyboard focus:
`isKeyboardFocus(el)` in `apps/web/app/collection/final/binders/trayClear.ts`
(`el.matches(":focus-visible")`, falling back to a pointer/key modality tracker
where the pseudo-class throws). happy-dom answers `:focus-visible` true after
`.focus()`, so a unit test must stub `el.matches` to model a mouse press.
Related: [[focus-centres-and-scroll-margins-add]].
