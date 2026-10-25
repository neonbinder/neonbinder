---
name: radix-button-outside-theme-portal
description: A Radix Themes control (NeonButton, Radix Button) inside a hand-rolled createPortal(document.body) layer renders unpadded (--space-* empty); fix is a prop-less nested <Theme> inside the portal, never portalling into the root Theme element
metadata:
  type: reference
---

Radix's size, radius, spacing and font-size tokens are scoped to `.radix-themes`, not
`:root`. A hand-rolled modal that `createPortal`s to `document.body` sits outside
`src/main.tsx`'s `<Theme>`, so a NeonButton in it computes `padding: 0`, `radius: 0`.
Spot it in a screenshot: a Radix button that looks like a tight coloured label.
Seen NEO-71 (SetSelector dialogs) and NEO-350/359 (collection Overlay, Modal, P3Dialog,
p5 layer — the card drawer's "Add to collection" / "Put it up for sale").

**Fix, in the portal component itself:** wrap the portalled subtree in a prop-less
`<Theme>`. With a parent Theme in React context (portals keep context) it inherits
appearance/accent/radius, toggles `light`/`dark` live, and sets
`data-has-background="false"` so it paints nothing. Never hard-code `appearance="dark"`
(light mode exists since NEO-356).

**Do not portal into the root `.radix-themes` element instead**, even though it looks
simpler: (1) `lib/dom/inert-background.ts` inerts `<body>`'s other children, so a
layer inside `#root` leaves the whole app live behind the modal; (2) the root Theme is
`position: relative; z-index: 0`, a stacking context that traps the layer under any
body-level portal.

**How to apply:** pin it with a test asserting `dialog.closest(".radix-themes")` has
`data-is-root-theme="false"`, its parent is `document.body`, and the render container
is `inert` (`app/collection/prototypes/portal-theme.test.tsx`). Radix's own `Dialog`
portals into a Theme itself and needs none of this.
Related: [[reference_print_paths_and_radix_root_scheme]].
