---
name: radix-button-outside-theme-portal
description: A Radix Themes control (NeonButton, Radix Button) inside a hand-rolled modal that createPortal()s to <body> renders unpadded and unstyled, because Radix tokens live on the app's .radix-themes root; wrap the portalled content in a nested <Theme hasBackground={false}>
metadata:
  type: reference
---

Seen on NEO-350: the collection prototypes' `Modal` (`app/collection/prototypes/p2/Modal.tsx`)
portals to `document.body`, outside `src/main.tsx`'s `<Theme>`. A shared section that
used `NeonButton` (Radix `Button`) rendered there as a bare cyan box with no padding,
while the same component on its own page (the Print Shop) looked right. Radix's size,
radius and colour tokens are scoped to `.radix-themes`, not `:root`.

**How to apply:** when a component with Radix controls is reused inside a portal you
do not own, wrap the portalled subtree in `<Theme appearance="dark" accentColor="green"
grayColor="sage" radius="large" hasBackground={false}>` (the app's props), rather than
editing the modal. Radix's own `Dialog` portals into the theme and does not need this.
Spot it in a screenshot: a Radix button that looks like a tight coloured label.
Related: [[reference_print_paths_and_radix_root_scheme]].
