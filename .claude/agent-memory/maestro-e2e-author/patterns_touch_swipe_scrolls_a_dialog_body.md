---
name: touch-swipe-scrolls-a-dialog-body
description: maestro-web `swipe` is a TOUCH drag, so it scrolls the inner scroller under the finger (a fixed dialog's body) where scrollUntilVisible cannot; pin-to-top / pin-to-end recipes, where to start the touch, and the id-is-full-match fact
metadata:
  type: reference
---

**`swipe` scrolls a nested scroller; `scrollUntilVisible` never does.**
`CdpWebDriver.swipe` builds a Selenium `PointerInput(Kind.TOUCH)` down→move→up
sequence (javap, maestro-client.jar 2.8.0), so Chrome scrolls whatever
scroller is under the finger — e.g. the `flex-1 overflow-y-auto` body of a
`fixed inset-0` portal dialog (ReconciliationModal, ParallelGroupingModal).
`scrollUntilVisible` only moves the window, so inside such a dialog it can
only centre-give-up (R8 case 2). When the body has no overflow the touch
scroll chains to the window: harmless to the fixed dialog, but the page
behind it moves, so pick the next page scroll's direction accordingly.

**Why it matters:** Maestro does not see an inner scroller's clip (see
[[inner-scroller-clip-is-invisible-to-maestro]]), so a row clipped under a
dialog footer is "visible" and the tap lands on the footer — on
ParallelGroupingModal the ✕ column's x falls inside the footer's Save button.
NEO-300 removed the modal's auto-scroll-to-last-✕, which is what had been
hiding that.

**How to apply:**
- Make the swipe's END STATE position-independent: two DOWN swipes (30%→80%)
  pin the body to its top, one UP swipe (75%→25%, ~312px of the 625px Maestro
  measures) pins a short body to its end. A swipe past the limit is a no-op.
  Then one measured partial swipe if the target needs it (a half swipe
  75%→50% ≈157px covers a wider range of unknown offsets than a full one).
- Start the touch in the body's own padding: never on a dnd-kit draggable (a
  touch drag starts a DRAG), never on the backdrop (a press asks to discard).
  The layout viewport is 1009px wide (1024 less the scrollbar): a
  `max-w-3xl` dialog spans ~121-889 → x=13%; a `max-w-6xl` one spans ~16-993
  → x=3%.
- Re-pin before a hard assert on something ABOVE the body's top: elements
  scrolled above y=0 are pruned from the hierarchy (below-the-body ones are not).
- Prefer asserting through the dialog's PINNED header/footer (counts,
  "N ready, M pending", "0 promotions, 1 demotion") — they read the same
  wherever the body is scrolled.
- `id:` is a FULL regex match (`Regex.matches` on resource-id, plus a second
  pass on its `substringAfterLast('/')`), not a find — same as `text:`.
  Escape `(`/`)` in either. resource-id is `node.id || ariaLabel || …`, so a DOM
  id on an element shadows its aria-label.

Worked examples: `parallel-grouping-reject-parallel.yaml` (pin to end, then
✕), `parallel-grouping-demoted-parallel-takes-parallels.yaml` (click-to-place
instead of drag), `flagship-colour-is-a-parallel-both-ways.yaml` STEP 2 (merged from `parallel-grouping-promoted-insert-fetches-from-bsc`)
(ReconciliationModal row button + Keep all), `inserts-1996-score-one-nb-set-two-bsc-sources.yaml`
(one UP swipe pins a short body to its end before tapping a Pending row's NAME).

**Audit trigger:** any change that adds width to a dialog row (an inline button, a
badge) can wrap its label to two lines and push the label's CENTRE past the body's
bottom edge, so a flow that tapped it unswiped goes red with no flow change. The
failure reads as `No visible element found` on the NEXT step (what the tap should
have revealed); compare the tap's logged text bounds against the body's bottom in
the failure hierarchy before anything else.
