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

**Only a POINT-TO-POINT swipe is a touch drag.** `swipe: {start: "x%, y%",
end: "x%, y%"}` → `CdpWebDriver.swipe(Point, Point)` (touch). `swipe:
{direction: UP}` AND `swipe: {from: <selector>, direction: UP}` both go to
`swipe(SwipeDirection)` / `swipe(Point, SwipeDirection)`, which ignore the
element and run `window.scroll(± innerHeight/2)` (javap, 2.8.0) — they can
never move a dialog body. The YAML parses fine either way, so nothing warns.

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

Worked examples: (the Bowman flow's STEP 14 used one for a Make insert of…
radio under the pinned preview, CI 36172808297, until the set-shape dialogs
started folding answered questions and the radio moved into the band — a
layout fix beats a swipe), `parallel-grouping-reject-parallel.yaml` (pin to end, then
✕), `parallel-grouping-demoted-parallel-takes-parallels.yaml` (click-to-place
instead of drag), `bowman-insert-grouping-builds-parallels.yaml` STEP 2 (once the 2026 Bowman flagship flow)
(ReconciliationModal row button + Keep all), `inserts-1996-score-one-nb-set-two-bsc-sources.yaml`
(one UP swipe pins a short body to its end before tapping a Pending row's NAME).

**Audit trigger:** any change that adds width to a dialog row (an inline button, a
badge) can wrap its label to two lines and push the label's CENTRE past the body's
bottom edge, so a flow that tapped it unswiped goes red with no flow change. The
failure reads as `No visible element found` on the NEXT step (what the tap should
have revealed); compare the tap's logged text bounds against the body's bottom in
the failure hierarchy before anything else.

**Pin-to-END is only safe when the tail is SHORT — check what the query
leaves, not what you hope it leaves (NEO-325, CI 37874717642).** In
ReconciliationModal the two Pending columns are a side-by-side grid, so the
tail of the body is the LONGER column. Unfiltered, the SportLots column is the
prefix-filtered dealer list (hundreds of rows): two UP pins carried the
`Search SportLots items` box ~250px above the body. Even narrowed, a twin's
name matches its whole family ("Update Sapphire" → a dozen-plus `Chrome
Update Sapphire …` rows), and the bare-name twins sort FIRST, so the end is
far below them. Recipe: tap the SL search box at the pinned TOP (it sits
beside `Filter BSC items`, in the band), type, assert, then re-pin top + ONE
half swipe (75%→50%) to lift the column's first rows above the footer.

**A Ready row that appears while the body is scrolled moves the Ready header
OUT of the hierarchy.** Scroll anchoring holds Pending still, so everything
above the insertion point goes up; a `Ready (N of M)` gate then fails on a
pair that landed. Gate on a Pending header (`BSC (0 of M)`) and read Ready
after a re-pin to the top.

**A dialog that gets SHORTER turns a safe drag into a window scroll.** A drag
chains whenever the body under the finger cannot move that way, so a product
change that shrinks a step (NEO-332: the wizard's Decided list stopped latching
open and collapses past five) made one pin-to-top drag move the page behind the
wizard ~470px, and the post-Discard "Fetch cancelled" notice ended below the
fold with no flow change (CI 38068520584; reproduced locally: first poll not
found, one scroll found it). After any swipe in a dialog, read page content with
`scrollUntilVisible`, never with a bare wait.

**After a fixed-portal dialog closes, the page is back at its TOP** (the
column it was opened from is there, but a button under a 400px column list is
below the fold). The post-close positive is a `scrollUntilVisible`, not an
`extendedWaitUntil`.
