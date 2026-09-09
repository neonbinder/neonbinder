---
name: binder-header-pointerevents-and-inplace-form-scroll
description: binder-header is sticky+pointer-events-none (only logo/sign-out are clickable) so near-top center-x elements ARE tappable — there is NO app footer and no y≥489 danger zone (that claim was a myth); plus the UP-anchor pattern for in-place forms that render at/above the viewport top
metadata:
  type: reference
---

Two durable facts confirmed via NEO-39 forensics (credentials-lifecycle post-clear scroll, run logs with element bounds):

1. **The binder-layout sticky header is mostly tap-TRANSPARENT.**
   `components/modules/binder-header.tsx` renders `<header className="sticky top-0 z-20 ...
   pointer-events-none">` with `pointer-events-auto` ONLY on its two children: the left
   logo ("Neon Binder", x≈16–150) and the right sign-out button. So a tap whose target is
   a **full-width, center-x** element (inputs, most buttons; center ≈ x512) near the top of
   the viewport **passes THROUGH the header background and lands** — it is NOT occluded.
   The historic "sticky-header steals the tap" failures (e.g. the old "Yes, Clear" at
   bounds [66,19][158,51]) happened only because that button was **left-aligned**, overlapping
   the pointer-events-auto LOGO. Lesson: near-top center-x elements are safe; the element that
   actually gets stolen is one aligned under the left logo or right sign-out. The real,
   app has NO footer — the old "**FOOTER zone y≥489**" claim was FALSE (1024×629 headless
   viewport), not the top.

2. **In-place forms can render at/ABOVE the viewport top → anchor UP on a heading, don't center.**
   When a form swaps in IN PLACE after a state change (credentials cleared → username/password
   form replaces the summary view), the new form often sits HIGH: measured "Save Credentials"
   at y=36 with the username/password inputs scrolled ABOVE the fold (a bare DOWN
   `scrollUntilVisible "Save Credentials"` trivially "finds" Save at the top, then the field
   taps fail `Element not found: username`; on a colder/even-higher layout the DOWN scroll
   walks all the way to the page bottom and times out). Fix = re-anchor on a stable element
   that is ALWAYS above the form (the per-site heading, e.g. "BuySportsCards Credentials")
   with `scrollUntilVisible: { element: {text: HEADING}, direction: UP }` and **NO
   centerElement** — the UP scroll leaves the heading near the top, which pulls the whole form
   DOWN into the safe band (fields ≈y130/y220, button ≈y310). Do NOT `centerElement` the
   heading: centering it at y≈312 pushes the button down to ≈y512, below the fold
   zone. After the anchor, a plain DOWN `scrollUntilVisible` finds the button without moving.
   Apply the same UP-anchor before EACH tap that follows a viewport-shifting action (e.g. after
   typing into fields, before the Save tap). Flows that instead `openLink /profile` to reset to
   the TOP before the form interaction (the SL half of credentials-lifecycle) don't need this —
   DOWN-from-top is already reliable there.

3. **A bare `assertVisible` does NOT scroll — below-fold panel content needs `scrollUntilVisible`.**
   Confirmed NEO-39 (topps-chrome-marketplace-read, run 28331876415): expanding the
   `SetAttributesPanel` ("Edit attributes" → expanded) renders the whole panel BODY below its
   header, and on cold CI the header sits at y≈603 in the 625px viewport, so the body starts
   just below the fold. A bare `assertVisible` waits in place and times out (~17s) on an element
   that renders fine but is off-screen. Fix = convert each below-fold content check to
   `scrollUntilVisible` (the scroll IS the assertion — R6, no trailing assertVisible) and order
   them in **panel TOP→BOTTOM physical order** so every scroll moves DOWN monotonically (a DOWN
   `scrollUntilVisible` can't reach an element already above the viewport). SetAttributesPanel
   expanded body order is now driven ENTIRELY by the `EXPECTED_FEATURES` array order (the panel
   renders `applicable.map(...)` — array order == on-screen row order); target rows by
   `id: "Value for <Label>"`, NOT by position. **STALE (pre-NEO-71-74): the old "propagation
   counter → feature rows → MetadataSection (Total Cards/Block/TCDB at bottom)" order is GONE** —
   NEO-71-74 removed the propagation counter + TCDB Set ID, and FOLDED the release-metadata rows
   (Release Date → Total Cards → Block) INLINE mid-panel. Current setName order (Baseball):
   League, Era, Vintage, Season, Manufacturer, Short Print, Reprint → **Release Date, Total Cards,
   Block** → Autographed, Signed By, Prospect, Relic → physical specs (Country/Size/Material/
   Thickness/Language) → Event/Tournament, Convention/Event → **UPC (last)**. So Block is mid-panel
   now, NOT last; only "Block directly below Release Date" and "Hide-attributes toggle above all
   rows" remain load-bearing adjacencies (set-attributes-edit.yaml relies on both; validated green
   2026-07-15). Use
   plain scroll, **NO centerElement**: for an ASSERT (no tap follows) occlusion is
   irrelevant — assertVisible/scrollUntilVisible measure viewport-bounds intersection, not
   hit-testing, so an element landing at y≈600 still counts as visible. If
   `scrollUntilVisible` SUCCEEDS where a bare assertVisible failed, that also proves the element
   was below-fold, not absent (the scroll fails loudly if the element never appears).

Related: [[reference_maestro_web_tap_reliability]] (other maestro-web tap classes).
