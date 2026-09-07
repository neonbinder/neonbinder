---
name: below-the-fold-asserts-and-bottom-locked-scrolls
description: "An inline validation message under the last field of a form is BELOW THE FOLD at 1024x629 and maestro's hierarchy is viewport-clipped, so assertVisible reports 'Assertion is false' for a message that is rendering fine. And centerElement on a bottom-locked element burns ~2s per futile swipe — but that futile scrolling is what reaches max scroll."
metadata:
  type: reference
---

Both learned the same way, from CI run 34071657961 (PR #241).

## 1. `assertVisible` never scrolls, and the hierarchy is viewport-clipped

`/admin/players`, add form, 1024x629: the Birth year box ends at **y=625**. Its
helper line — which is where the client-side bounds refusal is SAID
("Use a whole year between 1850 and 2026.") — renders at y≈635. The failing
step's `screen-hierarchy/*.json` simply **ends** at
`[345,583][798,625] '1700'`. The refusal was correct and on the page; maestro
could not see it.

**Rule: never `assertVisible` a form's inline validation/helper message.** It is
by construction the line UNDER the field, and a form long enough to have one is
long enough to put it past 629. Use `scrollUntilVisible` and let the scroll be
the assertion (R6). Same for anything in the button row under it.

This is the same clipping that makes a hierarchy dump *silent* about a node
rather than *contradicting* it — see [[negative-asserts-pass-on-a-dead-page]]
for the other half of that trap.

## 2. `centerElement` on a bottom-locked element: measured cost, useful effect

The add form and the career editor are the LAST things on `/admin/players`, so
their controls cannot be centred — the page has no room left. Measured in that
run:

* `Create player …` — **6** consecutive swipes, `Element bounds` unchanged at
  y=552, `Visibility Percent: 1.0` every time. ~10s.
* `+ Add team` — **5** more, unchanged at y=484, visibility 1.0. ~7s.

That is R8's own stated exception (drop `centerElement` for an element truly
locked to the page bottom) and R10 dead time. Drop it, or `assertVisible` +
`tapOn` when a previous step already brought the element on screen.

**But the futile swiping has a side effect: it lands the page at MAXIMUM
SCROLL.** So one deliberately-centred scroll high in the sequence (e.g.
"No stints recorded yet.") is what makes every later measurement true. If you
strip `centerElement` from that one too, the page stops as soon as the target is
100% visible and everything below it moves. Keep exactly one, and say in a
comment that it is load-bearing.

`scrollUntilVisible` defaults to `direction: DOWN`, so a target ABOVE the current
position needs `direction: UP` — including "scroll back to the top of the form
to read what did NOT happen" after a tap left the page at the bottom.

## 3. Removing a TeamPicker chip CLOSES the popover

Not a bug, and it cost a whole flow. The chip's `×` is the focused element;
removing the chip unmounts it, `document.activeElement` falls back to `<body>`,
and `handleRootBlur` (which defers an `activeElement` read because
`relatedTarget` is unreliable) sees focus outside `rootRef` and runs
`setPopoverOpen(false); setQuery("")`. The next `tapOn: id: "Search teams"` then
polls 17s and fails.

Re-open with `tapOn: id: "Add team"` — the trigger is `setPopoverOpen(true)`,
never a toggle, so it is always safe. (Selecting a match, by contrast, leaves the
popover open on purpose — `addChip` clears the query and re-focuses the input.)
