---
name: one-7s-scroll-reaches-about-900px
description: A 7000 scrollUntilVisible reads at try 0 and after 2 swipes only (~624px of travel); a target more than ~900px down is found on the 3rd swipe with no read left. Measure document offsets over CDP and stop at a real anchor in between
metadata:
  type: reference
---

**The arithmetic.** Each try is about 2.3 s: a hierarchy read, then a 312px
swipe (`innerHeight/2`). The timeout is checked at the bottom of the loop, so a
7000 step reads at try 0, after swipe 1 and after swipe 2. Swipe 3 runs, and then
the timeout ends the step before the next read. A target whose bottom sits more
than about 624 + 629 px below the viewport top when the step starts fails as
`No visible element found`. The failure PNG and hierarchy then show it fully on
screen, often at max scroll, because swipe 3 brought it in.

**Do not read that as late arrival.** Count the `Swiping UP from center` lines
between the step's start and `CommandFailed` in maestro.log. Three swipes and
three `ElementNotFound` warnings is this case.
[[present-in-failure-dump-means-late-arrival]] is the case where the target was
already on screen at the last read.

**How to fix it.** Measure, don't guess. Probe the page over CDP with the pinned
Chrome ([[probe-a-fixture-without-draining-it]]): drill the same path with
clicks, then read each landmark's `getBoundingClientRect().top + scrollY` and
`scrollHeight`. Then put a meaningful anchor between the start and the target,
such as the selected row's `Attributes for <row>` header (centred,
`visibilityPercentage: 10`), and make each leg under ~600px. Merging two
centred steps of a retired flow into one step is how this regresses: the old
seed's three 30000 steps became one 7000 step on 2024 Topps Chrome's
base-parallel row (~1,250px from the columns row to `Build from Base`).

Never raise the timeout to cover the travel ([[never-diagnose-timing-first]]).
