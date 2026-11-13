---
name: shell-tabs-phone-menu
description: The binder shell's tabs (and the demo's Back to the tour / Sign up free) are only visible as links on desktop; on the phone project they live in the Menu dialog
metadata:
  type: feedback
---

The shell's nav (`navigation "Main"`) is `hidden lg:flex`; below lg the same links are in the `dialog "Menu"` behind the header's "Open menu" button. A bare `page.getByRole("link", { name: "Back to the tour" })` therefore passes on desktop and fails on `e2e-mobile`.

**Why:** found porting the NEO-464 demo specs; the shared helper `goViaShell(page, isMobile, name)` in `support/collection.ts` already does the branch (it also takes "Back to the tour").

**How to apply:** drive shell tabs through `goViaShell`. To assert `aria-current` on a phone, open the Menu, assert, close with Escape. Closing the Menu hands focus to its toggle, so read any focus assertion BEFORE opening it. Demo tab URLs put `side=` / `tab=` after `&` (`/demo/inventory?side=inventory&tab=cards`), so match `[?&]tab=`; a `[?]tab=` regex fails, and inside a `not.toHaveURL` it passes vacuously.
