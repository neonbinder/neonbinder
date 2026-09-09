---
name: reference-neo118-shipping-labels-selectors
description: NEO-118 shipping labels — visible-label→input mapping on /profile Shipping + /labels Ship To, the uppercase-preview assertion, empty-state copy, and the window.print() wedge
metadata:
  type: reference
---

NEO-118 added three surfaces. Selector facts worth not re-deriving:

**Shared label texts (tap the visible label, htmlFor focuses the input).**
Both the /profile Shipping section (ReturnAddressEditor, ids `ship-*`) and the
/labels "Ship To" form (ids `to-*`) use the SAME five visible labels: `Name`,
`Street Address`, `City`, `State`, `ZIP` (+ optional `Company`, `Apt / Suite`,
whose label nodes read "Company (optional)" — the `(optional)` span is part of
textContent, so exact `"Company"` does NOT match). All five are unique per page:
PublicProfileEditor uses `Username` / `Display Name` / `Tagline` / `… URL`, so
nothing on /profile collides with them.

**The uppercase preview is the real assertion.** `formatAddressBlock`
(lib/shipping/address.ts) uppercases every line and joins city/state/ZIP into
one. So typing "Jane Buyer" and asserting `JANE BUYER` / `SPRINGFIELD IL 62704`
proves the formatter ran — an echo of the input box would still be mixed case.
Each line is its own leaf `<div>`, so a full-anchored exact match hits it.

**NEVER tap "Print Label".** `window.print()` opens a native modal that blocks
every further browser event and wedges the run. Assert the preview and stop.
(Same reason the QR flow never taps its Print.)

**Empty state.** `/labels` renders a spinner while `getMyReturnAddress` is
undefined, the setup prompt when it is null, the form otherwise. The prompt copy
is "Add your return address on your profile first — it prints in the FROM block
of every label." + a `Go to Profile` button. The `Shipping Labels` h1 renders in
BOTH branches, so it cannot identify the branch — assert the copy.

**`/testing/reset` clears the return address.** `resetMyTestState` deletes the
whole `userProfiles` row, which is where `returnAddress` lives — so the standard
`sign-in?redirect=/testing/reset?redirect=…&account=new-profile` handshake both
guarantees empty Shipping fields (no eraseText, no NEO-41 re-hydration) and sets
up the empty-state branch.

**Marketing page glyph trap.** The landing card h3 is "Print 4×6 Shipping
Labels" and a marketing h2 is "Fits Any 4×6 Label Printer" — that is U+00D7
MULTIPLICATION SIGN, not the letter x. Match `.*Shipping Labels.*` /
`Fits Any 4.6 Label Printer` and sidestep it.

See [[patterns_url_redirect_chains]] and [[reference_maestro_web_getnodetext]].
